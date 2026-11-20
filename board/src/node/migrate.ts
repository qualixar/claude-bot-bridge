import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SqliteDb } from "./sqlite-db";

const TABLE = "_bb_migrations";

/**
 * Applies `*.sql` files from `dir` in name order, once each, recording them in `_bb_migrations`.
 * Safe to run on every start. Each file runs in its own transaction, so a failure leaves no half-applied file.
 * Returns the names applied by this call.
 */
export function applyMigrations(db: SqliteDb, dir: string): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const done = new Set(db.conn.prepare(`SELECT name FROM ${TABLE}`).all().map((r) => String(r.name)));
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.conn.prepare(`INSERT INTO ${TABLE} (name, applied_at) VALUES (?, ?)`).run(file, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
    applied.push(file);
  }
  return applied;
}
