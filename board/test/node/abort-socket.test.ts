import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/auth";
import { toB64Url } from "../../src/crypto/b64";
import { optionsFromEnv } from "../../src/node/options";
import { startServer, type RunningServer } from "../../src/node/server";
import { OWNER, SESSION_SECRET, WORKER } from "../harness-core";
import { join } from "node:path";

const ENV = {
  OWNER_KEY_SHA256: await sha256Hex(OWNER),
  WORKER_KEY_SHA256: await sha256Hex(WORKER),
  BOARD_ENCRYPTION_KEY: toB64Url(new Uint8Array(32).fill(5)),
  SESSION_SECRET,
  PORT: "0",
  DB_PATH: ":memory:",
  MIGRATIONS_DIR: join(import.meta.dirname, "../../migrations"),
};

let server: RunningServer | undefined;
afterEach(async () => {
  await server?.close().catch(() => undefined);
  server = undefined;
});

interface Settled {
  path: string;
  ms: number;
  aborted: boolean;
}

describe("Node server: a closed client socket aborts the request signal", () => {
  it("ends a task_wait on the server within 2 s of the client aborting", async () => {
    const settled: Settled[] = [];
    server = await startServer({ ...optionsFromEnv(ENV), onRequestSettled: (s: Settled) => void settled.push(s) });
    const ac = new AbortController();
    const started = Date.now();
    const pending = fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      signal: ac.signal,
      headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "task_wait", arguments: { timeout_s: 40 } } }),
    }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 400));
    const abortedAt = Date.now();
    ac.abort();
    expect(((await pending) as Error).name).toBe("AbortError");
    const deadline = abortedAt + 2000;
    while (settled.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(settled).toHaveLength(1);
    expect(settled[0].aborted).toBe(true);
    expect(Date.now() - abortedAt).toBeLessThan(2000);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("a request that finishes normally is reported as not aborted", async () => {
    const settled: Settled[] = [];
    server = await startServer({ ...optionsFromEnv(ENV), onRequestSettled: (s: Settled) => void settled.push(s) });
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    await res.text();
    await new Promise((r) => setTimeout(r, 50));
    expect(settled.at(-1)).toMatchObject({ path: "/healthz", aborted: false });
  });
});
