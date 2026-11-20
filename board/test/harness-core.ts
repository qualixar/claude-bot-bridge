// Runtime-neutral test support: builds apps over whichever BoardDb the harness supplies.
import { createApp, type App, type AppDeps } from "../src/app";
import { sha256Hex } from "../src/auth";
import { configFromEnv, type ConfigEnv } from "../src/config";
import { createVault } from "../src/crypto/vault";
import type { Store } from "../src/store/context";
import type { BoardDb } from "../src/store/db";

export const OWNER = "test-owner-token-0123456789abcdef";
export const WORKER = "test-worker-token-0123456789abcdef";
export const VIEWER = "test-viewer-key-0123456789abcdef";
export const SESSION_SECRET = "test-session-secret-0123456789abcdef0123456789";

export const BASE_ENV: ConfigEnv = {
  OWNER_TOKEN: OWNER,
  WORKER_TOKEN: WORKER,
  VIEWER_KEY_SHA256: await sha256Hex(VIEWER),
  SESSION_SECRET,
  ALLOW_PLAINTEXT_STORAGE: "1",
};

export function makeHarness(db: BoardDb, runtime: "workers" | "node") {
  const appWith = (over: ConfigEnv = {}, deps: Partial<AppDeps> = {}): App =>
    createApp({ db, config: configFromEnv({ ...BASE_ENV, ...over }), ...deps });
  /** A store with no encryption key, for tests that call store functions directly. */
  const plainStore = (): Store => ({ db, vault: createVault({}) });
  const resetDb = async (): Promise<void> => {
    await db.batch([
      db.prepare("DELETE FROM results"),
      db.prepare("DELETE FROM events"),
      db.prepare("DELETE FROM tasks"),
      db.prepare("DELETE FROM rate_limits"),
      db.prepare("UPDATE meta SET value = '0' WHERE key IN ('task_seq', 'paused')"),
    ]);
  };
  return { runtime, db, appWith, plainStore, resetDb, app: appWith() };
}
