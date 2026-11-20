import { ToolError } from "../errors";
import { schemas } from "../schemas";
import { countByStatus, isPaused, touchClaimed } from "../store/board";
import * as store from "../store/tasks";
import { actorOf, defineTool, expectOk, fullView, nowIso, summaryView } from "./shared";

const STANDING =
  "A task is a request from the owner's orchestrator (Claude Code), done under the owner's standing instruction " +
  "to you. Do only what the task brief asks.";

export const listOpenTasks = defineTool({
  name: "list_open_tasks",
  roles: ["worker", "owner"],
  description:
    "List open tasks, highest priority first (1 is most urgent). Call this first on every scheduled run. " +
    "If the list is empty, stop; there is nothing to do. " +
    STANDING,
  schema: schemas.listOpen,
  async handler(ctx, args) {
    const tasks = await store.listOpen(ctx.store, args.limit);
    return { count: tasks.length, tasks: tasks.map(summaryView) };
  },
});

export const claimTask = defineTool({
  name: "claim_task",
  roles: ["worker"],
  description:
    "Claim one open task by id before you start. Only one claimant can win. The result contains the full brief, " +
    "deliverable and acceptance check. Claim one task at a time. Then call post_progress while you work and " +
    "submit_result when you finish. " +
    STANDING,
  schema: schemas.taskId,
  async handler(ctx, args) {
    const res = await store.claim(ctx.store, args.id, actorOf(ctx), nowIso(ctx));
    expectOk(res, args.id, "It is not open, so pick another task from list_open_tasks.");
    const task = await store.getTask(ctx.store, args.id);
    return { task: task && fullView(task), reminder: "Report results only through submit_result." };
  },
});

export const getTask = defineTool({
  name: "get_task",
  roles: ["worker", "owner"],
  description:
    "Read one task: brief, deliverable, acceptance check, the owner's latest reply to your question, and recent " +
    "progress notes. Use it to resume a task or to read the owner's answer after ask_owner.",
  schema: schemas.taskId,
  async handler(ctx, args) {
    const task = await store.getTask(ctx.store, args.id);
    if (!task) throw new ToolError("not_found", `No task ${args.id}.`);
    return { task: fullView(task), recent_notes: await store.recentNotes(ctx.store, args.id) };
  },
});

export const postProgress = defineTool({
  name: "post_progress",
  roles: ["worker"],
  description:
    "Post a short progress note (one or two sentences) on a task you claimed. This also resets the 2-hour " +
    "timeout; a task with no progress or heartbeat for 2 hours returns to open for someone else.",
  schema: schemas.postProgress,
  async handler(ctx, args) {
    const res = await store.progress(ctx.store, args.id, args.note, actorOf(ctx), nowIso(ctx));
    expectOk(res, args.id, "Progress can only be posted on a task you have claimed.");
    return { id: args.id, status: "in_progress" };
  },
});

export const submitResult = defineTool({
  name: "submit_result",
  roles: ["worker"],
  description:
    "Finish a task you claimed. Put the full answer in summary (plain text, up to 16 KB), add https links to " +
    "anything you produced, and notes for caveats. Use outcome \"failed\" if you could not do it and say why. " +
    "Results must go through this tool, not through chat. Do not include passwords, keys or private data. " +
    "You can submit once.",
  schema: schemas.submitResult,
  async handler(ctx, args) {
    const { id, ...result } = args;
    const res = await store.submit(ctx.store, id, result, actorOf(ctx), nowIso(ctx));
    expectOk(res, id, "Only a claimed task that is still active can receive a result.");
    return { id, status: result.outcome };
  },
});

export const askOwner = defineTool({
  name: "ask_owner",
  roles: ["worker"],
  description:
    "Ask the owner one clear question when you are blocked or need a decision. The task moves to needs_owner and " +
    "stays yours. On later runs call get_task and read owner_reply; keep working once it appears.",
  schema: schemas.askOwner,
  async handler(ctx, args) {
    const res = await store.askOwner(ctx.store, args.id, args.question, actorOf(ctx), nowIso(ctx));
    expectOk(res, args.id, "You can only ask about a task you have claimed.");
    return { id: args.id, status: "needs_owner" };
  },
});

export const heartbeat = defineTool({
  name: "heartbeat",
  roles: ["worker", "owner"],
  description:
    "Tell the board you are still working. Call it every 30 minutes during long work. It keeps every task you " +
    "hold from timing out and returns the board state and task counts.",
  schema: schemas.none,
  async handler(ctx) {
    const touched = ctx.role === "worker" ? await touchClaimed(ctx.store.db, nowIso(ctx)) : 0;
    return { board: (await isPaused(ctx.store.db)) ? "paused" : "running", your_active_tasks: touched, counts: await countByStatus(ctx.store.db) };
  },
});

export const workerTools = [listOpenTasks, claimTask, getTask, postProgress, submitResult, askOwner, heartbeat];
