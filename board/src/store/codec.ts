import { ENC_PREFIX_V2, VaultError, aadFor } from "../crypto/vault";
import type { EventRow, ResultView, TaskRow } from "../types";
import type { Store } from "./context";

/**
 * Free-text columns that are encrypted at rest. Encryption happens here, at the store boundary, so
 * tools and web routes only ever see plaintext.
 */
export const TASK_TEXT = ["title", "brief", "deliverable", "acceptance", "question", "owner_reply"] as const;

/** Shown in place of a value that cannot be decrypted (key missing, wrong key, tampered). */
export const UNREADABLE = "[unreadable: key missing]";

export const sealText = (s: Store, table: string, column: string, id: string, value: string): Promise<string> =>
  s.vault.seal(aadFor(table, column, id), value);

export async function sealNullable(s: Store, table: string, column: string, id: string, value: string | null | undefined): Promise<string | null> {
  return value === null || value === undefined ? null : sealText(s, table, column, id, value);
}

/** Event notes are bound to their task and their own event id (enc:v2). Legacy notes used task id only (enc:v1). */
export const eventAad = (taskId: string, eventId: number): string => `events.note.${taskId}.${eventId}`;

export const sealEventNote = (s: Store, taskId: string, eventId: number, note: string): Promise<string> =>
  s.vault.seal(eventAad(taskId, eventId), note, 2);

export async function sealEventNoteNullable(s: Store, taskId: string, eventId: number, note: string | null | undefined): Promise<string | null> {
  return note === null || note === undefined ? null : sealEventNote(s, taskId, eventId, note);
}

/** Decrypts one value. A failure becomes the placeholder and logs only the task id, so one bad row never breaks a listing. */
async function readable(taskId: string, read: () => Promise<string>): Promise<string> {
  try {
    return await read();
  } catch (err) {
    if (!(err instanceof VaultError)) throw err;
    console.error(`unreadable stored value in task ${taskId}`);
    return UNREADABLE;
  }
}

const openText = (s: Store, table: string, column: string, id: string, value: string): Promise<string> =>
  readable(id, () => s.vault.open(aadFor(table, column, id), value));

async function openNullable(s: Store, table: string, column: string, id: string, value: string | null): Promise<string | null> {
  return value === null ? null : openText(s, table, column, id, value);
}

export async function openTask(s: Store, row: TaskRow): Promise<TaskRow> {
  const [title, brief, deliverable, acceptance, question, owner_reply] = await Promise.all([
    openText(s, "tasks", "title", row.id, row.title),
    openText(s, "tasks", "brief", row.id, row.brief),
    openText(s, "tasks", "deliverable", row.id, row.deliverable),
    openText(s, "tasks", "acceptance", row.id, row.acceptance),
    openNullable(s, "tasks", "question", row.id, row.question),
    openNullable(s, "tasks", "owner_reply", row.id, row.owner_reply),
  ]);
  return { ...row, title, brief, deliverable, acceptance, question, owner_reply };
}

export async function openEvent(s: Store, row: EventRow): Promise<EventRow> {
  if (row.note === null || row.task_id === null) return row;
  const { note, task_id: taskId, id } = row;
  const v2 = note.startsWith(ENC_PREFIX_V2);
  const text = await readable(taskId, async () => {
    if (s.vault.strict && !v2) throw new VaultError("Strict mode: legacy event note.");
    return s.vault.open(v2 ? eventAad(taskId, id) : aadFor("events", "note", taskId), note);
  });
  return { ...row, note: text };
}

export interface ResultRow extends Omit<ResultView, "links"> {
  links: string;
}

export async function openResult(s: Store, row: ResultRow): Promise<ResultView> {
  const [summary, links, notes] = await Promise.all([
    openText(s, "results", "summary", row.task_id, row.summary),
    openText(s, "results", "links", row.task_id, row.links),
    openText(s, "results", "notes", row.task_id, row.notes),
  ]);
  return { ...row, summary, links: links === UNREADABLE ? [] : (JSON.parse(links) as string[]), notes };
}
