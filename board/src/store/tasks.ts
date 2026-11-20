import { ORIGIN } from "../types";
import type { EventRow, ResultView, Status, TaskRow } from "../types";
import { nextEventIds } from "./board";
import { openEvent, openResult, openTask, sealEventNote, sealText, type ResultRow } from "./codec";
import type { Store } from "./context";
import { transition, type TransitionResult } from "./transition";

export interface NewTask {
  title: string;
  brief: string;
  deliverable: string;
  acceptance: string;
  priority: number;
  deadline?: string;
}

const taskId = (n: number | string): string => `T-${String(n).padStart(4, "0")}`;

export async function createTask(s: Store, input: NewTask, now: string, actor: string): Promise<TaskRow> {
  const seq = await s.db
    .prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'task_seq' RETURNING value")
    .first<{ value: string | number }>();
  const id = taskId(seq?.value ?? 0);
  const deadline = input.deadline ? new Date(input.deadline).toISOString() : null;
  const [eventId] = await nextEventIds(s.db);
  const [title, brief, deliverable, acceptance, note] = await Promise.all([
    sealText(s, "tasks", "title", id, input.title),
    sealText(s, "tasks", "brief", id, input.brief),
    sealText(s, "tasks", "deliverable", id, input.deliverable),
    sealText(s, "tasks", "acceptance", id, input.acceptance),
    sealEventNote(s, id, eventId, input.title),
  ]);
  await s.db.batch([
    s.db
      .prepare(
        "INSERT INTO tasks (id, title, brief, deliverable, acceptance, priority, deadline, status, origin, " +
          "created_at, updated_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)",
      )
      .bind(id, title, brief, deliverable, acceptance, input.priority, deadline, ORIGIN, now, now, now),
    s.db
      .prepare("INSERT INTO events (id, task_id, at, actor, kind, to_status, note) VALUES (?, ?, ?, ?, 'created', 'open', ?)")
      .bind(eventId, id, now, actor, note),
  ]);
  return (await getTask(s, id)) as TaskRow;
}

export async function getTask(s: Store, id: string): Promise<TaskRow | null> {
  const row = await s.db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<TaskRow>();
  return row ? openTask(s, row) : null;
}

export async function listTasks(s: Store, status: Status | undefined, limit: number): Promise<TaskRow[]> {
  const where = status ? "WHERE status = ?" : "";
  const stmt = s.db.prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC, id DESC LIMIT ?`);
  const res = await (status ? stmt.bind(status, limit) : stmt.bind(limit)).all<TaskRow>();
  return Promise.all(res.results.map((r) => openTask(s, r)));
}

export async function listOpen(s: Store, limit: number): Promise<TaskRow[]> {
  const res = await s.db
    .prepare("SELECT * FROM tasks WHERE status = 'open' ORDER BY priority ASC, created_at ASC, id ASC LIMIT ?")
    .bind(limit)
    .all<TaskRow>();
  return Promise.all(res.results.map((r) => openTask(s, r)));
}

export async function getEvents(s: Store, id: string): Promise<EventRow[]> {
  const res = await s.db.prepare("SELECT * FROM events WHERE task_id = ? ORDER BY id ASC").bind(id).all<EventRow>();
  return Promise.all(res.results.map((r) => openEvent(s, r)));
}

export async function recentNotes(s: Store, id: string, n = 10): Promise<EventRow[]> {
  const res = await s.db
    .prepare(
      "SELECT * FROM events WHERE task_id = ? AND kind IN ('progress', 'question', 'answer') ORDER BY id DESC LIMIT ?",
    )
    .bind(id, n)
    .all<EventRow>();
  return (await Promise.all(res.results.map((r) => openEvent(s, r)))).reverse();
}

export async function getResult(s: Store, id: string): Promise<ResultView | null> {
  const row = await s.db.prepare("SELECT * FROM results WHERE task_id = ?").bind(id).first<ResultRow>();
  return row ? openResult(s, row) : null;
}

export async function listResults(s: Store, limit: number): Promise<ResultView[]> {
  const res = await s.db
    .prepare("SELECT * FROM results ORDER BY created_at DESC, task_id DESC LIMIT ?")
    .bind(limit)
    .all<ResultRow>();
  return Promise.all(res.results.map((r) => openResult(s, r)));
}

/**
 * One primary-key read for task_wait: the board revision (meta.board_rev, bumped by triggers) and, when an id is
 * given, that task's status in the same query (D1 limits the queries per invocation, so a poll must cost one).
 * Returns null when the id does not exist.
 */
export async function readWaitState(s: Store, id?: string): Promise<{ rev: number; status: string | null } | null> {
  const rev = "(SELECT value FROM meta WHERE key = 'board_rev')";
  if (!id) {
    const row = await s.db.prepare(`SELECT ${rev} AS rev`).first<{ rev: string | number | null }>();
    return { rev: Number(row?.rev ?? 0), status: null };
  }
  const row = await s.db.prepare(`SELECT status, ${rev} AS rev FROM tasks WHERE id = ?`).bind(id).first<{ status: string; rev: string | number | null }>();
  return row ? { rev: Number(row.rev ?? 0), status: row.status } : null;
}

const ACTIVE: readonly Status[] = ["claimed", "in_progress"];

export const claim = (s: Store, id: string, actor: string, now: string): Promise<TransitionResult> =>
  transition(s, { id, from: ["open"], to: "claimed", actor, kind: "claimed", now, sets: { claimed_by: actor, claimed_at: now } });

export const progress = (s: Store, id: string, note: string, actor: string, now: string): Promise<TransitionResult> =>
  transition(s, { id, from: ACTIVE, to: "in_progress", actor, kind: "progress", note, now });

export const askOwner = (s: Store, id: string, question: string, actor: string, now: string): Promise<TransitionResult> =>
  transition(s, { id, from: ACTIVE, to: "needs_owner", actor, kind: "question", note: question, now, sets: { question, owner_reply: null } });

export const answer = (s: Store, id: string, reply: string, actor: string, now: string): Promise<TransitionResult> =>
  transition(s, { id, from: ["needs_owner"], to: "in_progress", actor, kind: "answer", note: reply, now, sets: { owner_reply: reply } });

export const cancel = (s: Store, id: string, reason: string, actor: string, now: string): Promise<TransitionResult> =>
  transition(s, { id, from: ["open", "claimed", "in_progress", "needs_owner"], to: "cancelled", actor, kind: "cancelled", note: reason || null, now });

export interface NewResult {
  outcome: "done" | "failed";
  summary: string;
  links: string[];
  notes: string;
}

export async function submit(s: Store, id: string, r: NewResult, actor: string, now: string): Promise<TransitionResult> {
  const [summary, links, notes] = await Promise.all([
    sealText(s, "results", "summary", id, r.summary),
    sealText(s, "results", "links", id, JSON.stringify(r.links)),
    sealText(s, "results", "notes", id, r.notes),
  ]);
  const insert = s.db
    .prepare(
      "INSERT INTO results (task_id, outcome, summary, links, notes, submitted_by, created_at) " +
        "SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0",
    )
    .bind(id, r.outcome, summary, links, notes, actor, now);
  return transition(s, {
    id,
    from: ["claimed", "in_progress", "needs_owner"],
    to: r.outcome,
    actor,
    kind: "result",
    note: `${r.outcome}: ${r.summary.slice(0, 200)}`,
    now,
    extra: [insert],
  });
}
