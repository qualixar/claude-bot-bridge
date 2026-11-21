import { describe, expect, it } from "vitest";
import { OWNER, VIEWER, WORKER, appWith, db } from "#harness";
import type { App } from "../src/app";
import { AUTH_FAIL_LIMIT } from "../src/guard";
import { CSP } from "../src/web/headers";
import { APP_JS } from "../src/web/ui/js";
import { APP_CSS } from "../src/web/ui/css";
import { createTask, owner, worker } from "./helpers";

const URL_BASE = "https://board.test";
const form = (key: string) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ key }).toString(),
});
const cookieOf = (res: Response) => (res.headers.getSetCookie()[0] ?? "").split(";")[0];
const get = (app: App, path: string, headers: Record<string, string> = {}, base = URL_BASE) => app.fetch(new Request(base + path, { headers }));

async function session(app: App, key = VIEWER, base = URL_BASE): Promise<string> {
  const res = await app.fetch(new Request(base + "/board/login", form(key)), { ip: "192.0.2.50" });
  expect(res.status).toBe(303);
  return cookieOf(res);
}

describe("login and session", () => {
  const app = appWith();

  it("shows a login form without a session and the board with one", async () => {
    const login = await get(app, "/board");
    expect(login.status).toBe(200);
    const html = await login.text();
    expect(html).toContain('action="/board/login"');
    expect(html).toContain('name="key"');
    expect(html).not.toContain("app.js");
    const cookie = await session(app);
    const board = await get(app, "/board", { cookie });
    const page = await board.text();
    expect(page).toContain("Claude Bot Bridge");
    expect(page).toContain('src="/board/assets/app.js"');
    for (const col of ["open", "claimed", "blocked", "done"]) expect(page).toContain(`data-col="${col}"`);
  });

  it("sets a HttpOnly, SameSite=Strict, Path=/board cookie for 12 h, Secure only over https", async () => {
    const https = await app.fetch(new Request(URL_BASE + "/board/login", form(VIEWER)));
    const c = https.headers.get("set-cookie")!;
    expect(c).toMatch(/^cbb_session=v2\.viewer\.\d+\.0\.[A-Za-z0-9_-]+;/);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("Path=/board");
    expect(c).toContain("Max-Age=43200");
    expect(c).toContain("Secure");
    expect(https.headers.get("location")).toBe("/board");
    const http = await app.fetch(new Request("http://localhost:8787/board/login", form(VIEWER)));
    expect(http.headers.get("set-cookie")).not.toContain("Secure");
    expect(http.headers.get("strict-transport-security")).toBeNull();
    expect(https.headers.get("strict-transport-security")).toMatch(/max-age=\d+/);
  });

  it("accepts the owner key and rejects worker, wrong and empty keys the same way", async () => {
    expect(await session(app, OWNER)).toMatch(/^cbb_session=v2\.owner\./);
    for (const key of [WORKER, "wrong-key-0123456789", ""]) {
      const res = await app.fetch(new Request(URL_BASE + "/board/login", form(key)), { ip: "192.0.2.60" });
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await res.text()).toContain("That key was not accepted.");
    }
    const wrongType = await app.fetch(new Request(URL_BASE + "/board/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: VIEWER }) }));
    expect(wrongType.status).toBe(401);
  });

  it("shares the failed-auth limit: 429 after 20 failures from one address", async () => {
    const ip = "192.0.2.70";
    for (let i = 0; i < AUTH_FAIL_LIMIT; i++) {
      expect((await app.fetch(new Request(URL_BASE + "/board/login", form(`bad-${i}`)), { ip })).status).toBe(401);
    }
    const limited = await app.fetch(new Request(URL_BASE + "/board/login", form("bad-21st")), { ip });
    expect(limited.status).toBe(429);
    expect(await limited.text()).toContain("Too many failed attempts");
    // Valid keys still get in from the limited address; only failures are limited.
    expect((await app.fetch(new Request(URL_BASE + "/board/login", form(VIEWER)), { ip })).status).toBe(303);
    const mcp = await app.fetch(new Request(URL_BASE + "/mcp", { method: "POST", headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", accept: "application/json" }, body: "{}" }), { ip });
    expect(mcp.status).not.toBe(429);
    expect((await app.fetch(new Request(URL_BASE + "/mcp", { method: "POST", headers: { authorization: "Bearer wrong-0123456789abcdef" } }), { ip })).status).toBe(429);
    // A bearer failure on the web API counts as well.
    const ip2 = "192.0.2.71";
    for (let i = 0; i < AUTH_FAIL_LIMIT; i++) await get(app, "/board/api/tasks", { authorization: `Bearer nope-${i}-0123456789` }).catch(() => null);
    expect((await app.fetch(new Request(URL_BASE + "/board/login", form(VIEWER)), { ip: ip2 })).status).toBe(303);
  });

  it("logout clears the cookie", async () => {
    const res = await app.fetch(new Request(URL_BASE + "/board/logout", { method: "POST" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toMatch(/cbb_session=;.*Max-Age=0/);
    expect((await get(app, "/board/logout")).status).toBe(405);
  });

  it("logout kills every older cookie (server-side session generation); logout without a session changes nothing", async () => {
    const gen = appWith();
    const a = await session(gen);
    const b = await session(gen, OWNER);
    expect((await get(gen, "/board/api/tasks", { cookie: a })).status).toBe(200);
    const anon = await gen.fetch(new Request(URL_BASE + "/board/logout", { method: "POST" }));
    expect(anon.status).toBe(303);
    expect((await get(gen, "/board/api/tasks", { cookie: a })).status).toBe(200);
    const out = await gen.fetch(new Request(URL_BASE + "/board/logout", { method: "POST", headers: { cookie: a } }));
    expect(out.status).toBe(303);
    for (const old of [a, b]) {
      expect((await get(gen, "/board/api/tasks", { cookie: old })).status).toBe(401);
      expect(await (await get(gen, "/board", { cookie: old })).text()).toContain('action="/board/login"');
    }
    const fresh = await session(gen);
    expect((await get(gen, "/board/api/tasks", { cookie: fresh })).status).toBe(200);
  });

  it("rejects expired and tampered sessions, and reports a missing SESSION_SECRET", async () => {
    let now = Date.now();
    const clocked = appWith({}, { now: () => now });
    const cookie = await session(clocked);
    expect((await get(clocked, "/board/api/tasks", { cookie })).status).toBe(200);
    expect((await get(clocked, "/board/api/tasks", { cookie: cookie.slice(0, -3) + "AAA" })).status).toBe(401);
    expect((await get(clocked, "/board/api/tasks", { cookie: cookie.replace(".viewer.", ".owner.") })).status).toBe(401);
    now += 12 * 3_600_000 + 1000;
    expect((await get(clocked, "/board/api/tasks", { cookie })).status).toBe(401);
    expect(await (await get(clocked, "/board", { cookie })).text()).toContain('name="key"');
    const noSecret = appWith({ SESSION_SECRET: undefined });
    expect((await noSecret.fetch(new Request(URL_BASE + "/board/login", form(VIEWER)))).status).toBe(503);
    expect((await get(noSecret, "/board/api/tasks", { cookie })).status).toBe(401);
  });
});

describe("web API access", () => {
  const app = appWith();
  it("needs a session or a viewer/owner bearer; the worker key is forbidden", async () => {
    expect((await get(app, "/board/api/tasks")).status).toBe(401);
    expect((await get(app, "/board/api/tasks", { authorization: `Bearer ${VIEWER}` })).status).toBe(200);
    expect((await get(app, "/board/api/tasks", { authorization: `Bearer ${OWNER}` })).status).toBe(200);
    expect((await get(app, "/board/api/tasks", { authorization: `Bearer ${WORKER}` })).status).toBe(403);
    expect((await get(app, "/board/api/tasks", { authorization: "Bearer wrong-0123456789abcdef" })).status).toBe(401);
    expect((await get(app, "/board/api/stream")).status).toBe(401);
    expect((await get(app, "/board/api/tasks/T-0001")).status).toBe(401);
  });

  it("is read-only: only GET is allowed, and unknown paths are 404", async () => {
    const auth = { authorization: `Bearer ${OWNER}` };
    for (const [method, path] of [["POST", "/board/api/tasks"], ["DELETE", "/board/api/tasks/T-0001"], ["PUT", "/board/api/stream"]] as const) {
      const res = await app.fetch(new Request(URL_BASE + path, { method, headers: auth }));
      expect(res.status, `${method} ${path}`).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
    }
    expect((await app.fetch(new Request(URL_BASE + "/board/login", { method: "GET" }))).headers.get("allow")).toBe("POST");
    expect((await app.fetch(new Request(URL_BASE + "/board", { method: "POST" }))).status).toBe(405);
    expect((await app.fetch(new Request(URL_BASE + "/board/assets/app.js", { method: "POST" }))).status).toBe(405);
    expect((await get(app, "/board/nope")).status).toBe(404);
    expect((await get(app, "/board/api/nope", auth)).status).toBe(404);
    expect((await get(app, "/boardx")).status).toBe(401);
  });
});

describe("board API shapes", () => {
  const app = appWith();
  const bearer = { authorization: `Bearer ${VIEWER}` };

  async function populate() {
    const ids = { open: await createTask({ title: "Open one", priority: 1 }) } as Record<string, string>;
    ids.claimed = await createTask({ title: "Claimed one" });
    await worker("claim_task", { id: ids.claimed });
    ids.progress = await createTask({ title: "Progress one" });
    await worker("claim_task", { id: ids.progress });
    await worker("post_progress", { id: ids.progress, note: "working" });
    ids.blocked = await createTask({ title: "Blocked one" });
    await worker("claim_task", { id: ids.blocked });
    await worker("ask_owner", { id: ids.blocked, question: "Which one?" });
    ids.done = await createTask({ title: "Done one" });
    await worker("claim_task", { id: ids.done });
    await worker("submit_result", { id: ids.done, summary: "finished", links: ["https://example.com/x"], notes: "n" });
    ids.failed = await createTask({ title: "Failed one" });
    await worker("claim_task", { id: ids.failed });
    await worker("submit_result", { id: ids.failed, summary: "nope", outcome: "failed" });
    ids.cancelled = await createTask({ title: "Cancelled one" });
    await owner("task_cancel", { id: ids.cancelled });
    return ids;
  }

  it("groups tasks into Open, Claimed, Blocked and Done with counts and card fields", async () => {
    const ids = await populate();
    const snap = (await (await get(app, "/board/api/tasks", bearer)).json()) as any;
    expect(snap.paused).toBe(false);
    expect(typeof snap.marker).toBe("string");
    expect(snap.columns.map((c: any) => [c.key, c.title, c.count])).toEqual([["open", "Open", 1], ["claimed", "Claimed", 2], ["blocked", "Blocked", 1], ["done", "Done", 3]]);
    const col = (k: string) => snap.columns.find((c: any) => c.key === k).tasks;
    expect(col("open")[0]).toEqual({
      id: ids.open, title: "Open one", priority: 1, claimed_by: null, status: "open",
      created_at: expect.any(String), updated_at: expect.any(String), last_activity_at: expect.any(String),
    });
    expect(col("claimed").map((t: any) => t.status).sort()).toEqual(["claimed", "in_progress"]);
    expect(col("claimed")[0].claimed_by).toBe("Muse");
    expect(col("blocked")[0]).toMatchObject({ id: ids.blocked, status: "needs_owner" });
    expect(col("done").map((t: any) => t.status).sort()).toEqual(["cancelled", "done", "failed"]);
    expect(JSON.stringify(snap)).not.toContain("brief");
  });

  it("flags the paused state", async () => {
    await owner("board_pause");
    expect(((await (await get(app, "/board/api/tasks", bearer)).json()) as any).paused).toBe(true);
  });

  it("lists newest first and caps each column at 200 while still counting all", async () => {
    const stmt = db.prepare("INSERT INTO tasks (id, title, brief, deliverable, acceptance, priority, status, origin, created_at, updated_at, last_activity_at) VALUES (?, ?, 'b', 'd', '', 2, 'open', 'o', ?, ?, ?)");
    const rows = Array.from({ length: 205 }, (_, i) => {
      const t = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      return stmt.bind(`T-${String(1000 + i)}`, `Task ${i}`, t, t, t);
    });
    await db.batch(rows);
    const snap = (await (await get(app, "/board/api/tasks", bearer)).json()) as any;
    const open = snap.columns[0];
    expect(open.count).toBe(205);
    expect(open.tasks).toHaveLength(200);
    expect(open.tasks[0].title).toBe("Task 204");
    expect(open.tasks[199].title).toBe("Task 5");
  });

  it("returns one task with its brief, timeline and result, and 404 otherwise", async () => {
    const ids = await populate();
    const done = (await (await get(app, `/board/api/tasks/${ids.done}`, bearer)).json()) as any;
    expect(done.task).toMatchObject({ id: ids.done, title: "Done one", brief: "Find three sources about X.", status: "done" });
    expect(done.events.map((e: any) => e.kind)).toEqual(["created", "claimed", "result"]);
    expect(done.result).toMatchObject({ summary: "finished", links: ["https://example.com/x"], outcome: "done" });
    const open = (await (await get(app, `/board/api/tasks/${ids.open}`, bearer)).json()) as any;
    expect(open.result).toBeNull();
    expect((await get(app, "/board/api/tasks/T-9999", bearer)).status).toBe(404);
    expect((await get(app, "/board/api/tasks/not-an-id", bearer)).status).toBe(404);
  });
});

describe("security headers", () => {
  const app = appWith();
  it("are on every web board response", async () => {
    const cookie = await session(app);
    const id = await createTask();
    const requests: [string, Record<string, string>, string?][] = [
      ["/board", {}], ["/board", { cookie }], ["/board/assets/app.js", {}], ["/board/assets/app.css", {}],
      ["/board/api/tasks", { cookie }], [`/board/api/tasks/${id}`, { cookie }], ["/board/api/tasks", {}], ["/board/nope", {}],
    ];
    for (const [path, headers] of requests) {
      const res = await get(app, path, headers);
      expect(res.headers.get("content-security-policy"), path).toBe(CSP);
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      // Not no-referrer: under that policy browsers send Origin: null on a form POST, and the login's origin check refuses it.
      expect(res.headers.get("referrer-policy"), path).toBe("same-origin");
      expect(res.headers.get("strict-transport-security"), path).toContain("max-age=");
      if (!path.includes("assets")) expect(res.headers.get("cache-control"), path).toBe("no-store");
    }
    const post = await app.fetch(new Request(URL_BASE + "/board/login", form("bad")));
    expect(post.headers.get("content-security-policy")).toBe(CSP);
    expect(get(app, "/board/api/stream", { cookie }).then((r) => r.headers.get("cache-control"))).resolves.toBe("no-store");
  });

  it("uses exactly the required policy", () => {
    expect(CSP).toBe("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  });
});

describe("UI assets", () => {
  const app = appWith();
  it("serves a page with no inline script, no inline style and no external resources", async () => {
    const cookie = await session(app);
    for (const html of [await (await get(app, "/board")).text(), await (await get(app, "/board", { cookie })).text()]) {
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
      expect(html).not.toMatch(/<style/i);
      expect(html).not.toMatch(/\sstyle=/i);
      expect(html).not.toMatch(/\son[a-z]+=/i);
      expect(html.match(/(?:src|href|action)="(https?:)?\/\/[^"]+"/g)).toBeNull();
    }
    const js = await get(app, "/board/assets/app.js");
    expect(js.headers.get("content-type")).toContain("text/javascript");
    const css = await get(app, "/board/assets/app.css");
    expect(css.headers.get("content-type")).toContain("text/css");
  });

  it("ships a script that parses, never uses innerHTML, and no remote URLs", () => {
    expect(() => new Function(APP_JS)).not.toThrow();
    expect(APP_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    expect(APP_JS).toContain("textContent");
    expect(APP_JS).toContain("EventSource");
    expect(APP_JS).toContain("3000");
    expect(APP_JS).toContain("prefers-reduced-motion");
    expect(APP_JS + APP_CSS).not.toMatch(/https?:\/\//);
    expect(APP_CSS).toContain("prefers-color-scheme: dark");
    expect(APP_CSS).toContain("max-width: 760px");
  });

  it("uses no teal or mint colours", () => {
    for (const [, hex] of APP_CSS.matchAll(/#([0-9a-f]{6})\b/gi)) {
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      if (d < 0.08) continue;
      let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
      expect(h < 140 || h > 195, `#${hex} hue ${Math.round(h)}`).toBe(true);
    }
  });
});

describe("live stream", () => {
  const app = appWith({}, { stream: { tickMs: 10, heartbeatMs: 60, maxMs: 700 } });

  async function open(path = "/board/api/stream") {
    const res = await app.fetch(new Request(URL_BASE + path, { headers: { authorization: `Bearer ${VIEWER}` } }));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const next = async (until: (b: string) => boolean, ms = 1500): Promise<string> => {
      const deadline = Date.now() + ms;
      while (!until(buffer)) {
        if (Date.now() > deadline) throw new Error(`timeout; got: ${buffer.slice(0, 200)}`);
        const r = await Promise.race([reader.read(), new Promise<null>((ok) => setTimeout(() => ok(null), 50))]);
        if (r === null) continue;
        if (r.done) return buffer;
        buffer += decoder.decode(r.value, { stream: true });
      }
      return buffer;
    };
    return { res, reader, next, take: () => { const b = buffer; buffer = ""; return b; } };
  }
  const eventData = (b: string) => JSON.parse(/data: (.*)\n/.exec(b)![1]);

  it("sends the snapshot at once, then a changed event when the board moves, then heartbeats", async () => {
    const s = await open();
    expect(s.res.headers.get("content-type")).toContain("text/event-stream");
    expect(s.res.headers.get("content-security-policy")).toBe(CSP);
    await s.next((b) => b.includes("event: changed"));
    const first = eventData(s.take());
    expect(first.columns[0].count).toBe(0);

    await createTask({ title: "Streamed" });
    await s.next((b) => b.includes("event: changed"));
    const second = eventData(s.take());
    expect(second.columns[0].count).toBe(1);
    expect(second.columns[0].tasks[0].title).toBe("Streamed");
    expect(second.marker).not.toBe(first.marker);

    await s.next((b) => b.includes(": heartbeat"));
    s.take();
    await s.reader.cancel();
  });

  it("closes after the maximum duration so EventSource reconnects", async () => {
    const s = await open();
    await s.next((b) => b.includes("event: changed"));
    const started = Date.now();
    for (;;) {
      const r = await s.reader.read();
      if (r.done) break;
      expect(Date.now() - started).toBeLessThan(3000);
    }
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  });

  it("works with a session cookie", async () => {
    const cookie = await session(app);
    const res = await get(app, "/board/api/stream", { cookie });
    expect(res.status).toBe(200);
    await res.body!.cancel();
  });
});
