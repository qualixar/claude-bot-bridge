import { STALE_AFTER_MS } from "../types";
import { sealEventNote } from "./codec";
import type { Store } from "./context";
import type { BoardDb } from "./db";

export async function isPaused(db: BoardDb): Promise<boolean> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'paused'").first<{ value: string }>();
  return row?.value === "1";
}

/**
 * Reserves `count` event ids. Every event insert uses ids from this counter (never AUTOINCREMENT),
 * so a ciphertext can be bound to the id of the event that holds it. Ids that end up unused are just gaps.
 */
export async function nextEventIds(db: BoardDb, count = 1): Promise<number[]> {
  const row = await db
    .prepare("UPDATE meta SET value = CAST(value AS INTEGER) + ? WHERE key = 'event_seq' RETURNING value")
    .bind(count)
    .first<{ value: string | number }>();
  if (!row) throw new Error("Database schema is out of date (meta.event_seq is missing): apply the migrations.");
  const last = Number(row.value);
  return Array.from({ length: count }, (_, i) => last - count + 1 + i);
}

export async function setPaused(db: BoardDb, paused: boolean, actor: string, now: string): Promise<boolean> {
  const [eventId] = await nextEventIds(db);
  const results = await db.batch([
    db.prepare("UPDATE meta SET value = ? WHERE key = 'paused'").bind(paused ? "1" : "0"),
    db
      .prepare("INSERT INTO events (id, task_id, at, actor, kind, to_status, note) VALUES (?, NULL, ?, ?, ?, NULL, NULL)")
      .bind(eventId, now, actor, paused ? "board_pause" : "board_resume"),
  ]);
  return (results[0].meta.changes ?? 0) > 0;
}

/** Increments the per-minute counter for `scope` and returns the new count. */
export async function bumpCounter(db: BoardDb, scope: string, nowMs: number): Promise<number> {
  const minute = Math.floor(nowMs / 60_000);
  const row = await db
    .prepare(
      "INSERT INTO rate_limits (scope, minute, count) VALUES (?, ?, 1) " +
        "ON CONFLICT (scope, minute) DO UPDATE SET count = count + 1 RETURNING count",
    )
    .bind(scope, minute)
    .first<{ count: number }>();
  const count = row?.count ?? 1;
  if (count === 1) await pruneRateLimits(db, nowMs);
  return count;
}

/** Reads the current minute's counter without changing it. */
export async function readCounter(db: BoardDb, scope: string, nowMs: number): Promise<number> {
  const row = await db
    .prepare("SELECT count FROM rate_limits WHERE scope = ? AND minute = ?")
    .bind(scope, Math.floor(nowMs / 60_000))
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * Per-minute counter. Returns true while the caller is within `limit` requests for the current minute.
 * Old buckets are pruned whenever a new minute bucket is created.
 */
export async function withinRateLimit(db: BoardDb, scope: string, nowMs: number, limit: number): Promise<boolean> {
  return (await bumpCounter(db, scope, nowMs)) <= limit;
}

export async function pruneRateLimits(db: BoardDb, nowMs: number): Promise<void> {
  const cutoff = Math.floor(nowMs / 60_000) - 10;
  await db.prepare("DELETE FROM rate_limits WHERE minute < ?").bind(cutoff).run();
}

/** Returns claimed/in_progress tasks with no heartbeat or progress for 2 hours to `open`. */
export async function reclaimStale(s: Store, nowMs: number): Promise<string[]> {
  const now = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - STALE_AFTER_MS).toISOString();
  const res = await s.db
    .prepare(
      "UPDATE tasks SET status = 'open', claimed_by = NULL, claimed_at = NULL, updated_at = ?, last_activity_at = ? " +
        "WHERE status IN ('claimed', 'in_progress') AND last_activity_at < ? RETURNING id",
    )
    .bind(now, now, cutoff)
    .all<{ id: string }>();
  const ids = res.results.map((r) => r.id);
  if (ids.length > 0) {
    const insert = s.db.prepare(
      "INSERT INTO events (id, task_id, at, actor, kind, to_status, note) VALUES (?, ?, ?, 'system', 'stale_reclaim', 'open', ?)",
    );
    const note = "No heartbeat or progress for 2 hours; returned to open.";
    const eventIds = await nextEventIds(s.db, ids.length);
    const sealed = await Promise.all(ids.map((id, i) => sealEventNote(s, id, eventIds[i], note)));
    await s.db.batch(ids.map((id, i) => insert.bind(eventIds[i], id, now, sealed[i])));
  }
  return ids;
}

/**
 * Refreshes the stale clock for every task the worker holds. There is one worker role, so this does not
 * depend on the display name: renaming WORKER_NAME must never strand tasks claimed under the old name.
 */
export async function touchClaimed(db: BoardDb, now: string): Promise<number> {
  // RETURNING, not meta.changes: D1 counts trigger writes in `changes`, so it would over-count.
  const res = await db
    .prepare("UPDATE tasks SET last_activity_at = ? WHERE status IN ('claimed', 'in_progress') RETURNING id")
    .bind(now)
    .all<{ id: string }>();
  return res.results.length;
}

export async function countByStatus(db: BoardDb): Promise<Record<string, number>> {
  const res = await db
    .prepare("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status")
    .all<{ status: string; n: number }>();
  return Object.fromEntries(res.results.map((r) => [r.status, r.n]));
}
