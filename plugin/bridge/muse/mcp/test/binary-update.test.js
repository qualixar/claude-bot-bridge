import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { updateBinary, isReleased, installedVersion, acquireLock, UpdateError } from "../src/binary-update.js";
import { installedBinPath } from "../src/binary.js";
import { readState } from "../src/state.js";
import { verifyKeyset } from "../src/keyset.js";
import { tmp, newKey, release, writeBinary, signManifest, fakeBinaryScript, hierarchy, run as realRun } from "./helpers.js";

const open = [];
afterEach(async () => { while (open.length) await open.pop().close(); });
const NOW = Date.UTC(2026, 10, 20);
/** A release signed by a `binary` key that names itself, plus the trust (root key + the keyset listing that key) to check it with. */
const rel = async (o = {}) => {
  const h = hierarchy({ now: NOW });
  const r = await release({ ...o, key: h.binary, tamper: { pre: { key_id: "binary-1" } } });
  open.push(r);
  const keyset = verifyKeyset({ json: h.json, signature: h.signature, pubPem: h.root.pubPem, now: NOW });
  return { ...r, h, trust: { pubPem: h.root.pubPem, keyset } };
};
/** The release manifest with some signed fields replaced, re-signed with the release key. */
const resigned = (r, over) => { const { signature: _s, ...m } = r.manifest; return signManifest({ ...m, ...over }, r.key.privateKey); };
const badHash = (r, c = "1") => resigned(r, { sha256: c.repeat(64) });

function setup(extra = {}) {
  const home = tmp("home");
  const bin = installedBinPath(home);
  const calls = { build: 0 };
  return {
    home, bin, calls,
    deps: {
      home, env: {}, now: () => NOW,
      run: realRun,
      canBuild: async () => true,
      buildFallback: async () => { calls.build += 1; return { ok: false, message: "build not wired" }; },
      installScript: "/plug/scripts/install.sh",
      allowBuild: true,
      ...extra,
    },
  };
}
const version = async (bin) => (await installedVersion(bin, realRun));

describe("isReleased", () => {
  it("rejects the placeholder manifest", () => {
    expect(isReleased({ version: "1.0.0", url: "u", sha256: "<placeholder until first release>", signature: "<base64>" })).toBe(false);
    expect(isReleased({ version: "1.0.0", url: "u", sha256: "a".repeat(64), signature: "" })).toBe(false);
    expect(isReleased({ version: "1.0.0", url: "u", sha256: "a".repeat(64), signature: "c2ln" })).toBe(true);
  });
});

describe("updateBinary: success paths", () => {
  it("installs a signed release when no binary exists", async () => {
    const r = await rel(); const s = setup();
    const out = await updateBinary({ ...s.deps, manifest: r.manifest, ...r.trust });
    expect(out).toMatchObject({ action: "installed", version: "9.9.9" });
    expect(await version(s.bin)).toBe("9.9.9");
    expect(fs.statSync(s.bin).mode & 0o777).toBe(0o755);
    expect(fs.existsSync(`${s.bin}.prev`)).toBe(false);
    expect(fs.readdirSync(path.dirname(s.bin)).sort()).toEqual(["muse-ax"]);
  });
  it("replaces an older binary atomically and keeps it as muse-ax.prev", async () => {
    const r = await rel(); const s = setup();
    writeBinary(s.bin, "0.0.1");
    const out = await updateBinary({ ...s.deps, manifest: r.manifest, ...r.trust });
    expect(out.action).toBe("installed");
    expect(await version(s.bin)).toBe("9.9.9");
    expect(await version(`${s.bin}.prev`)).toBe("0.0.1");
    expect(fs.readdirSync(path.dirname(s.bin)).sort()).toEqual(["muse-ax", "muse-ax.prev"]);
  });
  it("does nothing when the installed version already matches (no network)", async () => {
    const r = await rel(); const s = setup();
    writeBinary(s.bin, "9.9.9");
    const out = await updateBinary({ ...s.deps, manifest: r.manifest, ...r.trust });
    expect(out.action).toBe("current");
    expect(r.hits).toEqual([]);
  });
  it("treats a binary without a version command as outdated", async () => {
    const r = await rel(); const s = setup();
    fs.mkdirSync(path.dirname(s.bin), { recursive: true });
    fs.writeFileSync(s.bin, "#!/bin/sh\nexit 2\n", { mode: 0o755 });
    expect((await updateBinary({ ...s.deps, manifest: r.manifest, ...r.trust })).action).toBe("installed");
  });
  it("clears an earlier failure record on success", async () => {
    const r = await rel(); const s = setup();
    await updateBinary({ ...s.deps, manifest: badHash(r, "0"), ...r.trust });
    expect(readState(path.join(s.home, ".claude-bot-bridge")).binaryUpdate).toBeTruthy();
    await updateBinary({ ...s.deps, manifest: r.manifest, ...r.trust, force: true });
    expect(readState(path.join(s.home, ".claude-bot-bridge")).binaryUpdate).toBeNull();
  });
});

describe("updateBinary: rejections never replace the installed binary", () => {
  async function expectFailure(r, mutate, s = setup()) {
    writeBinary(s.bin, "0.0.1");
    const out = await updateBinary({ ...s.deps, manifest: mutate(r.manifest), ...r.trust });
    expect(out.action).toBe("failed");
    expect(await version(s.bin)).toBe("0.0.1");
    expect(fs.readdirSync(path.dirname(s.bin)).some((n) => n.includes(".new"))).toBe(false);
    return { out, s };
  }
  it("sha256 mismatch", async () => {
    const r = await rel();
    const { out } = await expectFailure(r, (m) => signManifest({ version: m.version, key_id: m.key_id, url: m.url, sha256: "1".repeat(64) }, r.key.privateKey));
    expect(out.error.code).toBe("sha256_mismatch");
  });
  it("manifest signed by another key: refused before any download", async () => {
    const r = await rel();
    const { out } = await expectFailure(r, (m) => signManifest({ version: m.version, url: m.url, sha256: m.sha256 }, newKey().privateKey));
    expect(out.error.code).toBe("bad_manifest_signature");
    expect(r.hits).toEqual([]);
  });
  it("edited manifest (url swapped after signing)", async () => {
    const r = await rel();
    const { out } = await expectFailure(r, (m) => ({ ...m, url: m.url.replace("/rel/", "/evil/") }));
    expect(out.error.code).toBe("bad_manifest_signature");
    expect(r.hits).toEqual([]);
  });
  it("missing signature", async () => {
    const r = await rel();
    const { out } = await expectFailure(r, (m) => ({ ...m, signature: "" }));
    expect(out.error.code).toBe("not_released");
  });
  it("HTTP 404", async () => {
    const r = await rel();
    const { out } = await expectFailure(r, (m) => signManifest({ version: m.version, key_id: m.key_id, url: m.url.replace("muse-ax.tar.gz", "missing.tgz"), sha256: m.sha256 }, r.key.privateKey));
    expect(out.error.code).toBe("download_failed");
  });
  it("an endless download is cut off at the size cap while it streams, and nothing is installed", async () => {
    const http = await import("node:http");
    let sent = 0, closed = false;
    const server = http.createServer((req, res) => {
      res.on("close", () => { closed = true; });
      const timer = setInterval(() => { sent += 16384; res.write(Buffer.alloc(16384)); }, 2);
      res.on("close", () => clearInterval(timer));
    });
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    open.push({ close: async () => { server.closeAllConnections?.(); await new Promise((ok) => server.close(ok)); } });
    const r = await rel();
    const s = setup();
    const { signature: _s, ...m } = r.manifest;
    const manifest = signManifest({ ...m, url: `http://127.0.0.1:${server.address().port}/endless.tar.gz` }, r.key.privateKey);
    const out = await updateBinary({ ...s.deps, manifest, ...r.trust, maxArchiveBytes: 256 * 1024 });
    expect(out.action).toBe("failed");
    expect(out.error.code).toBe("download_failed");
    expect(out.error.message).toMatch(/larger than expected/);
    await new Promise((ok) => setTimeout(ok, 200));
    expect(closed).toBe(true);
    expect(sent).toBeLessThan(8 * 1024 * 1024);
    expect(fs.existsSync(s.bin)).toBe(false);
  });
  it("non-https, non-loopback URL", async () => {
    const r = await rel();
    const { out } = await expectFailure(r, (m) => signManifest({ version: m.version, key_id: m.key_id, url: "http://example.com/x.tgz", sha256: m.sha256 }, r.key.privateKey));
    expect(out.error.code).toBe("bad_url");
    expect(r.hits).toEqual([]);
  });
  it("archive with an unexpected entry (path traversal)", async () => {
    const key = newKey();
    const r = await rel({ key, files: { "muse-ax": fakeBinaryScript("9.9.9"), "extra/evil": "x" } });
    const { out } = await expectFailure(r, (m) => m);
    expect(out.error.code).toBe("bad_archive");
  });
  it("archive without the binary", async () => {
    const r = await rel({ files: { "other": "x" } });
    expect((await expectFailure(r, (m) => m)).out.error.code).toBe("bad_archive");
  });
  it("downloaded binary reports a different version than the manifest", async () => {
    const r = await rel({ files: { "muse-ax": fakeBinaryScript("1.2.3") } });
    expect((await expectFailure(r, (m) => m)).out.error.code).toBe("version_mismatch");
  });
  it("downloaded binary that does not run", async () => {
    const r = await rel({ files: { "muse-ax": "not executable code" } });
    expect((await expectFailure(r, (m) => m)).out.error.code).toBe("version_mismatch");
  });
  it("signed but invalid code signature", async () => {
    const r = await rel(); const s = setup();
    const run = async (f, a, o) => f === "codesign" ? { code: 1, stdout: "", stderr: "invalid signature (code or signature have been modified)" } : realRun(f, a, o);
    writeBinary(s.bin, "0.0.1");
    const out = await updateBinary({ ...s.deps, run, manifest: r.manifest, ...r.trust });
    expect(out.error.code).toBe("codesign_failed");
    expect(await version(s.bin)).toBe("0.0.1");
  });
  it("an unsigned binary is accepted (sha256 + manifest signature already prove it)", async () => {
    const r = await rel(); const s = setup();
    const run = async (f, a, o) => f === "codesign" ? { code: 1, stdout: "", stderr: "code object is not signed at all" } : realRun(f, a, o);
    expect((await updateBinary({ ...s.deps, run, manifest: r.manifest, ...r.trust })).action).toBe("installed");
  });
});

describe("updateBinary: fallback and bookkeeping", () => {
  it("placeholder manifest falls back to the local build when the Command Line Tools exist", async () => {
    const s = setup();
    s.deps.buildFallback = async () => { s.calls.build += 1; writeBinary(s.bin, "9.9.9"); return { ok: true }; };
    const manifest = { version: "9.9.9", url: "u", sha256: "<placeholder until first release>", signature: "<base64>" };
    const out = await updateBinary({ ...s.deps, manifest, pubPem: newKey().pubPem });
    expect(out).toMatchObject({ action: "built", version: "9.9.9" });
    expect(s.calls.build).toBe(1);
  });
  it("without the Command Line Tools the failure is an actionable error and nothing is built", async () => {
    const r = await rel(); const s = setup({ canBuild: async () => false });
    const out = await updateBinary({ ...s.deps, manifest: badHash(r, "2"), ...r.trust });
    expect(out.action).toBe("failed");
    expect(s.calls.build).toBe(0);
    expect(out.error.message).toMatch(/xcode-select --install/);
    expect(out.error.message).toContain("/plug/scripts/install.sh");
    expect(out.error.message).not.toContain("\n");
  });
  it("a failing build is reported with both reasons", async () => {
    const r = await rel(); const s = setup();
    const out = await updateBinary({ ...s.deps, manifest: badHash(r, "2"), ...r.trust });
    expect(out.action).toBe("failed");
    expect(s.calls.build).toBe(1);
    expect(out.error.message).toContain("sha256");
    expect(out.error.message).toContain("build not wired");
  });
  it("skips entirely when CBB_MUSE_AX is set", async () => {
    const r = await rel(); const s = setup({ env: { CBB_MUSE_AX: "/opt/muse-ax" } });
    expect((await updateBinary({ ...s.deps, manifest: r.manifest, ...r.trust })).action).toBe("skipped");
    expect(r.hits).toEqual([]);
  });
  it("does not retry a failed version for 24 h while a working binary exists", async () => {
    const r = await rel(); const s = setup();
    writeBinary(s.bin, "0.0.1");
    const bad = badHash(r, "3");
    expect((await updateBinary({ ...s.deps, manifest: bad, ...r.trust })).action).toBe("failed");
    const again = await updateBinary({ ...s.deps, manifest: bad, ...r.trust });
    expect(again).toMatchObject({ action: "skipped", reason: "recent_failure" });
    expect(s.calls.build).toBe(1);
    const later = await updateBinary({ ...s.deps, now: () => Date.UTC(2026, 10, 22), manifest: bad, ...r.trust });
    expect(later.action).toBe("failed");
  });
  it("always retries when there is no binary at all", async () => {
    const r = await rel(); const s = setup();
    const bad = badHash(r, "3");
    await updateBinary({ ...s.deps, manifest: bad, ...r.trust });
    expect((await updateBinary({ ...s.deps, manifest: bad, ...r.trust })).action).toBe("failed");
  });
  it("reports phases so callers can answer 'updating'", async () => {
    const r = await rel(); const s = setup(); const phases = [];
    await updateBinary({ ...s.deps, manifest: r.manifest, ...r.trust, onPhase: (p) => phases.push(p) });
    expect(phases).toEqual(["downloading"]);
    const bad = badHash(r, "4"); phases.length = 0; writeBinary(s.bin, "0.0.1");
    await updateBinary({ ...s.deps, manifest: bad, ...r.trust, force: true, onPhase: (p) => phases.push(p) });
    expect(phases).toEqual(["downloading", "building"]);
  });
});

describe("update lock (pid + nonce)", () => {
  const lockOf = (s) => path.join(path.dirname(s.bin), ".update.lock");
  const age = (f, ms) => { const t = new Date(Date.UTC(2026, 10, 20) - ms); fs.utimesSync(f, t, t); };
  const HOUR = 3600e3;

  it("records the owner pid and a nonce, and releases only its own lock", () => {
    const dir = tmp("lock");
    const a = acquireLock(dir, { nowMs: Date.now() });
    const body = fs.readFileSync(path.join(dir, ".update.lock"), "utf8").split("\n");
    expect(body[0]).toBe(String(process.pid));
    expect(body[1]).toMatch(/^[0-9a-f-]{16,}$/);
    fs.writeFileSync(path.join(dir, ".update.lock"), "4242\nsomeone-elses-nonce\n");
    a.release();
    expect(fs.existsSync(path.join(dir, ".update.lock"))).toBe(true);
    const b = acquireLock(tmp("lock2"), { nowMs: Date.now() });
    b.release();
  });
  it("yields when a live process holds it, however old the lock is", async () => {
    const r = await rel(); const s = setup();
    fs.mkdirSync(path.dirname(s.bin), { recursive: true });
    fs.writeFileSync(lockOf(s), `${process.pid}\nn1\n`); age(lockOf(s), 24 * HOUR);
    expect((await updateBinary({ ...s.deps, manifest: r.manifest, ...r.trust })).action).toBe("busy");
    expect(r.hits).toEqual([]);
    expect(fs.existsSync(lockOf(s))).toBe(true);
  });
  it("yields when the owner is dead but the lock is still young", async () => {
    const r = await rel(); const s = setup({ isPidAlive: () => false });
    fs.mkdirSync(path.dirname(s.bin), { recursive: true });
    fs.writeFileSync(lockOf(s), "999999\nn1\n"); age(lockOf(s), 60e3);
    expect((await updateBinary({ ...s.deps, manifest: r.manifest, ...r.trust })).action).toBe("busy");
  });
  it("takes over when the owner is dead and the lock is old", async () => {
    const r = await rel(); const s = setup({ isPidAlive: () => false });
    fs.mkdirSync(path.dirname(s.bin), { recursive: true });
    fs.writeFileSync(lockOf(s), "999999\nn1\n"); age(lockOf(s), 24 * HOUR);
    expect((await updateBinary({ ...s.deps, manifest: r.manifest, ...r.trust })).action).toBe("installed");
    expect(fs.existsSync(lockOf(s))).toBe(false);
  });
  it("takes over a legacy directory lock (no owner recorded) once it is old", async () => {
    const r = await rel(); const s = setup();
    fs.mkdirSync(lockOf(s), { recursive: true }); age(lockOf(s), 24 * HOUR);
    expect((await updateBinary({ ...s.deps, manifest: r.manifest, ...r.trust })).action).toBe("installed");
  });
  it("a young legacy directory lock still blocks", async () => {
    const r = await rel(); const s = setup();
    fs.mkdirSync(lockOf(s), { recursive: true });
    expect((await updateBinary({ ...s.deps, manifest: r.manifest, ...r.trust })).action).toBe("busy");
  });
  it("is removed after a failed update too", async () => {
    const r = await rel(); const s = setup();
    await updateBinary({ ...s.deps, manifest: badHash(r, "6"), ...r.trust });
    expect(fs.existsSync(lockOf(s))).toBe(false);
  });
});

describe("updateBinary: no automatic build without consent", () => {
  it("allowBuild=false: no build even when the Command Line Tools exist; the error carries the one-line fix", async () => {
    const r = await rel(); const s = setup({ allowBuild: false });
    const out = await updateBinary({ ...s.deps, manifest: badHash(r, "7"), ...r.trust });
    expect(out.action).toBe("failed");
    expect(s.calls.build).toBe(0);
    expect(out.error.message).toContain("/bot-bridge:setup");
    expect(out.error.message).toContain("/plug/scripts/install.sh");
    expect(out.error.message).not.toContain("\n");
  });
  it("a placeholder manifest with allowBuild=false does not build either", async () => {
    const s = setup({ allowBuild: false });
    const manifest = { version: "9.9.9", url: "u", sha256: "<placeholder until first release>", signature: "<base64>" };
    expect((await updateBinary({ ...s.deps, manifest, pubPem: newKey().pubPem })).action).toBe("failed");
    expect(s.calls.build).toBe(0);
  });
  it("allowBuild defaults to false", async () => {
    const r = await rel(); const s = setup(); delete s.deps.allowBuild;
    await updateBinary({ ...s.deps, manifest: badHash(r, "8"), ...r.trust });
    expect(s.calls.build).toBe(0);
  });
});

describe("updateBinary: lazily resolved manifest", () => {
  it("is not resolved at all when the installed binary already is the target version", async () => {
    const s = setup(); writeBinary(s.bin, "9.9.9");
    let asked = 0;
    const out = await updateBinary({ ...s.deps, targetVersion: "9.9.9", resolveManifest: async () => { asked += 1; return { manifest: null, reason: "x" }; } });
    expect(out.action).toBe("current");
    expect(asked).toBe(0);
  });
  it("installs from the resolved manifest", async () => {
    const r = await rel(); const s = setup();
    const out = await updateBinary({ ...s.deps, targetVersion: "9.9.9", ...r.trust, resolveManifest: async () => ({ manifest: r.manifest, source: "release" }) });
    expect(out).toMatchObject({ action: "installed", version: "9.9.9" });
  });
  it("an unresolvable manifest is a failure with the reason and no build when building is not allowed", async () => {
    const s = setup({ allowBuild: false });
    const out = await updateBinary({ ...s.deps, targetVersion: "9.9.9", resolveManifest: async () => ({ manifest: null, reason: "no signed release manifest" }) });
    expect(out.action).toBe("failed");
    expect(out.error.message).toContain("no signed release manifest");
    expect(out.error.message).toContain("9.9.9");
    expect(s.calls.build).toBe(0);
  });
});

describe("updateBinary: the 24 h backoff needs a WORKING binary", () => {
  it("a present but broken binary does not suppress the retry", async () => {
    const r = await rel(); const s = setup();
    fs.mkdirSync(path.dirname(s.bin), { recursive: true });
    fs.writeFileSync(s.bin, "#!/bin/sh\nexit 2\n", { mode: 0o755 });
    await updateBinary({ ...s.deps, manifest: badHash(r, "9"), ...r.trust });
    const again = await updateBinary({ ...s.deps, manifest: r.manifest, ...r.trust });
    expect(again.action).toBe("installed");
  });
  it("a broken binary and the same failing manifest: the retry really runs (no recent_failure skip)", async () => {
    const r = await rel(); const s = setup();
    fs.mkdirSync(path.dirname(s.bin), { recursive: true });
    fs.writeFileSync(s.bin, "#!/bin/sh\nexit 2\n", { mode: 0o755 });
    const bad = badHash(r, "a");
    await updateBinary({ ...s.deps, manifest: bad, ...r.trust });
    expect((await updateBinary({ ...s.deps, manifest: bad, ...r.trust })).action).toBe("failed");
    expect(s.calls.build).toBe(2);
  });
});

describe("updateBinary: code signature and archive hardening", () => {
  it("codesign that cannot run is a failure, not a pass", async () => {
    const r = await rel(); const s = setup();
    const run = async (f, a, o) => f === "codesign" ? { code: -1, stdout: "", stderr: "spawn codesign ENOENT" } : realRun(f, a, o);
    writeBinary(s.bin, "0.0.1");
    const out = await updateBinary({ ...s.deps, run, manifest: r.manifest, ...r.trust });
    expect(out.action).toBe("failed");
    expect(out.error.code).toBe("codesign_failed");
    expect(await version(s.bin)).toBe("0.0.1");
  });
  it("an AppleDouble ._ entry next to the binary is refused, not ignored", async () => {
    const r = await rel({ files: { "muse-ax": fakeBinaryScript("9.9.9"), "._muse-ax": "appledouble" } }); const s = setup();
    writeBinary(s.bin, "0.0.1");
    const out = await updateBinary({ ...s.deps, manifest: r.manifest, ...r.trust });
    expect(out.error.code).toBe("bad_archive");
    expect(await version(s.bin)).toBe("0.0.1");
  });
  it("an archive holding only an AppleDouble entry is refused", async () => {
    const r = await rel({ files: { "._muse-ax": "x" } }); const s = setup();
    expect((await updateBinary({ ...s.deps, manifest: r.manifest, ...r.trust })).error.code).toBe("bad_archive");
  });
  it("a listing that fails is refused", async () => {
    const r = await rel(); const s = setup();
    const run = async (f, a, o) => f === "tar" && a[0] === "-tzf" ? { code: 1, stdout: "muse-ax\n", stderr: "boom" } : realRun(f, a, o);
    expect((await updateBinary({ ...s.deps, run, manifest: r.manifest, ...r.trust })).error.code).toBe("bad_archive");
  });
});

describe("UpdateError", () => {
  it("carries a code", () => expect(new UpdateError("x", "y").code).toBe("x"));
});
