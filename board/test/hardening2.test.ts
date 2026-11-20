// Findings from the independent review: limiter order, body caps, origin check, healthz/version, streams.
import { describe, expect, it, vi } from "vitest";
import { OWNER, VIEWER, WORKER, appWith, db } from "#harness";
import type { App } from "../src/app";
import { AUTH_FAIL_LIMIT } from "../src/guard";
import { WORKERS_STREAM } from "../src/web/routes";

const B = "https://board.test";
const mcpReq = (token: string, body = "{}", extra: RequestInit = {}) =>
  new Request(`${B}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" }, body, ...extra });
const formReq = (path: string, key: string, headers: Record<string, string> = {}) =>
  new Request(B + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams({ key }).toString() });

/** A request body delivered as a stream with no content-length, like a chunked upload. */
function chunked(url: string, headers: Record<string, string>, bytes: number): Request {
  const chunk = new TextEncoder().encode("x".repeat(1024));
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= bytes) return c.close();
      c.enqueue(chunk);
      sent += chunk.length;
    },
  });
  return new Request(url, { method: "POST", headers, body, duplex: "half" } as RequestInit);
}

describe("M2: valid keys always pass; only failures are limited", () => {
  it("lets owner, worker and viewer through after 25 failures from the same shared address", async () => {
    const app = appWith();
    const ip = "203.0.113.50";
    for (let i = 0; i < AUTH_FAIL_LIMIT + 5; i++) await app.fetch(mcpReq(`bad-${i}-0123456789abcdefgh`), { ip });
    expect((await app.fetch(mcpReq("bad-more-0123456789abcdefgh"), { ip })).status).toBe(429);
    for (const token of [OWNER, WORKER]) expect((await app.fetch(mcpReq(token, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })), { ip })).status).toBe(200);
    expect((await app.fetch(new Request(`${B}/board/api/tasks`, { headers: { authorization: `Bearer ${VIEWER}` } }), { ip })).status).toBe(200);
    expect((await app.fetch(formReq("/board/login", VIEWER), { ip })).status).toBe(303);
    expect((await app.fetch(formReq("/board/login", "nope"), { ip })).status).toBe(429);
  });
});

describe("M3a: the failed-auth limiter is pluggable", () => {
  it("uses an injected limiter (the Workers rate-limit binding) and writes nothing to the database", async () => {
    const seen: string[] = [];
    let over = false;
    const app = appWith({}, { failureLimiter: async (key) => (seen.push(key), over) });
    expect((await app.fetch(mcpReq("bad-0123456789abcdefgh"), { ip: "198.51.100.1" })).status).toBe(401);
    over = true;
    expect((await app.fetch(mcpReq("bad-0123456789abcdefgh"), { ip: "198.51.100.1" })).status).toBe(429);
    expect((await app.fetch(mcpReq(OWNER, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })), { ip: "198.51.100.1" })).status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/^authfail:[0-9a-f]{16}$/);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE scope LIKE 'authfail:%'").first<{ n: number }>())!.n).toBe(0);
  });
});

describe("L1: body size is capped while reading, not by content-length", () => {
  it("rejects a chunked MCP body over 128 KB with 413", async () => {
    const app = appWith();
    const res = await app.fetch(chunked(`${B}/mcp`, { authorization: `Bearer ${OWNER}`, "content-type": "application/json", accept: "application/json" }, 300 * 1024));
    expect(res.status).toBe(413);
  });

  it("rejects a chunked login body over 4 KB without reading it all", async () => {
    const app = appWith();
    const res = await app.fetch(chunked(`${B}/board/login`, { "content-type": "application/x-www-form-urlencoded" }, 64 * 1024), { ip: "192.0.2.90" });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("still accepts bodies under the cap", async () => {
    const app = appWith();
    const res = await app.fetch(mcpReq(OWNER, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })));
    expect(res.status).toBe(200);
  });
});

describe("L2: login and logout check the Origin header", () => {
  const app = appWith();
  it("accepts the same origin and a missing Origin (non-browser clients)", async () => {
    expect((await app.fetch(formReq("/board/login", VIEWER, { origin: B }), { ip: "192.0.2.1" })).status).toBe(303);
    expect((await app.fetch(formReq("/board/login", VIEWER), { ip: "192.0.2.1" })).status).toBe(303);
    expect((await app.fetch(new Request(`${B}/board/logout`, { method: "POST", headers: { origin: B } }))).status).toBe(303);
  });

  it("rejects another origin, a null origin and a cross-site fetch with 403 and no cookie", async () => {
    for (const origin of ["https://evil.example", "null", "http://board.test", "https://board.test.evil.example"]) {
      const res = await app.fetch(formReq("/board/login", VIEWER, { origin }), { ip: "192.0.2.2" });
      expect(res.status, origin).toBe(403);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect((await app.fetch(formReq("/board/login", VIEWER, { "sec-fetch-site": "cross-site" }), { ip: "192.0.2.2" })).status).toBe(403);
    expect((await app.fetch(new Request(`${B}/board/logout`, { method: "POST", headers: { origin: "https://evil.example" } }))).status).toBe(403);
  });
});

describe("M3: a TLS-terminating proxy without TRUST_PROXY gets an explanation, not a blank 403", () => {
  const app = appWith();
  const behindProxy = (headers: Record<string, string>) =>
    new Request("http://board.test/board/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://board.test", ...headers },
      body: new URLSearchParams({ key: VIEWER }).toString(),
    });

  it("names TRUST_PROXY=1 when X-Forwarded-Proto is https but trust is off", async () => {
    const res = await app.fetch(behindProxy({ "x-forwarded-proto": "https" }), { ip: "192.0.2.9" });
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("TRUST_PROXY=1");
    expect(html).toContain("proxy");
  });

  it("stays a bare 403 for a genuine cross-origin post, and says nothing about proxies", async () => {
    const res = await app.fetch(formReq("/board/login", VIEWER, { origin: "https://evil.example" }), { ip: "192.0.2.9" });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("TRUST_PROXY");
  });

  it("explains it on logout too", async () => {
    const res = await app.fetch(new Request("http://board.test/board/logout", { method: "POST", headers: { origin: "https://board.test", "x-forwarded-proto": "https" } }));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("TRUST_PROXY=1");
  });
});

describe("L4: /healthz is minimal and real; /version needs a key", () => {
  it("returns only {ok:true} after a database round trip, and 503 when the database fails", async () => {
    const res = await appWith().fetch(new Request(`${B}/healthz`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const broken = { prepare: () => { throw new Error("db down"); }, batch: async () => [] };
    const down = await appWith({}, { db: broken }).fetch(new Request(`${B}/healthz`));
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ ok: false });
  });

  it("serves version, schema and api only to a valid key of any role", async () => {
    const app = appWith();
    expect((await app.fetch(new Request(`${B}/version`))).status).toBe(401);
    expect((await app.fetch(new Request(`${B}/version`, { headers: { authorization: "Bearer wrong-0123456789abcdef" } }))).status).toBe(401);
    for (const key of [OWNER, WORKER, VIEWER]) {
      const res = await app.fetch(new Request(`${B}/version`, { headers: { authorization: `Bearer ${key}` } }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, version: "0.2.0", schema: 2, api: 1 });
    }
    expect((await app.fetch(new Request(`${B}/version`, { method: "POST", headers: { authorization: `Bearer ${OWNER}` } }))).status).toBe(405);
  });

  it("accepts a session cookie too, and counts wrong keys against the limiter", async () => {
    const app = appWith();
    const login = await app.fetch(formReq("/board/login", VIEWER), { ip: "192.0.2.7" });
    const cookie = login.headers.getSetCookie()[0].split(";")[0];
    expect((await app.fetch(new Request(`${B}/version`, { headers: { cookie } }))).status).toBe(200);
    for (let i = 0; i < AUTH_FAIL_LIMIT; i++) await app.fetch(new Request(`${B}/version`, { headers: { authorization: `Bearer bad-${i}-0123456789abcdefgh` } }), { ip: "192.0.2.8" });
    expect((await app.fetch(new Request(`${B}/version`, { headers: { authorization: "Bearer bad-last-0123456789abcdefgh" } }), { ip: "192.0.2.8" })).status).toBe(429);
  });
});

describe("M3b: stream lifetime and per-session cap", () => {
  it("keeps Workers streams at 60 s or less and Node at 5 minutes by default", async () => {
    expect(WORKERS_STREAM.maxMs).toBeLessThanOrEqual(60_000);
    expect(WORKERS_STREAM.tickMs).toBe(2000);
  });

  it("caps concurrent streams per session and frees the slot when one closes", async () => {
    const app = appWith({}, { maxStreamsPerSession: 2 });
    const open = (token = VIEWER) => app.fetch(new Request(`${B}/board/api/stream`, { headers: { authorization: `Bearer ${token}` } }));
    const a = await open();
    const b = await open();
    expect([a.status, b.status]).toEqual([200, 200]);
    const c = await open();
    expect(c.status).toBe(429);
    expect(c.headers.get("retry-after")).toBeTruthy();
    // A different session (the owner key) has its own allowance.
    const other = await open(OWNER);
    expect(other.status).toBe(200);
    await a.body!.cancel();
    const again = await open();
    expect(again.status).toBe(200);
    for (const r of [b, other, again]) await r.body!.cancel();
  });

  it("is unlimited when no cap is configured (Workers)", async () => {
    const app = appWith();
    const rs = await Promise.all(Array.from({ length: 5 }, () => app.fetch(new Request(`${B}/board/api/stream`, { headers: { authorization: `Bearer ${VIEWER}` } }))));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    for (const r of rs) await r.body!.cancel();
  });

  it("frees the slot when the stream ends by itself", async () => {
    const app = appWith({}, { maxStreamsPerSession: 1, stream: { tickMs: 5, heartbeatMs: 50, maxMs: 60 } });
    const open = () => app.fetch(new Request(`${B}/board/api/stream`, { headers: { authorization: `Bearer ${VIEWER}` } }));
    const first = await open();
    const reader = first.body!.getReader();
    while (!(await reader.read()).done);
    await vi.waitFor(async () => expect((await open()).status).toBe(200), { timeout: 1000 });
  });
});

export type { App };
