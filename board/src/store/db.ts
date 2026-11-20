/**
 * Storage port. This is exactly the subset of Cloudflare D1 that the store uses, so a D1 database
 * satisfies it natively and the Node build supplies an adapter over `node:sqlite`.
 */
export type BoardValue = string | number | null;

export interface BoardRunResult {
  meta: { changes?: number };
}

export interface BoardStatement {
  bind(...values: BoardValue[]): BoardStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<BoardRunResult>;
}

export interface BoardDb {
  prepare(sql: string): BoardStatement;
  /** Runs the statements in order inside one transaction: all take effect or none do. */
  batch(statements: BoardStatement[]): Promise<BoardRunResult[]>;
}
