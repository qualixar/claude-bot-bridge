import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { makeHarness } from "./harness-core";

const h = makeHarness(env.DB, "workers");
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);

export * from "./harness-core";
export const { runtime, db, appWith, plainStore, resetDb, app } = h;
