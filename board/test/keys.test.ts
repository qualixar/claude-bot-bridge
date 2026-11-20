import { describe, expect, it } from "vitest";
import { BASE_ENV, OWNER, VIEWER, WORKER, appWith, db } from "#harness";
import { authenticate, sha256Hex } from "../src/auth";
import { AUTH_FAIL_LIMIT } from "../src/guard";

const listBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
const mcp = (token: string | null, extra: Record<string, string> = {}) =>
  new Request("https://board.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: listBody,
  });

const HASHED = async () => ({
  OWNER_TOKEN: undefined,
  WORKER_TOKEN: undefined,
  OWNER_KEY_SHA256: await sha256Hex(OWNER),
  WORKER_KEY_SHA256: await sha256Hex(WORKER),
  VIEWER_KEY_SHA256: await sha256Hex(VIEWER),
});

describe("hashed keys", () => {
  it("authenticates owner, worker and viewer by SHA-256 of the key", async () => {
    const env = await HASHED();
    const app = appWith(env);
    expect((await app.fetch(mcp(OWNER))).status).toBe(200);
    expect((await app.fetch(mcp(WORKER))).status).toBe(200);
    expect((await app.fetch(mcp("not-a-key-0123456789"))).status).toBe(401);
    // The hash itself is not a credential.
    expect((await app.fetch(mcp(env.OWNER_KEY_SHA256))).status).toBe(401);
    expect(await authenticate(mcp(OWNER), env)).toBe("owner");
    expect(await authenticate(mcp(VIEWER), env)).toBe("viewer");
    expect(await authenticate(mcp(WORKER), env)).toBe("worker");
  });

  it("accepts upper-case hex and prefers the hash over a legacy plaintext token", async () => {
    const env = await HASHED();
    const app = appWith({ ...env, OWNER_KEY_SHA256: env.OWNER_KEY_SHA256.toUpperCase(), OWNER_TOKEN: "legacy-owner-token-0123456789" });
    expect((await app.fetch(mcp(OWNER))).status).toBe(200);
    expect((await app.fetch(mcp("legacy-owner-token-0123456789"))).status).toBe(401);
  });

  it("fails closed on a malformed hash instead of falling back to the plaintext token", async () => {
    const app = appWith({ OWNER_KEY_SHA256: "not-hex", OWNER_TOKEN: OWNER });
    expect((await app.fetch(mcp(OWNER))).status).toBe(401);
    expect((await app.fetch(mcp(WORKER))).status).toBe(401);
  });

  it("refuses everyone when two roles share a key", async () => {
    const app = appWith({ ...(await HASHED()), VIEWER_KEY_SHA256: await sha256Hex(WORKER) });
    for (const t of [OWNER, WORKER, VIEWER]) expect((await app.fetch(mcp(t))).status).toBe(401);
  });

  it("keeps the legacy plaintext tokens working", async () => {
    expect((await appWith().fetch(mcp(OWNER))).status).toBe(200);
    expect((await appWith().fetch(mcp(WORKER))).status).toBe(200);
  });
});

describe("viewer role", () => {
  it("is refused on /mcp with 403, whatever the path or method", async () => {
    const app = appWith();
    expect((await app.fetch(mcp(VIEWER))).status).toBe(403);
    expect((await app.fetch(new Request("https://board.test/mcp", { method: "GET", headers: { authorization: `Bearer ${VIEWER}` } }))).status).toBe(403);
    expect((await app.fetch(new Request("https://board.test/other", { headers: { authorization: `Bearer ${VIEWER}` } }))).status).toBe(403);
  });
});

describe("failed-auth limiter", () => {
  const withIp = (app: ReturnType<typeof appWith>, token: string, ip: string) => app.fetch(mcp(token), { ip });

  it("returns 429 after 20 failures a minute from one address, and logs only a count", async () => {
    const warn: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void warn.push(a);
    try {
      const app = appWith();
      for (let i = 0; i < AUTH_FAIL_LIMIT; i++) expect((await withIp(app, `wrong-${i}-0123456789abcdef`, "198.51.100.7")).status).toBe(401);
      const blocked = await withIp(app, "wrong-again-0123456789abcdef", "198.51.100.7");
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).toBe("60");
      // Valid keys always pass, even from an address that has been limited (a shared tunnel or egress IP).
      expect((await withIp(app, OWNER, "198.51.100.7")).status).toBe(200);
      expect((await withIp(app, WORKER, "198.51.100.7")).status).toBe(200);
      expect((await withIp(app, OWNER, "198.51.100.8")).status).toBe(200);
      expect(warn).toHaveLength(1);
      expect(JSON.stringify(warn)).not.toMatch(/wrong-|198\.51/);
    } finally {
      console.warn = orig;
    }
  });

  it("does not count requests with no credentials, and the block ends with the minute", async () => {
    let now = 1_800_000_000_000;
    const app = appWith({}, { now: () => now });
    for (let i = 0; i < 30; i++) expect((await app.fetch(mcp(null), { ip: "203.0.113.9" })).status).toBe(401);
    for (let i = 0; i < AUTH_FAIL_LIMIT; i++) await withIp(app, `x-${i}-0123456789abcdefgh`, "203.0.113.9");
    expect((await withIp(app, "bad-after-limit-0123456789", "203.0.113.9")).status).toBe(429);
    now += 61_000;
    expect((await withIp(app, "bad-next-minute-0123456789", "203.0.113.9")).status).toBe(401);
  });

  it("falls back to the CF-Connecting-IP header supplied by the Workers entry", async () => {
    const app = appWith({}, { clientIp: (req) => req.headers.get("cf-connecting-ip") });
    for (let i = 0; i < AUTH_FAIL_LIMIT; i++) await app.fetch(mcp(`bad-${i}-0123456789abcdefgh`, { "cf-connecting-ip": "192.0.2.1" }));
    expect((await app.fetch(mcp("bad-21st-0123456789abcdefgh", { "cf-connecting-ip": "192.0.2.1" }))).status).toBe(429);
    expect((await app.fetch(mcp(OWNER, { "cf-connecting-ip": "192.0.2.1" }))).status).toBe(200);
    expect((await app.fetch(mcp(OWNER, { "cf-connecting-ip": "192.0.2.2" }))).status).toBe(200);
    const rows = await db.prepare("SELECT scope FROM rate_limits WHERE scope LIKE 'authfail:%'").all<{ scope: string }>();
    expect(rows.results[0].scope).toMatch(/^authfail:[0-9a-f]{16}$/);
  });
});

describe("harness defaults", () => {
  it("allows plaintext storage for tests only", () => {
    expect(BASE_ENV.ALLOW_PLAINTEXT_STORAGE).toBe("1");
  });
});
