import { resolve } from "node:path";
import { applyMigrations } from "../src/node/migrate";
import { SqliteDb } from "../src/node/sqlite-db";
import { makeHarness } from "./harness-core";

const sqlite = new SqliteDb(":memory:");
applyMigrations(sqlite, resolve(import.meta.dirname, "../migrations"));
const h = makeHarness(sqlite, "node");

export * from "./harness-core";
export const { runtime, db, appWith, plainStore, resetDb, app } = h;
