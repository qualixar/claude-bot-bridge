import { describe, expect, it } from "vitest";
import { pruneRateLimits, reclaimStale, withinRateLimit } from "../src/store/board";
import { BASE_ENV, app, appWith, db, plainStore } from "#harness";
import { createApp } from "../src/app";
import { configFromEnv } from "../src/config";
import { OWNER, WORKER, createTask, owner, post, send, worker } from "./helpers";

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const HOUR = 3_600_000;

describe("atomic claim", () => {
  it("lets exactly one of many simultaneous claims win", async () => {
    const id = await createTask();
    const results = await Promise.all(Array.from({ length: 10 }, () => worker("claim_task", { id })));
    expect(results.filter((r) => r.body.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.body.ok).every((r) => r.body.error.code === "invalid_state")).toBe(true);
    const events = (await owner("task_get", { id })).body.events.filter((e: any) => e.kind === "claimed");
    expect(events).toHaveLength(1);
  });

  it("rejects a second claim on a claimed task", async () => {
    const id = await createTask();
    await worker("claim_task", { id });
    const again = await worker("claim_task", { id });
    expect(again.body.error).toMatchObject({ code: "invalid_state", current_status: "claimed" });
  });
});

describe("stale reclaim", () => {
  it("returns a task with no activity for 2 hours to open and logs it", async () => {
    const id = await createTask();
    await worker("claim_task", { id });
    await db.prepare("UPDATE tasks SET last_activity_at = ? WHERE id = ?").bind(ago(2 * HOUR + 1000), id).run();
    expect((await worker("list_open_tasks")).body.tasks.map((t: any) => t.id)).toEqual([id]);
    const t = (await owner("task_get", { id })).body;
    expect(t.task).toMatchObject({ status: "open", claimed_by: null });
    expect(t.events.at(-1)).toMatchObject({ actor: "system", kind: "stale_reclaim", to_status: "open" });
    expect((await worker("claim_task", { id })).body.ok).toBe(true);
  });

  it("keeps recent claims and tasks waiting on the owner", async () => {
    const fresh = await createTask();
    const waiting = await createTask();
    for (const id of [fresh, waiting]) await worker("claim_task", { id });
    await worker("ask_owner", { id: waiting, question: "?" });
    await db.prepare("UPDATE tasks SET last_activity_at = ? WHERE id = ?").bind(ago(HOUR), fresh).run();
    await db.prepare("UPDATE tasks SET last_activity_at = ? WHERE id = ?").bind(ago(5 * HOUR), waiting).run();
    expect(await reclaimStale(plainStore(), Date.now())).toEqual([]);
  });

  it("progress and heartbeat reset the clock", async () => {
    const a = await createTask();
    const b = await createTask();
    for (const id of [a, b]) await worker("claim_task", { id });
    for (const id of [a, b]) await db.prepare("UPDATE tasks SET last_activity_at = ? WHERE id = ?").bind(ago(110 * 60_000), id).run();
    await worker("post_progress", { id: a, note: "alive" });
    await worker("heartbeat");
    const rows = await db.prepare("SELECT last_activity_at AS t, status FROM tasks").all<{ t: string; status: string }>();
    for (const r of rows.results) {
      expect(r.t > ago(60_000)).toBe(true);
      expect(r.status).not.toBe("open");
    }
  });

  it("is also run by the housekeeping tick", async () => {
    const id = await createTask();
    await worker("claim_task", { id });
    await db.prepare("UPDATE tasks SET last_activity_at = ? WHERE id = ?").bind(ago(3 * HOUR), id).run();
    await app.tick(Date.now());
    const row = await db.prepare("SELECT status FROM tasks WHERE id = ?").bind(id).first<{ status: string }>();
    expect(row!.status).toBe("open");
  });
});

describe("pause", () => {
  it("makes every worker tool return paused, and resume restores them", async () => {
    const id = await createTask();
    expect((await owner("board_pause")).body.board).toBe("paused");
    for (const [name, args] of [["list_open_tasks", {}], ["claim_task", { id }], ["get_task", { id }], ["heartbeat", {}], ["post_progress", { id, note: "x" }]] as const) {
      const r = await worker(name, args);
      expect(r.isError).toBe(true);
      expect(r.body.error.code).toBe("paused");
      expect(r.body.error.message).toMatch(/^paused/);
    }
    expect((await owner("list_open_tasks")).body.count).toBe(1);
    expect((await owner("heartbeat")).body.board).toBe("paused");
    expect((await owner("board_resume")).body.board).toBe("running");
    expect((await worker("claim_task", { id })).body.ok).toBe(true);
    const kinds = (await db.prepare("SELECT kind FROM events WHERE task_id IS NULL ORDER BY id").all<{ kind: string }>()).results.map((r) => r.kind);
    expect(kinds).toEqual(["board_pause", "board_resume"]);
  });
});

describe("rate limit", () => {
  it("returns 429 for the worker past the per-minute limit but not the owner", async () => {
    const limited = appWith({ WORKER_RATE_LIMIT_PER_MIN: "3" });
    const mk = (token: string) =>
      new Request("https://board.test/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await limited.fetch(mk(WORKER))).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    const blocked = await limited.fetch(mk(WORKER));
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect((await limited.fetch(mk(OWNER))).status).toBe(200);
  });

  it("uses the default limit for a bad setting and prunes old buckets", async () => {
    const bad = appWith({ WORKER_RATE_LIMIT_PER_MIN: "abc" });
    const req = () =>
      new Request("https://board.test/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${WORKER}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    expect((await bad.fetch(req())).status).toBe(200);
    const now = Date.now();
    await db.prepare("INSERT INTO rate_limits (scope, minute, count) VALUES ('worker', 1, 5)").run();
    expect(await withinRateLimit(db, "x", now, 5)).toBe(true);
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE minute = 1").first<{ n: number }>();
    expect(rows!.n).toBe(0);
    await db.prepare("INSERT INTO rate_limits (scope, minute, count) VALUES ('worker', 2, 5)").run();
    await pruneRateLimits(db, now);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE minute = 2").first<{ n: number }>())!.n).toBe(0);
  });
});

describe("transport", () => {
  it("answers initialize with the instructions", async () => {
    const r = await post(WORKER, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    expect(r.status).toBe(200);
    expect(r.json.result.serverInfo.name).toBe("claude-bot-bridge-board");
    expect(r.json.result.instructions).toMatch(/standing instruction/);
  });

  it("accepts notifications, and works with only Accept: application/json", async () => {
    const note = await post(WORKER, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);
    const res = await send(new Request("https://board.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${WORKER}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    }));
    expect(res.status).toBe(200);
  });

  it("rejects invalid JSON and oversized bodies without detail", async () => {
    const bad = await post(OWNER, "{not json");
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe(-32700);
    const big = await post(OWNER, JSON.stringify({ pad: "x".repeat(130 * 1024) }));
    expect(big.status).toBe(413);
    const declared = await post(OWNER, "{}", { "content-length": String(200 * 1024) }).catch(() => null);
    expect(declared === null || [413, 400].includes(declared.status)).toBe(true);
  });

  it("returns a generic 500 JSON-RPC error and no stack when the database fails", async () => {
    const brokenDb = { prepare: () => { throw new Error("secret internal detail at /src/x.ts:1"); }, batch: async () => [] };
    const broken = createApp({ db: brokenDb, config: configFromEnv(BASE_ENV) });
    const res = await broken.fetch(
      new Request("https://board.test/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "task_list", arguments: {} } }),
      }),
    );
    const text = await res.text();
    expect(text).not.toMatch(/secret internal|\.ts|stack/);
    expect(text).toMatch(/Internal error/);
  });
});
