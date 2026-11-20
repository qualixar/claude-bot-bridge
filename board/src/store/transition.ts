import type { Status, TaskRow } from "../types";
import type { Store } from "./context";
import { sealEventNoteNullable, sealNullable } from "./codec";
import { nextEventIds } from "./board";
import type { BoardStatement } from "./db";

type PlainColumn = "claimed_by" | "claimed_at";
type SealedColumn = "question" | "owner_reply";

export interface Transition {
  id: string;
  from: readonly Status[];
  to: Status;
  actor: string;
  kind: string;
  note?: string | null;
  now: string;
  /** Plaintext values; `question` and `owner_reply` are encrypted before they are written. */
  sets?: Partial<Record<PlainColumn | SealedColumn, string | null>>;
  /** Statements that must only take effect when the task update matched. Each must end `WHERE changes() > 0`. */
  extra?: BoardStatement[];
}

export type TransitionResult =
  | { ok: true }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid_state"; current: Status };

const EVENT_SQL =
  "INSERT INTO events (id, task_id, at, actor, kind, to_status, note) SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0";

const SEALED = new Set<string>(["question", "owner_reply"]);

async function sealedSets(s: Store, t: Transition): Promise<[string, string | null][]> {
  return Promise.all(
    Object.entries(t.sets ?? {}).map(async ([col, value]): Promise<[string, string | null]> => [
      col,
      SEALED.has(col) ? await sealNullable(s, "tasks", col, t.id, value) : (value ?? null),
    ]),
  );
}

function buildUpdate(s: Store, t: Transition, sets: [string, string | null][]): BoardStatement {
  const cols = ["status = ?", "updated_at = ?", "last_activity_at = ?", ...sets.map(([c]) => `${c} = ?`)];
  const marks = t.from.map(() => "?").join(", ");
  const sql = `UPDATE tasks SET ${cols.join(", ")} WHERE id = ? AND status IN (${marks})`;
  return s.db.prepare(sql).bind(t.to, t.now, t.now, ...sets.map(([, v]) => v), t.id, ...t.from);
}

/**
 * Atomic compare-and-set on the task status. The UPDATE only matches when the task is in an
 * allowed state, and the event row (and any extras) are written only if it matched, all in one batch.
 */
export async function transition(s: Store, t: Transition): Promise<TransitionResult> {
  const [eventId] = await nextEventIds(s.db);
  const [sets, note] = await Promise.all([sealedSets(s, t), sealEventNoteNullable(s, t.id, eventId, t.note)]);
  const event = s.db.prepare(EVENT_SQL).bind(eventId, t.id, t.now, t.actor, t.kind, t.to, note);
  const results = await s.db.batch([buildUpdate(s, t, sets), ...(t.extra ?? []), event]);
  if ((results[0].meta.changes ?? 0) > 0) return { ok: true };
  const row = await s.db.prepare("SELECT status FROM tasks WHERE id = ?").bind(t.id).first<Pick<TaskRow, "status">>();
  return row ? { ok: false, reason: "invalid_state", current: row.status } : { ok: false, reason: "not_found" };
}
