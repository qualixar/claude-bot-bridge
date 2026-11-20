import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../src/node/migrate";
import { SqliteDb } from "../../src/node/sqlite-db";

const MIGRATIONS = join(import.meta.dirname, "../../migrations");
const dbs: SqliteDb[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) {
    try {
      d.close();
    } catch {
      /* already closed */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fresh(path = ":memory:"): SqliteDb {
  const db = new SqliteDb(path);
  dbs.push(db);
  applyMigrations(db, MIGRATIONS);
  return db;
}

describe("SqliteDb (BoardDb over node:sqlite)", () => {
  it("implements prepare, bind, first, all and run like D1", async () => {
    const db = fresh();
    const ins = await db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").bind("k", "v").run();
    expect(ins.meta.changes).toBe(1);
    expect(await db.prepare("SELECT value FROM meta WHERE key = ?").bind("k").first()).toEqual({ value: "v" });
    expect(await db.prepare("SELECT value FROM meta WHERE key = ?").bind("nope").first()).toBeNull();
    const all = await db.prepare("SELECT key FROM meta ORDER BY key").all<{ key: string }>();
    expect(all.results.map((r) => r.key)).toEqual(["board_rev", "event_seq", "k", "paused", "task_seq"]);
    expect(Object.getPrototypeOf(all.results[0])).toBe(Object.prototype);
    const upd = await db.prepare("UPDATE meta SET value = '9' WHERE key = 'k' RETURNING value").first<{ value: string }>();
    expect(upd).toEqual({ value: "9" });
    expect((await db.prepare("DELETE FROM meta WHERE key = 'nothing'").run()).meta.changes).toBe(0);
  });

  it("bind returns a new statement, so a prepared statement can be reused", async () => {
    const db = fresh();
    const stmt = db.prepare("SELECT value FROM meta WHERE key = ?");
    expect(await stmt.bind("paused").first()).toEqual({ value: "0" });
    expect(await stmt.bind("task_seq").first()).toEqual({ value: "0" });
  });

  it("runs a batch as one transaction and rolls everything back on failure", async () => {
    const db = fresh();
    const ok = await db.batch([
      db.prepare("INSERT INTO meta (key, value) VALUES ('a', '1')"),
      db.prepare("INSERT INTO meta (key, value) VALUES ('b', '2')"),
    ]);
    expect(ok.map((r) => r.meta.changes)).toEqual([1, 1]);
    await expect(
      db.batch([db.prepare("INSERT INTO meta (key, value) VALUES ('c', '3')"), db.prepare("INSERT INTO meta (key, value) VALUES ('a', 'dup')")]),
    ).rejects.toThrow(/UNIQUE/);
    expect(await db.prepare("SELECT value FROM meta WHERE key = 'c'").first()).toBeNull();
    // The connection is usable afterwards (the failed transaction was rolled back, not left open).
    await db.batch([db.prepare("INSERT INTO meta (key, value) VALUES ('d', '4')")]);
    expect(await db.prepare("SELECT value FROM meta WHERE key = 'd'").first()).toEqual({ value: "4" });
  });

  it("supports changes() chaining inside a batch, the way the store's compare-and-set does", async () => {
    const db = fresh();
    const res = await db.batch([
      db.prepare("UPDATE meta SET value = '1' WHERE key = 'nothing'"),
      db.prepare("INSERT INTO meta (key, value) SELECT 'ghost', 'x' WHERE changes() > 0"),
    ]);
    expect(res.map((r) => r.meta.changes)).toEqual([0, 0]);
    expect(await db.prepare("SELECT 1 AS n FROM meta WHERE key = 'ghost'").first()).toBeNull();
  });

  it("enforces foreign keys like D1", async () => {
    const db = fresh();
    await expect(
      db.prepare("INSERT INTO results (task_id, outcome, summary, links, notes, submitted_by, created_at) VALUES ('T-1', 'done', 's', '[]', '', 'x', 'now')").run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("rejects statements that did not come from this adapter", async () => {
    const db = fresh();
    const foreign = { bind: () => foreign, first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: {} }) };
    await expect(db.batch([foreign as never])).rejects.toThrow(/not prepared/);
  });

  it("persists to a file in WAL mode and reopens with the data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cbb-sqlite-"));
    dirs.push(dir);
    const path = join(dir, "board.sqlite");
    const a = fresh(path);
    await a.prepare("UPDATE meta SET value = '41' WHERE key = 'task_seq'").run();
    expect(a.conn.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    a.close();
    const b = new SqliteDb(path);
    dbs.push(b);
    expect(await b.prepare("SELECT value FROM meta WHERE key = 'task_seq'").first()).toEqual({ value: "41" });
  });
});
