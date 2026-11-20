import type { EventRow, ResultView, TaskRow } from "../types";
import { openTask } from "./codec";
import type { Store } from "./context";
import type { BoardDb } from "./db";
import { isPaused } from "./board";
import { getEvents, getResult, getTask } from "./tasks";

export const COLUMN_LIMIT = 200;

export const COLUMNS = [
  { key: "open", title: "Open", statuses: ["open"] },
  { key: "claimed", title: "Claimed", statuses: ["claimed", "in_progress"] },
  { key: "blocked", title: "Blocked", statuses: ["needs_owner"] },
  { key: "done", title: "Done", statuses: ["done", "failed", "cancelled"] },
] as const;

export interface Card {
  id: string;
  title: string;
  priority: number;
  claimed_by: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
}

export interface ColumnView {
  key: string;
  title: string;
  count: number;
  tasks: Card[];
}

export interface Snapshot {
  paused: boolean;
  marker: string;
  columns: ColumnView[];
}

const toCard = (t: TaskRow): Card => ({
  id: t.id,
  title: t.title,
  priority: t.priority,
  claimed_by: t.claimed_by,
  status: t.status,
  created_at: t.created_at,
  updated_at: t.updated_at,
  last_activity_at: t.last_activity_at,
});

/** The board revision: one primary-key read. A trigger bumps it inside the transaction of every write the board shows. */
export async function changeMarker(db: BoardDb): Promise<string> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'board_rev'").first<{ value: string }>();
  return row?.value ?? "0";
}

/** Web-session generation (`meta.session_gen`, absent = 0). One primary-key read; no migration needed. */
export async function sessionGeneration(db: BoardDb): Promise<number> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'session_gen'").first<{ value: string }>();
  const n = Number(row?.value ?? 0);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** Invalidates every web session issued so far. */
export async function bumpSessionGeneration(db: BoardDb): Promise<void> {
  await db
    .prepare("INSERT INTO meta (key, value) VALUES ('session_gen', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1")
    .run();
}

async function loadColumn(s: Store, statuses: readonly string[]): Promise<{ count: number; tasks: Card[] }> {
  const marks = statuses.map(() => "?").join(", ");
  const [rows, total] = await Promise.all([
    s.db
      .prepare(`SELECT * FROM tasks WHERE status IN (${marks}) ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .bind(...statuses, COLUMN_LIMIT)
      .all<TaskRow>(),
    s.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status IN (${marks})`).bind(...statuses).first<{ n: number }>(),
  ]);
  const opened = await Promise.all(rows.results.map((r) => openTask(s, r)));
  return { count: total?.n ?? 0, tasks: opened.map(toCard) };
}

export async function boardSnapshot(s: Store): Promise<Snapshot> {
  const [marker, paused, columns] = await Promise.all([
    changeMarker(s.db),
    isPaused(s.db),
    Promise.all(COLUMNS.map(async (c) => ({ key: c.key, title: c.title, ...(await loadColumn(s, c.statuses)) }))),
  ]);
  return { paused, marker, columns };
}

export interface TaskDetail {
  task: TaskRow;
  events: EventRow[];
  result: ResultView | null;
}

export async function taskDetail(s: Store, id: string): Promise<TaskDetail | null> {
  const task = await getTask(s, id);
  if (!task) return null;
  const [events, result] = await Promise.all([getEvents(s, id), getResult(s, id)]);
  return { task, events, result };
}
