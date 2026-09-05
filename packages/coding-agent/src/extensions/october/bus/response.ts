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
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) return body + decoder.decode();
			bytes += chunk.value.byteLength;
			if (bytes > maxBytes) throw new Error(`October bus response exceeds ${maxBytes} bytes`);
			body += decoder.decode(chunk.value, { stream: true });
			if (complete?.(body)) return body;
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
