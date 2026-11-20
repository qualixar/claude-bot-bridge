import { describe, it, expect } from "vitest";
import path from "node:path";
import { resolveBinary, installedBinPath, installScriptPath, BIN_ENV } from "../src/binary.js";
import { handleCall } from "../src/bots/muse.js";

const HOME = "/home/u";
const installed = path.join(HOME, ".claude-bot-bridge", "bin", "muse-ax");
const present = (...files) => (p) => files.includes(p);

describe("resolveBinary", () => {
  it("prefers CBB_MUSE_AX when it points at an executable", () => {
    const r = resolveBinary({ env: { [BIN_ENV]: "/opt/muse-ax" }, home: HOME, isExecutable: present("/opt/muse-ax", installed) });
    expect(r).toEqual({ ok: true, bin: "/opt/muse-ax", source: "env" });
  });
  it("falls back to ~/.claude-bot-bridge/bin/muse-ax", () => {
    const r = resolveBinary({ env: {}, home: HOME, isExecutable: present(installed) });
    expect(r).toEqual({ ok: true, bin: installed, source: "default" });
  });
  it("treats an empty CBB_MUSE_AX as unset", () => {
    const r = resolveBinary({ env: { [BIN_ENV]: "" }, home: HOME, isExecutable: present(installed) });
    expect(r.source).toBe("default");
  });
  it("fails loudly when CBB_MUSE_AX is set but not executable (no silent fallback)", () => {
    const r = resolveBinary({ env: { [BIN_ENV]: "/nope" }, home: HOME, isExecutable: present(installed) });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("binary_missing");
    expect(r.error.message).toContain("/nope");
    expect(r.error.message).toContain(BIN_ENV);
  });
  it("returns an actionable one-line error naming install.sh when nothing is found", () => {
    const r = resolveBinary({ env: { CLAUDE_PLUGIN_ROOT: "/plug" }, home: HOME, isExecutable: present() });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("binary_missing");
    expect(r.error.message).toContain("/plug/scripts/install.sh");
    expect(r.error.message).not.toContain("\n");
  });
});

describe("paths", () => {
  it("installedBinPath is under the home directory", () => expect(installedBinPath(HOME)).toBe(installed));
  it("installScriptPath uses CLAUDE_PLUGIN_ROOT when set", () => {
    expect(installScriptPath({ CLAUDE_PLUGIN_ROOT: "/p" }, "/x/y")).toBe("/p/scripts/install.sh");
  });
  it("installScriptPath derives from the server location otherwise", () => {
    expect(installScriptPath({}, "/p/bridge/muse/mcp/dist")).toBe("/p/scripts/install.sh");
  });
});

describe("handleCall without a binary", () => {
  it("returns binary_missing instead of crashing", async () => {
    const r = await handleCall("status", {}, { env: {}, home: HOME, isExecutable: () => false });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("binary_missing");
  });
  it("still validates input first", async () => {
    const r = await handleCall("send", { chat: "A", text: "bad" }, { env: {}, home: HOME, isExecutable: () => false });
    expect(r.error.code).toBe("invalid_argument");
  });
  it("runs the resolved binary", async () => {
    let used;
    const exec = (bin, args, opts, cb) => { used = bin; cb(null, '{"ok":true}'); };
    const r = await handleCall("status", {}, { env: { [BIN_ENV]: "/opt/muse-ax" }, home: HOME, isExecutable: present("/opt/muse-ax"), exec });
    expect(used).toBe("/opt/muse-ax");
    expect(r.ok).toBe(true);
  });
});
