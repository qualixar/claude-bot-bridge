import { describe, it, expect } from "vitest";
import http from "node:http";
import { readCapped, TooLargeError } from "../src/net.js";

/** A Response whose body is an endless stream of 1 KiB chunks; `state` records how far the reader got and whether it hung up. */
function endless(state, headers = {}) {
  const body = new ReadableStream({
    pull(controller) { state.pulled += 1; controller.enqueue(new Uint8Array(1024)); },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return new Response(body, { headers });
}

describe("readCapped", () => {
  it("returns the whole body when it is within the cap", async () => {
    const buf = await readCapped(new Response("hello"), 5);
    expect(buf.toString()).toBe("hello");
  });
  it("stops reading and cancels the stream as soon as the cap is passed (it never buffers the whole body)", async () => {
    const state = { pulled: 0, cancelled: false };
    await expect(readCapped(endless(state), 4096)).rejects.toBeInstanceOf(TooLargeError);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThanOrEqual(6);   // 4 KiB cap, 1 KiB chunks: a handful of reads, not the endless stream
  });
  it("refuses before reading a byte when Content-Length already exceeds the cap", async () => {
    const state = { pulled: 0, cancelled: false };
    await expect(readCapped(endless(state, { "content-length": "999999" }), 4096)).rejects.toBeInstanceOf(TooLargeError);
    expect(state.pulled).toBe(0);
  });
  it("a lying Content-Length does not raise the cap", async () => {
    const state = { pulled: 0, cancelled: false };
    await expect(readCapped(endless(state, { "content-length": "10" }), 4096)).rejects.toBeInstanceOf(TooLargeError);
  });
  it("works on a response object without a stream (a test double)", async () => {
    const fake = { headers: new Headers(), arrayBuffer: async () => new Uint8Array(10).buffer };
    expect((await readCapped(fake, 10)).length).toBe(10);
    await expect(readCapped(fake, 9)).rejects.toBeInstanceOf(TooLargeError);
  });
  it("over real HTTP: the connection is dropped while the server is still sending", async () => {
    let sent = 0, closed = false;
    const server = http.createServer((req, res) => {
      res.on("close", () => { closed = true; });
      const timer = setInterval(() => { sent += 16384; res.write(Buffer.alloc(16384)); }, 2);
      res.on("close", () => clearInterval(timer));
    });
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
      await expect(readCapped(res, 64 * 1024)).rejects.toBeInstanceOf(TooLargeError);
      await new Promise((ok) => setTimeout(ok, 200));
      expect(closed).toBe(true);
      expect(sent).toBeLessThan(8 * 1024 * 1024);
    } finally { server.closeAllConnections?.(); await new Promise((ok) => server.close(ok)); }
  });
});
