import { beforeEach, describe, expect, it } from "vitest";
import { appWith, db } from "#harness";
import { toB64Url } from "../src/crypto/b64";
import { createVault } from "../src/crypto/vault";
import type { App } from "../src/app";
import { OWNER, WORKER } from "./harness-core";

const K1 = toB64Url(new Uint8Array(32).fill(11));
const K2 = toB64Url(new Uint8Array(32).fill(22));

let rpc = 0;
const call = async (app: App, token: string, name: string, args: Record<string, unknown> = {}) => {
  const res = await app.fetch(
    new Request("https://board.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const json = (await res.json()) as any;
  return { isError: Boolean(json.result?.isError), body: JSON.parse(json.result.content[0].text) };
};
const raw = async (sql: string, ...binds: (string | number)[]) => (await db.prepare(sql).bind(...binds).all<Record<string, any>>()).results;
const encrypted = (v: unknown) => typeof v === "string" && /^enc:v[12]:/.test(v);

const task = { title: "Secret title", brief: "Secret brief", deliverable: "Secret deliverable", acceptance: "Secret acceptance", priority: 2 };

async function fullLifecycle(app: App): Promise<string> {
  const id = (await call(app, OWNER, "task_create", task)).body.task.id as string;
  await call(app, WORKER, "claim_task", { id });
  await call(app, WORKER, "post_progress", { id, note: "Secret progress" });
  await call(app, WORKER, "ask_owner", { id, question: "Secret question?" });
  await call(app, OWNER, "task_answer", { id, reply: "Secret reply" });
  await call(app, WORKER, "submit_result", { id, summary: "Secret summary", links: ["https://example.com/secret"], notes: "Secret notes" });
  return id;
}

describe("encryption at rest", () => {
  let app: App;
  beforeEach(() => {
    app = appWith({ BOARD_ENCRYPTION_KEY: K1, ALLOW_PLAINTEXT_STORAGE: undefined });
  });

  it("stores every free-text column as enc:v1 ciphertext and returns plaintext through the tools", async () => {
    const id = await fullLifecycle(app);
    const [t] = await raw("SELECT * FROM tasks WHERE id = ?", id);
    for (const c of ["title", "brief", "deliverable", "acceptance", "question", "owner_reply"]) expect(encrypted(t[c]), c).toBe(true);
    const [r] = await raw("SELECT * FROM results WHERE task_id = ?", id);
    for (const c of ["summary", "links", "notes"]) expect(encrypted(r[c]), c).toBe(true);
    const events = await raw("SELECT * FROM events WHERE task_id = ?", id);
    expect(events.length).toBeGreaterThanOrEqual(6);
    const noted = events.filter((e) => e.note !== null);
    expect(noted.map((e) => e.kind)).toEqual(["created", "progress", "question", "answer", "result"]);
    for (const e of noted) expect(encrypted(e.note), e.kind).toBe(true);
    // Metadata stays queryable.
    expect(t.status).toBe("done");
    expect(JSON.stringify(await raw("SELECT * FROM tasks"))).not.toContain("Secret");

    const got = await call(app, OWNER, "task_get", { id });
    expect(got.body.task).toMatchObject({ title: "Secret title", brief: "Secret brief", acceptance: "Secret acceptance", question: "Secret question?", owner_reply: "Secret reply" });
    expect(got.body.result).toMatchObject({ summary: "Secret summary", notes: "Secret notes", links: ["https://example.com/secret"] });
    expect(got.body.events.map((e: any) => e.note)).toContain("Secret progress");
    expect((await call(app, OWNER, "task_list")).body.tasks[0].title).toBe("Secret title");
  });

  it("encrypts an empty acceptance too, and system notes", async () => {
    const id = (await call(app, OWNER, "task_create", { title: "t", brief: "b", deliverable: "d" })).body.task.id;
    expect(encrypted((await raw("SELECT acceptance FROM tasks WHERE id = ?", id))[0].acceptance)).toBe(true);
    await call(app, WORKER, "claim_task", { id });
    await db.prepare("UPDATE tasks SET last_activity_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(id).run();
    await app.tick(Date.now());
    const sys = (await raw("SELECT note FROM events WHERE kind = 'stale_reclaim'"))[0];
    expect(encrypted(sys.note)).toBe(true);
    expect((await call(app, OWNER, "task_get", { id })).body.events.at(-1).note).toMatch(/No heartbeat/);
  });

  it("refuses to read a ciphertext moved to another task (AAD binding): shows a placeholder", async () => {
    const a = (await call(app, OWNER, "task_create", { ...task, title: "A title" })).body.task.id;
    const b = (await call(app, OWNER, "task_create", { ...task, title: "B title" })).body.task.id;
    const [ra] = await raw("SELECT title FROM tasks WHERE id = ?", a);
    await db.prepare("UPDATE tasks SET title = ? WHERE id = ?").bind(ra.title, b).run();
    expect((await call(app, OWNER, "task_get", { id: a })).body.task.title).toBe("A title");
    // The moved ciphertext does not decrypt under the other task's AAD: it shows as unreadable, never as A's text.
    const swapped = await call(app, OWNER, "task_get", { id: b });
    expect(swapped.body.task.title).toBe("[unreadable: key missing]");
    expect(JSON.stringify(swapped.body)).not.toMatch(/A title|enc:v1/);
  });

  it("reads legacy plaintext rows and writes new ones encrypted", async () => {
    await db.prepare(
      "INSERT INTO tasks (id, title, brief, deliverable, acceptance, priority, status, origin, created_at, updated_at, last_activity_at) " +
        "VALUES ('T-0500', 'Legacy title', 'Legacy brief', 'Legacy deliverable', '', 2, 'open', 'o', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    ).run();
    expect((await call(app, WORKER, "get_task", { id: "T-0500" })).body.task.title).toBe("Legacy title");
    expect((await call(app, WORKER, "claim_task", { id: "T-0500" })).body.ok).toBe(true);
    const fresh = (await call(app, OWNER, "task_create", task)).body.task.id;
    expect(encrypted((await raw("SELECT title FROM tasks WHERE id = ?", fresh))[0].title)).toBe(true);
    expect((await raw("SELECT title FROM tasks WHERE id = 'T-0500'"))[0].title).toBe("Legacy title");
  });
});

describe("key rotation", () => {
  it("re-encrypts legacy and previous-key rows with the current key, page by page", async () => {
    const plain = appWith();
    const legacy = await fullLifecycle(plain);
    const first = appWith({ BOARD_ENCRYPTION_KEY: K1, ALLOW_PLAINTEXT_STORAGE: undefined });
    const keyed = await fullLifecycle(first);
    const second = appWith({ BOARD_ENCRYPTION_KEY: K2, BOARD_ENCRYPTION_KEY_PREVIOUS: K1, ALLOW_PLAINTEXT_STORAGE: undefined });

    // Before rotating, the new key plus PREVIOUS still reads everything.
    expect((await call(second, OWNER, "task_get", { id: keyed })).body.task.title).toBe("Secret title");
    expect((await call(second, OWNER, "task_get", { id: legacy })).body.task.title).toBe("Secret title");

    let cursor: string | undefined;
    let rewritten = 0;
    let pages = 0;
    do {
      const page = await call(second, OWNER, "admin_rotate_encryption", { cursor, limit: 1 });
      expect(page.body.ok).toBe(true);
      rewritten += page.body.rewritten;
      cursor = page.body.next_cursor ?? undefined;
      pages++;
    } while (cursor && pages < 200);
    expect(cursor).toBeUndefined();
    expect(rewritten).toBeGreaterThan(0);

    // Now the current key alone reads every row: no legacy plaintext, nothing on the old key.
    const only = appWith({ BOARD_ENCRYPTION_KEY: K2, ALLOW_PLAINTEXT_STORAGE: undefined });
    for (const id of [legacy, keyed]) {
      const got = await call(only, OWNER, "task_get", { id });
      expect(got.body.task).toMatchObject({ title: "Secret title", question: "Secret question?" });
      expect(got.body.result.summary).toBe("Secret summary");
    }
    for (const t of await raw("SELECT title, brief, question FROM tasks")) expect(encrypted(t.title) && encrypted(t.brief) && encrypted(t.question)).toBe(true);
    for (const e of await raw("SELECT note FROM events WHERE note IS NOT NULL")) expect(encrypted(e.note)).toBe(true);
    const v = createVault({ key: K2 });
    expect(await v.open("tasks.title." + legacy, (await raw("SELECT title FROM tasks WHERE id = ?", legacy))[0].title)).toBe("Secret title");

    // A second pass has nothing left to do.
    let again = 0;
    cursor = undefined;
    do {
      const page = await call(only, OWNER, "admin_rotate_encryption", { cursor, limit: 100 });
      again += page.body.rewritten;
      cursor = page.body.next_cursor ?? undefined;
    } while (cursor);
    expect(again).toBe(0);
  });

  it("needs a key, an owner token and a valid cursor", async () => {
    const noKey = await call(appWith(), OWNER, "admin_rotate_encryption");
    expect(noKey.body.error.code).toBe("invalid_state");
    const keyed = appWith({ BOARD_ENCRYPTION_KEY: K1, ALLOW_PLAINTEXT_STORAGE: undefined });
    expect((await call(keyed, OWNER, "admin_rotate_encryption", { cursor: "bogus" })).body.error.code).toBe("invalid_input");
    expect((await call(keyed, WORKER, "admin_rotate_encryption")).body.error.code).toBe("forbidden");
    expect((await call(keyed, OWNER, "admin_rotate_encryption", { cursor: "tasks:" })).body.ok).toBe(true);
  });
});

describe("missing encryption key", () => {
  it("answers 503 on every route including /healthz unless plaintext is explicitly allowed", async () => {
    const app = appWith({ ALLOW_PLAINTEXT_STORAGE: undefined });
    const errors: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    try {
      const mcp = await app.fetch(new Request("https://board.test/mcp", { method: "POST", headers: { authorization: `Bearer ${OWNER}` } }));
      expect(mcp.status).toBe(503);
      expect((await app.fetch(new Request("https://board.test/board"))).status).toBe(503);
      expect((await app.fetch(new Request("https://board.test/healthz"))).status).toBe(503);
    } finally {
      console.error = orig;
    }
    expect(String(errors[0][0])).toMatch(/BOARD_ENCRYPTION_KEY is not set/);
    expect((await appWith().fetch(new Request("https://board.test/healthz"))).status).toBe(200);
  });
});
