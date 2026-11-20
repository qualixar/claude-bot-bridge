import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../src/node/migrate";
import { SqliteDb } from "../../src/node/sqlite-db";

const REAL = join(import.meta.dirname, "../../migrations");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "cbb-mig-"));
  dirs.push(d);
  return d;
};
const tables = (db: SqliteDb) => db.conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => String(r.name));

describe("migration runner", () => {
  it("applies the real migrations once, in order, and records them", () => {
    const db = new SqliteDb(":memory:");
    expect(applyMigrations(db, REAL)).toEqual(["0001_init.sql", "0002_board_rev_event_seq.sql"]);
    expect(tables(db)).toEqual(expect.arrayContaining(["_bb_migrations", "events", "meta", "rate_limits", "results", "tasks"]));
    expect(db.conn.prepare("SELECT name FROM _bb_migrations").all().map((r) => r.name)).toEqual(["0001_init.sql", "0002_board_rev_event_seq.sql"]);
  });

  it("is idempotent: a second run applies nothing and keeps the data", () => {
    const db = new SqliteDb(":memory:");
    applyMigrations(db, REAL);
    db.exec("UPDATE meta SET value = '7' WHERE key = 'task_seq'");
    expect(applyMigrations(db, REAL)).toEqual([]);
    expect(applyMigrations(db, REAL)).toEqual([]);
    expect(db.conn.prepare("SELECT value FROM meta WHERE key = 'task_seq'").get()).toEqual({ value: "7" });
  });

  it("applies new files added later", () => {
    const dir = tmp();
    writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE a (x);");
    writeFileSync(join(dir, "notes.txt"), "not sql");
    const db = new SqliteDb(":memory:");
    expect(applyMigrations(db, dir)).toEqual(["0001_a.sql"]);
    writeFileSync(join(dir, "0003_c.sql"), "CREATE TABLE c (x);");
    writeFileSync(join(dir, "0002_b.sql"), "CREATE TABLE b (x);");
    expect(applyMigrations(db, dir)).toEqual(["0002_b.sql", "0003_c.sql"]);
    expect(tables(db)).toEqual(expect.arrayContaining(["a", "b", "c"]));
  });

  it("rolls a failing file back completely, names it, and leaves it unrecorded", () => {
    const dir = tmp();
    writeFileSync(join(dir, "0001_ok.sql"), "CREATE TABLE ok (x);");
    writeFileSync(join(dir, "0002_bad.sql"), "CREATE TABLE half (x); INSERT INTO missing_table VALUES (1);");
    const db = new SqliteDb(":memory:");
    expect(() => applyMigrations(db, dir)).toThrow(/0002_bad\.sql failed/);
    expect(tables(db)).not.toContain("half");
    expect(db.conn.prepare("SELECT name FROM _bb_migrations").all().map((r) => r.name)).toEqual(["0001_ok.sql"]);
    // Fixing the file lets the next run apply it.
    writeFileSync(join(dir, "0002_bad.sql"), "CREATE TABLE half (x);");
    expect(applyMigrations(db, dir)).toEqual(["0002_bad.sql"]);
  });
});
