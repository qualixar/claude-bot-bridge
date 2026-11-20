import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createManager } from "../src/lifecycle.js";
import { installedBinPath } from "../src/binary.js";
import { handleCall } from "../src/bots/muse.js";
import { readState, mergeState } from "../src/state.js";
import { manifestUrl } from "../src/manifest-source.js";
import { tmp, release, writeBinary, signManifest, hierarchy, run as testRun } from "./helpers.js";
const badHash = (r) => { const { signature: _s, ...m } = r.manifest; return signManifest({ ...m, sha256: "5".repeat(64) }, r.key.privateKey); };

const NOW = Date.UTC(2026, 10, 20, 12);
const offline = async () => new Response("not found", { status: 404 });
const placeholder = { version: "0.1.0", url: "https://github.com/qualixar/claude-bot-bridge/releases/download/v0.1.0/x.tar.gz", sha256: "<placeholder until first release>", signature: "<base64>" };
const open = [];
afterEach(async () => { while (open.length) await open.pop().close(); });

/**
 * A throwaway key hierarchy for every test: a root, a binary key that signs the release manifest (and names itself in key_id)
 * and a keyset signed by that root. It is handed to the manager as its root key and its bundled keyset, so what these tests
 * prove never depends on whether the repository's own keyset (keys/keyset.json) is signed yet.
 */
const trustFor = (h) => ({ pubPem: h.root.pubPem, bundledKeyset: { json: h.json, signature: h.signature } });

/** Manager wired to fakes. `cli` records every muse-ax CLI call and answers from `answers`. */
async function rig({ installed = "0.1.0", env = {}, answers = {}, fetchImpl, canBuild = async () => false, buildFallback, bundled, latest = "v0.1.0" } = {}) {
  const h = hierarchy({ now: NOW });
  const r = await release({ version: "0.1.0", key: h.binary, tamper: { pre: { key_id: "binary-1" } } }); open.push(r);
  const trust = trustFor(h);
  const home = tmp("home"), dir = path.join(home, ".claude-bot-bridge"), bin = installedBinPath(home);
  if (installed) writeBinary(bin, installed);
  const cli = [];
  const exec = (b, args, o, cb) => { cli.push(args.join(" ")); cb(null, JSON.stringify(answers[args[0]] ?? { ok: true })); };
  const apiCalls = [];
  const api = async (url) => { apiCalls.push(url); return { ok: true, status: 200, json: async () => ({ tag_name: latest }) }; };
  const builds = { n: 0 };
  // The keyset is looked for on GitHub first (none is published in these tests); it is not an API call.
  const routed = (url, o) => (url.startsWith(r.base) ? fetch(url, o) : url === manifestUrl("0.1.0") || url.includes("/keys/keyset.json") ? offline() : api(url));
  const m = createManager({ run: testRun,
    env, home, manifest: bundled === undefined ? r.manifest : bundled, ...trust, pluginVersion: "0.1.0", now: () => NOW,
    fetchImpl: fetchImpl ?? routed,
    exec, canBuild, buildFallback: buildFallback ?? (async () => { builds.n += 1; return { ok: false, message: "no build in tests" }; }), installScript: "/plug/scripts/install.sh",
  });
  return { m, r, h, trust, home, dir, bin, cli, apiCalls, exec, builds, routed };
}

describe("manager.start", () => {
  it("brings the binary up to date, then refreshes rules, then checks for plugin updates", async () => {
    const t = await rig({ installed: null });
    await t.m.start();
    expect(readState(t.dir).binaryUpdate ?? null).toBeNull();
    expect(t.cli).toEqual(["rules update"]);
    expect(t.apiCalls).toHaveLength(1);
    expect(t.m.gate()).toBeNull();
  });
  it("remembers the keyset it trusted in <home>/keys/current, so a later failed fetch cannot weaken it", async () => {
    const t = await rig({ installed: null });
    await t.m.start();
    expect(fs.readlinkSync(path.join(t.dir, "keys", "current"))).toMatch(/^v-/);
    expect(fs.readFileSync(path.join(t.dir, "keys", "current", "keyset.json"), "utf8")).toBe(t.h.json);
  });
  it("does nothing network-related when everything is current and recently checked", async () => {
    const t = await rig();
    mergeState(t.dir, { rulesUpdate: { checkedAt: new Date(NOW - 3600e3).toISOString() }, updateCheck: { checkedAt: new Date(NOW - 3600e3).toISOString(), latest: "0.1.0" } });
    await t.m.start();
    expect(t.cli).toEqual([]);
    expect(t.apiCalls).toEqual([]);
    expect(t.r.hits).toEqual([]);
  });
  it("CBB_NO_AUTO_UPDATE=1 turns off binary and rules updates", async () => {
    const t = await rig({ installed: "0.0.1", env: { CBB_NO_AUTO_UPDATE: "1" } });
    await t.m.start();
    expect(t.cli).toEqual([]);
    expect(t.r.hits).toEqual([]);
  });
});

describe("tools during an update", () => {
  it("return `updating` with retry_after_seconds instead of hanging, then recover", async () => {
    let release_; const gateOpen = new Promise((ok) => { release_ = ok; });
    let t;
    const slowFetch = async (url, o) => { await gateOpen; return t.routed(url, o); };
    t = await rig({ installed: "0.0.1" });
    const m = createManager({ run: testRun, env: {}, home: t.home, manifest: t.r.manifest, ...t.trust, pluginVersion: "0.1.0", now: () => NOW,
      fetchImpl: slowFetch, exec: t.exec, canBuild: async () => false, buildFallback: async () => ({ ok: false }), installScript: "x" });
    const started = m.start();
    for (let i = 0; i < 100 && !m.gate(); i++) await new Promise((ok) => setTimeout(ok, 20));
    const g = m.gate();
    expect(g).toMatchObject({ ok: false, error: { code: "updating" } });
    expect(g.error.retry_after_seconds).toBeGreaterThan(0);
    expect(g.error.message).toMatch(/retry/i);
    const r = await handleCall("status", {}, { manager: m, exec: () => { throw new Error("must not run"); } });
    expect(r.error.code).toBe("updating");
    release_(); await started;
    expect(m.gate()).toBeNull();
  });
});

describe("failed update", () => {
  it("with no binary: binary_missing carries the actionable reason", async () => {
    const t = await rig({ installed: null });
    const bad = badHash(t.r);
    const m = createManager({ run: testRun, env: {}, home: t.home, manifest: bad, ...t.trust, pluginVersion: "0.1.0", now: () => NOW,
      fetchImpl: t.routed, exec: t.exec, canBuild: async () => false, buildFallback: async () => ({ ok: false }), installScript: "/plug/scripts/install.sh" });
    await m.start();
    expect(m.gate()).toBeNull();
    const r = await handleCall("status", {}, { manager: m, home: t.home, env: {} });
    expect(r.error.code).toBe("binary_missing");
    expect(r.error.message).toContain("/bot-bridge:setup");
    expect(r.error.message).toContain("/plug/scripts/install.sh");
    expect(r.error.message).not.toContain("\n");
  });
  it("with a working older binary: tools keep working", async () => {
    const t = await rig({ installed: "0.0.1" });
    const bad = badHash(t.r);
    const m = createManager({ run: testRun, env: {}, home: t.home, manifest: bad, ...t.trust, pluginVersion: "0.1.0", now: () => NOW,
      fetchImpl: t.routed, exec: t.exec, canBuild: async () => false, buildFallback: async () => ({ ok: false }), installScript: "x" });
    await m.start();
    expect(m.gate()).toBeNull();
    const r = await handleCall("status", {}, { manager: m, home: t.home, env: {}, exec: t.exec });
    expect(r.ok).toBe(true);
  });
});

describe("the release manifest is what delivers the binary", () => {
  it("with only the placeholder bundled, the signed manifest from the release URL installs the binary", async () => {
    const t = await rig({ installed: null, bundled: placeholder });
    const seen = [];
    const m = createManager({ run: testRun, env: {}, home: t.home, manifest: placeholder, ...t.trust, pluginVersion: "0.1.0", now: () => NOW,
      fetchImpl: (url, o) => { seen.push(url); return url === manifestUrl("0.1.0") ? new Response(JSON.stringify(t.r.manifest)) : fetch(url, o); },
      exec: t.exec, canBuild: async () => false, buildFallback: async () => ({ ok: false }), installScript: "x" });
    await m.start();
    expect(seen.filter((u) => !u.includes("/keys/keyset.json"))[0]).toBe("https://github.com/qualixar/claude-bot-bridge/releases/download/v0.1.0/binary-manifest.json");
    expect(readState(t.dir).binaryUpdate ?? null).toBeNull();
    expect((await handleCall("chats", {}, { manager: m, home: t.home, env: {}, exec: t.exec })).ok).toBe(true);
  });
  it("a release manifest of another version is not used", async () => {
    const t = await rig({ installed: null, bundled: placeholder });
    const wrong = signManifest({ version: "0.0.9", url: t.r.manifest.url, sha256: t.r.manifest.sha256 }, t.r.key.privateKey);
    const m = createManager({ run: testRun, env: {}, home: t.home, manifest: placeholder, ...t.trust, pluginVersion: "0.1.0", now: () => NOW,
      fetchImpl: (url, o) => (url === manifestUrl("0.1.0") ? new Response(JSON.stringify(wrong)) : fetch(url, o)),
      exec: t.exec, canBuild: async () => false, buildFallback: async () => ({ ok: false }), installScript: "x" });
    await m.start();
    expect((await handleCall("status", {}, { manager: m, home: t.home, env: {} })).error.code).toBe("binary_missing");
  });
  it("a binary that already reports the plugin version triggers no manifest request at all", async () => {
    const t = await rig({ installed: "0.1.0" });
    const seen = [];
    const m = createManager({ run: testRun, env: {}, home: t.home, manifest: placeholder, ...t.trust, pluginVersion: "0.1.0", now: () => NOW,
      fetchImpl: async (url) => { seen.push(url); return offline(); }, exec: t.exec, canBuild: async () => false, buildFallback: async () => ({ ok: false }), installScript: "x" });
    mergeState(t.dir, { rulesUpdate: { checkedAt: new Date(NOW).toISOString() }, updateCheck: { checkedAt: new Date(NOW).toISOString(), latest: "0.1.0" } });
    await m.start();
    expect(seen).toEqual([]);
  });
});

describe("no automatic build without consent", () => {
  const build = (t) => async () => { t.n += 1; return { ok: false, message: "no build in tests" }; };
  async function startWith({ env = {}, setup } = {}) {
    const t = await rig({ installed: null, bundled: placeholder, canBuild: async () => true, env });
    const count = { n: 0 };
    if (setup) setup(t);
    const m = createManager({ run: testRun, env, home: t.home, manifest: placeholder, ...t.trust, pluginVersion: "0.1.0", now: () => NOW,
      fetchImpl: t.routed, exec: t.exec, canBuild: async () => true, buildFallback: build(count), installScript: "/plug/scripts/install.sh" });
    await m.start();
    return { t, count, m };
  }
  it("nothing is built at session start by default; the tool says how to fix it in one line", async () => {
    const { t, count, m } = await startWith();
    expect(count.n).toBe(0);
    const r = await handleCall("status", {}, { manager: m, home: t.home, env: {} });
    expect(r.error.code).toBe("binary_missing");
    expect(r.error.message).toContain("/bot-bridge:setup");
    expect(r.error.message).not.toContain("\n");
  });
  it("CBB_ALLOW_LOCAL_BUILD=1 allows it", async () => {
    expect((await startWith({ env: { CBB_ALLOW_LOCAL_BUILD: "1" } })).count.n).toBe(1);
  });
  it("having run setup before allows it (the marker install.sh leaves)", async () => {
    expect((await startWith({ setup: (t) => { fs.mkdirSync(t.dir, { recursive: true }); fs.writeFileSync(path.join(t.dir, ".setup-done"), "x"); } })).count.n).toBe(1);
  });
  it("the automatic build runs install.sh with CBB_NO_SETUP_MARKER=1 so it can never grant consent by itself", async () => {
    const t = await rig({ installed: null, bundled: placeholder, env: { CBB_ALLOW_LOCAL_BUILD: "1" } });
    const calls = [];
    const run = async (file, args, o) => { calls.push({ file, args, env: o?.env }); return file === "xcode-select" ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "stop" }; };
    const m = createManager({ run: testRun, env: { CBB_ALLOW_LOCAL_BUILD: "1" }, home: t.home, manifest: placeholder, ...t.trust, pluginVersion: "0.1.0", now: () => NOW,
      fetchImpl: t.routed, exec: t.exec, run, installScript: "/plug/scripts/install.sh" });
    await m.start();
    const build = calls.find((c) => c.file === "sh");
    expect(build.args).toEqual(["/plug/scripts/install.sh"]);
    expect(build.env.CBB_NO_SETUP_MARKER).toBe("1");
  });
  it("an earlier install.sh build directory counts as having run setup", async () => {
    expect((await startWith({ setup: (t) => fs.mkdirSync(path.join(t.dir, "build"), { recursive: true }) })).count.n).toBe(1);
  });
});

describe("after(): status decoration and rules triggers", () => {
  const unknown = { ok: true, version_check: "probe", muse_version: { short: "14.0" } };

  it("adds update_available to status only", async () => {
    const t = await rig();
    mergeState(t.dir, { updateCheck: { checkedAt: new Date(NOW).toISOString(), latest: "0.2.0" } });
    const s = t.m.after("status", { ok: true, version_check: "verified" });
    expect(s.update_available).toEqual({ current: "0.1.0", latest: "0.2.0", how: expect.stringContaining("claude plugin update bot-bridge@claude-bot-bridge") });
    expect(t.m.after("chats", { ok: true }).update_available).toBeUndefined();
    expect(t.m.after("status", { ok: false, error: {} }).update_available).toBeUndefined();
  });
  it("does not mutate the result it is given", async () => {
    const t = await rig();
    mergeState(t.dir, { updateCheck: { checkedAt: new Date(NOW).toISOString(), latest: "0.2.0" } });
    const input = { ok: true }; t.m.after("status", input);
    expect(input).toEqual({ ok: true });
  });
  it("triggers a background rules update immediately for an unknown Muse version, once", async () => {
    const t = await rig();
    t.m.after("status", unknown); await t.m.idle();
    expect(t.cli).toEqual(["rules update"]);
    t.m.after("status", unknown); await t.m.idle();
    expect(t.cli).toEqual(["rules update"]);
  });
  it("never triggers for a verified version or non-status tools", async () => {
    const t = await rig();
    t.m.after("status", { ok: true, version_check: "verified", muse_version: { short: "13.1" } });
    t.m.after("selftest", unknown); await t.m.idle();
    expect(t.cli).toEqual([]);
  });
  it("is disabled with CBB_NO_AUTO_UPDATE", async () => {
    const t = await rig({ env: { CBB_NO_AUTO_UPDATE: "1" } });
    t.m.after("status", unknown); await t.m.idle();
    expect(t.cli).toEqual([]);
  });
});

describe("handleCall + manager", () => {
  it("passes status through manager.after", async () => {
    const exec = (b, a, o, cb) => cb(null, '{"ok":true,"version_check":"verified"}');
    const manager = { gate: () => null, after: (cmd, r) => ({ ...r, decorated: cmd }) };
    const r = await handleCall("status", {}, { bin: "/x", exec, manager });
    expect(r.decorated).toBe("status");
  });
  it("input errors still win over everything", async () => {
    const manager = { gate: () => ({ ok: false, error: { code: "updating" } }), after: (c, r) => r };
    expect((await handleCall("send", { chat: "A", text: "bad" }, { manager })).error.code).toBe("invalid_argument");
  });
  it("works without a manager (tests, embedding)", async () => {
    const exec = (b, a, o, cb) => cb(null, '{"ok":true}');
    expect((await handleCall("chats", {}, { bin: "/x", exec })).ok).toBe(true);
  });
});
