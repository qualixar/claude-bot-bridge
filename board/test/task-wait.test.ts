import { plainStore, runtime } from "#harness";
import { describe, expect, it } from "vitest";
import { listing, callTool } from "../src/tools";
import { waitSchema } from "../src/wait/schema";
import { MAX_WAIT_S, waitForChange, type WaitDeps, type WaitState } from "../src/wait/poll";
import { readWaitState } from "../src/store/tasks";
import { WORKER, createTask, owner, post, worker } from "./helpers";

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const revNow = async (): Promise<number> => (await readWaitState(plainStore()))!.rev;

/** Direct tool call, so a test can hand in an abort signal and fake wait timings. */
function direct(args: Record<string, unknown>, extra: Record<string, unknown> = {}, role: "owner" | "worker" = "owner") {
  return callTool({ store: plainStore(), role, nowMs: Date.now(), workerName: "Muse", ...extra } as any, "task_wait", args).then((r) => ({
    isError: Boolean(r.isError),
    body: JSON.parse((r.content[0] as { text: string }).text),
  }));
}

describe(`task_wait (${runtime})`, () => {
  it("returns immediately when the revision already moved past since_rev", async () => {
    const before = await revNow();
    await createTask();
    const t0 = Date.now();
    const r = await owner("task_wait", { since_rev: before });
    expect(Date.now() - t0).toBeLessThan(900);
    expect(r.body).toMatchObject({ ok: true, changed: true });
    expect(r.body.rev).toBeGreaterThan(before);
    expect(r.body.note).toMatch(/untrusted/);
  });

  it("with id and an already moved since_rev it returns the task right away", async () => {
    const before = await revNow();
    const id = await createTask();
    const r = await owner("task_wait", { id, since_rev: before });
    expect(r.body).toMatchObject({ changed: true, task: { id, status: "open" } });
    expect(r.body.task.brief).toBeUndefined();
  });

  it("returns when another request changes the task status", async () => {
    const id = await createTask();
    const t0 = Date.now();
    const waiting = owner("task_wait", { id, timeout_s: 10 });
    await sleepMs(250);
    await worker("claim_task", { id });
    const r = await waiting;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.body).toMatchObject({ ok: true, changed: true, task: { id, status: "claimed" } });
    expect(r.body.results).toBeUndefined();
  });

  it("without id, wakes on any board change made after the call started", async () => {
    const waiting = owner("task_wait", { timeout_s: 10 });
    await sleepMs(250);
    await createTask();
    const r = await waiting;
    expect(r.body).toMatchObject({ changed: true });
    expect(r.body.task).toBeUndefined();
  });

  it("includes the results when the task reaches done", async () => {
    const id = await createTask();
    await worker("claim_task", { id });
    const waiting = owner("task_wait", { id, timeout_s: 10 });
    await sleepMs(250);
    await worker("submit_result", { id, summary: "all done", links: ["https://example.com/x"] });
    const r = await waiting;
    expect(r.body.task.status).toBe("done");
    expect(r.body.results).toHaveLength(1);
    expect(r.body.results[0]).toMatchObject({ task_id: id, summary: "all done", outcome: "done" });
    expect(r.body.note).toMatch(/untrusted/i);
  });

  it("includes the failed result too, and none for a cancelled task", async () => {
    const a = await createTask();
    await worker("claim_task", { id: a });
    const wa = owner("task_wait", { id: a, timeout_s: 10 });
    await sleepMs(250);
    await worker("submit_result", { id: a, summary: "could not", outcome: "failed" });
    expect((await wa).body.results[0].outcome).toBe("failed");

    const b = await createTask();
    const wb = owner("task_wait", { id: b, timeout_s: 10 });
    await sleepMs(250);
    await owner("task_cancel", { id: b });
    const rb = await wb;
    expect(rb.body).toMatchObject({ changed: true, task: { status: "cancelled" } });
    expect(rb.body.results).toBeUndefined();
  });

  it("a task that is already final returns at once with its results and changed:false", async () => {
    const id = await createTask();
    await worker("claim_task", { id });
    await worker("submit_result", { id, summary: "s" });
    const t0 = Date.now();
    const r = await owner("task_wait", { id, timeout_s: 30 });
    expect(Date.now() - t0).toBeLessThan(900);
    expect(r.body).toMatchObject({ changed: false, final: true, task: { status: "done" } });
    expect(r.body.results).toHaveLength(1);
  });

  it("times out cleanly with changed:false and the current rev", async () => {
    const rev = await revNow();
    const t0 = Date.now();
    const r = await owner("task_wait", { timeout_s: 1 });
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(900);
    expect(took).toBeLessThan(4000);
    expect(r.body).toMatchObject({ ok: true, changed: false, rev });
    expect(r.body.task).toBeUndefined();
  });

  it("with id, a change to another task does not wake it", async () => {
    const id = await createTask();
    const other = await createTask();
    const waiting = owner("task_wait", { id, timeout_s: 1 });
    await sleepMs(200);
    await worker("claim_task", { id: other });
    const r = await waiting;
    expect(r.body).toMatchObject({ changed: false, task: { id, status: "open" } });
  });

  it("unknown task id is not_found", async () => {
    expect((await owner("task_wait", { id: "T-9999" })).body.error.code).toBe("not_found");
  });

  it("is an owner tool: the worker key cannot list or call it", async () => {
    expect(listing("worker").map((t) => t.name)).not.toContain("task_wait");
    expect(listing("owner").map((t) => t.name)).toContain("task_wait");
    const r = await worker("task_wait", { timeout_s: 1 });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe("forbidden");
    const viaDirect = await direct({ timeout_s: 1 }, {}, "worker");
    expect(viaDirect.body.error.code).toBe("forbidden");
    const list = await post(WORKER, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(list.json.result.tools.map((t: any) => t.name)).not.toContain("task_wait");
  });

  it("validates bounds and unknown fields", async () => {
    for (const bad of [{ timeout_s: 0 }, { timeout_s: 51 }, { timeout_s: 1.5 }, { timeout_s: "3" }, { since_rev: -1 }, { since_rev: 1.2 }, { id: "nope" }, { extra: 1 }]) {
      const r = await owner("task_wait", bad);
      expect(r.isError, JSON.stringify(bad)).toBe(true);
      expect(r.body.error.code).toBe("invalid_input");
    }
    expect(waitSchema.parse({})).toEqual({ timeout_s: 25 });
    expect(waitSchema.safeParse({ timeout_s: 50 }).success).toBe(true);
    expect(waitSchema.safeParse({ timeout_s: 1, since_rev: 0, id: "T-0001" }).success).toBe(true);
  });

  it("stops early when the request is aborted", async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = direct({ timeout_s: 30 }, { signal: ac.signal });
    await sleepMs(200);
    ac.abort();
    const r = await p;
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.body).toMatchObject({ ok: true, changed: false, aborted: true });
  });

  it("an already aborted request returns without polling", async () => {
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    const r = await direct({ timeout_s: 30 }, { signal: ac.signal });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(r.body.aborted).toBe(true);
  });
});

/** A fake clock: sleeping advances time, so the loop runs instantly. */
function fakeClock(intervalMs = 1500) {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const deps: WaitDeps = {
    intervalMs,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  };
  return { deps, sleeps, elapsed: () => t - 1_000_000 };
}

describe("waitForChange (pure loop)", () => {
  const states = (list: WaitState[]) => {
    let i = 0;
    const reads: number[] = [];
    return { read: async () => (reads.push(i), list[Math.min(i++, list.length - 1)]), reads };
  };

  it("polls about every 1.5 s and stops at the timeout", async () => {
    const c = fakeClock();
    const s = states([{ rev: 5, status: null }]);
    const out = await waitForChange(s.read, { timeoutS: 5 }, undefined, c.deps);
    expect(out).toMatchObject({ changed: false, rev: 5 });
    expect(c.sleeps).toEqual([1500, 1500, 1500, 500]);
    expect(c.elapsed()).toBe(5000);
    expect(s.reads).toHaveLength(5);
  });

  it("caps wall time at 50 s even if asked for more", async () => {
    const c = fakeClock();
    await waitForChange(async () => ({ rev: 1, status: null }), { timeoutS: 500 }, undefined, c.deps);
    expect(c.elapsed()).toBe(MAX_WAIT_S * 1000);
  });

  it("detects a rev move on the third poll", async () => {
    const c = fakeClock();
    const s = states([{ rev: 5, status: null }, { rev: 5, status: null }, { rev: 5, status: null }, { rev: 6, status: null }]);
    const out = await waitForChange(s.read, { timeoutS: 25 }, undefined, c.deps);
    expect(out).toMatchObject({ changed: true, rev: 6 });
    expect(c.elapsed()).toBe(4500);
  });

  it("uses since_rev as the baseline when it is ahead of the first read", async () => {
    const c = fakeClock();
    const out = await waitForChange(async () => ({ rev: 7, status: null }), { sinceRev: 9, timeoutS: 2 }, undefined, c.deps);
    expect(out.changed).toBe(false);
  });

  it("id mode ignores rev moves and reacts only to a status change", async () => {
    const c = fakeClock();
    const s = states([
      { rev: 5, status: "open" },
      { rev: 6, status: "open" },
      { rev: 7, status: "claimed" },
    ]);
    const out = await waitForChange(s.read, { id: "T-0001", timeoutS: 25 }, undefined, c.deps);
    expect(out).toMatchObject({ changed: true, rev: 7, status: "claimed" });
  });

  it("reports a task that disappeared as missing", async () => {
    const c = fakeClock();
    const s = states([{ rev: 5, status: "open" }, null as unknown as WaitState]);
    const out = await waitForChange(s.read, { id: "T-0001", timeoutS: 25 }, undefined, c.deps);
    expect(out.missing).toBe(true);
  });

  it("abort during a sleep ends the loop with aborted:true", async () => {
    const ac = new AbortController();
    const deps: WaitDeps = {
      intervalMs: 1500,
      now: () => 0,
      sleep: async () => {
        ac.abort();
      },
    };
    const out = await waitForChange(async () => ({ rev: 1, status: null }), { timeoutS: 25 }, ac.signal, deps);
    expect(out).toMatchObject({ changed: false, aborted: true, rev: 1 });
  });

  it("the default sleep wakes at once on abort", async () => {
    const ac = new AbortController();
    const p = waitForChange(async () => ({ rev: 1, status: null }), { timeoutS: 30 }, ac.signal);
    setTimeout(() => ac.abort(), 50);
    const t0 = Date.now();
    expect((await p).aborted).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
