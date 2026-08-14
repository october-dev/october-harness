import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "../../../core/extensions/types.ts";
import type { OctoberBusEnv } from "./env.ts";
import { octoberBusUrl } from "./env.ts";

const FIRE_TIMEOUT_MS = 3_000;
const PRE_PROMPT_TIMEOUT_MS = 5_000;
const SUMMARY_LIMIT = 2000;

interface HookSessionPayload {
	event: "start" | "end";
	sessionId: string;
	sessionFile: string | undefined;
	cwd: string;
	reason: string;
}

interface HookStopPayload {
	sessionId: string;
	summary: string;
	willRetry: boolean;
}

function sessionFields(ctx: ExtensionContext): Pick<HookSessionPayload, "sessionId" | "sessionFile" | "cwd"> {
	return {
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile: ctx.sessionManager.getSessionFile(),
		cwd: ctx.cwd,
	};
}

function assistantText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	const parts = Array.isArray(message.content) ? message.content : [];
	return parts
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

function lastAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") return message as AssistantMessage;
	}
	return undefined;
}

async function postHook(env: OctoberBusEnv, route: string, body: unknown, timeoutMs: number): Promise<unknown> {
	try {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (env.token) {
			headers["X-October-Bus-Token"] = env.token;
		}
		const response = await fetch(octoberBusUrl(env, route), {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await response.text();
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

function fireAndForget(env: OctoberBusEnv, route: string, body: unknown): void {
	void postHook(env, route, body, FIRE_TIMEOUT_MS);
}

export function registerOctoberHooks(pi: ExtensionAPI, env: OctoberBusEnv): void {
	pi.on("session_start", (event, ctx) => {
		fireAndForget(env, "/hook/session", {
			event: "start",
			...sessionFields(ctx),
			reason: event.reason,
		} satisfies HookSessionPayload);
	});

	pi.on("session_shutdown", (event, ctx) => {
		fireAndForget(env, "/hook/session", {
			event: "end",
			...sessionFields(ctx),
			reason: event.reason,
		} satisfies HookSessionPayload);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const response = await postHook(
			env,
			"/hook/pre-prompt",
			{ sessionId: ctx.sessionManager.getSessionId(), prompt: event.prompt },
			PRE_PROMPT_TIMEOUT_MS,
		);
		if (!response || typeof response !== "object") return;
		const inject = (response as { inject?: unknown }).inject;
		if (typeof inject !== "string" || inject.trim().length === 0) return;
		return {
			message: {
				customType: "october-bus",
				content: [{ type: "text", text: inject }],
				display: false,
			},
		};
	});

	pi.on("agent_end", (event, ctx) => {
		const assistant = lastAssistant(event.messages);
		const summary = assistant ? assistantText(assistant).slice(0, SUMMARY_LIMIT) : "";
		// Extension agent_end does not include willRetry; approximate from the last assistant error.
		const willRetry = assistant ? isRetryableAssistantError(assistant) : false;
		fireAndForget(env, "/hook/stop", {
			sessionId: ctx.sessionManager.getSessionId(),
			summary,
			willRetry,
		} satisfies HookStopPayload);
	});
}
