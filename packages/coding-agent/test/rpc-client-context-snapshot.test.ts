import { describe, expect, it, vi } from "vitest";
import type { ContextSnapshot } from "../src/index.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type RpcClientPrivate = {
	send: (command: { type: string }) => Promise<unknown>;
	getData: <T>(response: unknown) => T;
};

describe("RpcClient getContextSnapshot", () => {
	it("sends get_context_snapshot with the request id and content flag, and returns the snapshot or null", async () => {
		const client = new RpcClient();
		const snapshot: ContextSnapshot = {
			requestId: "2",
			createdAt: 0,
			estimator: "chars/4",
			totalEstTokens: 10,
			items: [
				{
					index: 0,
					kind: "conversation",
					label: "user",
					role: "user",
					attributed: true,
					estTokens: 10,
				},
			],
			groups: [{ kind: "conversation", itemCount: 1, estTokens: 10 }],
			omitted: [],
			transforms: [],
		};
		const privateClient = client as unknown as RpcClientPrivate;
		let responseData: ContextSnapshot | null = snapshot;
		const send = vi.fn(async () => ({
			type: "response",
			command: "get_context_snapshot",
			success: true,
			data: responseData,
		}));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => (response as { data: T }).data;

		await expect(client.getContextSnapshot({ requestId: "2", includeContent: true })).resolves.toEqual(snapshot);
		responseData = null;
		await expect(client.getContextSnapshot()).resolves.toBeNull();
		expect(send).toHaveBeenNthCalledWith(1, { type: "get_context_snapshot", requestId: "2", includeContent: true });
		expect(send).toHaveBeenNthCalledWith(2, {
			type: "get_context_snapshot",
			requestId: undefined,
			includeContent: undefined,
		});
	});
});
