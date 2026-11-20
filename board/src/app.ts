import { bearerToken, createAuthenticator, type Authenticator } from "./auth";
import type { AppConfig } from "./config";
import { createVault } from "./crypto/vault";
import { authGuard, dbFailureLimiter, type FailureLimiter } from "./guard";
import { json, plain, rpcInternalError } from "./http";
import { handleMcp } from "./mcp";
import { pruneRateLimits, reclaimStale, withinRateLimit } from "./store/board";
import type { Store } from "./store/context";
import type { BoardDb } from "./store/db";
import { DEFAULT_STREAM, StreamSlots, handleBoard, handleVersion, type StreamTiming, type WebCtx } from "./web/routes";
import { securityHeaders } from "./web/headers";

export interface AppDeps {
  db: BoardDb;
  config: AppConfig;
  now?: () => number;
  /** Client address for the failed-auth limiter when the runtime does not pass one (Workers: CF-Connecting-IP). */
  clientIp?: (req: Request) => string | null;
  stream?: Partial<StreamTiming>;
  /** Failed-auth limiter. Default: database counters. Workers pass the rate-limiting binding. */
  failureLimiter?: FailureLimiter;
  /** Cap on concurrent Server-Sent Events streams per session. Unset means no cap (Workers). */
  maxStreamsPerSession?: number;
}

export interface ConnInfo {
  /** Address resolved by the server (Node: socket address, or X-Forwarded-For when TRUST_PROXY=1). */
  ip?: string;
}

export interface App {
  fetch(req: Request, info?: ConnInfo): Promise<Response>;
  /** Housekeeping: returns stale tasks to open and prunes old rate-limit rows. Called by cron / setInterval. */
  tick(nowMs?: number): Promise<void>;
}

interface Core {
  db: BoardDb;
  store: Store;
  auth: Authenticator;
  config: AppConfig;
  now: () => number;
  limiter: FailureLimiter;
}

async function mcpRoute(c: Core, req: Request, path: string, ip: string): Promise<Response> {
  const token = bearerToken(req);
  if (!token) return plain(401, { "www-authenticate": "Bearer" });
  const role = await c.auth.identify(token);
  if (!role) {
    const over = await (await authGuard(c.limiter, ip)).fail();
    return over ? plain(429, { "retry-after": "60" }) : plain(401, { "www-authenticate": "Bearer" });
  }
  if (role === "viewer") return plain(403);
  if (path !== "/mcp") return plain(404);
  if (req.method !== "POST") return plain(405, { allow: "POST" });
  if (role === "worker" && !(await withinRateLimit(c.db, "worker", c.now(), c.config.workerRateLimit))) {
    return plain(429, { "retry-after": "60" });
  }
  return handleMcp(req, role, c.store, c.config.workerName);
}

/** Liveness with a real database round trip, so a container's health reflects the database. No data, no version. */
async function health(db: BoardDb, configured: boolean): Promise<Response> {
  if (!configured) return json(503, { ok: false });
  try {
    await db.prepare("SELECT 1 AS ok").first();
  } catch (err) {
    console.error("healthz: database check failed", err instanceof Error ? err.message : "unknown");
    return json(503, { ok: false });
  }
  return json(200, { ok: true }, { "cache-control": "no-store" });
}

const isBoardPath = (path: string): boolean => path === "/board" || path.startsWith("/board/");

function failure(req: Request, err: unknown): Response {
  console.error("request failure", err instanceof Error ? err.message : "unknown");
  const url = new URL(req.url);
  if (isBoardPath(url.pathname)) return new Response(null, { status: 500, headers: securityHeaders(url.protocol === "https:", "api") });
  return rpcInternalError();
}

/** One application, two runtimes: the Workers entry and the Node server both wrap this. */
export function createApp(deps: AppDeps): App {
  const { db, config } = deps;
  const now = deps.now ?? Date.now;
  const store: Store = { db, vault: createVault({ key: config.encryptionKey, previous: config.encryptionKeyPrevious, strict: config.strictEncryption }) };
  const core: Core = { db, store, auth: createAuthenticator(config), config, now, limiter: deps.failureLimiter ?? dbFailureLimiter(db, now) };
  const slots = deps.maxStreamsPerSession ? new StreamSlots(deps.maxStreamsPerSession) : undefined;
  const stream: StreamTiming = { ...DEFAULT_STREAM, ...deps.stream };
  const storageIssues = config.issues.filter((i) => i.scope === "storage");

  async function route(req: Request, info: ConnInfo | undefined): Promise<Response> {
    const url = new URL(req.url);
    const ip = info?.ip ?? deps.clientIp?.(req) ?? "unknown";
    const board = isBoardPath(url.pathname);
    if (!board && url.pathname !== "/version") return mcpRoute(core, req, url.pathname, ip);
    const guard = await authGuard(core.limiter, ip);
    const ctx: WebCtx = { store, auth: core.auth, config, guard, now, https: url.protocol === "https:", stream, slots };
    return board ? handleBoard(ctx, req, url.pathname) : handleVersion(ctx, req);
  }

  return {
    async fetch(req, info) {
      if (new URL(req.url).pathname === "/healthz") return health(db, storageIssues.length === 0);
      if (storageIssues.length > 0) {
        console.error(`board refusing requests: ${storageIssues.map((i) => i.message).join(" ")}`);
        return plain(503);
      }
      try {
        return await route(req, info);
      } catch (err) {
        return failure(req, err);
      }
    },
    async tick(nowMs = now()) {
      await reclaimStale(store, nowMs);
      await pruneRateLimits(db, nowMs);
    },
  };
}
