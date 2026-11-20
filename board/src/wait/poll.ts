// Long-poll loop for task_wait. Pure: the database read, the clock and the sleep are all injected, so the
// same code runs on Workers and Node (no Durable Objects) and the tests can run it on a fake clock.
import { MAX_WAIT_S } from "./schema";

export { MAX_WAIT_S };

/** What one cheap read returns: the board revision and, when a task id was asked for, that task's status. */
export interface WaitState {
  rev: number;
  status: string | null;
}

export interface WaitDeps {
  intervalMs: number;
  now: () => number;
  /** Resolves after `ms`, or earlier when `signal` aborts. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface WaitInput {
  id?: string;
  sinceRev?: number;
  timeoutS: number;
}

export interface WaitOutcome {
  changed: boolean;
  rev: number;
  status?: string;
  aborted?: boolean;
  /** The task asked for does not exist (any more). */
  missing?: boolean;
  /** The task was already in a final state when the call began, so nothing can change. */
  final?: boolean;
}

export const POLL_INTERVAL_MS = 1500;
export const FINAL_STATUSES: readonly string[] = ["done", "failed", "cancelled"];

export const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

export const defaultWaitDeps: WaitDeps = { intervalMs: POLL_INTERVAL_MS, now: Date.now, sleep: abortableSleep };

/**
 * Waits until the board changes, or, with an id, until that task's status changes, or until the timeout.
 * `read(id)` is one primary-key read; it returns null when the task does not exist.
 * - since_rev given and already behind the board: returns changed at once (no change is ever missed).
 * - id given: a rev move caused by other tasks is ignored; only that task's status counts.
 * - the wall time never exceeds MAX_WAIT_S, and an aborted request ends the loop at the next check.
 */
export async function waitForChange(
  read: (id?: string) => Promise<WaitState | null>,
  input: WaitInput,
  signal?: AbortSignal,
  deps: WaitDeps = defaultWaitDeps,
): Promise<WaitOutcome> {
  const startedAt = deps.now();
  const deadline = startedAt + Math.min(input.timeoutS, MAX_WAIT_S) * 1000;
  const first = await read(input.id);
  if (!first) return { changed: false, rev: 0, missing: true };
  if (input.sinceRev !== undefined && first.rev > input.sinceRev) return { changed: true, rev: first.rev, ...(first.status ? { status: first.status } : {}) };
  if (input.id && first.status && FINAL_STATUSES.includes(first.status)) return { changed: false, rev: first.rev, status: first.status, final: true };
  const baseRev = Math.max(first.rev, input.sinceRev ?? 0);
  let last = first;
  while (!signal?.aborted && deps.now() < deadline) {
    await deps.sleep(Math.min(deps.intervalMs, deadline - deps.now()), signal);
    if (signal?.aborted) break;
    const state = await read(input.id);
    if (!state) return { changed: false, rev: last.rev, missing: true };
    last = state;
    const moved = input.id ? state.status !== first.status : state.rev > baseRev;
    if (moved) return { changed: true, rev: state.rev, ...(state.status ? { status: state.status } : {}) };
  }
  return { changed: false, rev: last.rev, ...(last.status ? { status: last.status } : {}), ...(signal?.aborted ? { aborted: true } : {}) };
}
