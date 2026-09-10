import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "../../../core/extensions/types.ts";
import type { OctoberDesktopBusEnv } from "./env.ts";
import { octoberBusUrl } from "./env.ts";
import { createNativeInbox } from "./native-inbox.ts";
import { readBusResponse } from "./response.ts";

const FIRE_TIMEOUT_MS = 3_000;
const PRE_PROMPT_TIMEOUT_MS = 5_000;
const EXCERPT_USER_LIMIT = 6_000;
const EXCERPT_ASSISTANT_LIMIT = 12_000;
const INJECT_LIMIT = 100_000;
const AGENT = "october";

function hookHeaders(env: OctoberDesktopBusEnv): Record<string, string> {
	const headers: Record<string, string> = {};
	if (env.token) headers["X-October-Bus-Token"] = env.token;
	if (env.capability) headers["X-October-MCP-Capability"] = env.capability;
	return headers;
}

function identity(env: OctoberDesktopBusEnv): { canvas: string; node: string; launch?: string; agent: string } {
	return {
		canvas: env.canvas,
		node: env.node,
		...(env.launch ? { launch: env.launch } : {}),
		agent: AGENT,
	};
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				!!part && part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

function turnResult(messages: AgentMessage[], ctx: ExtensionContext) {
	let userPrompt = "";
	let final: Extract<AgentMessage, { role: "assistant" }> | undefined;
	for (const message of messages) {
		if (message.role === "user") {
			userPrompt = textOf(message.content);
			final = undefined;
		} else if (message.role === "assistant") {
			final = message;
		}
	}
	return {
		outcome:
			final?.stopReason === "stop"
				? "completed"
				: final?.stopReason === "aborted"
					? "cancelled"
					: final?.stopReason === "error"
						? "failed"
						: "unknown",
		excerpt: final
			? {
					cwd: ctx.cwd,
					userPrompt: userPrompt.slice(0, EXCERPT_USER_LIMIT),
					assistantText: textOf(final.content).slice(0, EXCERPT_ASSISTANT_LIMIT),
				}
			: null,
	};
}

async function postJson(env: OctoberDesktopBusEnv, route: string, body: unknown): Promise<unknown> {
	try {
		const response = await fetch(octoberBusUrl(env, route), {
			method: "POST",
			headers: { "Content-Type": "application/json", ...hookHeaders(env) },
			body: JSON.stringify(body),
			redirect: "error",
			signal: AbortSignal.timeout(FIRE_TIMEOUT_MS),
		});
		const text = await readBusResponse(response, INJECT_LIMIT * 4);
		if (!response.ok || text.trim().length === 0) return undefined;
		try {
			return JSON.parse(text) as unknown;
		} catch {
			return undefined;
		}
	} catch {
		return undefined;
	}
}

/** GET /hook/pre-prompt — desktop records turn-start and returns orientation + unread peers as text. */
async function pullPrePrompt(env: OctoberDesktopBusEnv, providerTurnId: string) {
	try {
		const response = await fetch(
			octoberBusUrl(env, "/hook/pre-prompt", {
				canvas: env.canvas,
				node: env.node,
				launch: env.launch,
				agent: AGENT,
				providerTurnId,
			}),
			{
				headers: hookHeaders(env),
				redirect: "error",
				signal: AbortSignal.timeout(PRE_PROMPT_TIMEOUT_MS),
			},
		);
		if (!response.ok) return undefined;
		const text = (await readBusResponse(response, INJECT_LIMIT * 4)).trim();
		// Do not acknowledge a truncated batch that the model will never receive in full.
		if (text.length > INJECT_LIMIT) return undefined;
		return { text, receipt: response.headers.get("x-october-inbox-receipt") };
	} catch {
		return undefined;
	}
}

export function registerOctoberHooks(pi: ExtensionAPI, env: OctoberDesktopBusEnv): void {
	let providerTurnId: string | undefined;
	let nativeContext: ExtensionContext | undefined;
	let uiPrompt = false;
	let pendingContext: { receipt: string; turn: string; session: string } | undefined;
	let completion: (ReturnType<typeof turnResult> & { providerTurnId: string }) | undefined;
	const inbox = createNativeInbox(
		env,
		() => nativeContext?.sessionManager.getSessionId() ?? "",
		() =>
			nativeContext?.mode === "tui" &&
			nativeContext.hasUI &&
			nativeContext.isIdle() &&
			!nativeContext.hasPendingMessages() &&
			!uiPrompt,
		(text, receipt) =>
			pi.sendMessage(
				{ customType: "october-bus-wake", content: text, display: true, details: { receipt } },
				{ triggerTurn: true, deliverAs: "followUp" },
			),
	);
	pi.on("ui_prompt_start", () => {
		uiPrompt = true;
	});
	pi.on("ui_prompt_end", () => {
		uiPrompt = false;
	});
	pi.on("message_start", async (event, ctx) => {
		if (event.message.role === "custom" && event.message.customType === "october-bus-wake") {
			const details: unknown = event.message.details;
			if (details && typeof details === "object" && "receipt" in details)
				inbox.accepted(details.receipt, ctx.sessionManager.getSessionId());
		}
		if (event.message.role !== "custom" || event.message.customType !== "october-bus" || !pendingContext) return;
		const details: unknown = event.message.details;
		if (
			!details ||
			typeof details !== "object" ||
			!("receipt" in details) ||
			!("providerTurnId" in details) ||
			details.receipt !== pendingContext.receipt ||
			details.providerTurnId !== pendingContext.turn ||
			ctx.sessionManager.getSessionId() !== pendingContext.session
		)
			return;
		const receipt = pendingContext.receipt;
		pendingContext = undefined;
		await ordered(() => postJson(env, "/hook/inbox-ack", { ...identity(env), receipt }));
	});
	// A new prompt may start while an earlier settled handler is publishing. Preserve native
	// event order across the HTTP boundary so an old stop cannot overtake a new start.
	let publication = Promise.resolve();
	const ordered = <T>(action: () => Promise<T>): Promise<T> => {
		const next = publication.then(action);
		publication = next.then(
			() => {},
			() => {},
		);
		return next;
	};
	const session = async (_event: unknown, ctx: ExtensionContext) => {
		nativeContext = ctx;
		uiPrompt = false;
		providerTurnId = undefined;
		pendingContext = undefined;
		completion = undefined;
		let session = "";
		let file: string | undefined;
		let cwd = "";
		try {
			session = ctx.sessionManager.getSessionId() || "";
			file = ctx.sessionManager.getSessionFile();
			cwd = ctx.cwd;
		} catch {
			/* presence still reports */
		}
		await ordered(() =>
			postJson(env, "/hook/session", {
				...identity(env),
				status: "live",
				session,
				file,
				cwd,
			}),
		);
		if (ctx.mode === "tui") inbox.start();
		else inbox.stop();
	};
	pi.on("session_start", session);

	pi.on("session_shutdown", async () => {
		inbox.stop();
		nativeContext = undefined;
		providerTurnId = undefined;
		pendingContext = undefined;
		completion = undefined;
		await ordered(() =>
			postJson(env, "/hook/session", {
				...identity(env),
				status: "offline",
			}),
		);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const turn = randomUUID();
		providerTurnId = turn;
		pendingContext = undefined;
		completion = undefined;
		const pulled = await ordered(() => pullPrePrompt(env, turn));
		if (!pulled?.text || providerTurnId !== turn) return;
		if (pulled.receipt)
			pendingContext = { receipt: pulled.receipt, turn, session: ctx.sessionManager.getSessionId() };
		// Preparing an extension result is not handoff: subsequent preparation can still fail.
		// The matching native message_start acknowledges this receipt after the agent accepts it.
		return {
			message: {
				customType: "october-bus",
				content: pulled.text,
				display: false,
				...(pulled.receipt ? { details: { receipt: pulled.receipt, providerTurnId: turn } } : {}),
			},
		};
	});

	pi.on("agent_start", async () => {
		completion = undefined;
		// Native custom messages bypass before_agent_start. This event proves that the provider
		// actually began work; preserve the same turn identity across its automatic retries.
		providerTurnId ??= randomUUID();
		const turn = providerTurnId;
		await ordered(() =>
			postJson(env, "/hook/notify", {
				...identity(env),
				needsInput: false,
				notificationType: "working",
				turnBoundary: true,
				providerTurnId: turn,
			}),
		);
	});
	pi.on("agent_end", (event, ctx) => {
		if (providerTurnId) completion = { ...turnResult(event.messages, ctx), providerTurnId };
	});
	pi.on("agent_settled", async () => {
		if (!providerTurnId) return;
		const result = completion ?? { providerTurnId, outcome: "unknown", excerpt: null };
		providerTurnId = undefined;
		completion = undefined;
		await ordered(() => postJson(env, "/hook/stop", { ...identity(env), ...result }));
	});
}
