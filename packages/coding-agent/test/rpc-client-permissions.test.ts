import { describe, expect, it, vi } from "vitest";
import type { OctoberPermissionExplanation } from "../src/index.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type RpcClientPrivate = {
	send: (command: { type: string }) => Promise<unknown>;
	getData: <T>(response: unknown) => T;
};

describe("RpcClient getPermissions", () => {
	// Regression test for #48.
	it("sends get_permissions and returns the public explanation or null", async () => {
		const client = new RpcClient();
		const info: OctoberPermissionExplanation = {
			locked: true,
			selected: { mode: "accept-edits", source: "environment" },
			project: { trusted: false, setting: null, tightened: false },
			delegationCeiling: null,
			effectiveMode: "accept-edits",
			interactive: true,
			tools: {
				read: {
					outcome: "allow",
					reason: "allowed by permission mode accept-edits (from OCTOBER_PERMISSION_MODE)",
				},
				edit: {
					outcome: "allow",
					reason: "allowed by permission mode accept-edits (from OCTOBER_PERMISSION_MODE)",
				},
				command: {
					outcome: "ask",
					reason: "permission mode accept-edits (from OCTOBER_PERMISSION_MODE) asks before command tools",
				},
			},
		};
		const privateClient = client as unknown as RpcClientPrivate;
		let responseData: OctoberPermissionExplanation | null = info;
		const send = vi.fn(async () => ({
			type: "response",
			command: "get_permissions",
			success: true,
			data: responseData,
		}));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => (response as { data: T }).data;

		await expect(client.getPermissions()).resolves.toEqual(info);
		responseData = null;
		await expect(client.getPermissions()).resolves.toBeNull();
		expect(send).toHaveBeenNthCalledWith(1, { type: "get_permissions" });
		expect(send).toHaveBeenNthCalledWith(2, { type: "get_permissions" });
	});
});
