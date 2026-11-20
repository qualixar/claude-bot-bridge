// Findings from the independent review: rotation races, unreadable rows, board revision, event AAD, strict mode.
import { describe, expect, it, vi } from "vitest";
import { appWith, db } from "#harness";
import type { App } from "../src/app";
import { toB64Url } from "../src/crypto/b64";
import { createVault } from "../src/crypto/vault";
import { rotateBatch } from "../src/store/rotate";
import { rotateToCompletion } from "../src/store/rotate-run";
import { changeMarker } from "../src/store/web";
import type { BoardDb } from "../src/store/db";
import { OWNER, VIEWER, WORKER } from "./harness-core";

const K1 = toB64Url(new Uint8Array(32).fill(31));
const K2 = toB64Url(new Uint8Array(32).fill(32));
const keyed = (over: Record<string, string | undefined> = {}) => appWith({ BOARD_ENCRYPTION_KEY: K1, ALLOW_PLAINTEXT_STORAGE: undefined, ...over });

let rpc = 0;
async function call(app: App, token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await app.fetch(
    new Request("https://board.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const json = (await res.json()) as any;
  return { isError: Boolean(json.result?.isError), body: JSON.parse(json.result.content[0].text) };
}
const raw = async (sql: string, ...b: (string | number)[]) => (await db.prepare(sql).bind(...b).all<Record<string, any>>()).results;
const newTask = async (app: App, title = "Secret title") => (await call(app, OWNER, "task_create", { title, brief: "b", deliverable: "d" })).body.task.id as string;
const inProgress = async (app: App, title?: string) => {
  const id = await newTask(app, title);
  await call(app, WORKER, "claim_task", { id });
  await call(app, WORKER, "post_progress", { id, note: "going" });
  return id;
};

describe("H1: rotation counts rows actually changed", () => {
  it("reports a raced row as skipped, not rewritten, and a repeat pass completes it", async () => {
    const old = keyed();
    const id = await inProgress(old);
    await call(old, WORKER, "ask_owner", { id, question: "first question?" });
    await call(old, OWNER, "task_answer", { id, reply: "first answer" }); // `question` is now an old-key ciphertext
    const store = (database: BoardDb) => ({ db: database, vault: createVault({ key: K2, previous: K1 }) });
    let fired = false;
    const racing: BoardDb = {
      prepare: (sql) => db.prepare(sql),
      async batch(stmts) {
        if (!fired) {
          fired = true;
          await call(old, WORKER, "ask_owner", { id, question: "late question?" }); // rewrites `question` mid-rotation
        }
        return db.batch(stmts);
      },
    };
    const first = await rotateBatch(store(racing), "tasks:", 50);
    expect(first).toMatchObject({ rewritten: 0, skipped: 1, unreadable: 0 });
    expect((await raw("SELECT title FROM tasks WHERE id = ?", id))[0].title).not.toBe("");
    const verify = await rotateBatch(store(db), "tasks:", 50, { verify: true });
    expect(verify.stale).toBeGreaterThan(0);
    const second = await rotateBatch(store(db), "tasks:", 50);
    expect(second).toMatchObject({ rewritten: 1, skipped: 0 });
    expect((await rotateBatch(store(db), "tasks:", 50, { verify: true })).stale).toBe(0);
  });

  it("rotateToCompletion repeats passes after a race and ends verified", async () => {
    const old = keyed();
    const id = await inProgress(old);
    await call(old, WORKER, "ask_owner", { id, question: "first question?" });
    await call(old, OWNER, "task_answer", { id, reply: "first answer" });
    let fired = false;
    const racing: BoardDb = {
      prepare: (sql) => db.prepare(sql),
      async batch(stmts) {
        if (!fired) {
          fired = true;
          await call(old, WORKER, "ask_owner", { id, question: "late question?" });
        }
        return db.batch(stmts);
      },
    };
    const report = await rotateToCompletion({ db: racing, vault: createVault({ key: K2, previous: K1 }) });
    expect(report.skipped).toBeGreaterThanOrEqual(1);
    expect(report.passes).toBeGreaterThanOrEqual(2);
    expect(report).toMatchObject({ verified: true, stale: 0, unreadable: 0 });
    const only = keyed({ BOARD_ENCRYPTION_KEY: K2 });
    expect((await call(only, OWNER, "task_get", { id })).body.task.question).toBe("late question?");
  });

  it("rotateToCompletion is not verified while an unreadable value remains", async () => {
    const app = keyed();
    const id = await newTask(app);
    await db.prepare("UPDATE tasks SET brief = 'enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA' WHERE id = ?").bind(id).run();
    const report = await rotateToCompletion({ db, vault: createVault({ key: K1 }) });
    expect(report).toMatchObject({ verified: false, unreadable: 1 });
  });

  it("verify mode writes nothing and counts values not on the current key", async () => {
    await inProgress(keyed());
    const before = JSON.stringify(await raw("SELECT * FROM tasks"));
    const res = await rotateBatch({ db, vault: createVault({ key: K2, previous: K1 }) }, undefined, 50, { verify: true });
    expect(res.rewritten).toBe(0);
    expect(res.stale).toBeGreaterThan(0);
    expect(JSON.stringify(await raw("SELECT * FROM tasks"))).toBe(before);
  });

  it("reports undecryptable values instead of aborting the pass", async () => {
    const app = keyed();
    const bad = await newTask(app, "Will be lost");
    const good = await newTask(app, "Fine");
    await db.prepare("UPDATE tasks SET title = 'enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA' WHERE id = ?").bind(bad).run();
    const res = await rotateBatch({ db, vault: createVault({ key: K1 }) }, "tasks:", 50, { verify: true });
    expect(res.unreadable).toBe(1);
    const other = await rotateBatch({ db, vault: createVault({ key: K2, previous: K1 }) }, "tasks:", 50);
    expect(other.unreadable).toBe(1);
    expect(other.rewritten).toBe(2);
    expect((await call(keyed({ BOARD_ENCRYPTION_KEY: K2 }), OWNER, "task_get", { id: good })).body.task.title).toBe("Fine");
  });
});

describe("M1: one unreadable row does not take the board down", () => {
  async function corrupted() {
    const app = keyed();
    const bad = await newTask(app, "Broken one");
    const ok = await newTask(app, "Healthy one");
    await db.prepare("UPDATE tasks SET title = 'enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA', brief = 'enc:v1:bad' WHERE id = ?").bind(bad).run();
    return { app, bad, ok };
  }

  it("shows a placeholder for the field and logs only the task id", async () => {
    const { app, bad, ok } = await corrupted();
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a.join(" ")));
    try {
      const open = (await call(app, WORKER, "list_open_tasks")).body;
      expect(open.ok).toBe(true);
      const byId = Object.fromEntries(open.tasks.map((t: any) => [t.id, t.title]));
      expect(byId[bad]).toBe("[unreadable: key missing]");
      expect(byId[ok]).toBe("Healthy one");
      expect((await call(app, OWNER, "task_list")).body.ok).toBe(true);
      const snap = (await (await app.fetch(new Request("https://board.test/board/api/tasks", { headers: { authorization: `Bearer ${VIEWER}` } }))).json()) as any;
      expect(snap.columns[0].tasks.map((t: any) => t.title).sort()).toEqual(["Healthy one", "[unreadable: key missing]"]);
      const got = (await call(app, OWNER, "task_get", { id: bad })).body;
      expect(got.task.brief).toBe("[unreadable: key missing]");
      expect(got.task.deliverable).toBe("d");
    } finally {
      spy.mockRestore();
    }
    expect(errors.some((e) => e.includes(bad))).toBe(true);
    expect(errors.join(" ")).not.toMatch(/Broken one|enc:v1/);
  });

  it("keeps the SSE snapshot alive", async () => {
    const { app } = await corrupted();
    const res = await app.fetch(new Request("https://board.test/board/api/stream", { headers: { authorization: `Bearer ${VIEWER}` } }));
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("retry:");
    await reader.cancel();
  });

  it("shows placeholders for unreadable events and results", async () => {
    const app = keyed();
    const id = await inProgress(app);
    await call(app, WORKER, "submit_result", { id, summary: "s", links: ["https://example.com/a"] });
    await db.prepare("UPDATE results SET summary = 'enc:v1:x', links = 'enc:v1:y' WHERE task_id = ?").bind(id).run();
    await db.prepare("UPDATE events SET note = 'enc:v2:x' WHERE task_id = ? AND kind = 'progress'").bind(id).run();
    const got = (await call(app, OWNER, "task_get", { id })).body;
    expect(got.result).toMatchObject({ summary: "[unreadable: key missing]", links: [] });
    expect(got.events.find((e: any) => e.kind === "progress").note).toBe("[unreadable: key missing]");
  });
});

describe("M3: board revision counter", () => {
  const rev = async () => (await raw("SELECT value FROM meta WHERE key = 'board_rev'"))[0].value;

  it("is bumped by every kind of write, in the same transaction, and is the whole change marker", async () => {
    const app = appWith();
    const seen = [await changeMarker(db)];
    const id = await newTask(app);
    seen.push(await changeMarker(db));
    await call(app, WORKER, "claim_task", { id });
    seen.push(await changeMarker(db));
    await call(app, WORKER, "heartbeat");
    seen.push(await changeMarker(db));
    await call(app, OWNER, "board_pause");
    seen.push(await changeMarker(db));
    await call(app, OWNER, "board_resume");
    seen.push(await changeMarker(db));
    await db.prepare("UPDATE tasks SET last_activity_at = '2020-01-01T00:00:00.000Z'").run();
    await app.tick(Date.now());
    seen.push(await changeMarker(db));
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.at(-1)).toBe(await rev());
  });

  it("does not move on reads or on rate-limit writes", async () => {
    const app = appWith();
    await newTask(app);
    const before = await changeMarker(db);
    await call(app, OWNER, "task_list");
    await call(app, WORKER, "list_open_tasks");
    await app.fetch(new Request("https://board.test/mcp", { method: "POST", headers: { authorization: "Bearer wrong-0123456789abcdef" } }));
    expect(await changeMarker(db)).toBe(before);
  });

  it("is rolled back with a failed batch", async () => {
    const before = await rev();
    await expect(db.batch([db.prepare("INSERT INTO events (task_id, at, actor, kind) VALUES ('T-1','n','a','k')"), db.prepare("INSERT INTO meta (key, value) VALUES ('paused', 'dup')")])).rejects.toThrow();
    expect(await rev()).toBe(before);
  });
});

describe("M4: the worker display name is not an identity", () => {
  it("keeps heartbeating a task claimed as Musebot after WORKER_NAME becomes Muse", async () => {
    const legacy = appWith({ WORKER_NAME: "Musebot" });
    const id = await newTask(legacy);
    await call(legacy, WORKER, "claim_task", { id });
    await db.prepare("UPDATE tasks SET last_activity_at = ? WHERE id = ?").bind(new Date(Date.now() - 30 * 60_000).toISOString(), id).run();
    const renamed = appWith({ WORKER_NAME: "Muse" });
    const hb = await call(renamed, WORKER, "heartbeat");
    expect(hb.body.your_active_tasks).toBe(1);
    expect((await raw("SELECT last_activity_at AS t, claimed_by FROM tasks WHERE id = ?", id))[0]).toMatchObject({ claimed_by: "Musebot" });
    expect((await raw("SELECT last_activity_at AS t FROM tasks WHERE id = ?", id))[0].t > "2025").toBe(true);
    expect((await call(renamed, WORKER, "post_progress", { id, note: "still mine" })).body.ok).toBe(true);
    expect((await call(renamed, WORKER, "submit_result", { id, summary: "done" })).body.ok).toBe(true);
  });
});

describe("L3: event ciphertexts are bound to their event id; strict mode", () => {
  it("writes enc:v2 for event notes, bound to task and event id, so notes cannot be swapped inside a task", async () => {
    const app = keyed();
    const id = await inProgress(app);
    await call(app, WORKER, "post_progress", { id, note: "second note" });
    const notes = (await raw("SELECT id, note FROM events WHERE task_id = ? AND kind = 'progress' ORDER BY id", id));
    expect(notes).toHaveLength(2);
    for (const n of notes) expect(n.note).toMatch(/^enc:v2:/);
    await db.prepare("UPDATE events SET note = ? WHERE id = ?").bind(notes[1].note, notes[0].id).run();
    const got = (await call(app, OWNER, "task_get", { id })).body;
    const progress = got.events.filter((e: any) => e.kind === "progress").map((e: any) => e.note);
    expect(progress).toEqual(["[unreadable: key missing]", "second note"]);
  });

  it("still reads legacy enc:v1 event notes and rotation upgrades them to v2", async () => {
    const app = keyed();
    const id = await inProgress(app);
    const vault = createVault({ key: K1 });
    const ev = (await raw("SELECT id FROM events WHERE task_id = ? AND kind = 'progress'", id))[0];
    await db.prepare("UPDATE events SET note = ? WHERE id = ?").bind(await vault.seal(`events.note.${id}`, "legacy note"), ev.id).run();
    expect((await call(app, OWNER, "task_get", { id })).body.events.find((e: any) => e.kind === "progress").note).toBe("legacy note");
    const rotated = await rotateBatch({ db, vault }, "events:", 100);
    expect(rotated.rewritten).toBeGreaterThan(0);
    expect((await raw("SELECT note FROM events WHERE id = ?", ev.id))[0].note).toMatch(/^enc:v2:/);
    expect((await call(app, OWNER, "task_get", { id })).body.events.find((e: any) => e.kind === "progress").note).toBe("legacy note");
  });

  it("STRICT_ENCRYPTION=1 refuses plaintext and v1 event values, until rotation has run", async () => {
    const plain = appWith();
    const id = await inProgress(plain, "Plain title");
    const strict = keyed({ STRICT_ENCRYPTION: "1" });
    let got = (await call(strict, OWNER, "task_get", { id })).body;
    expect(got.task.title).toBe("[unreadable: key missing]");
    expect(got.events[0].note).toBe("[unreadable: key missing]");
    const pass = await rotateBatch({ db, vault: createVault({ key: K1, strict: true }) }, undefined, 100);
    expect(pass.unreadable).toBe(0);
    for (let cursor = pass.next_cursor; cursor; ) cursor = (await rotateBatch({ db, vault: createVault({ key: K1, strict: true }) }, cursor, 100)).next_cursor;
    got = (await call(strict, OWNER, "task_get", { id })).body;
    expect(got.task.title).toBe("Plain title");
    expect(got.events[0].note).toBe("Plain title");
  });

  it("STRICT_ENCRYPTION needs an encryption key", async () => {
    const res = await appWith({ STRICT_ENCRYPTION: "1" }).fetch(new Request("https://board.test/healthz"));
    expect(res.status).toBe(503);
  });
});
