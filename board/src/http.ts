export const plain = (status: number, headers: Record<string, string> = {}): Response =>
  new Response(null, { status, headers });

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

export const rpcInternalError = (): Response =>
  json(500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });

/**
 * Reads a request body but stops as soon as it exceeds `maxBytes`, so a chunked body with no
 * content-length is capped too. Returns null when the cap was exceeded.
 */
export async function readCapped(req: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
