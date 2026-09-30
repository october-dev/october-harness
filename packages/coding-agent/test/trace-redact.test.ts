import { type AssistantMessageFrame, reduceAssistantMessageFrames } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { TraceFrame, TraceRecord } from "../src/core/trace/format.ts";
import { OMITTED, REDACTED, TraceRedactor } from "../src/core/trace/redact.ts";

// Regression: october-dev/october-harness#9

function redactor(secrets: string[] = []): TraceRedactor {
	const result = new TraceRedactor();
	for (const secret of secrets) result.addSecret(secret);
	return result;
}

function textOf(message: unknown): string {
	return ((message as { content: Array<{ type: string; text?: string }> }).content ?? [])
		.map((block) => block.text ?? "")
		.join("");
}

describe("trace redaction", () => {
	it("redacts credential-named keys at any depth and case, and string keys holding secrets", () => {
		const value = redactor(["sk-key-123"]).redactValue(
			{
				arguments: {
					nested: { API_KEY: "a", clientSecret: "b", "x-auth-token": "c", password: { deep: "d" } },
					"sk-key-123": "value",
				},
				usage: { totalTokens: 12, input: 3 },
			},
			false,
		);
		expect(value).toEqual({
			arguments: {
				nested: { API_KEY: REDACTED, clientSecret: REDACTED, "x-auth-token": REDACTED, password: REDACTED },
				[REDACTED]: "value",
			},
			usage: { totalTokens: 12, input: 3 },
		});
	});

	it("redacts embedded URL credentials, secret query parameters, and Bearer/Basic values", () => {
		const text = redactor().redactString(
			"see https://user:pass@example.com/path?token=abc&page=2 then Authorization: Bearer abc.def-123 and Basic dXNlcjpwYXNz=",
		);
		expect(text).toBe(
			`see https://${REDACTED}@example.com/path?token=${REDACTED}&page=2 then Authorization: Bearer ${REDACTED} and Basic ${REDACTED}`,
		);
		expect(redactor().redactString("Basic setup is easy")).toBe("Basic setup is easy");
	});

	it("redacts explicitly named credentials of any shape and bare Basic credentials by decoding them", () => {
		const target = redactor();
		expect(target.redactString("Authorization: Bearer abcdefghijklmnop")).toBe(`Authorization: Bearer ${REDACTED}`);
		expect(target.redactString("Authorization: Basic YTpi")).toBe(`Authorization: Basic ${REDACTED}`);
		expect(target.redactString('{"authorization":"Token x"}')).toBe(`{"authorization":"Token ${REDACTED}"}`);
		expect(target.redactString("sent Basic YTpi to the proxy")).toBe(`sent Basic ${REDACTED} to the proxy`);
		// Auth schemes are case-insensitive; the credential, not the scheme, must be removed.
		expect(target.redactString("authorization: bearer abcdefghijklmnop")).toBe(`authorization: bearer ${REDACTED}`);
		expect(target.redactString("Authorization: basic YTpi")).toBe(`Authorization: basic ${REDACTED}`);
		expect(target.redactString("AUTHORIZATION: BeArEr abcdefghijklmnop")).toBe(`AUTHORIZATION: BeArEr ${REDACTED}`);
		expect(target.redactString("then bearer abcdefghijklmnop and BASIC YTpi")).toBe(
			`then bearer ${REDACTED} and BASIC ${REDACTED}`,
		);
		expect(target.redactFragments(["authorization: bea", "rer abcdefgh", "ijklmnop"])).toEqual([
			"authorization: bea",
			`rer ${REDACTED}`,
			REDACTED,
		]);
		expect(target.redactString("export SERVICE_KEY=abc and DB_PASS=x1")).toBe(
			`export SERVICE_KEY=${REDACTED} and DB_PASS=${REDACTED}`,
		);
		expect(target.redactString("Basic setup is easy; the key: use it; tokens: 5")).toBe(
			"Basic setup is easy; the key: use it; tokens: 5",
		);
	});

	it("redacts whole quoted credential values, including spaces, punctuation, and escaped quotes", () => {
		const target = redactor();
		expect(target.redactString('{"password":"correct horse battery staple"}')).toBe(`{"password":"${REDACTED}"}`);
		expect(target.redactString("password = 'it\\'s, a; secret' and more")).toBe(`password = '${REDACTED}' and more`);
		expect(target.redactString('authorization: "Bearer my token here"')).toBe(`authorization: "Bearer ${REDACTED}"`);
		expect(target.redactString('api_key="a,b;c&d" x')).toBe(`api_key="${REDACTED}" x`);
		expect(target.redactString("password=hunter2 rest")).toBe(`password=${REDACTED} rest`);
		expect(target.redactFragments(['password="correct ', 'horse battery staple"'])).toEqual([
			`password="${REDACTED}`,
			`${REDACTED}"`,
		]);
	});

	it("finds a credential assignment inside or after another named field", () => {
		const target = redactor();
		const words = ["correct", "horse", "battery", "staple"];
		const cases: Array<[string, string]> = [
			['log: password="correct horse battery staple"', `log: password="${REDACTED}"`],
			[`note="password='correct horse battery staple'"`, `note="password='${REDACTED}'"`],
			['note="password=\\"correct horse battery staple\\""', `note="password=\\"${REDACTED}\\""`],
			['{"message":"password=\\"correct horse battery staple\\""}', `{"message":"password=\\"${REDACTED}\\""}`],
		];
		for (const [input, expected] of cases) expect(target.redactString(input)).toBe(expected);
		const split = target.redactFragments(['note="password=\\"correct ', 'horse battery staple\\""']);
		expect(split).toEqual([`note="password=\\"${REDACTED}`, `${REDACTED}\\""`]);

		const record = target.redactRecord({
			type: "tool_end",
			seq: 5,
			ts: 1,
			runId: "run",
			requestId: "req",
			toolCallId: "call-x",
			toolName: "print",
			result: { content: [{ type: "text", text: 'log: password="correct horse battery staple"' }], details: {} },
			isError: false,
		} as TraceRecord);
		const updates = target.redactToolUpdates(
			['log: password="correct ', 'horse battery staple"'].map((text) => ({ content: [{ type: "text", text }] })),
		);
		for (const serialized of [JSON.stringify(record), JSON.stringify(updates), JSON.stringify(split)]) {
			for (const word of words) expect(serialized).not.toContain(word);
		}
	});

	it("registers values of credential-named environment variables beyond API keys", () => {
		const target = new TraceRedactor();
		target.addEnv({
			SERVICE_KEY: "unregistered-key-4821",
			SSH_PRIVATE_KEY: "private-material-4821",
			DB_PASSPHRASE: "phrase-4821",
			EDITOR: "vim",
		});
		expect(target.redactString("unregistered-key-4821 private-material-4821 phrase-4821 vim")).toBe(
			`${REDACTED} ${REDACTED} ${REDACTED} vim`,
		);
	});

	it("redacts short SDK secrets and short sensitive environment values, but not numbers or schema literals", () => {
		const target = redactor(["7"]);
		target.addEnv({ SERVICE_PASSWORD: "true", GITHUB_TOKEN: "1", HOME: "/home/user" });
		expect(target.redactString("pin 1 7 true /home/user")).toBe(`pin ${REDACTED} ${REDACTED} ${REDACTED} /home/user`);
		const message = target.redactValue({
			role: "assistant",
			stopReason: "toolUse",
			content: [{ type: "text", text: "got 1 item" }],
			usage: { input: 1, output: 7, totalTokens: 8 },
			timestamp: 17,
		});
		expect(message).toEqual({
			role: "assistant",
			stopReason: "toolUse",
			content: [{ type: "text", text: `got ${REDACTED} item` }],
			usage: { input: 1, output: 7, totalTokens: 8 },
			timestamp: 17,
		});
	});

	it("redacts overlapping and Unicode secrets completely", () => {
		const target = redactor(["abc", "bcd", "clé-secrète🔑"]);
		expect(target.redactString("xabcdx and clé-secrète🔑!")).toBe(`x${REDACTED}x and ${REDACTED}!`);
	});

	it("registers credential-named headers with their scheme-less credential part", () => {
		const target = new TraceRedactor();
		target.addHeaders({ Authorization: "Token zyx987", "x-request-id": "req-1" });
		expect(target.redactString("Token zyx987 and zyx987 and req-1")).toBe(`${REDACTED} and ${REDACTED} and req-1`);
	});

	it("omits images and signatures with typed markers", () => {
		const value = redactor().redactValue({
			role: "user",
			content: [
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				{ type: "text", text: "hi", textSignature: "sig" },
				{ type: "thinking", thinking: "encrypted", redacted: true, thinkingSignature: "sig" },
				{ type: "toolCall", id: "t1", name: "read", arguments: {}, thoughtSignature: "sig" },
			],
		});
		expect(value).toEqual({
			role: "user",
			content: [
				{ type: "image", omitted: true, mimeType: "image/png", bytes: 5 },
				{ type: "text", text: "hi", textSignature: OMITTED },
				{ type: "thinking", thinking: OMITTED, redacted: true, thinkingSignature: OMITTED },
				{ type: "toolCall", id: "call-1", name: "read", arguments: {}, thoughtSignature: OMITTED },
			],
		});
	});

	it("replaces session and tool call IDs with pseudonyms fixed at first appearance", () => {
		const target = redactor();
		const first = target.redactRecord({
			type: "tool_start",
			seq: 4,
			ts: 1,
			runId: "run",
			requestId: "req",
			toolCallId: "call-4821",
			toolName: "echo",
			args: {},
		} as TraceRecord);
		const session = target.redactRecord({
			type: "session_attach",
			seq: 1,
			ts: 1,
			sessionId: "session-4821",
		} as TraceRecord);
		// Regression: a secret learned after the first appearance must not change the written form.
		target.addSecret("4821");
		const later = target.redactValue({ type: "toolCall", id: "call-4821", name: "echo", arguments: {} });
		const laterSession = target.redactRecord({
			type: "session_detach",
			seq: 9,
			ts: 2,
			sessionId: "session-4821",
			openOperations: 0,
		} as TraceRecord);
		expect(first).toMatchObject({ seq: 4, runId: "run", requestId: "req", toolCallId: "call-1", toolName: "echo" });
		expect(later).toMatchObject({ id: "call-1", name: "echo" });
		expect(session.sessionId).toBe("session-1");
		expect(laterSession.sessionId).toBe("session-1");
		// Distinct IDs never share a pseudonym, even an original that looks like one.
		expect(target.pseudonym("call", "call-1")).toBe("call-2");
		expect(target.pseudonym("call", "other")).toBe("call-3");
		expect(target.pseudonym("call", "call-4821")).toBe("call-1");
	});

	it("sanitizes a secret split across text start, deltas, and end consistently with the reducer", () => {
		const secret = "sk-ABCDEF";
		const frames: TraceFrame[] = [
			{ type: "start", partial: { role: "assistant", content: [], stopReason: "pending" } },
			{ type: "text_start", contentIndex: 0, content: { type: "text", text: "key sk-A" } },
			{ type: "text_delta", contentIndex: 0, delta: "BC" },
			{ type: "text_delta", contentIndex: 0, delta: "DEF done" },
			{ type: "text_end", contentIndex: 0, content: "key sk-ABCDEF done" },
		];
		const redacted = redactor([secret]).redactFrames(frames);
		const serialized = JSON.stringify(redacted);
		expect(serialized).not.toContain("sk-A");
		expect(serialized).not.toContain("BC");
		expect(serialized).not.toContain("DEF");
		const reduced = reduceAssistantMessageFrames(redacted as unknown as AssistantMessageFrame[]);
		expect(textOf(reduced)).toBe(`key ${REDACTED} done`);
		const prefix = reduceAssistantMessageFrames(redacted.slice(0, 4) as unknown as AssistantMessageFrame[]);
		expect(textOf(prefix)).toBe(`key ${REDACTED}${REDACTED}${REDACTED} done`);
	});

	it("removes a streamed secret that disappears from the final text", () => {
		const frames: TraceFrame[] = [
			{ type: "start", partial: { role: "assistant", content: [], stopReason: "pending" } },
			{ type: "text_start", contentIndex: 0, content: { type: "text", text: "" } },
			{ type: "text_delta", contentIndex: 0, delta: "oops sk-GONE" },
			{ type: "text_end", contentIndex: 0, content: "corrected" },
		];
		const redacted = redactor(["sk-GONE"]).redactFrames(frames);
		expect(JSON.stringify(redacted)).not.toContain("sk-GONE");
		expect(textOf(reduceAssistantMessageFrames(redacted as unknown as AssistantMessageFrame[]))).toBe("corrected");
	});

	it("coalesces tool-call JSON fragments that carry a secret into valid redacted JSON", () => {
		const frames: TraceFrame[] = [
			{ type: "start", partial: { role: "assistant", content: [], stopReason: "pending" } },
			{
				type: "toolcall_start",
				contentIndex: 0,
				toolCall: { type: "toolCall", id: "t1", name: "run", arguments: {} },
			},
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"cmd":"curl -H sk-' },
			{ type: "toolcall_delta", contentIndex: 0, delta: 'XYZ9","count":1}' },
			{
				type: "toolcall_end",
				contentIndex: 0,
				id: "t1",
				name: "run",
				arguments: { cmd: "curl -H sk-XYZ9", count: 1 },
			},
		];
		const redacted = redactor(["sk-XYZ9", "1"]).redactFrames(frames);
		const serialized = JSON.stringify(redacted);
		expect(serialized).not.toContain("sk-");
		expect(serialized).not.toContain("XYZ9");
		expect(redacted[2]).toMatchObject({ delta: `{"cmd":"curl -H ${REDACTED}","count":1}`, coalesced: true });
		expect(redacted[3]).toMatchObject({ delta: "", coalesced: true });
		const reduced = reduceAssistantMessageFrames(redacted as unknown as AssistantMessageFrame[]);
		expect(reduced?.content[0]).toMatchObject({ arguments: { cmd: `curl -H ${REDACTED}`, count: 1 } });

		const unaffected = redactor(["other"]).redactFrames(frames);
		expect(unaffected[2]).toEqual(frames[2]);
	});

	it("redacts a secret spanning two tool updates in both updates", () => {
		const updates = [
			{ content: [{ type: "text", text: "token=ab" }], details: {} },
			{ content: [{ type: "text", text: "cd9 rest" }], details: { n: 1 } },
		];
		const redacted = redactor(["abcd9"]).redactToolUpdates(updates);
		expect(redacted).toEqual([
			{ content: [{ type: "text", text: `token=${REDACTED}` }], details: {} },
			{ content: [{ type: "text", text: `${REDACTED} rest` }], details: { n: 1 } },
		]);
	});
});
