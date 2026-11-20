import type { Authenticator } from "../auth";
import { bearerToken, sha256Hex } from "../auth";
import type { AppConfig } from "../config";
import type { AuthGuard } from "../guard";
import { json, readCapped } from "../http";
import type { Store } from "../store/context";
import type { Role } from "../types";
import { API_VERSION, BOARD_VERSION, SCHEMA_VERSION } from "../version";
import { boardSnapshot, bumpSessionGeneration, changeMarker, sessionGeneration, taskDetail } from "../store/web";
import { fullView } from "../tools/shared";
import { securityHeaders, type BodyKind } from "./headers";
import { SESSION_COOKIE, SESSION_TTL_MS, readCookie, sessionCookie, signSession, verifySession, type SessionRole } from "./session";
import { APP_CSS } from "./ui/css";
import { APP_JS } from "./ui/js";
import { boardPage, loginPage, type LoginNotice } from "./ui/pages";
import { eventStream } from "./stream";

export interface StreamTiming {
  tickMs: number;
  heartbeatMs: number;
  maxMs: number;
}

export const DEFAULT_STREAM: StreamTiming = { tickMs: 2_000, heartbeatMs: 15_000, maxMs: 5 * 60_000 };
/** Workers bills wall time and holds the connection: keep streams short; EventSource reconnects by itself. */
export const WORKERS_STREAM: StreamTiming = { ...DEFAULT_STREAM, maxMs: 60_000 };

/** Counts open streams per session key so one browser cannot hold unlimited connections (Node). */
export class StreamSlots {
  private readonly open = new Map<string, number>();
  constructor(private readonly max: number) {}
  /** Returns a release function, or null when the session is at its cap. */
  acquire(key: string): (() => void) | null {
    const n = this.open.get(key) ?? 0;
    if (n >= this.max) return null;
    this.open.set(key, n + 1);
    return () => {
      const left = (this.open.get(key) ?? 1) - 1;
      if (left <= 0) this.open.delete(key);
      else this.open.set(key, left);
    };
  }
}
const MAX_LOGIN_BODY = 4096;
const TASK_PATH = /^\/board\/api\/tasks\/(T-\d{4,6})$/;

export interface WebCtx {
  store: Store;
  auth: Authenticator;
  config: AppConfig;
  guard: AuthGuard;
  now: () => number;
  https: boolean;
  stream: StreamTiming;
  slots?: StreamSlots;
}

const respond = (ctx: WebCtx, kind: BodyKind, body: BodyInit | null, status: number, headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers: securityHeaders(ctx.https, kind, headers) });

const page = (ctx: WebCtx, html: string, status = 200): Response =>
  respond(ctx, "html", html, status, { "content-type": "text/html; charset=utf-8" });

const apiJson = (ctx: WebCtx, status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: securityHeaders(ctx.https, "api", { "content-type": "application/json; charset=utf-8" }) });

const notAllowed = (ctx: WebCtx, allow: string): Response => respond(ctx, "api", null, 405, { allow });

/**
 * Who is calling: a session cookie wins, otherwise a bearer key of any role. A wrong key is counted
 * against the failed-auth limiter (429 once over, else 401); a valid key never touches the limiter.
 */
export async function authorize(ctx: WebCtx, req: Request): Promise<{ role: Role; sessionKey: string } | Response> {
  const cookie = readCookie(req, SESSION_COOKIE);
  const sessionRole = cookie ? await cookieRole(ctx, cookie) : null;
  if (cookie && sessionRole) return { role: sessionRole, sessionKey: cookie };
  const token = bearerToken(req);
  if (!token) return apiJson(ctx, 401, { error: "unauthorized" });
  const role = await ctx.auth.identify(token);
  if (role) return { role, sessionKey: token };
  return (await ctx.guard.fail()) ? respond(ctx, "api", null, 429, { "retry-after": "60" }) : apiJson(ctx, 401, { error: "unauthorized" });
}

/** The role a session cookie grants right now (signature, expiry and the server-side generation), or null. */
async function cookieRole(ctx: WebCtx, cookie: string): Promise<SessionRole | null> {
  const secret = ctx.config.sessionSecret;
  return secret ? verifySession(secret, cookie, ctx.now(), await sessionGeneration(ctx.store.db)) : null;
}

/** The web board is for viewer and owner keys; the worker key is a valid key but may not use it. */
async function viewerRole(ctx: WebCtx, req: Request): Promise<{ role: Role; sessionKey: string } | Response> {
  const who = await authorize(ctx, req);
  if (who instanceof Response) return who;
  return who.role === "worker" ? apiJson(ctx, 403, { error: "forbidden" }) : who;
}

/** GET /version: version, schema and api numbers for any valid key. /healthz stays free of them. */
export async function handleVersion(ctx: WebCtx, req: Request): Promise<Response> {
  if (req.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
  const who = await authorize(ctx, req);
  if (who instanceof Response) return who;
  return json(200, { ok: true, version: BOARD_VERSION, schema: SCHEMA_VERSION, api: API_VERSION }, { "cache-control": "no-store" });
}

async function showBoard(ctx: WebCtx, req: Request): Promise<Response> {
  const cookie = readCookie(req, SESSION_COOKIE);
  const role = cookie ? await cookieRole(ctx, cookie) : null;
  return role ? page(ctx, boardPage()) : page(ctx, loginPage("none"));
}

async function readForm(req: Request): Promise<URLSearchParams | null> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) return null;
  const bytes = await readCapped(req, MAX_LOGIN_BODY);
  return bytes === null ? null : new URLSearchParams(new TextDecoder().decode(bytes));
}

/** Browsers always send Origin on a form POST; it must be this site. Non-browser clients send none. */
function sameOrigin(req: Request): boolean {
  if (req.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = req.headers.get("origin");
  return origin === null || origin === new URL(req.url).origin;
}

const loginFailure = (ctx: WebCtx, notice: LoginNotice, status: number): Response =>
  respond(ctx, "html", loginPage(notice), status, { "content-type": "text/html; charset=utf-8", ...(status === 429 ? { "retry-after": "60" } : {}) });

async function login(ctx: WebCtx, req: Request): Promise<Response> {
  const secret = ctx.config.sessionSecret;
  if (!sameOrigin(req)) return refusedOrigin(ctx, req);
  if (!secret) return loginFailure(ctx, "unavailable", 503);
  const key = (await readForm(req))?.get("key") ?? "";
  const role = key ? await ctx.auth.identify(key) : null;
  if (role !== "viewer" && role !== "owner") {
    return (await ctx.guard.fail()) ? loginFailure(ctx, "limited", 429) : loginFailure(ctx, "rejected", 401);
  }
  const value = await signSession(secret, role, ctx.now() + SESSION_TTL_MS, await sessionGeneration(ctx.store.db));
  return respond(ctx, "html", null, 303, { location: "/board", "set-cookie": sessionCookie(value, ctx.https) });
}

/**
 * A browser behind a TLS-terminating proxy sends Origin https://host while this server, not trusting the proxy,
 * sees http: say so, because a blank 403 gives the operator nothing to act on. Real cross-site posts stay blank.
 */
function refusedOrigin(ctx: WebCtx, req: Request): Response {
  const proxied = !ctx.https && (req.headers.get("x-forwarded-proto") ?? "").split(",").pop()?.trim().toLowerCase() === "https";
  return proxied ? loginFailure(ctx, "proxy", 403) : respond(ctx, "html", null, 403);
}

/** Signs out this browser and, when the request carries a valid session, every older cookie too (generation bump). */
async function logout(ctx: WebCtx, req: Request): Promise<Response> {
  if (!sameOrigin(req)) return refusedOrigin(ctx, req);
  const cookie = readCookie(req, SESSION_COOKIE);
  if (cookie && (await cookieRole(ctx, cookie))) await bumpSessionGeneration(ctx.store.db);
  return respond(ctx, "html", null, 303, { location: "/board", "set-cookie": sessionCookie("", ctx.https) });
}

async function api(ctx: WebCtx, req: Request, path: string): Promise<Response> {
  const who = await viewerRole(ctx, req);
  if (who instanceof Response) return who;
  if (path === "/board/api/tasks") return apiJson(ctx, 200, await boardSnapshot(ctx.store));
  if (path === "/board/api/stream") {
    const release = ctx.slots ? ctx.slots.acquire((await sha256Hex(who.sessionKey)).slice(0, 16)) : () => undefined;
    if (!release) return respond(ctx, "api", null, 429, { "retry-after": "10" });
    const body = eventStream({
      ...ctx.stream,
      now: ctx.now,
      onClose: release,
      marker: () => changeMarker(ctx.store.db),
      snapshot: () => boardSnapshot(ctx.store),
    });
    return respond(ctx, "api", body, 200, { "content-type": "text/event-stream; charset=utf-8", "x-accel-buffering": "no" });
  }
  const m = TASK_PATH.exec(path);
  if (!m) return apiJson(ctx, 404, { error: "not_found" });
  const detail = await taskDetail(ctx.store, m[1]);
  if (!detail) return apiJson(ctx, 404, { error: "not_found" });
  return apiJson(ctx, 200, { task: fullView(detail.task), events: detail.events, result: detail.result });
}

/** Routes under /board. The board is read-only: nothing here changes task state. */
export async function handleBoard(ctx: WebCtx, req: Request, path: string): Promise<Response> {
  const get = req.method === "GET" || req.method === "HEAD";
  if (path === "/board") return get ? showBoard(ctx, req) : notAllowed(ctx, "GET");
  if (path === "/board/assets/app.css") return get ? respond(ctx, "asset", APP_CSS, 200, { "content-type": "text/css; charset=utf-8" }) : notAllowed(ctx, "GET");
  if (path === "/board/assets/app.js") return get ? respond(ctx, "asset", APP_JS, 200, { "content-type": "text/javascript; charset=utf-8" }) : notAllowed(ctx, "GET");
  if (path === "/board/login") return req.method === "POST" ? login(ctx, req) : notAllowed(ctx, "POST");
  if (path === "/board/logout") return req.method === "POST" ? logout(ctx, req) : notAllowed(ctx, "POST");
  if (path.startsWith("/board/api/")) return get ? api(ctx, req, path) : notAllowed(ctx, "GET");
  return respond(ctx, "api", null, 404);
}

