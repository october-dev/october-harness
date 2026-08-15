import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "../../../core/extensions/types.ts";
import type { OctoberBusEnv } from "./env.ts";
import { octoberBusUrl } from "./env.ts";

const FIRE_TIMEOUT_MS = 3_000;
const PRE_PROMPT_TIMEOUT_MS = 5_000;
const EXCERPT_USER_LIMIT = 6_000;
const EXCERPT_ASSISTANT_LIMIT = 12_000;
const INJECT_LIMIT = 100_000;
const AGENT = "october";

function hookHeaders(env: OctoberBusEnv): Record<string, string> {
	const headers: Record<string, string> = {};
	if (env.token) headers["X-October-Bus-Token"] = env.token;
	return headers;
}

function identity(env: OctoberBusEnv): { canvas: string; node: string; launch?: string; agent: string } {
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

function turnExcerpt(
	messages: AgentMessage[],
	ctx: ExtensionContext,
): { cwd: string; userPrompt: string; assistantText: string } {
	let userPrompt = "";
	let assistantText = "";
	for (const message of messages) {
		if (!message || !("role" in message)) continue;
		const text = textOf("content" in message ? message.content : undefined);
		if (!text.trim()) continue;
		if (message.role === "user") {
			userPrompt = text;
			assistantText = "";
		} else if (message.role === "assistant") {
			assistantText += assistantText ? `\n${text}` : text;
		}
	}
	return {
		cwd: ctx.cwd,
		userPrompt: userPrompt.slice(0, EXCERPT_USER_LIMIT),
		assistantText: assistantText.slice(0, EXCERPT_ASSISTANT_LIMIT),
	};
}

async function postJson(env: OctoberBusEnv, route: string, body: unknown): Promise<unknown> {
	try {
		const response = await fetch(octoberBusUrl(env, route), {
			method: "POST",
			headers: { "Content-Type": "application/json", ...hookHeaders(env) },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(FIRE_TIMEOUT_MS),
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
	void postJson(env, route, body);
}

/** GET /hook/pre-prompt — desktop records turn-start and returns orientation + unread peers as text. */
async function pullPrePrompt(env: OctoberBusEnv): Promise<string> {
	try {
		const response = await fetch(
			octoberBusUrl(env, "/hook/pre-prompt", {
				canvas: env.canvas,
				node: env.node,
				launch: env.launch,
				agent: AGENT,
			}),
			{
				headers: hookHeaders(env),
				signal: AbortSignal.timeout(PRE_PROMPT_TIMEOUT_MS),
			},
		);
		if (!response.ok) return "";
		return (await response.text()).trim();
	} catch {
		return "";
	}
}

export function registerOctoberHooks(pi: ExtensionAPI, env: OctoberBusEnv): void {
	pi.on("session_start", (_event, ctx) => {
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
		fireAndForget(env, "/hook/session", {
			...identity(env),
			status: "live",
			session,
			file,
			cwd,
		});
	});

	pi.on("session_shutdown", () => {
		fireAndForget(env, "/hook/session", {
			...identity(env),
			status: "offline",
		});
	});

	pi.on("before_agent_start", async () => {
		const inject = await pullPrePrompt(env);
		if (!inject) return;
		return {
			message: {
				customType: "october-bus",
				content: [{ type: "text", text: inject.slice(0, INJECT_LIMIT) }],
				display: false,
			},
		};
	});

	pi.on("agent_end", (event, ctx) => {
		// Always post stop: desktop records turn-end from this hook even when the excerpt is empty.
		const excerpt = turnExcerpt(Array.isArray(event.messages) ? event.messages : [], ctx);
		fireAndForget(env, "/hook/stop", {
			...identity(env),
			excerpt,
		});
	});
}
