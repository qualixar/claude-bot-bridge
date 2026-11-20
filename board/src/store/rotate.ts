import { ENC_PREFIX_V2, VaultError, aadFor } from "../crypto/vault";
import { ToolError } from "../errors";
import { TASK_TEXT, eventAad } from "./codec";
import type { Store } from "./context";
import type { BoardStatement } from "./db";

export interface RotateResult {
  scanned: number;
  /** Rows whose update actually changed a row. */
  rewritten: number;
  /** Rows whose update matched nothing because the row changed underneath us; repeat the pass. */
  skipped: number;
  /** Values that cannot be decrypted with the configured keys. They are reported, never fatal. */
  unreadable: number;
  /** Verify mode only: values not yet on the current key (and, for events, not yet enc:v2). */
  stale: number;
  /** Pass this back to continue; null when every table has been scanned. */
  next_cursor: string | null;
}

interface Spec {
  table: "tasks" | "events" | "results";
  key: string;
  numericKey: boolean;
  columns: readonly string[];
  where: string;
  aadId: (row: Record<string, unknown>) => string;
}

const SPECS: readonly Spec[] = [
  { table: "tasks", key: "id", numericKey: false, columns: TASK_TEXT, where: "", aadId: (r) => String(r.id) },
  { table: "events", key: "id", numericKey: true, columns: ["note"], where: "AND note IS NOT NULL AND task_id IS NOT NULL", aadId: (r) => String(r.task_id) },
  { table: "results", key: "task_id", numericKey: false, columns: ["summary", "links", "notes"], where: "", aadId: (r) => String(r.task_id) },
];

const CURSOR = /^(tasks|events|results):(T-\d{1,10}|\d{1,15})?$/;

function parseCursor(cursor: string | undefined): { index: number; after: string } {
  if (!cursor) return { index: 0, after: "" };
  const m = CURSOR.exec(cursor);
  if (!m) throw new ToolError("invalid_input", "cursor: not a cursor returned by a previous call");
  return { index: SPECS.findIndex((s) => s.table === m[1]), after: m[2] ?? "" };
}

type Verdict = { kind: "current" } | { kind: "unreadable" } | { kind: "stale"; next: string };

/** Where the value is read with (whatever it was written with) and written to (the current scheme). */
function aads(spec: Spec, row: Record<string, unknown>, column: string, stored: string): { read: string; write: string; version: 1 | 2 } {
  if (spec.table !== "events") {
    const aad = aadFor(spec.table, column, spec.aadId(row));
    return { read: aad, write: aad, version: 1 };
  }
  const taskId = String(row.task_id);
  const legacy = aadFor("events", "note", taskId);
  const current = eventAad(taskId, Number(row.id));
  return { read: stored.startsWith(ENC_PREFIX_V2) ? current : legacy, write: current, version: 2 };
}

async function judge(s: Store, spec: Spec, row: Record<string, unknown>, column: string): Promise<Verdict | null> {
  const stored = row[column];
  if (typeof stored !== "string") return null;
  const a = aads(spec, row, column, stored);
  try {
    const opened = await s.vault.inspect(a.read, stored);
    const upToDate = opened.current && (a.version === 1 || stored.startsWith(ENC_PREFIX_V2));
    return upToDate ? { kind: "current" } : { kind: "stale", next: await s.vault.seal(a.write, opened.text, a.version) };
  } catch (err) {
    if (err instanceof VaultError) return { kind: "unreadable" };
    throw err;
  }
}

interface RowPlan {
  statement: BoardStatement | null;
  unreadable: number;
  stale: number;
}

async function planRow(s: Store, spec: Spec, row: Record<string, unknown>): Promise<RowPlan> {
  const changes: { column: string; next: string }[] = [];
  let unreadable = 0;
  for (const column of spec.columns) {
    const v = await judge(s, spec, row, column);
    if (v?.kind === "unreadable") unreadable++;
    else if (v?.kind === "stale") changes.push({ column, next: v.next });
  }
  if (changes.length === 0) return { statement: null, unreadable, stale: 0 };
  // Compare-and-set on the old ciphertext so a concurrent write is never overwritten with stale data.
  const set = changes.map((c) => `${c.column} = ?`).join(", ");
  const guard = changes.map((c) => `${c.column} = ?`).join(" AND ");
  const binds = [...changes.map((c) => c.next), row[spec.key] as string | number, ...changes.map((c) => row[c.column] as string)];
  return { statement: s.db.prepare(`UPDATE ${spec.table} SET ${set} WHERE ${spec.key} = ? AND ${guard}`).bind(...binds), unreadable, stale: changes.length };
}

/**
 * Re-encrypts one page of rows with the current key (legacy plaintext, previous-key values and v1 event
 * notes are rewritten; values already current are left alone). A row counts as rewritten only when its
 * UPDATE changed a row; if the row changed underneath us it is `skipped` and a repeat pass picks it up.
 * With `verify` nothing is written: `stale` counts the values that still are not on the current key.
 * Call repeatedly until `next_cursor` is null.
 */
export async function rotateBatch(s: Store, cursor: string | undefined, limit: number, opts: { verify?: boolean } = {}): Promise<RotateResult> {
  if (!s.vault.encrypting) throw new ToolError("invalid_state", "No BOARD_ENCRYPTION_KEY is configured, so there is nothing to rotate to.");
  const { index, after } = parseCursor(cursor);
  const spec = SPECS[index];
  const res = await s.db
    .prepare(`SELECT * FROM ${spec.table} WHERE ${spec.key} > ? ${spec.where} ORDER BY ${spec.key} ASC LIMIT ?`)
    .bind(spec.numericKey ? Number(after || 0) : after, limit)
    .all<Record<string, unknown>>();
  const plans = await Promise.all(res.results.map((row) => planRow(s, spec, row)));
  const writes = plans.filter((p) => p.statement !== null);
  const unreadable = plans.reduce((n, p) => n + p.unreadable, 0);
  const stale = plans.reduce((n, p) => n + p.stale, 0);
  let rewritten = 0;
  if (!opts.verify && writes.length > 0) {
    const results = await s.db.batch(writes.map((p) => p.statement as BoardStatement));
    rewritten = results.filter((r) => (r.meta.changes ?? 0) > 0).length;
  }
  const last = res.results.at(-1)?.[spec.key];
  const nextSpec = SPECS[index + 1];
  const next = res.results.length === limit ? `${spec.table}:${last}` : nextSpec ? `${nextSpec.table}:` : null;
  return {
    scanned: res.results.length,
    rewritten,
    skipped: opts.verify ? 0 : writes.length - rewritten,
    unreadable,
    stale: opts.verify ? stale : 0,
    next_cursor: next,
  };
}
