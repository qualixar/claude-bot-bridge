// Re-encrypts every stored value with the current BOARD_ENCRYPTION_KEY, straight against the SQLite file.
// Run it after changing keys: set BOARD_ENCRYPTION_KEY_PREVIOUS to the old key first. It repeats passes until
// nothing is rewritten or skipped, then verifies. Safe to run twice.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { configFromEnv } from "../config";
import { createVault } from "../crypto/vault";
import { rotateToCompletion, type RotationReport } from "../store/rotate-run";
import { applyMigrations } from "./migrate";
import { optionsFromEnv, validate } from "./options";
import { SqliteDb } from "./sqlite-db";

export async function rotateAll(env: Record<string, string | undefined>): Promise<RotationReport> {
  const opts = optionsFromEnv(env);
  await validate(opts.env);
  const config = configFromEnv(opts.env);
  const db = new SqliteDb(opts.dbPath);
  try {
    applyMigrations(db, opts.migrationsDir);
    const store = { db, vault: createVault({ key: config.encryptionKey, previous: config.encryptionKeyPrevious, strict: config.strictEncryption }) };
    return await rotateToCompletion(store);
  } finally {
    db.close();
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  rotateAll(process.env).then(
    (r) => {
      console.log(`rotation: ${r.passes} pass(es), scanned ${r.scanned} rows, rewrote ${r.rewritten}, skipped ${r.skipped} (raced), unreadable ${r.unreadable}, still on an old key ${r.stale}`);
      if (r.verified) console.log("verified: every stored value decrypts with the current key. BOARD_ENCRYPTION_KEY_PREVIOUS may now be removed.");
      else {
        console.error("NOT verified: do not remove BOARD_ENCRYPTION_KEY_PREVIOUS. Fix the unreadable or stale values above and run the rotation again.");
        process.exit(2);
      }
    },
    (err: unknown) => {
      console.error(`rotation failed: ${err instanceof Error ? err.message : "unknown"}`);
      process.exit(1);
    },
  );
}
