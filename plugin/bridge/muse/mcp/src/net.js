// Bounded downloads: the size cap is enforced while the body streams in, so an endless or oversized response is dropped
// after `maxBytes` instead of being buffered first and judged afterwards.

export class TooLargeError extends Error {
  constructor(maxBytes) { super(`larger than ${maxBytes} bytes`); this.name = "TooLargeError"; this.maxBytes = maxBytes; }
}

/** The body of `res` as a Buffer, at most `maxBytes` long. Throws TooLargeError (and cancels the stream) past that. */
export async function readCapped(res, maxBytes) {
  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel?.().catch(() => {});
    throw new TooLargeError(maxBytes);
  }
  if (typeof res.body?.getReader !== "function") {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new TooLargeError(maxBytes);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new TooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
