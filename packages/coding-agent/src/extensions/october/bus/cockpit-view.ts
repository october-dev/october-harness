import { type Component, type Keybinding, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { Theme, ThemeColor } from "../../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import type { CockpitMessage, CockpitPeer, CockpitReceipt, CockpitSection, CockpitTask } from "./cockpit-data.ts";

export interface CockpitViewData {
	transport: string;
	identity: string[];
	/** One-line status shown in the fixed header. */
	connection: { text: string; tone: ThemeColor };
	/** Full connection diagnostics, shown in the scrollable body so they never overflow the header. */
	connectionDetail?: string;
	snapshotAt?: string;
	/** Static explanation shown instead of sections when the cockpit cannot read a Bus. */
	notice?: string[];
	peers?: CockpitSection<CockpitPeer>;
	tasks?: CockpitSection<CockpitTask>;
	messages?: CockpitMessage[];
}

export type CockpitReceiptLoader = (messageId: string, signal: AbortSignal) => Promise<CockpitReceipt>;

/** The part of the TUI the view needs: terminal height and repaint. */
export interface CockpitHost {
	terminal: { rows: number };
	requestRender(): void;
}

interface Row {
	text: string;
	key?: string;
	detail?: () => Detail;
}

interface Detail {
	title: string;
	fields: [string, string][];
	messageId?: string;
	recordedIds?: Set<string>;
}

type ReceiptState =
	| { messageId: string; state: "loading" }
	| { messageId: string; state: "ready"; receipt: CockpitReceipt }
	| { messageId: string; state: "error"; error: string };

/** Remove terminal escapes and control characters from untrusted text. Keeps newlines. */
export function cleanText(value: string): string {
	return stripAnsi(value)
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "    ")
		.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "");
}

function oneLine(value: string): string {
	return cleanText(value).replace(/\n+/g, " ").trim();
}

export function formatTime(value: string | undefined): string {
	if (!value) return "unavailable";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return oneLine(value);
	return `${date.toISOString().slice(0, 19).replace("T", " ")}Z`;
}

/** Read-only collaboration cockpit: one scrolling list of peers, tasks and messages, plus a detail view. */
export class OctoberCockpitView implements Component {
	private readonly host: CockpitHost;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly loadReceipt: CockpitReceiptLoader | undefined;
	private readonly onClose: () => void;
	private data: CockpitViewData;
	/** The cursor follows an item by key, or a non-item line by index once the user moves. */
	private cursorKey: string | undefined;
	private cursorIndex = 0;
	private moved = false;
	private listOffset = 0;
	private detail: Detail | undefined;
	private detailOffset = 0;
	private receipt: ReceiptState | undefined;
	private receiptAbort: AbortController | undefined;
	private disposed = false;
	private width = 80;

	constructor(
		host: CockpitHost,
		theme: Theme,
		keybindings: KeybindingsManager,
		data: CockpitViewData,
		onClose: () => void,
		loadReceipt?: CockpitReceiptLoader,
	) {
		this.host = host;
		this.theme = theme;
		this.keybindings = keybindings;
		this.data = data;
		this.onClose = onClose;
		this.loadReceipt = loadReceipt;
	}

	setData(data: CockpitViewData): void {
		if (this.disposed) return;
		this.data = data;
		this.host.requestRender();
	}

	dispose(): void {
		this.disposed = true;
		this.receiptAbort?.abort();
	}

	invalidate(): void {}

	handleInput(input: string): void {
		const kb = this.keybindings;
		if (this.detail) {
			const page = Math.max(1, this.bodyHeight() - 1);
			if (kb.matches(input, "tui.select.cancel")) this.closeDetail();
			else if (kb.matches(input, "tui.select.up")) this.detailOffset--;
			else if (kb.matches(input, "tui.select.down")) this.detailOffset++;
			else if (kb.matches(input, "tui.select.pageUp")) this.detailOffset -= page;
			else if (kb.matches(input, "tui.select.pageDown")) this.detailOffset += page;
			else return;
			this.detailOffset = Math.max(0, this.detailOffset);
			this.host.requestRender();
			return;
		}
		if (kb.matches(input, "tui.select.cancel")) {
			this.onClose();
			return;
		}
		const rows = this.rows();
		const cursor = this.cursor(rows);
		const page = Math.max(1, this.bodyHeight() - 1);
		let next: number;
		if (kb.matches(input, "tui.select.confirm")) {
			const detail = rows[cursor]?.detail;
			if (detail) this.openDetail(detail());
			next = cursor;
		} else if (kb.matches(input, "tui.select.up")) next = this.step(rows, cursor, -1);
		else if (kb.matches(input, "tui.select.down")) next = this.step(rows, cursor, 1);
		else if (kb.matches(input, "tui.select.pageUp")) next = this.lineAt(rows, cursor - page, -1);
		else if (kb.matches(input, "tui.select.pageDown")) next = this.lineAt(rows, cursor + page, 1);
		else return;
		if (next !== cursor) {
			this.moved = true;
			this.cursorIndex = next;
			this.cursorKey = rows[next]?.key;
		}
		this.host.requestRender();
	}

	render(width: number): string[] {
		this.width = width;
		const lines = this.detail ? this.renderDetail(width, this.detail) : this.renderList(width);
		// Very short terminals cannot fit header, body and footer; never return more rows than allowed.
		return lines.slice(0, this.height()).map((line) => truncateToWidth(line, width));
	}

	private height(): number {
		const rows = Math.max(1, this.host.terminal.rows);
		return Math.min(rows, Math.max(8, Math.floor(rows * 0.8)));
	}

	private bodyHeight(): number {
		return Math.max(1, this.height() - (this.detail ? 4 : this.headerHeight() + 2));
	}

	private hint(binding: Keybinding): string {
		return this.keybindings.getKeys(binding)[0] ?? binding;
	}

	/**
	 * Resolve the cursor row: the tracked item, else the tracked line. Before the user moves, the view
	 * starts at the top and selects the first item only when it is on the first screen, so diagnostics
	 * above it are not scrolled away.
	 */
	private cursor(rows: Row[]): number {
		if (rows.length === 0) return 0;
		const keyed = this.cursorKey ? rows.findIndex((row) => row.key === this.cursorKey) : -1;
		if (keyed >= 0) return keyed;
		if (!this.moved) {
			const first = rows.findIndex((row) => row.key !== undefined);
			return first >= 0 && first < this.bodyHeight() ? first : 0;
		}
		return Math.min(this.cursorIndex, rows.length - 1);
	}

	/** Up/Down jump between items; past the first or last item they move line by line so text stays reachable. */
	private step(rows: Row[], from: number, direction: 1 | -1): number {
		for (let index = from + direction; index >= 0 && index < rows.length; index += direction) {
			if (rows[index].key) return index;
		}
		return this.lineAt(rows, from + direction, direction);
	}

	/** Clamp to the list and skip blank separator lines, so every non-blank line can hold the cursor. */
	private lineAt(rows: Row[], target: number, direction: 1 | -1): number {
		let index = Math.max(0, Math.min(rows.length - 1, target));
		while (rows[index]?.text === "" && index + direction >= 0 && index + direction < rows.length) index += direction;
		return index;
	}

	private headerHeight(): number {
		return this.headerLines(this.width).length;
	}

	private openDetail(detail: Detail): void {
		this.detail = detail;
		this.detailOffset = 0;
		this.receiptAbort?.abort();
		this.receiptAbort = undefined;
		this.receipt = undefined;
		const messageId = detail.messageId;
		if (!messageId || !this.loadReceipt) return;
		const abort = new AbortController();
		this.receiptAbort = abort;
		this.receipt = { messageId, state: "loading" };
		const settle = (next: ReceiptState): void => {
			// A closed view, a different detail, or a newer request for the same message cannot repaint.
			if (this.disposed || abort.signal.aborted || this.receiptAbort !== abort) return;
			this.receipt = next;
			this.host.requestRender();
		};
		this.loadReceipt(messageId, abort.signal).then(
			(receipt) => settle({ messageId, state: "ready", receipt }),
			(error: unknown) =>
				settle({ messageId, state: "error", error: error instanceof Error ? error.message : String(error) }),
		);
	}

	private closeDetail(): void {
		this.receiptAbort?.abort();
		this.receiptAbort = undefined;
		this.receipt = undefined;
		this.detail = undefined;
	}

	private headerLines(width: number): string[] {
		const theme = this.theme;
		const data = this.data;
		const snapshot = data.snapshotAt ? theme.fg("dim", ` · snapshot ${formatTime(data.snapshotAt)}`) : "";
		const lines = [
			`${theme.bold(theme.fg("accent", "October cockpit"))}${theme.fg("dim", " · read-only")}`,
			theme.fg("muted", oneLine(data.transport)),
			...data.identity.map((line) => oneLine(line)),
			`${theme.fg(data.connection.tone, oneLine(data.connection.text))}${snapshot}`,
			theme.fg("border", "─".repeat(Math.max(1, width))),
		];
		// The fixed header always leaves room for one body line and the two footer lines.
		return lines.slice(0, Math.max(1, this.height() - 3));
	}

	private wrapped(text: string, indent: number): string[] {
		return wrapTextWithAnsi(text, Math.max(1, this.width - 2 - indent)).map((line) => " ".repeat(indent) + line);
	}

	private section<T>(
		rows: Row[],
		title: string,
		section: CockpitSection<T>,
		emptyText: string,
		toRow: (item: T) => Row,
	): void {
		const theme = this.theme;
		if (section.state === "loading") {
			rows.push({ text: `${theme.bold(title)} ${theme.fg("dim", "loading…")}` });
			return;
		}
		if (section.state === "error") {
			rows.push({ text: `${theme.bold(title)} ${theme.fg("error", "unavailable")}` });
			for (const line of cleanText(section.error).split("\n"))
				for (const wrapped of this.wrapped(theme.fg("error", line), 2)) rows.push({ text: wrapped });
			return;
		}
		const malformed = section.malformed > 0 ? theme.fg("warning", ` · ${section.malformed} malformed omitted`) : "";
		rows.push({ text: `${theme.bold(title)} ${theme.fg("dim", `(${section.items.length})`)}${malformed}` });
		if (section.items.length === 0) rows.push({ text: `  ${theme.fg("dim", emptyText)}` });
		for (const item of section.items) rows.push(toRow(item));
	}

	private rows(): Row[] {
		const theme = this.theme;
		const data = this.data;
		const rows: Row[] = [];
		if (data.connectionDetail) {
			rows.push({ text: theme.bold("Connection") });
			for (const line of cleanText(data.connectionDetail).split("\n"))
				for (const wrapped of this.wrapped(theme.fg("error", line), 2)) rows.push({ text: wrapped });
		}
		if (data.notice) {
			if (rows.length) rows.push({ text: "" });
			for (const line of data.notice)
				for (const wrapped of this.wrapped(oneLine(line), 0)) rows.push({ text: wrapped });
		}
		if (data.peers) {
			if (rows.length) rows.push({ text: "" });
			this.section(rows, "Peers", data.peers, "No linked peers.", (peer) => this.peerRow(peer));
		}
		if (data.tasks) {
			if (rows.length) rows.push({ text: "" });
			this.section(rows, "Tasks", data.tasks, "No shared tasks.", (task) => this.taskRow(task));
		}
		if (data.messages) {
			if (rows.length) rows.push({ text: "" });
			const messages = data.messages;
			rows.push({
				text: `${theme.bold("Messages")} ${theme.fg("dim", `(${messages.length}) observed in this session`)}`,
			});
			rows.push({
				text: `  ${theme.fg("dim", "Queued messages not yet delivered are not previewed; reading them would consume them.")}`,
			});
			if (messages.length === 0)
				rows.push({ text: `  ${theme.fg("dim", "No messages recorded in this session.")}` });
			const recorded = new Set(messages.map((message) => message.id));
			for (const message of messages) rows.push(this.messageRow(message, recorded));
		}
		return rows;
	}

	private peerRow(peer: CockpitPeer): Row {
		const theme = this.theme;
		return {
			key: `peer:${peer.id}`,
			text: [
				oneLine(peer.id),
				oneLine(peer.displayName),
				oneLine(peer.lifecycle),
				peer.ready ? theme.fg("success", "ready") : theme.fg("warning", "not ready"),
				peer.reachable ? theme.fg("success", "reachable") : theme.fg("error", "unreachable"),
			].join(" · "),
			detail: () => ({
				title: `Peer ${oneLine(peer.id)}`,
				fields: [
					["ID", peer.id],
					["Display name", peer.displayName],
					["Lifecycle", peer.lifecycle],
					["Ready", peer.ready ? "ready" : "not ready"],
					["Reachable", peer.reachable ? "reachable" : "unreachable"],
					["Execution", peer.executionId ?? "unavailable"],
					["Capabilities", peer.capabilities.length ? peer.capabilities.join(", ") : "none reported"],
					["Updated", formatTime(peer.updatedAt)],
				],
			}),
		};
	}

	private taskRow(task: CockpitTask): Row {
		const readiness = task.ready === undefined ? "" : task.ready ? ", ready" : ", not ready";
		const createdBy = task.createdBy === null ? "none" : (task.createdBy ?? "unavailable");
		return {
			key: `task:${task.id}`,
			text: [
				`${oneLine(task.id)} [${oneLine(task.status)}${readiness}] ${oneLine(task.heading)}`,
				`by ${oneLine(createdBy)}`,
				task.claimedBy ? `claimed by ${oneLine(task.claimedBy)}` : "unclaimed",
				`created ${formatTime(task.createdAt)}`,
				`updated ${formatTime(task.updatedAt)}`,
			].join(" · "),
			detail: () => ({
				title: `Task ${oneLine(task.id)}`,
				fields: [
					["ID", task.id],
					["Heading", task.heading],
					["Status", task.status],
					[
						"Readiness",
						task.ready === undefined ? "not reported by this Bus" : task.ready ? "ready" : "not ready",
					],
					["Created by", task.createdBy === null ? "none reported" : (task.createdBy ?? "unavailable")],
					["Claimed by", task.claimedBy ?? "unclaimed"],
					["Created", formatTime(task.createdAt)],
					["Updated", formatTime(task.updatedAt)],
					["Dependencies", task.dependencies.length ? task.dependencies.join(", ") : "none"],
					["Note", task.note ?? "unavailable"],
					[
						"Progress",
						task.progress === undefined
							? "not reported by this Bus"
							: task.progress.length === 0
								? "none"
								: task.progress
										.map(
											(entry) =>
												`${formatTime(entry.createdAt)} ${entry.kind}${entry.agentId ? ` ${entry.agentId}` : ""}: ${entry.text}`,
										)
										.join("\n"),
					],
					["Description", task.description || "(empty)"],
				],
			}),
		};
	}

	private messageRow(message: CockpitMessage, recorded: Set<string>): Row {
		const incoming = message.direction === "incoming";
		const peer = incoming ? `from ${message.from ?? "unrecorded sender"}` : `to ${message.to ?? "unknown"}`;
		const parts = [
			`${incoming ? "←" : "→"} ${oneLine(message.id)} ${oneLine(message.mode ?? "mode unavailable")} ${oneLine(peer)}`,
			oneLine(message.localState),
			formatTime(message.serverTime?.value ?? message.observedAt),
		];
		if (message.responseTo)
			parts.push(`re ${oneLine(message.responseTo)}${message.parentRecorded ? "" : " (not in this session)"}`);
		if (message.taskId) parts.push(`task ${oneLine(message.taskId)}`);
		if (message.replies.length)
			parts.push(`${message.replies.length} repl${message.replies.length === 1 ? "y" : "ies"}`);
		return {
			key: `message:${message.id}`,
			text: parts.join(" · "),
			detail: () => ({
				title: `Message ${oneLine(message.id)}`,
				messageId: message.id,
				recordedIds: recorded,
				fields: [
					["ID", message.id],
					["Direction", incoming ? "incoming" : "outgoing"],
					["From", message.from ?? "not recorded in this session"],
					["To", message.to ?? "unavailable"],
					["Mode", message.mode ?? "unavailable"],
					["Task", message.taskId ?? "none linked"],
					[
						"Responds to",
						message.responseTo
							? `${message.responseTo}${message.parentRecorded ? "" : " (not in this session)"}`
							: "none",
					],
					["Replies", message.replies.length ? message.replies.join(", ") : "none recorded in this session"],
					[
						message.serverTime?.label === "accepted" ? "Accepted (Bus)" : "Created (Bus)",
						formatTime(message.serverTime?.value),
					],
					["Observed (session)", formatTime(message.observedAt)],
					["Local state", `${message.localState} at ${formatTime(message.localStateAt)}`],
					...(message.error ? ([["Local error", message.error]] as [string, string][]) : []),
					["Recorded from", message.source],
					["Body", message.body ?? "unavailable"],
				],
			}),
		};
	}

	private renderList(width: number): string[] {
		const theme = this.theme;
		const header = this.headerLines(width);
		const rows = this.rows();
		const cursor = this.cursor(rows);
		const bodyHeight = Math.max(1, this.height() - header.length - 2);
		if (cursor < this.listOffset) this.listOffset = cursor;
		if (cursor >= this.listOffset + bodyHeight) this.listOffset = cursor - bodyHeight + 1;
		this.listOffset = Math.max(0, Math.min(this.listOffset, rows.length - bodyHeight));
		const visible = rows
			.slice(this.listOffset, this.listOffset + bodyHeight)
			.map((row, index) =>
				index + this.listOffset === cursor ? `${theme.fg("accent", "› ")}${row.text}` : `  ${row.text}`,
			);
		const range =
			rows.length > bodyHeight
				? ` · ${this.listOffset + 1}-${this.listOffset + visible.length} of ${rows.length}`
				: "";
		const inspect = rows.some((row) => row.key) ? ` · ${this.hint("tui.select.confirm")} inspect` : "";
		return [
			...header,
			...visible,
			theme.fg("border", "─".repeat(Math.max(1, width))),
			theme.fg(
				"dim",
				`${this.hint("tui.select.up")}/${this.hint("tui.select.down")} move${inspect} · ${this.hint("tui.select.cancel")} close${range}`,
			),
		];
	}

	private detailLines(width: number, detail: Detail): string[] {
		const theme = this.theme;
		const fields = [...detail.fields];
		const receipt = this.receipt;
		if (detail.messageId) {
			if (!this.loadReceipt) fields.push(["Bus receipt", "unavailable"]);
			else if (!receipt || receipt.state === "loading") fields.push(["Bus receipt", "loading…"]);
			else if (receipt.state === "error") fields.push(["Bus receipt", `unavailable: ${receipt.error}`]);
			else {
				const { receipt: value } = receipt;
				const response = value.responseMessageId
					? `${value.responseMessageId}${detail.recordedIds?.has(value.responseMessageId) ? "" : " (not in this session)"}`
					: "none";
				fields.push(
					["Bus state", value.state],
					["Bus accepted", formatTime(value.acceptedAt)],
					["Bus delivered", formatTime(value.deliveredAt)],
					["Bus acknowledged", formatTime(value.acknowledgedAt)],
					["Bus replied", formatTime(value.repliedAt)],
					["Response message", response],
				);
			}
		}
		const lines: string[] = [];
		for (const [label, raw] of fields) {
			const value = cleanText(raw);
			const name = theme.fg("muted", `${label}:`);
			if (!value.includes("\n")) {
				lines.push(...wrapTextWithAnsi(`${name} ${value}`, width));
				continue;
			}
			lines.push(name);
			for (const line of value.split("\n")) lines.push(...wrapTextWithAnsi(`  ${line}`, width));
		}
		return lines;
	}

	private renderDetail(width: number, detail: Detail): string[] {
		const theme = this.theme;
		const body = this.detailLines(width, detail);
		const bodyHeight = Math.max(1, this.height() - 4);
		this.detailOffset = Math.max(0, Math.min(this.detailOffset, body.length - bodyHeight));
		const visible = body.slice(this.detailOffset, this.detailOffset + bodyHeight);
		const range =
			body.length > bodyHeight
				? ` · ${this.detailOffset + 1}-${this.detailOffset + visible.length} of ${body.length}`
				: "";
		return [
			`${theme.bold(theme.fg("accent", detail.title))}${theme.fg("dim", " · read-only")}`,
			theme.fg("border", "─".repeat(Math.max(1, width))),
			...visible,
			theme.fg("border", "─".repeat(Math.max(1, width))),
			theme.fg(
				"dim",
				`${this.hint("tui.select.up")}/${this.hint("tui.select.down")} scroll · ${this.hint("tui.select.cancel")} back${range}`,
			),
		];
	}
}
