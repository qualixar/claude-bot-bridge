import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../src/auth";
import { toB64Url } from "../../src/crypto/b64";
import { StartupError, optionsFromEnv } from "../../src/node/options";
import { main, startServer, type RunningServer } from "../../src/node/server";
import { rotateAll } from "../../src/node/rotate";
import { OWNER, SESSION_SECRET, VIEWER, WORKER } from "../harness-core";

const MIGRATIONS = join(import.meta.dirname, "../../migrations");
const KEY = toB64Url(new Uint8Array(32).fill(5));
const ENV = {
  OWNER_KEY_SHA256: await sha256Hex(OWNER),
  WORKER_KEY_SHA256: await sha256Hex(WORKER),
  VIEWER_KEY_SHA256: await sha256Hex(VIEWER),
  BOARD_ENCRYPTION_KEY: KEY,
  SESSION_SECRET,
};

const running: RunningServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function start(env: Record<string, string | undefined> = {}, extra: Record<string, unknown> = {}): Promise<{ server: RunningServer; base: string }> {
  const opts = optionsFromEnv({ ...ENV, ...env, PORT: "0", DB_PATH: ":memory:", MIGRATIONS_DIR: MIGRATIONS });
  const server = await startServer({ ...opts, ...extra });
  running.push(server);
  return { server, base: `http://127.0.0.1:${server.port}` };
}

let rpc = 0;
const call = async (base: string, token: string, name: string, args: Record<string, unknown> = {}) => {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }),
  });
  const json = (await res.json()) as any;
  return JSON.parse(json.result.content[0].text);
};

describe("Node server", () => {
  it("answers GET /healthz with {\"ok\":true} and no auth, and nothing else in it", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    const head = await fetch(`${base}/healthz`, { method: "HEAD" });
    expect(head.status).toBe(200);
  });

  it("serves MCP and the board API end to end: create as owner, claim as worker, see it move", async () => {
    const { base } = await start();
    const created = await call(base, OWNER, "task_create", { title: "Smoke", brief: "b", deliverable: "d" });
    const id = created.task.id;
    const snap = async () => (await (await fetch(`${base}/board/api/tasks`, { headers: { authorization: `Bearer ${VIEWER}` } })).json()) as any;
    let s = await snap();
    expect(s.columns[0].tasks.map((t: any) => t.id)).toEqual([id]);
    expect((await call(base, WORKER, "claim_task", { id })).ok).toBe(true);
    s = await snap();
    expect(s.columns[0].count).toBe(0);
    expect(s.columns[1].tasks[0]).toMatchObject({ id, title: "Smoke", claimed_by: "Muse", status: "claimed" });
  });

  it("supports the login form, a cookie session, SSE and logout over real HTTP", async () => {
    const { base } = await start();
    const login = await fetch(`${base}/board/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `key=${encodeURIComponent(VIEWER)}`,
    });
    expect(login.status).toBe(303);
    const cookie = login.headers.getSetCookie()[0].split(";")[0];
    expect(login.headers.getSetCookie()[0]).not.toContain("Secure");
    const page = await fetch(`${base}/board`, { headers: { cookie } });
    expect(await page.text()).toContain("app.js");
    const sse = await fetch(`${base}/board/api/stream`, { headers: { cookie } });
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const reader = sse.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("retry: 3000");
    await reader.cancel();
  });

  it("returns 413 for oversized bodies, 400 for a malformed host, and 404/401 like the app", async () => {
    const { base, server } = await start();
    const big = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json" }, body: "x".repeat(170 * 1024) });
    expect(big.status).toBe(413);
    expect((await fetch(`${base}/whatever`)).status).toBe(401);
    const status = await new Promise<string>((resolve, reject) => {
      const sock = connect(server.port, "127.0.0.1", () => sock.write("GET / HTTP/1.1\r\nHost: bad host\r\nConnection: close\r\n\r\n"));
      let data = "";
      sock.on("data", (d) => (data += d));
      sock.on("end", () => resolve(data.split("\r\n")[0]));
      sock.on("error", reject);
    });
    expect(status).toContain("400");
  });

  it("uses X-Forwarded-For (last entry) and -Proto only when TRUST_PROXY=1", async () => {
    const trusted = await start({ TRUST_PROXY: "1" });
    const bad = (i: number, xff: string) => fetch(`${trusted.base}/mcp`, { method: "POST", headers: { authorization: `Bearer wrong-${i}-0123456789abcdef`, "x-forwarded-for": xff } });
    // The first entry is client-controlled: rotating it must not dodge the limit.
    for (let i = 0; i < 20; i++) expect((await bad(i, `10.0.0.${i}, 203.0.113.5`)).status).toBe(401);
    expect((await bad(99, "10.9.9.9, 203.0.113.5")).status).toBe(429);
    // A different client behind the proxy is unaffected.
    expect((await fetch(`${trusted.base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${OWNER}`, "x-forwarded-for": "203.0.113.6", "content-type": "application/json", accept: "application/json" }, body: "{}" })).status).not.toBe(429);
    const login = await fetch(`${trusted.base}/board/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.7" }, body: `key=${VIEWER}` });
    expect(login.headers.getSetCookie()[0]).toContain("Secure");
    expect(login.headers.get("strict-transport-security")).toContain("max-age");

    const direct = await start();
    for (let i = 0; i < 20; i++) await fetch(`${direct.base}/mcp`, { method: "POST", headers: { authorization: `Bearer wrong-${i}-0123456789abcdef`, "x-forwarded-for": `10.0.0.${i}` } });
    expect((await fetch(`${direct.base}/mcp`, { method: "POST", headers: { authorization: "Bearer wrong-again-0123456789abcdef", "x-forwarded-for": "10.0.1.1" } })).status).toBe(429);
    const ignored = await fetch(`${direct.base}/board/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-proto": "https" }, body: `key=${VIEWER}` });
    expect(ignored.status).toBe(303);
    expect(ignored.headers.getSetCookie()[0]).not.toContain("Secure");
  });

  it("closes promptly even with a Server-Sent Events stream open", async () => {
    const { base, server } = await start();
    const sse = await fetch(`${base}/board/api/stream`, { headers: { authorization: `Bearer ${VIEWER}` } });
    const reader = sse.body!.getReader();
    await reader.read();
    const started = Date.now();
    await server.close();
    expect(Date.now() - started).toBeLessThan(4000);
    await reader.cancel().catch(() => undefined);
    running.length = 0;
  });

  it("runs the housekeeping tick on an interval", async () => {
    const { server } = await start({}, { tickMs: 20 });
    await server.db.prepare("INSERT INTO tasks (id, title, brief, deliverable, acceptance, priority, status, claimed_by, origin, created_at, updated_at, last_activity_at) VALUES ('T-0001', 't', 'b', 'd', '', 2, 'claimed', 'Muse', 'o', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')").run();
    await vi.waitFor(async () => {
      const row = await server.db.prepare("SELECT status FROM tasks WHERE id = 'T-0001'").first<{ status: string }>();
      expect(row?.status).toBe("open");
    }, { timeout: 2000 });
  });

  it("keeps its data and does not re-run migrations when restarted on the same file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cbb-srv-"));
    dirs.push(dir);
    const env = { ...ENV, PORT: "0", DB_PATH: join(dir, "nested", "board.sqlite"), MIGRATIONS_DIR: MIGRATIONS };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const a = await startServer(optionsFromEnv(env));
    const id = (await call(`http://127.0.0.1:${a.port}`, OWNER, "task_create", { title: "Persist", brief: "b", deliverable: "d" })).task.id;
    await a.close();
    expect(log.mock.calls.flat().join(" ")).toContain("0001_init.sql");
    log.mockClear();
    const b = await startServer(optionsFromEnv(env));
    running.push(b);
    expect((await call(`http://127.0.0.1:${b.port}`, OWNER, "task_get", { id })).task.title).toBe("Persist");
    expect(log.mock.calls.flat().join(" ")).not.toContain("migrations applied");
  });
});

describe("startup validation", () => {
  const opts = (env: Record<string, string | undefined>) => optionsFromEnv({ ...ENV, PORT: "0", DB_PATH: ":memory:", MIGRATIONS_DIR: MIGRATIONS, ...env });

  it("refuses to start without BOARD_ENCRYPTION_KEY, with a clear message", async () => {
    const err = await startServer(opts({ BOARD_ENCRYPTION_KEY: undefined })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StartupError);
    expect((err as StartupError).problems.join(" ")).toMatch(/BOARD_ENCRYPTION_KEY is not set/);
    await expect(startServer(opts({ BOARD_ENCRYPTION_KEY: undefined, ALLOW_PLAINTEXT_STORAGE: "1" }))).resolves.toHaveProperty("port");
  });

  it("refuses to start with a missing session secret, shared keys, bad hashes or a bad port", async () => {
    await expect(startServer(opts({ SESSION_SECRET: undefined }))).rejects.toThrow(/SESSION_SECRET/);
    await expect(startServer(opts({ VIEWER_KEY_SHA256: ENV.OWNER_KEY_SHA256 }))).rejects.toThrow(/share the same key/);
    await expect(startServer(opts({ WORKER_KEY_SHA256: "zz" }))).rejects.toThrow(/WORKER_KEY_SHA256/);
    expect(() => optionsFromEnv({ PORT: "99999" })).toThrow(/PORT/);
    expect(() => optionsFromEnv({ PORT: "abc" })).toThrow(/PORT/);
    expect(optionsFromEnv({})).toMatchObject({ host: "127.0.0.1", port: 8787, dbPath: "./data/board.sqlite" });
  });

  it("releases the database if the port is already taken", async () => {
    const { server } = await start();
    await expect(startServer({ ...opts({}), port: server.port })).rejects.toThrow(/EADDRINUSE/);
  });

  it("main() prints the problems and exits 1 on bad configuration, and starts otherwise", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await main({ ...ENV, BOARD_ENCRYPTION_KEY: undefined });
    expect(exit).toHaveBeenCalledWith(1);
    expect(err.mock.calls.flat().join(" ")).toContain("BOARD_ENCRYPTION_KEY is not set");
    err.mockClear();
    await main({ ...ENV, PORT: "not-a-port" });
    expect(err.mock.calls.flat().join(" ")).toContain("PORT");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const before = process.listenerCount("SIGTERM");
    await main({ ...ENV, PORT: "0", DB_PATH: ":memory:", MIGRATIONS_DIR: MIGRATIONS });
    expect(log.mock.calls.flat().join(" ")).toMatch(/listening on http:\/\/127\.0\.0\.1:\d+/);
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
  });
});

describe("rotate script", () => {
  it("re-encrypts a plaintext database file with the current key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cbb-rot-"));
    dirs.push(dir);
    const env = { ...ENV, BOARD_ENCRYPTION_KEY: undefined, ALLOW_PLAINTEXT_STORAGE: "1", PORT: "0", DB_PATH: join(dir, "b.sqlite"), MIGRATIONS_DIR: MIGRATIONS };
    const plain = await startServer(optionsFromEnv(env));
    const id = (await call(`http://127.0.0.1:${plain.port}`, OWNER, "task_create", { title: "Old plaintext", brief: "b", deliverable: "d" })).task.id;
    await plain.close();

    expect(await rotateAll({ ...env, BOARD_ENCRYPTION_KEY: KEY })).toMatchObject({ scanned: expect.any(Number), rewritten: 2, skipped: 0, verified: true, stale: 0, unreadable: 0 });
    expect(await rotateAll({ ...env, BOARD_ENCRYPTION_KEY: KEY })).toMatchObject({ rewritten: 0, passes: 1, verified: true });
    const keyed = await startServer(optionsFromEnv({ ...env, BOARD_ENCRYPTION_KEY: KEY, ALLOW_PLAINTEXT_STORAGE: undefined }));
    running.push(keyed);
    expect((await call(`http://127.0.0.1:${keyed.port}`, OWNER, "task_get", { id })).task.title).toBe("Old plaintext");
    const raw = await keyed.db.prepare("SELECT title FROM tasks WHERE id = ?").bind(id).first<{ title: string }>();
    expect(raw!.title).toMatch(/^enc:v1:/);
    await expect(rotateAll({ ...env })).rejects.toThrow(/nothing to rotate|BOARD_ENCRYPTION_KEY/);
  });
});
