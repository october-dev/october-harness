import type { OctoberDesktopBusEnv } from "./env.ts";
import { octoberBusUrl } from "./env.ts";
import { readBusResponse } from "./response.ts";

/** Core owns automatic-delivery policy and the existing inbox receipt. This consumer only offers
 * a batch to the actual active native session and reports its exact message-start handoff. */
export function createNativeInbox(
	env: OctoberDesktopBusEnv,
	session: () => string,
	canReceive: () => boolean,
	deliver: (text: string, receipt: string) => void,
) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = true;
	let polling = false;
	let pending: { key: string; receipt: string; accepted: boolean } | undefined;
	let controller: AbortController | undefined;
	const request = async (route: string, receipt?: string): Promise<Record<string, unknown>> => {
		controller = new AbortController();
		const timeout = setTimeout(() => controller?.abort(), 5_000);
		timeout.unref();
		try {
			const response = await fetch(octoberBusUrl(env, route), {
				method: "POST",
				redirect: "error",
				signal: controller.signal,
				headers: {
					"Content-Type": "application/json",
					"X-October-Bus-Token": env.token ?? "",
					"X-October-MCP-Capability": env.capability ?? "",
				},
				body: JSON.stringify({
					canvas: env.canvas,
					node: env.node,
					launch: env.launch,
					...(receipt ? { receipt } : {}),
				}),
			});
			if (!response.ok) throw new Error("October native inbox unavailable");
			const result: unknown = JSON.parse(await readBusResponse(response, 2 * 1024 * 1024));
			if (!result || typeof result !== "object" || Array.isArray(result))
				throw new Error("Invalid October inbox response");
			return result as Record<string, unknown>;
		} finally {
			clearTimeout(timeout);
			controller = undefined;
		}
	};
	const poll = async () => {
		if (stopped || polling) return;
		polling = true;
		try {
			if (pending) {
				if (!pending.accepted) return;
				// ACK is idempotent. An uncertain response never causes another read/native message.
				await request("/hook/inbox-ack", pending.receipt);
				pending = undefined;
			}
			const key = session();
			if (!key || !canReceive()) return;
			const batch = await request("/hook/wake");
			if (
				typeof batch.receipt !== "string" ||
				!batch.receipt ||
				batch.receipt.length > 256 ||
				typeof batch.text !== "string" ||
				!batch.text.trim()
			)
				return;
			if (stopped || session() !== key || !canReceive()) {
				// Positive refusal before invoking the provider, never a timeout recovery.
				await request("/hook/inbox-decline", batch.receipt);
				return;
			}
			pending = { key, receipt: batch.receipt, accepted: false };
			deliver(batch.text, batch.receipt);
		} catch {
			// A missing handoff is uncertain. Do not replay the native message or original inbox read.
		} finally {
			polling = false;
			if (!stopped) {
				timer = setTimeout(poll, 2_000);
				timer.unref();
			}
		}
	};
	return {
		start() {
			if (!stopped || !env.launch || !env.token || !env.capability) return;
			stopped = false;
			void poll();
		},
		stop() {
			stopped = true;
			clearTimeout(timer);
			timer = undefined;
			controller?.abort();
		},
		accepted(receipt: unknown, key: string) {
			if (pending && pending.receipt === receipt && pending.key === key) pending.accepted = true;
		},
	};
}
