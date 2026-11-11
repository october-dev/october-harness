/**
 * Context transparency: a metadata snapshot of the context one model request was built from.
 *
 * The snapshot is derived from the messages the agent loop already assembled for the request, so
 * reading it never fetches a source again or calls the model. Content stays out of the snapshot
 * unless a caller reveals it explicitly.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, getCurrentSystemMessage, getCurrentTools } from "@earendil-works/pi-ai";
import { estimateTokens } from "./compaction/compaction.ts";
import { convertToLlm } from "./messages.ts";

/** How many recent request snapshots a session keeps. */
export const MAX_CONTEXT_SNAPSHOTS = 5;

/** Where a piece of context comes from, in the order the groups are reported. */
export type ContextSourceKind = "instructions" | "tools" | "compaction" | "extension" | "bus" | "conversation";

export type ContextOmissionReason = "compacted" | "context_edit" | "excluded_from_context" | "skill_hidden_from_model";

export type ContextTruncationReason = "bash_output_truncated";

export interface ContextItem {
	/** Position in the request, starting at 0. */
	index: number;
	kind: ContextSourceKind;
	/** The exact origin when known: a file path, `section:<name>`, a tool name, a session entry id, a custom type, or an extension path. */
	sourceId?: string;
	label: string;
	role: string;
	/** False when the harness cannot name the exact origin. Never guessed. */
	attributed: boolean;
	/** Estimated tokens (chars/4). Not a provider token count. */
	estTokens: number;
	truncated?: { reason: ContextTruncationReason };
	/** Present only when the caller asked to reveal content. */
	content?: string;
}

export interface ContextOmission {
	kind: ContextSourceKind;
	reason: ContextOmissionReason;
	sourceId?: string;
	/** How many items this record covers, when it covers more than one. */
	count?: number;
	estTokens?: number;
}

/** One extension handler that changed the conversation sent in this request. */
export interface ContextTransform {
	extensionPath: string;
	event: "context" | "context_with_system";
	added: number;
	removed: number;
}

export interface ContextGroup {
	kind: ContextSourceKind;
	itemCount: number;
	estTokens: number;
}

export interface ContextSnapshot {
	requestId: string;
	createdAt: number;
	modelId?: string;
	estimator: "chars/4";
	totalEstTokens: number;
	items: ContextItem[];
	groups: ContextGroup[];
	omitted: ContextOmission[];
	transforms: ContextTransform[];
}

/** What an extension runner records for one handler: fingerprints of the messages it added. */
export interface ContextTransformRecord {
	extensionPath: string;
	event: "context" | "context_with_system";
	added: string[];
	removed: number;
}

/** Which request to inspect and whether to include item content. Content is left out unless asked for. */
export interface ContextSnapshotOptions {
	/** Defaults to the latest request. */
	requestId?: string;
	includeContent?: boolean;
}

/**
 * A stable identity for a message that survives the structured clone each handler pass makes.
 * A message that cannot be serialized (for example a BigInt in `details`) gets a fingerprint that
 * matches nothing, so it is reported as unattributed instead of breaking the request.
 */
export function fingerprintContextMessage(message: AgentMessage): string {
	try {
		return JSON.stringify(message);
	} catch {
		return `unserializable:${message.role}`;
	}
}

/** Compare the messages before and after a handler as multisets of fingerprints. */
export function diffContextFingerprints(
	before: readonly string[],
	after: readonly string[],
): { added: string[]; removed: number } {
	const remaining = new Map<string, number>();
	for (const fingerprint of before) remaining.set(fingerprint, (remaining.get(fingerprint) ?? 0) + 1);
	const added: string[] = [];
	for (const fingerprint of after) {
		const count = remaining.get(fingerprint) ?? 0;
		if (count > 0) remaining.set(fingerprint, count - 1);
		else added.push(fingerprint);
	}
	let removed = 0;
	for (const count of remaining.values()) removed += count;
	return { added, removed };
}

const KIND_ORDER: readonly ContextSourceKind[] = [
	"instructions",
	"tools",
	"compaction",
	"extension",
	"bus",
	"conversation",
];

/** Prompt sections the harness itself writes. Any other section comes from an extension. */
const BUILTIN_SECTIONS = new Set(["preamble", "tools", "rules", "docs", "addendum", "skills", "cwd"]);
const PROJECT_INSTRUCTIONS_BLOCK = /<project_instructions path="([^"]*)">[\s\S]*?<\/project_instructions>/g;
const BUS_CUSTOM_TYPE_PREFIX = "october-bus";

interface Draft {
	kind: ContextSourceKind;
	sourceId?: string;
	label: string;
	role: string;
	attributed: boolean;
	estTokens: number;
	truncated?: { reason: ContextTruncationReason };
	read: () => string;
}

export interface BuildContextSnapshotInput {
	requestId: string;
	createdAt: number;
	modelId?: string;
	/** The messages handed to the extension transforms. */
	baseMessages: readonly AgentMessage[];
	/** The session entry a base message was projected from. */
	entryIdOf: (message: AgentMessage) => string | undefined;
	/** The messages after every transform: what the model receives. */
	finalMessages: readonly AgentMessage[];
	transforms: readonly ContextTransformRecord[];
	/** Omissions the caller already knows about. */
	omitted: readonly ContextOmission[];
}

export interface BuiltContextSnapshot {
	snapshot: ContextSnapshot;
	/** The text of item `index`, read from the request's own messages. */
	readContent: (index: number) => string | undefined;
}

function estimateText(text: string): number {
	return Math.ceil(text.length / 4);
}

function messageText(message: AgentMessage): string {
	const [sent] = convertToLlm([message]);
	if (!sent) return "";
	if (sent.role === "system") return contentText(sent.content);
	if (sent.role === "assistant") {
		return sent.content
			.map((block) =>
				block.type === "text"
					? block.text
					: block.type === "thinking"
						? block.thinking
						: `${block.name}(${JSON.stringify(block.arguments)})`,
			)
			.join("\n");
	}
	if (typeof sent.content === "string") return sent.content;
	return sent.content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
}

function projectContextDrafts(text: string): Draft[] {
	const drafts: Draft[] = [];
	const wrapper = text.replace(PROJECT_INSTRUCTIONS_BLOCK, "");
	drafts.push({
		kind: "instructions",
		sourceId: "section:project_context",
		label: "section:project_context",
		role: "system",
		attributed: true,
		estTokens: estimateText(wrapper),
		read: () => wrapper,
	});
	for (const match of text.matchAll(PROJECT_INSTRUCTIONS_BLOCK)) {
		const [block, path] = match;
		drafts.push({
			kind: "instructions",
			sourceId: path,
			label: path,
			role: "system",
			attributed: true,
			estTokens: estimateText(block),
			read: () => block,
		});
	}
	return drafts;
}

function sectionDrafts(sections: Record<string, string | null>): Draft[] {
	const drafts: Draft[] = [];
	for (const [name, text] of Object.entries(sections)) {
		if (text === null) continue;
		if (name === "project_context") {
			drafts.push(...projectContextDrafts(text));
			continue;
		}
		const builtin = BUILTIN_SECTIONS.has(name);
		drafts.push({
			kind: builtin ? "instructions" : "extension",
			sourceId: `section:${name}`,
			label: `section:${name}`,
			role: "system",
			attributed: builtin,
			estTokens: estimateText(text),
			read: () => text,
		});
	}
	return drafts;
}

function classifyMessage(message: AgentMessage): { kind: ContextSourceKind; sourceId?: string } {
	if (message.role === "custom") {
		const kind = message.customType.startsWith(BUS_CUSTOM_TYPE_PREFIX) ? "bus" : "extension";
		return { kind, sourceId: message.customType };
	}
	if (message.role === "compactionSummary" || message.role === "branchSummary") return { kind: "compaction" };
	return { kind: "conversation" };
}

function groupDrafts(drafts: readonly Draft[]): ContextGroup[] {
	return KIND_ORDER.flatMap((kind) => {
		const members = drafts.filter((draft) => draft.kind === kind);
		if (members.length === 0) return [];
		return [{ kind, itemCount: members.length, estTokens: members.reduce((sum, draft) => sum + draft.estTokens, 0) }];
	});
}

/**
 * Describe the request context. Prompt sections and tools are read from the replayed system
 * state, messages are matched to the session entries they came from, and anything an extension
 * handler added is attributed to that handler. An item whose origin cannot be named is reported
 * as unattributed.
 */
export function buildContextSnapshot(input: BuildContextSnapshotInput): BuiltContextSnapshot {
	const drafts: Draft[] = [];
	const head = getCurrentSystemMessage(input.finalMessages);

	if (head?.sections) drafts.push(...sectionDrafts(head.sections));
	const headText = head ? contentText(head.content) : "";
	if (headText.length > 0) {
		drafts.push({
			kind: "extension",
			sourceId: "system_prompt_text",
			label: "system prompt text",
			role: "system",
			attributed: false,
			estTokens: estimateText(headText),
			read: () => headText,
		});
	}
	for (const tool of getCurrentTools(input.finalMessages)) {
		const text = JSON.stringify(tool);
		drafts.push({
			kind: "tools",
			sourceId: tool.name,
			label: tool.name,
			role: "tool",
			attributed: true,
			estTokens: estimateText(text),
			read: () => text,
		});
	}

	const baseByFingerprint = new Map<string, AgentMessage[]>();
	for (const message of input.baseMessages) {
		if (message.role === "system") continue;
		const fingerprint = fingerprintContextMessage(message);
		const matches = baseByFingerprint.get(fingerprint) ?? [];
		matches.push(message);
		baseByFingerprint.set(fingerprint, matches);
	}
	const addedBy = new Map<string, string[]>();
	for (const transform of input.transforms) {
		for (const fingerprint of transform.added) {
			const paths = addedBy.get(fingerprint) ?? [];
			paths.push(transform.extensionPath);
			addedBy.set(fingerprint, paths);
		}
	}

	const excluded: ContextOmission[] = [];
	for (const message of input.finalMessages) {
		if (message.role === "system") continue;
		const fingerprint = fingerprintContextMessage(message);
		const base = baseByFingerprint.get(fingerprint)?.shift();
		const extensionPath = addedBy.get(fingerprint)?.shift();
		const entryId = base ? input.entryIdOf(base) : undefined;
		if (message.role === "bashExecution" && message.excludeFromContext) {
			excluded.push({
				kind: "conversation",
				reason: "excluded_from_context",
				...(entryId ? { sourceId: entryId } : {}),
				estTokens: estimateTokens(message),
			});
			continue;
		}
		const classified = classifyMessage(message);
		const sourceId = extensionPath !== undefined ? extensionPath : (classified.sourceId ?? entryId);
		drafts.push({
			kind: extensionPath !== undefined ? "extension" : classified.kind,
			...(sourceId !== undefined ? { sourceId } : {}),
			label: message.role === "custom" ? `custom:${message.customType}` : message.role,
			role: message.role,
			attributed: sourceId !== undefined,
			estTokens: estimateTokens(message),
			...(message.role === "bashExecution" && message.truncated
				? { truncated: { reason: "bash_output_truncated" as const } }
				: {}),
			read: () => messageText(message),
		});
	}

	const items = drafts.map(({ read: _read, ...draft }, index): ContextItem => ({ index, ...draft }));
	return {
		snapshot: {
			requestId: input.requestId,
			createdAt: input.createdAt,
			...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
			estimator: "chars/4",
			totalEstTokens: drafts.reduce((sum, draft) => sum + draft.estTokens, 0),
			items,
			groups: groupDrafts(drafts),
			omitted: [...input.omitted, ...excluded],
			transforms: input.transforms.map((transform) => ({
				extensionPath: transform.extensionPath,
				event: transform.event,
				added: transform.added.length,
				removed: transform.removed,
			})),
		},
		readContent: (index) => drafts[index]?.read(),
	};
}

const GROUP_TITLES: Record<ContextSourceKind, string> = {
	instructions: "Instructions",
	tools: "Tools",
	compaction: "Compaction summaries",
	extension: "Extensions",
	bus: "Bus",
	conversation: "Conversation",
};

function formatTokens(tokens: number): string {
	return `~${tokens.toLocaleString("en-US")} tokens`;
}

function pluralize(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatOmission(omission: ContextOmission): string {
	const size = omission.estTokens === undefined ? "" : `, ${formatTokens(omission.estTokens)}`;
	if (omission.count !== undefined) {
		return `${omission.reason}: ${pluralize(omission.count, `${omission.kind} item`)}${size}`;
	}
	return `${omission.reason}: ${omission.sourceId ?? omission.kind} (${omission.kind})${size}`;
}

/** The terminal view. Metadata only: item content is never printed here. */
export function formatContextSnapshot(snapshot: ContextSnapshot): string {
	const lines = [
		`Context for request ${snapshot.requestId} (estimated with ${snapshot.estimator}, ${formatTokens(snapshot.totalEstTokens)} in total)`,
		"Sizes are estimates, not provider token counts. Content is hidden; use /context reveal <index> to show one item.",
		"",
	];
	for (const group of snapshot.groups) {
		lines.push(
			`${GROUP_TITLES[group.kind]} (${pluralize(group.itemCount, "item")}, ${formatTokens(group.estTokens)})`,
		);
		for (const item of snapshot.items.filter((candidate) => candidate.kind === group.kind)) {
			const notes = [
				item.attributed ? "" : "[unattributed]",
				item.truncated ? `[truncated: ${item.truncated.reason}]` : "",
			].filter((note) => note.length > 0);
			const suffix = notes.length > 0 ? `  ${notes.join(" ")}` : "";
			lines.push(`  #${item.index}  ${item.label}  ${formatTokens(item.estTokens)}${suffix}`);
		}
		lines.push("");
	}
	if (snapshot.omitted.length > 0) {
		lines.push(`Omitted (${snapshot.omitted.length})`);
		for (const omission of snapshot.omitted) lines.push(`  ${formatOmission(omission)}`);
		lines.push("");
	}
	if (snapshot.transforms.length > 0) {
		lines.push("Extension changes");
		for (const transform of snapshot.transforms) {
			lines.push(`  ${transform.extensionPath}  ${transform.event}  +${transform.added} -${transform.removed}`);
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}
