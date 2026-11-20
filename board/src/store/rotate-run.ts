import type { Store } from "./context";
import { rotateBatch } from "./rotate";

export interface RotationReport {
  passes: number;
  scanned: number;
  rewritten: number;
  skipped: number;
  /** Values that cannot be decrypted with the configured keys. */
  unreadable: number;
  /** Values still not on the current key after the final verify pass. */
  stale: number;
  /** True only when a verify pass found every value on the current key: then the PREVIOUS key may be removed. */
  verified: boolean;
}

export const MAX_PASSES = 10;

interface PassTotals {
  scanned: number;
  rewritten: number;
  skipped: number;
  unreadable: number;
  stale: number;
}

async function onePass(s: Store, limit: number, verify: boolean): Promise<PassTotals> {
  const t: PassTotals = { scanned: 0, rewritten: 0, skipped: 0, unreadable: 0, stale: 0 };
  let cursor: string | undefined;
  do {
    const page = await rotateBatch(s, cursor, limit, { verify });
    for (const k of Object.keys(t) as (keyof PassTotals)[]) t[k] += page[k];
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return t;
}

/**
 * Repeats full passes until one rewrites nothing and skips nothing (a write that raced a pass is
 * picked up by the next), then runs a verify pass that writes nothing.
 */
export async function rotateToCompletion(s: Store, limit = 100): Promise<RotationReport> {
  const total = { scanned: 0, rewritten: 0, skipped: 0 };
  let passes = 0;
  let last: PassTotals;
  do {
    last = await onePass(s, limit, false);
    passes++;
    total.scanned += last.scanned;
    total.rewritten += last.rewritten;
    total.skipped += last.skipped;
  } while ((last.rewritten > 0 || last.skipped > 0) && passes < MAX_PASSES);
  const check = await onePass(s, limit, true);
  return { passes, ...total, unreadable: check.unreadable, stale: check.stale, verified: check.stale === 0 && check.unreadable === 0 && last.skipped === 0 };
}
