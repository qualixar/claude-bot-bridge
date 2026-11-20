import { describe, expect, it, vi } from "vitest";
// @ts-expect-error plain ESM script without types
import { buildCall, callBoard, main, parseArgs } from "../client/board.mjs";
// @ts-expect-error plain ESM script without types
import { boardEnv } from "../client/upgrade.mjs";

const ENV = { MUSE_BOARD_URL: "https://board.example/mcp", MUSE_BOARD_OWNER_TOKEN: "owner-secret-value-123456" };
const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });
const toolReply = (obj: unknown) => ({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(obj) }] } });

describe("board client", () => {
  it("parses flags and positionals", () => {
    expect(parseArgs(["get", "T-0001", "--limit", "5"])).toEqual({ positional: ["get", "T-0001"], flags: { limit: "5" } });
    expect(() => parseArgs(["list", "--status"])).toThrow(/needs a value/);
  });

  it("maps each command to a tool call", () => {
    expect(buildCall(["create"], { title: "t", brief: "b", deliverable: "d", priority: "1" })).toEqual(["task_create", { title: "t", brief: "b", deliverable: "d", priority: 1 }]);
    expect(buildCall(["list"], { status: "open" })).toEqual(["task_list", { status: "open" }]);
    expect(buildCall(["get", "T-0001"], {})).toEqual(["task_get", { id: "T-0001" }]);
    expect(buildCall(["results"], {})).toEqual(["task_results", {}]);
    expect(buildCall(["results", "T-0002"], {})).toEqual(["task_results", { id: "T-0002" }]);
    expect(buildCall(["answer", "T-0001"], { reply: "yes" })).toEqual(["task_answer", { id: "T-0001", reply: "yes" }]);
    expect(buildCall(["cancel", "T-0001"], { reason: "r" })).toEqual(["task_cancel", { id: "T-0001", reason: "r" }]);
    expect(buildCall(["pause"], {})[0]).toBe("board_pause");
    expect(buildCall(["resume"], {})[0]).toBe("board_resume");
    expect(() => buildCall(["bogus"], {})).toThrow(/Unknown command/);
    expect(() => buildCall(["get"], {})).toThrow(/task id/);
    expect(() => buildCall(["create"], { title: "t" })).toThrow(/--brief/);
    expect(() => buildCall(["list"], { limit: "x" })).toThrow(/integer/);
  });

  it("sends the owner token as a bearer header and never prints it", async () => {
    const fetchImpl = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(reply(toolReply({ ok: true, tasks: [] })));
    const out = { log: vi.fn() };
    expect(await main(["list"], ENV, out, fetchImpl as any)).toBe(0);
    const init = fetchImpl.mock.calls[0][1];
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${ENV.MUSE_BOARD_OWNER_TOKEN}`);
    expect(JSON.stringify(out.log.mock.calls)).not.toContain(ENV.MUSE_BOARD_OWNER_TOKEN);
  });

  it("exits 2 on a tool error and prints usage on no command", async () => {
    const out = { log: vi.fn() };
    expect(await main(["get", "T-0001"], ENV, out, reply(toolReply({ ok: false, error: { code: "not_found" } })) as any)).toBe(2);
    expect(await main([], ENV, out, reply({}) as any)).toBe(0);
    expect(out.log.mock.calls.at(-1)![0]).toMatch(/Usage: board/);
  });

  it("reports configuration and transport problems without leaking the token", async () => {
    await expect(callBoard({}, "task_list", {})).rejects.toThrow(/CBB_BOARD_URL is not set/);
    await expect(callBoard({ MUSE_BOARD_URL: "https://x/mcp" }, "task_list", {})).rejects.toThrow(/CBB_BOARD_OWNER_KEY is not set/);
    await expect(callBoard({ ...ENV, MUSE_BOARD_URL: "http://evil.example/mcp" }, "task_list", {})).rejects.toThrow(/https/);
    await expect(callBoard({ ...ENV, MUSE_BOARD_URL: "http://localhost:8787/mcp" }, "task_list", {}, reply(toolReply({ ok: true })) as any)).resolves.toEqual({ ok: true });
    await expect(callBoard(ENV, "x", {}, (async () => new Response(null, { status: 401 })) as any)).rejects.toThrow(/401/);
    await expect(callBoard(ENV, "x", {}, (async () => new Response(null, { status: 429 })) as any)).rejects.toThrow(/429/);
    await expect(callBoard(ENV, "x", {}, (async () => new Response("<html>", { status: 502 })) as any)).rejects.toThrow(/HTTP 502/);
    await expect(callBoard(ENV, "x", {}, reply({ error: { message: "boom" } }) as any)).rejects.toThrow(/boom/);
  });
});

describe("board keygen and rotate", () => {
  const fixed = (fill: number) => (n: number) => Buffer.alloc(n, fill);

  it("prints a role key once with its SHA-256 and the server variable name", async () => {
    const { keygen } = await import("../client/board.mjs" as string);
    const lines: string[] = keygen({ role: "viewer" }, fixed(1));
    const key = lines.find((l) => l.startsWith("Key:"))!.split(/\s+/)[1];
    const hash = lines.find((l) => l.startsWith("SHA-256:"))!.split(/\s+/)[1];
    expect(Buffer.from(key, "base64url")).toHaveLength(32);
    const { createHash } = await import("node:crypto");
    expect(hash).toBe(createHash("sha256").update(key).digest("hex"));
    expect(lines.join("\n")).toContain(`VIEWER_KEY_SHA256=${hash}`);
    expect(keygen({ role: "owner" }, fixed(2)).join("\n")).toContain("OWNER_KEY_SHA256=");
    expect(keygen({ role: "worker" }, fixed(3)).join("\n")).toContain("WORKER_KEY_SHA256=");
  });

  it("generates 32-byte random keys by default, all different", async () => {
    const { keygen } = await import("../client/board.mjs" as string);
    const a = keygen({ role: "owner" }).find((l: string) => l.startsWith("Key:"));
    const b = keygen({ role: "owner" }).find((l: string) => l.startsWith("Key:"));
    expect(a).not.toBe(b);
  });

  it("prints an encryption key (32 bytes, base64) and a session secret", async () => {
    const { keygen } = await import("../client/board.mjs" as string);
    const enc = keygen({ "encryption-key": true }, fixed(4))[0] as string;
    expect(enc).toMatch(/^BOARD_ENCRYPTION_KEY=/);
    expect(Buffer.from(enc.split("=").slice(1).join("="), "base64")).toHaveLength(32);
    expect(keygen({ "session-secret": true }, fixed(5))[0]).toMatch(/^SESSION_SECRET=[A-Za-z0-9_-]{43}$/);
    expect(() => keygen({})).toThrow(/--role/);
    expect(() => keygen({ role: "admin" })).toThrow(/--role/);
  });

  it("runs keygen without any board environment, and parses its boolean flags", async () => {
    expect(parseArgs(["keygen", "--encryption-key"])).toEqual({ positional: ["keygen"], flags: { "encryption-key": true } });
    const out = { log: vi.fn() };
    expect(await main(["keygen", "--role", "viewer"], {}, out)).toBe(0);
    expect(out.log.mock.calls.join("\n")).toMatch(/VIEWER_KEY_SHA256=[0-9a-f]{64}/);
    expect(await main(["--help"], {}, out)).toBe(0);
  });

  const scripted = (results: unknown[]) => {
    const seen: unknown[] = [];
    const fetchImpl = async (_u: string, init: RequestInit) => {
      seen.push(JSON.parse(init.body as string).params.arguments);
      return new Response(JSON.stringify(toolReply(results.shift())), { status: 200 });
    };
    return { seen, fetchImpl };
  };
  const page = (o: Record<string, unknown>) => ({ ok: true, scanned: 0, rewritten: 0, skipped: 0, unreadable: 0, stale: 0, next_cursor: null, ...o });

  it("rotate repeats full passes until one is clean, then verifies, and only then says the old key may go", async () => {
    const { seen, fetchImpl } = scripted([
      page({ scanned: 50, rewritten: 2, skipped: 1, next_cursor: "tasks:T-0050" }),
      page({ scanned: 10, rewritten: 1 }),
      page({ scanned: 60, rewritten: 1 }),
      page({ scanned: 60 }),
      page({ scanned: 60 }),
    ]);
    const out = { log: vi.fn() };
    expect(await main(["rotate"], ENV, out, fetchImpl as any)).toBe(0);
    expect(seen).toEqual([{ limit: 50 }, { limit: 50, cursor: "tasks:T-0050" }, { limit: 50 }, { limit: 50 }, { limit: 50, verify: true }]);
    const report = JSON.parse(out.log.mock.calls[0][0]);
    expect(report).toMatchObject({ ok: true, passes: 3, rewritten: 4, skipped: 1, verified: true });
    expect(out.log.mock.calls[1][0]).toMatch(/PREVIOUS may now be removed/);
  });

  it("rotate refuses to bless the old key when values are unreadable or still stale", async () => {
    const { fetchImpl } = scripted([page({ scanned: 3 }), page({ scanned: 3, unreadable: 1, stale: 2 })]);
    const out = { log: vi.fn() };
    expect(await main(["rotate"], ENV, out, fetchImpl as any)).toBe(2);
    expect(JSON.parse(out.log.mock.calls[0][0])).toMatchObject({ ok: false, verified: false, unreadable: 1, stale: 2 });
    expect(out.log.mock.calls[1][0]).toMatch(/do not remove BOARD_ENCRYPTION_KEY_PREVIOUS/);
  });

  it("rotate gives up after 10 passes that keep skipping, and surfaces server errors", async () => {
    const results = [...Array.from({ length: 10 }, () => page({ scanned: 1, skipped: 1 })), page({ scanned: 1 })];
    const { seen, fetchImpl } = scripted(results);
    const out = { log: vi.fn() };
    expect(await main(["rotate"], ENV, out, fetchImpl as any)).toBe(2);
    expect(seen).toHaveLength(11);
    await expect(main(["rotate"], ENV, out, reply(toolReply({ ok: false, error: { message: "no key" } })) as any)).rejects.toThrow(/no key/);
  });
});

describe("board env names", () => {
  it("prefers CBB_BOARD_URL / CBB_BOARD_OWNER_KEY and still accepts the legacy MUSE_* names", () => {
    expect(boardEnv({ CBB_BOARD_URL: "https://a/mcp", CBB_BOARD_OWNER_KEY: "k1", MUSE_BOARD_URL: "https://b/mcp", MUSE_BOARD_OWNER_TOKEN: "k2" })).toEqual({ url: "https://a/mcp", token: "k1" });
    expect(boardEnv({ MUSE_BOARD_URL: "https://b/mcp", MUSE_BOARD_OWNER_TOKEN: "k2" })).toEqual({ url: "https://b/mcp", token: "k2" });
    expect(boardEnv({})).toEqual({ url: undefined, token: undefined });
  });
});

describe("board wait and init subcommands", () => {
  it("maps `wait` to task_wait with id, since_rev and timeout_s", () => {
    expect(buildCall(["wait", "T-0007"], { "since-rev": "12", timeout: "30" })).toEqual(["task_wait", { id: "T-0007", since_rev: 12, timeout_s: 30 }]);
    expect(buildCall(["wait"], {})).toEqual(["task_wait", {}]);
    expect(() => buildCall(["wait"], { "since-rev": "x" })).toThrow(/--since-rev must be an integer/);
    expect(() => buildCall(["wait"], { timeout: "1.5" })).toThrow(/--timeout must be an integer/);
  });

  it("runs `wait` through the board and prints the result", async () => {
    const seen: any[] = [];
    const fetchImpl = async (_u: string, init: RequestInit) => {
      seen.push(JSON.parse(init.body as string).params);
      return new Response(JSON.stringify(toolReply({ ok: true, changed: true, rev: 9, final: true })), { status: 200 });
    };
    const out = { log: vi.fn() };
    expect(await main(["wait", "T-0001", "--since-rev", "3", "--timeout", "20"], ENV, out, fetchImpl as any)).toBe(0);
    expect(seen).toEqual([{ name: "task_wait", arguments: { id: "T-0001", since_rev: 3, timeout_s: 20 } }]);
    expect(JSON.parse(out.log.mock.calls[0][0])).toMatchObject({ changed: true, rev: 9, final: true });
  });

  it("lists wait and init in the usage text", async () => {
    const out = { log: vi.fn() };
    await main([], {}, out);
    const text = out.log.mock.calls[0][0] as string;
    expect(text).toMatch(/wait \[ID\] \[--since-rev N\] \[--timeout S\]/);
    expect(text).toMatch(/init \(--cloudflare \| --docker \| --node\)/);
  });

  it("dispatches `init` to cbb-board-init with the rest of the arguments, without needing board variables", async () => {
    const out = { log: vi.fn() };
    expect(await main(["init", "--help"], {}, out)).toBe(0);
    expect(out.log.mock.calls[0][0]).toMatch(/^Usage: cbb-board-init/);
  });

  it("passes its flags and injected dependencies to init (no real wrangler or docker)", async () => {
    const out = { log: vi.fn() };
    const written: string[] = [];
    const calls: string[] = [];
    const deps = {
      cwd: "/nowhere",
      fsx: { exists: () => false, write: (p: string) => void written.push(p), read: () => "", chmod: () => undefined },
      exec: async (cmd: string) => (calls.push(cmd), { code: 0, stdout: "", stderr: "" }),
      ask: async () => true,
    };
    const code = await main(["init", "--docker", "--yes"], {}, out, fetch, deps);
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(written.some((p) => p.endsWith(".env"))).toBe(true);
  });
});
