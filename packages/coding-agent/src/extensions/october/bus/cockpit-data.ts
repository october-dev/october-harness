import type { SessionEntry } from "../../../core/session-manager.ts";
import { MCP_TOOL_PREFIX } from "./mcp-client.ts";
import {
	type BusMessage,
	DELIVERY_ENTRY,
	isRecord,
	POLICY_CONTEXT_TITLE,
	parseDeliveryRecord,
	parseMessages,
	REQUEST_ENTRY,
} from "./public.ts";

/** A section that loads independently. A failed read is never shown as an empty list. */
export type CockpitSection<T> =
	| { state: "loading" }
	| { state: "error"; error: string }
	| { state: "ready"; items: T[]; malformed: number };

export interface CockpitNode {
	agentId: string;
	executionId: string;
	scopeId?: string;
	leaseExpiresAt?: string;
	displayName?: string;
	lifecycle?: string;
	ready?: boolean;
	reachable?: boolean;
}

export interface CockpitPeer {
	id: string;
	displayName: string;
	lifecycle: string;
	ready: boolean;
	reachable: boolean;
	executionId?: string;
	capabilities: string[];
	updatedAt?: string;
}

export interface CockpitTaskProgress {
	kind: string;
	text: string;
	agentId?: string;
	createdAt?: string;
}

export interface CockpitTask {
	id: string;
	heading: string;
	description: string;
	status: string;
	/** Absent on Bus releases whose tasks do not report readiness. */
	ready?: boolean;
	/** `null` means the Bus reports no creating agent; `undefined` means the field was not supplied. */
	createdBy?: string | null;
	claimedBy?: string;
	dependencies: string[];
	note?: string;
	/** Absent on Bus releases whose tasks do not report progress. */
	progress?: CockpitTaskProgress[];
	createdAt: string;
	updatedAt: string;
}

export interface CockpitReceipt {
	messageId: string;
	state: string;
	acceptedAt: string;
	deliveredAt?: string;
	acknowledgedAt?: string;
	repliedAt?: string;
	responseMessageId?: string;
}

export type CockpitMessageSource = "delivery" | "check_inbox" | "message_peer" | "delegation";

export interface CockpitMessage {
	id: string;
	direction: "incoming" | "outgoing";
	source: CockpitMessageSource;
	/** Undefined when this session did not record the sender. Never inferred from the current identity. */
	from?: string;
	to?: string;
	mode?: string;
	body?: string;
	responseTo?: string;
	taskId?: string;
	/** Bus-supplied time: message creation for incoming messages, send acceptance for outgoing messages. */
	serverTime?: { label: "created" | "accepted"; value: string };
	/** Session entry time when this session first recorded the message. */
	observedAt: string;
	/** Local harness state, distinct from the Bus receipt state. */
	localState: string;
	localStateAt: string;
	error?: string;
	/** Exact IDs of recorded messages whose `responseTo` is this message. */
	replies: string[];
	/** The message this one answers, when `responseTo` is recorded in this session. */
	parentRecorded: boolean;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function headingFrom(title: unknown, description: unknown): string | undefined {
	const explicit = typeof title === "string" ? title.trim() : "";
	if (explicit) return explicit;
	if (typeof description !== "string") return undefined;
	return description
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
}

export function parseNodeStatus(value: Record<string, unknown>): CockpitNode {
	const identity = value.identity;
	if (!isRecord(identity) || !text(identity.agentId) || !text(identity.executionId))
		throw new Error("get_node_status returned a malformed node status");
	const agent = isRecord(value.agent) ? value.agent : {};
	return {
		agentId: identity.agentId as string,
		executionId: identity.executionId as string,
		scopeId: text(identity.scopeId),
		leaseExpiresAt: text(identity.leaseExpiresAt),
		displayName: text(agent.displayName),
		lifecycle: text(agent.lifecycle),
		ready: typeof agent.ready === "boolean" ? agent.ready : undefined,
		reachable: typeof agent.reachable === "boolean" ? agent.reachable : undefined,
	};
}

function collection<T>(
	value: Record<string, unknown>,
	field: string,
	tool: string,
	parse: (item: unknown) => T | undefined,
): { items: T[]; malformed: number } {
	const raw = value[field];
	if (!Array.isArray(raw)) throw new Error(`${tool} returned a malformed ${field} collection`);
	const items: T[] = [];
	let malformed = 0;
	for (const item of raw) {
		const parsed = parse(item);
		if (parsed) items.push(parsed);
		else malformed++;
	}
	return { items, malformed };
}

function parsePeer(item: unknown): CockpitPeer | undefined {
	if (
		!isRecord(item) ||
		!text(item.id) ||
		typeof item.displayName !== "string" ||
		typeof item.lifecycle !== "string" ||
		typeof item.ready !== "boolean" ||
		typeof item.reachable !== "boolean"
	)
		return undefined;
	return {
		id: item.id as string,
		displayName: item.displayName,
		lifecycle: item.lifecycle,
		ready: item.ready,
		reachable: item.reachable,
		executionId: text(item.executionId),
		capabilities: Array.isArray(item.capabilities)
			? item.capabilities.flatMap((capability) =>
					isRecord(capability) && text(capability.name) ? [capability.name as string] : [],
				)
			: [],
		updatedAt: text(item.updatedAt),
	};
}

export function parsePeerList(value: Record<string, unknown>): { items: CockpitPeer[]; malformed: number } {
	return collection(value, "peers", "list_peers", parsePeer);
}

function parseProgress(value: unknown): CockpitTaskProgress[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.flatMap((item) =>
		isRecord(item) && typeof item.kind === "string" && typeof item.text === "string"
			? [{ kind: item.kind, text: item.text, agentId: text(item.agentId), createdAt: text(item.createdAt) }]
			: [],
	);
}

/** Accepts both the pinned Bus task (description only) and the newer task (title, ready, progress). */
function parseTask(item: unknown): CockpitTask | undefined {
	if (!isRecord(item) || !text(item.id) || !text(item.status) || !text(item.createdAt) || !text(item.updatedAt))
		return undefined;
	const heading = headingFrom(item.title, item.description);
	if (!heading) return undefined;
	return {
		id: item.id as string,
		heading,
		description: typeof item.description === "string" ? item.description : "",
		status: item.status as string,
		ready: typeof item.ready === "boolean" ? item.ready : undefined,
		createdBy: item.createdBy === null ? null : text(item.createdBy),
		claimedBy: text(item.claimedBy),
		dependencies: Array.isArray(item.dependencies)
			? item.dependencies.filter((dependency): dependency is string => typeof dependency === "string")
			: [],
		note: text(item.note),
		progress: parseProgress(item.recentProgress),
		createdAt: item.createdAt as string,
		updatedAt: item.updatedAt as string,
	};
}

export function parseTaskList(value: Record<string, unknown>): { items: CockpitTask[]; malformed: number } {
	return collection(value, "tasks", "list_tasks", parseTask);
}

export function parseReceipt(value: unknown): CockpitReceipt {
	if (!isRecord(value) || !text(value.messageId) || !text(value.state) || !text(value.acceptedAt))
		throw new Error("malformed delivery receipt");
	return {
		messageId: value.messageId as string,
		state: value.state as string,
		acceptedAt: value.acceptedAt as string,
		deliveredAt: text(value.deliveredAt),
		acknowledgedAt: text(value.acknowledgedAt),
		repliedAt: text(value.repliedAt),
		responseMessageId: text(value.responseMessageId),
	};
}

function policyTaskId(context: unknown): string | undefined {
	if (!Array.isArray(context)) return undefined;
	for (const item of context) {
		if (!isRecord(item) || item.title !== POLICY_CONTEXT_TITLE || typeof item.text !== "string") continue;
		try {
			const parsed: unknown = JSON.parse(item.text);
			if (isRecord(parsed) && parsed.version === 1 && text(parsed.taskId)) return parsed.taskId as string;
		} catch {
			// Invalid peer-supplied policy context carries no task link.
		}
	}
	return undefined;
}

function resultJson(content: unknown): unknown {
	if (!Array.isArray(content)) return undefined;
	const joined = content
		.filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
		.map((part) => (part as { text: string }).text)
		.join("\n")
		.trim();
	if (!joined) return undefined;
	try {
		return JSON.parse(joined);
	} catch {
		return undefined;
	}
}

/**
 * Rebuild the messages this session observed, from the current branch only. Inputs: harness delivery
 * records, request records from `/delegate` and `/handoff`, and recorded successful model calls to
 * `message_peer` and `check_inbox`. Correlation uses exact message IDs only.
 */
export function buildMessageHistory(branch: SessionEntry[]): CockpitMessage[] {
	const byId = new Map<string, CockpitMessage>();
	const calls = new Map<string, Record<string, unknown>>();

	const record = (message: Omit<CockpitMessage, "replies" | "parentRecorded">): void => {
		const existing = byId.get(message.id);
		if (!existing) {
			byId.set(message.id, { ...message, replies: [], parentRecorded: false });
			return;
		}
		// Keep the first observation; later records only advance local state and fill gaps.
		existing.localState = message.localState;
		existing.localStateAt = message.localStateAt;
		existing.error = message.error;
		existing.from ??= message.from;
		existing.to ??= message.to;
		existing.mode ??= message.mode;
		existing.body ??= message.body;
		existing.responseTo ??= message.responseTo;
		existing.taskId ??= message.taskId;
		existing.serverTime ??= message.serverTime;
	};
	const incoming = (
		message: BusMessage,
		source: CockpitMessageSource,
		state: string,
		at: string,
		error?: string,
	): void =>
		record({
			id: message.id,
			direction: "incoming",
			source,
			from: message.from,
			to: message.to,
			mode: message.mode,
			body: message.body,
			responseTo: message.responseTo,
			taskId: policyTaskId(message.context),
			serverTime: message.createdAt ? { label: "created", value: message.createdAt } : undefined,
			observedAt: at,
			localState: state,
			localStateAt: at,
			error,
		});

	for (const entry of branch) {
		if (entry.type === "custom" && entry.customType === DELIVERY_ENTRY) {
			const delivery = parseDeliveryRecord(entry.data);
			if (!delivery) continue;
			for (const message of delivery.messages)
				incoming(message, "delivery", delivery.state, entry.timestamp, delivery.error);
			continue;
		}
		if (entry.type === "custom" && entry.customType === REQUEST_ENTRY) {
			const data = entry.data;
			if (!isRecord(data) || data.version !== 1 || !text(data.messageId)) continue;
			const receipt = isRecord(data.receipt) ? data.receipt : {};
			record({
				id: data.messageId as string,
				direction: "outgoing",
				source: "delegation",
				from: text(data.from),
				to: text(data.to),
				mode: text(data.mode),
				body: typeof data.body === "string" ? data.body : undefined,
				taskId: text(data.taskId),
				serverTime: text(receipt.acceptedAt)
					? { label: "accepted", value: receipt.acceptedAt as string }
					: undefined,
				observedAt: entry.timestamp,
				localState: "sent",
				localStateAt: entry.timestamp,
			});
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "toolCall" && part.name === `${MCP_TOOL_PREFIX}message_peer`)
					calls.set(part.id, part.arguments);
			}
			continue;
		}
		if (message.role !== "toolResult" || message.isError) continue;
		if (message.toolName === `${MCP_TOOL_PREFIX}check_inbox`) {
			const result = resultJson(message.content);
			if (!isRecord(result)) continue;
			for (const delivered of parseMessages(result.messages))
				incoming(delivered, "check_inbox", "delivered to model", entry.timestamp);
			continue;
		}
		if (message.toolName !== `${MCP_TOOL_PREFIX}message_peer`) continue;
		const result = resultJson(message.content);
		const args = calls.get(message.toolCallId);
		if (!isRecord(result) || !text(result.messageId) || !args) continue;
		record({
			id: result.messageId as string,
			direction: "outgoing",
			source: "message_peer",
			to: text(args.peer),
			mode: text(args.mode),
			body: typeof args.message === "string" ? args.message : undefined,
			responseTo: text(args.responseTo),
			taskId: policyTaskId(args.context),
			serverTime: text(result.acceptedAt) ? { label: "accepted", value: result.acceptedAt as string } : undefined,
			observedAt: entry.timestamp,
			localState: "sent",
			localStateAt: entry.timestamp,
		});
	}

	const messages = [...byId.values()];
	for (const message of messages) {
		if (!message.responseTo) continue;
		const parent = byId.get(message.responseTo);
		if (!parent) continue;
		message.parentRecorded = true;
		parent.replies.push(message.id);
	}
	return messages.reverse();
}
