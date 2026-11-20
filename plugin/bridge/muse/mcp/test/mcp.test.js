import { describe, it, expect } from "vitest";
import { parseOutput, runCli } from "../src/cli.js";
import * as v from "../src/validate.js";
import { buildArgs, processTimeout, handleCall, TOOLS } from "../src/bots/muse.js";

describe("validation", () => {
  it("accepts a good send", () => expect(v.sendText("[Claude Code] hi")).toBe("[Claude Code] hi"));
  it("refuses missing prefix", () => expect(() => v.sendText("hi")).toThrow(v.InputError));
  it("refuses prefix only", () => expect(() => v.sendText("[Claude Code]")).toThrow(v.InputError));
  it("refuses >500 chars", () => expect(() => v.sendText("[Claude Code] " + "a".repeat(490))).toThrow(v.InputError));
  it("allows exactly 500", () => expect(() => v.sendText("[Claude Code] " + "a".repeat(486))).not.toThrow());
  it("refuses newline", () => expect(() => v.sendText("[Claude Code] a\nb")).toThrow(v.InputError));
  it("refuses non-string", () => expect(() => v.sendText(5)).toThrow(v.InputError));
  it("chat name rules", () => {
    expect(() => v.chatName("")).toThrow();
    expect(() => v.chatName("a\u0000b")).toThrow();
    expect(() => v.chatName("x".repeat(201))).toThrow();
    expect(v.chatName("Main chat")).toBe("Main chat");
  });
  it("ranges", () => {
    expect(() => v.intInRange("last", 0, 1, 200)).toThrow();
    expect(() => v.intInRange("last", 1.5, 1, 200)).toThrow();
    expect(() => v.numInRange("timeout", NaN, 1, 600)).toThrow();
  });
});

describe("muse_send description", () => {
  const desc = TOOLS.find((t) => t[0] === "muse_send")[2];
  it("states the real duration and the refusal codes, not the old ~2 s", () => {
    expect(desc).not.toMatch(/~2 s|about 2 s/);
    expect(desc).toMatch(/3 to 5 seconds/);
    expect(desc).toContain("composer_mismatch");
    expect(desc).toContain("click_target_mismatch");
  });
});

describe("buildArgs", () => {
  it("maps tools", () => {
    expect(buildArgs("status")).toEqual(["status"]);
    expect(buildArgs("open", { chat: "A" })).toEqual(["open", "A"]);
    expect(buildArgs("read", { chat: "A", last: 5 })).toEqual(["read", "--chat", "A", "--last", "5"]);
    expect(buildArgs("read", {})).toEqual(["read"]);
    expect(buildArgs("send", { chat: "A", text: "[Claude Code] x" })).toEqual(["send", "--chat", "A", "[Claude Code] x"]);
    expect(buildArgs("wait-reply", { chat: "A", timeout: 30 })).toEqual(["wait-reply", "--chat", "A", "--timeout", "30"]);
  });
  it("rejects bad input and unknown tools", () => {
    expect(() => buildArgs("send", { chat: "A", text: "no prefix" })).toThrow();
    expect(() => buildArgs("open", {})).toThrow();
    expect(() => buildArgs("rm")).toThrow();
  });
  it("wait-reply gets slack on the process timeout", () => {
    expect(processTimeout("wait-reply", { timeout: 60 })).toBe(90_000);
    expect(processTimeout("status")).toBe(60_000);
  });
});

describe("parseOutput", () => {
  it("parses JSON even when exit code is non-zero", () => {
    expect(parseOutput('{"ok":false,"error":{"code":"x"}}\n', new Error("exit 1")).ok).toBe(false);
  });
  it("reports empty output", () => expect(parseOutput("", null).error.code).toBe("cli_error"));
  it("reports timeouts", () => expect(parseOutput("", Object.assign(new Error("t"), { killed: true })).error.message).toMatch(/timed out/));
});

describe("handleCall", () => {
  it("returns invalid_argument without spawning anything", async () => {
    const exec = () => { throw new Error("must not run"); };
    const r = await handleCall("send", { chat: "A", text: "bad" }, { exec });
    expect(r.error.code).toBe("invalid_argument");
  });
  it("passes argv to the CLI and returns its JSON", async () => {
    let seen;
    const exec = (bin, args, opts, cb) => { seen = args; cb(null, '{"ok":true,"chats":[]}'); };
    const r = await handleCall("chats", {}, { exec, bin: "/x/muse-ax" });
    expect(seen).toEqual(["chats"]);
    expect(r.ok).toBe(true);
  });
  it("runCli handles a missing binary", async () => {
    const r = await runCli(["status"], { bin: "/nonexistent/muse-ax" });
    expect(r.ok).toBe(false);
  });
  it("exposes all eight tools", () => {
    expect(TOOLS.map((t) => t[0]).sort()).toEqual(["muse_doctor", "muse_list_chats", "muse_open_chat", "muse_read", "muse_selftest", "muse_send", "muse_status", "muse_wait_reply"]);
  });
  it("no tool description promises to switch chats or to press anything in the chat list", () => {
    const text = (name) => TOOLS.find((t) => t[0] === name)[2];
    expect(text("muse_open_chat")).toMatch(/never switches chats/);
    expect(text("muse_open_chat")).toMatch(/chat_switch_unsupported/);
    expect(text("muse_open_chat")).toMatch(/open the chat in Muse themselves/);
    for (const [name, , description, shape] of TOOLS) {
      expect(description, name).not.toMatch(/presses its sidebar button/);
      expect(description, name).not.toMatch(/Open a chat by exact name/);
      if (shape.chat) expect(shape.chat.description, name).toMatch(/never switches chats/);
    }
    expect(text("muse_read")).toMatch(/already the open one/);
    expect(text("muse_send")).toMatch(/never switches chats/);
  });
  it("muse_doctor is read-only: it maps to `doctor` with no flags, whatever the caller passes", async () => {
    expect(buildArgs("doctor")).toEqual(["doctor"]);
    expect(buildArgs("doctor", { dump_tree: "/tmp/x.json", text: true })).toEqual(["doctor"]);
    const doctor = TOOLS.find((t) => t[0] === "muse_doctor");
    expect(doctor[1]).toBe("doctor");
    expect(doctor[2]).toMatch(/read-only/i);
    expect(doctor[3]).toEqual({});
  });
  it("muse_doctor runs the CLI once with exactly one argument", async () => {
    let seen;
    const exec = (bin, args, opts, cb) => { seen = args; cb(null, '{"ok":true,"bot":"muse","report":"x"}'); };
    const r = await handleCall("doctor", { dump_tree: "/tmp/x" }, { exec, bin: "/x/muse-ax" });
    expect(seen).toEqual(["doctor"]);
    expect(r.ok).toBe(true);
    expect(r.note).toBeUndefined();
  });
});
