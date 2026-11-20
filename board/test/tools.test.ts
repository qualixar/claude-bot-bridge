import { db } from "#harness";
import { describe, expect, it } from "vitest";
import { createTask, owner, sampleTask, worker } from "./helpers";

describe("owner tools", () => {
  it("task_create returns a T-0001 style id with fixed origin and defaults", async () => {
    const r = await owner("task_create", { title: "A", brief: "b", deliverable: "d" });
    expect(r.body.ok).toBe(true);
    expect(r.body.task).toMatchObject({ id: "T-0001", status: "open", priority: 2, origin: "Claude Code (owner's orchestrator)", acceptance: "" });
    expect((await owner("task_create", sampleTask())).body.task.id).toBe("T-0002");
  });

  it("normalises the deadline to UTC ISO", async () => {
    const r = await owner("task_create", sampleTask({ deadline: "2026-12-01T18:00:00+02:00" }));
    expect(r.body.task.deadline).toBe("2026-12-01T16:00:00.000Z");
  });

  it("task_list filters by status and orders newest first", async () => {
    const a = await createTask();
    const b = await createTask();
    await worker("claim_task", { id: a });
    expect((await owner("task_list")).body.tasks.map((t: any) => t.id)).toEqual([b, a]);
    expect((await owner("task_list", { status: "claimed" })).body.tasks.map((t: any) => t.id)).toEqual([a]);
  });

  it("task_get returns the full event log and result", async () => {
    const id = await createTask();
    await worker("claim_task", { id });
    await worker("post_progress", { id, note: "halfway" });
    await worker("submit_result", { id, summary: "done it", links: ["https://example.com/a"] });
    const r = await owner("task_get", { id });
    expect(r.body.events.map((e: any) => e.kind)).toEqual(["created", "claimed", "progress", "result"]);
    expect(r.body.events[1]).toMatchObject({ actor: "Muse", to_status: "claimed" });
    expect(r.body.result.summary).toBe("done it");
    expect(r.body.note).toMatch(/untrusted/);
    expect((await owner("task_get", { id: "T-9999" })).body.error.code).toBe("not_found");
  });

  it("task_results returns one result, the latest results, or not_found", async () => {
    const a = await createTask();
    const b = await createTask();
    for (const id of [a, b]) {
      await worker("claim_task", { id });
      await worker("submit_result", { id, summary: `s-${id}`, notes: "caveat" });
    }
    expect((await owner("task_results", { id: a })).body.results[0]).toMatchObject({ summary: `s-${a}`, notes: "caveat", links: [] });
    expect((await owner("task_results")).body.results).toHaveLength(2);
    expect((await owner("task_results", { id: "T-0099" })).body.error.code).toBe("not_found");
  });

  it("task_answer needs a pending question and returns the task to in_progress", async () => {
    const id = await createTask();
    await worker("claim_task", { id });
    expect((await owner("task_answer", { id, reply: "x" })).body.error.code).toBe("invalid_state");
    await worker("ask_owner", { id, question: "Which year?" });
    expect((await owner("task_answer", { id, reply: "2026" })).body.status).toBe("in_progress");
    const t = await worker("get_task", { id });
    expect(t.body.task).toMatchObject({ status: "in_progress", owner_reply: "2026", question: "Which year?" });
    expect(t.body.recent_notes.map((e: any) => e.kind)).toEqual(["question", "answer"]);
  });

  it("task_cancel cancels active tasks, not finished ones, and tells the worker to stop", async () => {
    const id = await createTask();
    await worker("claim_task", { id });
    expect((await owner("task_cancel", { id, reason: "not needed" })).body.status).toBe("cancelled");
    const late = await worker("post_progress", { id, note: "still going" });
    expect(late.body.error).toMatchObject({ code: "invalid_state", current_status: "cancelled" });
    expect(late.body.error.message).toMatch(/stop work/);
    expect((await owner("task_cancel", { id })).body.error.code).toBe("invalid_state");
    expect((await owner("task_cancel", { id: "T-0404" })).body.error.code).toBe("not_found");
  });
});

describe("worker tools", () => {
  it("list_open_tasks shows only open tasks, by priority then age", async () => {
    const low = await createTask({ priority: 3 });
    const high = await createTask({ priority: 1 });
    const mid = await createTask({ priority: 2 });
    const claimed = await createTask({ priority: 1 });
    await worker("claim_task", { id: claimed });
    const r = await worker("list_open_tasks");
    expect(r.body.tasks.map((t: any) => t.id)).toEqual([high, mid, low]);
    expect(r.body.tasks[0].brief).toBeUndefined();
    expect((await worker("list_open_tasks", { limit: 1 })).body.count).toBe(1);
    expect((await owner("list_open_tasks")).body.count).toBe(3);
  });

  it("claim_task returns the full task and records the claimant", async () => {
    const id = await createTask();
    const r = await worker("claim_task", { id });
    expect(r.body.task).toMatchObject({ id, status: "claimed", claimed_by: "Muse", brief: "Find three sources about X." });
    expect((await worker("claim_task", { id: "T-0777" })).body.error.code).toBe("not_found");
  });

  it("get_task works for both roles and reports unknown ids", async () => {
    const id = await createTask();
    expect((await worker("get_task", { id })).body.task.id).toBe(id);
    expect((await owner("get_task", { id })).body.task.status).toBe("open");
    expect((await worker("get_task", { id: "T-0500" })).body.error.code).toBe("not_found");
  });

  it("post_progress moves claimed to in_progress and needs a claimed task", async () => {
    const id = await createTask();
    expect((await worker("post_progress", { id, note: "early" })).body.error.code).toBe("invalid_state");
    await worker("claim_task", { id });
    expect((await worker("post_progress", { id, note: "going" })).body.status).toBe("in_progress");
    expect((await worker("post_progress", { id, note: "again" })).body.ok).toBe(true);
  });

  it("ask_owner moves to needs_owner and keeps the question", async () => {
    const id = await createTask();
    await worker("claim_task", { id });
    expect((await worker("ask_owner", { id, question: "Which one?" })).body.status).toBe("needs_owner");
    expect((await owner("task_get", { id })).body.task).toMatchObject({ status: "needs_owner", question: "Which one?" });
    expect((await worker("ask_owner", { id, question: "again" })).body.error.code).toBe("invalid_state");
  });

  it("submit_result stores summary, links and notes once, and can report failure", async () => {
    const id = await createTask();
    await worker("claim_task", { id });
    const r = await worker("submit_result", { id, summary: "answer", links: ["https://a.example/x", "https://b.example/y"], notes: "n" });
    expect(r.body).toMatchObject({ ok: true, status: "done" });
    expect((await worker("submit_result", { id, summary: "again" })).body.error.code).toBe("invalid_state");
    const failed = await createTask();
    await worker("claim_task", { id: failed });
    await worker("submit_result", { id: failed, summary: "blocked by login", outcome: "failed" });
    expect((await owner("task_get", { id: failed })).body.task.status).toBe("failed");
    expect((await worker("submit_result", { id: "T-0888", summary: "x" })).body.error.code).toBe("not_found");
  });

  it("submit_result from needs_owner is allowed so a stuck task can be closed", async () => {
    const id = await createTask();
    await worker("claim_task", { id });
    await worker("ask_owner", { id, question: "?" });
    expect((await worker("submit_result", { id, summary: "gave up", outcome: "failed" })).body.ok).toBe(true);
  });

  it("heartbeat reports counts and refreshes held tasks", async () => {
    const id = await createTask();
    await createTask();
    await worker("claim_task", { id });
    await db.prepare("UPDATE tasks SET last_activity_at = ? WHERE id = ?").bind(new Date(Date.now() - 100 * 60_000).toISOString(), id).run();
    const r = await worker("heartbeat");
    expect(r.body).toMatchObject({ board: "running", your_active_tasks: 1, counts: { claimed: 1, open: 1 } });
    const t = await db.prepare("SELECT last_activity_at FROM tasks WHERE id = ?").bind(id).first<{ last_activity_at: string }>();
    expect(t!.last_activity_at > new Date(Date.now() - 60_000).toISOString()).toBe(true);
    expect((await owner("heartbeat")).body.your_active_tasks).toBe(0);
  });
});
