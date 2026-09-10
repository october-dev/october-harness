/** Bound memory before buffering a local service's response, including chunked bodies. */
export async function readBusResponse(
	response: Response,
	maxBytes: number,
	complete?: (body: string) => boolean,
): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let body = "";
	const streaming = response.headers.get("content-type")?.includes("text/event-stream");
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) return body + decoder.decode();
			body += decoder.decode(chunk.value, { stream: true });
			if (streaming) {
				// Complete SSE comment lines are liveness, not response data. Discard them so an
				// indefinitely pending human question cannot exhaust the response memory bound.
				body = body.replace(/^:[^\n]*\n/gm, "");
				if (!body.trim()) body = "";
				bytes = Buffer.byteLength(body);
			} else bytes += chunk.value.byteLength;
			if (bytes > maxBytes) throw new Error(`October bus response exceeds ${maxBytes} bytes`);
			if (complete?.(body)) return body;
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
