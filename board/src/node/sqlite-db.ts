import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { BoardDb, BoardRunResult, BoardStatement, BoardValue } from "../store/db";

class SqliteStatement implements BoardStatement {
  constructor(
    private readonly owner: SqliteDb,
    readonly sql: string,
    private readonly values: readonly BoardValue[] = [],
  ) {}

  bind(...values: BoardValue[]): BoardStatement {
    return new SqliteStatement(this.owner, this.sql, values);
  }

  async first<T>(): Promise<T | null> {
    const row = this.owner.statement(this.sql).get(...this.values);
    return row ? ({ ...row } as T) : null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.owner.statement(this.sql).all(...this.values).map((r) => ({ ...r }) as T) };
  }

  async run(): Promise<BoardRunResult> {
    return this.runSync();
  }

  runSync(): BoardRunResult {
    const info = this.owner.statement(this.sql).run(...this.values);
    return { meta: { changes: Number(info.changes) } };
  }
}

/**
 * BoardDb over Node's built-in `node:sqlite`. Statements execute synchronously, so a `batch` can never
 * interleave with another call: it runs as one transaction (BEGIN IMMEDIATE ... COMMIT, ROLLBACK on error).
 */
export class SqliteDb implements BoardDb {
  readonly conn: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();

  constructor(path: string) {
    this.conn = new DatabaseSync(path);
    this.conn.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") this.conn.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  }

  statement(sql: string): StatementSync {
    let st = this.cache.get(sql);
    if (!st) {
      st = this.conn.prepare(sql);
      this.cache.set(sql, st);
    }
    return st;
  }

  prepare(sql: string): BoardStatement {
    return new SqliteStatement(this, sql);
  }

  async batch(statements: BoardStatement[]): Promise<BoardRunResult[]> {
    const own = statements.map((s) => {
      if (!(s instanceof SqliteStatement)) throw new Error("batch: statement was not prepared by this database");
      return s;
    });
    this.conn.exec("BEGIN IMMEDIATE");
    try {
      const results = own.map((s) => s.runSync());
      this.conn.exec("COMMIT");
      return results;
    } catch (err) {
      this.conn.exec("ROLLBACK");
      throw err;
    }
  }

  /** Runs raw SQL (several statements allowed). Used for migrations. */
  exec(sql: string): void {
    this.conn.exec(sql);
  }

  close(): void {
    this.cache.clear();
    this.conn.close();
  }
}
