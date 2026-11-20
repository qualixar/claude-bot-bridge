// Node entry: the same app as the Workers build, over node:http and a SQLite file.
import { mkdirSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createApp, type App } from "../app";
import { configFromEnv } from "../config";
import { HttpError, abortOnClientClose, clientIp, sendWebResponse, toWebRequest } from "./http-adapter";
import { applyMigrations } from "./migrate";
import { StartupError, optionsFromEnv, validate, type RequestSettled, type ServerOptions } from "./options";
import { SqliteDb } from "./sqlite-db";

export const TICK_MS = 15 * 60_000;
export const MAX_STREAMS_PER_SESSION = 3;

export interface RunningServer {
  port: number;
  app: App;
  db: SqliteDb;
  close(): Promise<void>;
}

function requestHandler(app: App, trustProxy: boolean, onSettled?: (info: RequestSettled) => void) {
  return async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> => {
    const started = Date.now();
    const signal = abortOnClientClose(res);
    try {
      const webReq = await toWebRequest(req, trustProxy, signal);
      const response = await app.fetch(webReq, { ip: clientIp(req, trustProxy) });
      onSettled?.({ method: req.method ?? "GET", path: (req.url ?? "/").split("?")[0], ms: Date.now() - started, aborted: signal.aborted });
      await sendWebResponse(res, response, req.method === "HEAD");
    } catch (err) {
      if (res.headersSent) return void res.destroy();
      const status = err instanceof HttpError ? err.status : 500;
      if (!(err instanceof HttpError)) console.error("request failure", err instanceof Error ? err.message : "unknown");
      res.statusCode = status;
      res.setHeader("connection", "close");
      res.end();
    }
  };
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolvePort((server.address() as AddressInfo).port));
  });
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  await validate(opts.env);
  const config = configFromEnv(opts.env);
  if (opts.dbPath !== ":memory:") mkdirSync(dirname(resolve(opts.dbPath)), { recursive: true });
  const db = new SqliteDb(opts.dbPath);
  const applied = applyMigrations(db, opts.migrationsDir);
  if (applied.length > 0) console.log(`migrations applied: ${applied.join(", ")}`);
  const app = createApp({ db, config, maxStreamsPerSession: MAX_STREAMS_PER_SESSION });
  const server = createServer(requestHandler(app, config.trustProxy, opts.onRequestSettled));
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  const tick = () => app.tick().catch((err: unknown) => console.error("tick failure", err instanceof Error ? err.message : "unknown"));
  const timer = setInterval(tick, opts.tickMs ?? TICK_MS);
  timer.unref();
  let port: number;
  try {
    port = await listen(server, opts.port, opts.host);
  } catch (err) {
    clearInterval(timer);
    db.close();
    throw err;
  }
  void tick();
  return {
    port,
    app,
    db,
    async close() {
      clearInterval(timer);
      const closed = new Promise<void>((done) => server.close(() => done()));
      server.closeIdleConnections();
      // Open Server-Sent Events streams would hold the server open; give requests a moment, then cut them.
      const cut = setTimeout(() => server.closeAllConnections(), 2_000);
      await closed;
      clearTimeout(cut);
      db.close();
    },
  };
}

export async function main(raw: Record<string, string | undefined> = process.env): Promise<void> {
  try {
    const running = await startServer(optionsFromEnv(raw));
    console.log(`Claude Bot Bridge Board listening on http://${raw.HOST || "127.0.0.1"}:${running.port} (data: ${raw.DB_PATH || "./data/board.sqlite"})`);
    let stopping = false;
    const stop = (signal: string) => {
      if (stopping) return;
      stopping = true;
      console.log(`${signal} received, shutting down`);
      running.close().then(() => process.exit(0), (err: unknown) => {
        console.error("shutdown failure", err instanceof Error ? err.message : "unknown");
        process.exit(1);
      });
    };
    process.on("SIGTERM", () => stop("SIGTERM"));
    process.on("SIGINT", () => stop("SIGINT"));
  } catch (err) {
    if (err instanceof StartupError) {
      console.error(`Claude Bot Bridge Board cannot start:\n${err.problems.map((p) => `  - ${p}`).join("\n")}`);
    } else {
      console.error("startup failure", err instanceof Error ? err.message : "unknown");
    }
    process.exit(1);
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) void main();
