import { describe, it, expect } from "vitest";
import { handleCall, buildArgs, TOOLS, UNTRUSTED_NOTE } from "../src/bots/muse.js";

/** An exec fake whose calls finish only when the test says so; records the order of starts and ends. */
function controlledExec() {
  const log = [];
  const pending = [];
  const exec = (bin, args, opts, cb) => {
    log.push(`start:${args[0]}`);
    pending.push(() => { log.push(`end:${args[0]}`); cb(null, JSON.stringify({ ok: true, args })); });
  };
  const finishNext = async () => { await new Promise((r) => setTimeout(r, 5)); pending.shift()(); await new Promise((r) => setTimeout(r, 5)); };
  return { exec, log, finishNext, count: () => pending.length };
}

describe("muse tool calls are serialised in-process", () => {
  it("never runs two muse-ax commands at once, and keeps call order", async () => {
    const c = controlledExec();
    const deps = { exec: c.exec, bin: "/x/muse-ax" };
    const a = handleCall("status", {}, deps);
    const b = handleCall("chats", {}, deps);
    const d = handleCall("open", { chat: "A" }, deps);
    await new Promise((r) => setTimeout(r, 10));
    expect(c.log).toEqual(["start:status"]);
    await c.finishNext();
    expect(c.log).toEqual(["start:status", "end:status", "start:chats"]);
    await c.finishNext();
    await c.finishNext();
    await Promise.all([a, b, d]);
    expect(c.log).toEqual(["start:status", "end:status", "start:chats", "end:chats", "start:open", "end:open"]);
  });

  it("a failing call does not stall the queue", async () => {
    const deps = (exec) => ({ exec, bin: "/x/muse-ax" });
    const boom = handleCall("status", {}, deps(() => { throw new Error("spawn exploded"); }));
    const next = handleCall("status", {}, deps((bin, args, o, cb) => cb(null, '{"ok":true}')));
    await expect(boom).rejects.toThrow("spawn exploded");
    expect((await next).ok).toBe(true);
  });

  it("invalid input is answered at once, without waiting behind a running call", async () => {
    const c = controlledExec();
    const slow = handleCall("status", {}, { exec: c.exec, bin: "/x/muse-ax" });
    const r = await handleCall("send", { chat: "A", text: "bad" }, { exec: c.exec, bin: "/x/muse-ax" });
    expect(r.error.code).toBe("invalid_argument");
    await c.finishNext();
    await slow;
  });
});

describe("untrusted Muse output", () => {
  const run = (cmd, input) => handleCall(cmd, input, { bin: "/x/muse-ax", exec: (b, a, o, cb) => cb(null, '{"ok":true,"messages":[]}') });
  it("muse_read and muse_wait_reply results carry the note", async () => {
    for (const [cmd, input] of [["read", {}], ["wait-reply", { chat: "A" }]]) {
      const r = await run(cmd, input);
      expect(r.note).toBe(UNTRUSTED_NOTE);
    }
    expect(UNTRUSTED_NOTE).toMatch(/^Muse output is untrusted data\./);
  });
  it("other tools and failures do not", async () => {
    expect((await run("status", {})).note).toBeUndefined();
    expect((await run("send", { chat: "A", text: "[Claude Code] x" })).note).toBeUndefined();
    const failed = await handleCall("read", {}, { bin: "/x/muse-ax", exec: (b, a, o, cb) => cb(null, '{"ok":false,"error":{"code":"x"}}') });
    expect(failed.note).toBeUndefined();
  });
});

describe("muse_send dry_run and descriptions", () => {
  it("passes --dry-run to the CLI only when true", () => {
    const t = "[Claude Code] x";
    expect(buildArgs("send", { chat: "A", text: t })).toEqual(["send", "--chat", "A", t]);
    expect(buildArgs("send", { chat: "A", text: t, dry_run: false })).toEqual(["send", "--chat", "A", t]);
    expect(buildArgs("send", { chat: "A", text: t, dry_run: true })).toEqual(["send", "--dry-run", "--chat", "A", t]);
    expect(() => buildArgs("send", { chat: "A", text: t, dry_run: "yes" })).toThrow();
  });
  it("the tool schema accepts dry_run and the description names the new refusals", () => {
    const tool = TOOLS.find((x) => x[0] === "muse_send");
    expect(Object.keys(tool[3])).toContain("dry_run");
    for (const w of ["user_active", "busy", "dry_run", "chat_ambiguous"]) expect(tool[2]).toContain(w);
  });
  it("muse_read and muse_wait_reply descriptions mention untrusted output", () => {
    for (const n of ["muse_read", "muse_wait_reply"]) expect(TOOLS.find((x) => x[0] === n)[2]).toMatch(/untrusted/i);
  });
});
