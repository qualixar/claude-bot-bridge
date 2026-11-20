import { sha256Hex } from "./auth";
import { bumpCounter } from "./store/board";
import type { BoardDb } from "./store/db";

export const AUTH_FAIL_LIMIT = 20;

/** Records one failed attempt for `key` and says whether that key is now over the limit. */
export type FailureLimiter = (key: string) => Promise<boolean>;

/**
 * Limiter backed by the database (Node's SQLite file, or D1 when no better option exists). Only failures
 * call it, so valid traffic never writes a row. On Workers the rate-limiting binding is used instead.
 */
export function dbFailureLimiter(db: BoardDb, now: () => number): FailureLimiter {
  return async (key) => {
    const count = await bumpCounter(db, key, now());
    if (count === AUTH_FAIL_LIMIT + 1) {
      console.warn(`auth: more than ${AUTH_FAIL_LIMIT} failed attempts from one client in a minute; limiting it until the minute ends`);
    }
    return count > AUTH_FAIL_LIMIT;
  };
}

/** Adapter for the Cloudflare Workers rate-limiting binding (`ratelimits` in wrangler config). */
export function bindingFailureLimiter(binding: { limit(opts: { key: string }): Promise<{ success: boolean }> }): FailureLimiter {
  return async (key) => !(await binding.limit({ key })).success;
}

export interface AuthGuard {
  /**
   * Call only after a credential was presented and rejected. True means this client is over the limit
   * and should get 429 instead of 401. Valid keys never reach this, so they always pass.
   */
  fail(): Promise<boolean>;
}

/** Keyed by a hash of the client address. Only counts are ever logged, never tokens or addresses. */
export async function authGuard(limiter: FailureLimiter, ip: string): Promise<AuthGuard> {
  const key = `authfail:${(await sha256Hex(ip)).slice(0, 16)}`;
  return { fail: () => limiter(key) };
}
