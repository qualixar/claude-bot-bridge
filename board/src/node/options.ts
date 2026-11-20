import { resolve } from "node:path";
import { createAuthenticator } from "../auth";
import { configFromEnv, type ConfigEnv } from "../config";

export interface ServerOptions {
  env: ConfigEnv;
  host: string;
  port: number;
  dbPath: string;
  migrationsDir: string;
  tickMs?: number;
  /** Called once per request when the application has finished handling it. For tests and diagnostics; carries no secrets. */
  onRequestSettled?: (info: RequestSettled) => void;
}

export interface RequestSettled {
  method: string;
  path: string;
  ms: number;
  /** The client had closed the connection before the response was complete. */
  aborted: boolean;
}

/** Raised when the configuration is unusable. `problems` are safe to print: they never contain secrets. */
export class StartupError extends Error {
  constructor(readonly problems: string[]) {
    super(`Cannot start: ${problems.join(" ")}`);
  }
}

export function optionsFromEnv(raw: Record<string, string | undefined>): ServerOptions {
  const port = Number(raw.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new StartupError(["PORT must be a number between 0 and 65535."]);
  return {
    env: raw,
    host: raw.HOST || "127.0.0.1",
    port,
    dbPath: raw.DB_PATH || "./data/board.sqlite",
    migrationsDir: raw.MIGRATIONS_DIR || resolve(import.meta.dirname, "../../migrations"),
  };
}

export async function validate(env: ConfigEnv): Promise<void> {
  const config = configFromEnv(env);
  const problems = [...config.issues.map((i) => i.message), ...(await createAuthenticator(config).problems())];
  if (problems.length > 0) throw new StartupError(problems);
}
