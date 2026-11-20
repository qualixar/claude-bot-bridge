// The maintainer's signing scripts, run with throwaway keys and a throwaway keys/ folder. Skipped when OpenSSL 3 or jq is missing.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { verifyDetached, verifyManifest } from "../src/crypto.js";
import { verifyKeyset, verifyWithTrust, verifyManifestWithTrust } from "../src/keyset.js";
import { tmp } from "./helpers.js";

const SCRIPTS = new URL("../../../../scripts/", import.meta.url).pathname;
const REAL_RULES = new URL("../../../../../rules/muse.json", import.meta.url).pathname;
const openssl = ["/opt/homebrew/opt/openssl@3/bin/openssl", "/opt/homebrew/bin/openssl", "/usr/local/opt/openssl@3/bin/openssl", "openssl"]
  .find((c) => { try { return execFileSync(c, ["pkeyutl", "-help"], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).includes("rawin") || true; } catch (e) { return String(e.stderr ?? "").includes("rawin"); } });
const haveJq = spawnSync("jq", ["--version"]).status === 0;
const can = Boolean(openssl) && haveJq && fs.existsSync(REAL_RULES);

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const DAY = 86400000;

function keypair(d) {
  const priv = path.join(d, `${Math.random().toString(36).slice(2)}-key.pem`), pub = priv.replace("-key.pem", "-pub.pem");
  execFileSync(openssl, ["genpkey", "-algorithm", "ed25519", "-out", priv]);
  execFileSync(openssl, ["pkey", "-in", priv, "-pubout", "-out", pub]);
  const raw = execFileSync(openssl, ["pkey", "-in", priv, "-pubout", "-outform", "DER"]).subarray(-32).toString("base64");
  return { priv, pub, pubPem: fs.readFileSync(pub, "utf8"), raw };
}

/** A repository-shaped sandbox: keys/ (three public keys + an unsigned keyset.json + UNSIGNED), rules/ (index + muse.json). */
function sandbox({ keyset = {}, rules = {} } = {}) {
  const d = tmp("sign");
  const root = keypair(d), rk = keypair(d), bk = keypair(d), other = keypair(d);
  const keys = path.join(d, "keys"), rulesDir = path.join(d, "rules");
  fs.mkdirSync(keys); fs.mkdirSync(rulesDir);
  fs.writeFileSync(path.join(keys, "root-public.pem"), root.pubPem);
  fs.writeFileSync(path.join(keys, "rules-public.pem"), rk.pubPem);
  fs.writeFileSync(path.join(keys, "binary-public.pem"), bk.pubPem);
  const now = Date.now();
  const ks = { schema: 1, issued_at: iso(now - DAY), not_after: iso(now + 300 * DAY),
    keys: [{ id: "rules-1", use: "rules", public_key_b64: rk.raw, not_after: iso(now + 600 * DAY) }, { id: "binary-1", use: "binary", public_key_b64: bk.raw, not_after: iso(now + 600 * DAY) }],
    revoked: [], ...keyset };
  fs.writeFileSync(path.join(keys, "keyset.json"), JSON.stringify(ks, null, 2) + "\n");
  fs.writeFileSync(path.join(keys, "UNSIGNED"), "x");
  const real = JSON.parse(fs.readFileSync(REAL_RULES, "utf8"));
  fs.writeFileSync(path.join(rulesDir, "muse.json"), JSON.stringify({ ...real, key_id: "rules-1", ...rules }, null, 2) + "\n");
  fs.writeFileSync(path.join(rulesDir, "index.json"), JSON.stringify({ schema: 1, revision: 1, key_id: "rules-1", bots: [{ id: "muse", rules: "muse.json" }] }, null, 2) + "\n");
  fs.writeFileSync(path.join(rulesDir, "UNSIGNED"), "x");
  return { d, root, rk, bk, other, keys, rulesDir, keyset: path.join(keys, "keyset.json") };
}
const sh = (script, args, env = {}) => spawnSync("sh", [path.join(SCRIPTS, script), ...args], { encoding: "utf8", env: { PATH: process.env.PATH, OPENSSL: openssl, ...env } });
const env = (s) => ({ CBB_KEYS_DIR: s.keys, CBB_RULES_DIR: s.rulesDir });
const signKeyset = (s) => sh("sign-keyset.sh", [s.root.priv], env(s));
const read = (f) => fs.readFileSync(f, "utf8");
const keysetState = (s) => verifyKeyset({ json: read(s.keyset), signature: read(`${s.keyset}.sig`), pubPem: s.root.pubPem });
const noSecrets = (r) => expect(r.stdout + r.stderr).not.toContain("PRIVATE KEY");

describe.skipIf(!can)("sign-keyset.sh (root key, offline)", () => {
  it("writes a root signature over the exact bytes that the Node verifier accepts, and removes keys/UNSIGNED", () => {
    const s = sandbox();
    const r = signKeyset(s);
    expect(r.status, r.stderr).toBe(0);
    expect(read(`${s.keyset}.sig`).trim()).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    expect(keysetState(s).state).toBe("valid");
    expect(verifyDetached(s.root.pubPem, read(s.keyset) + " ", read(`${s.keyset}.sig`))).toBe(false);
    expect(fs.existsSync(path.join(s.keys, "UNSIGNED"))).toBe(false);
    noSecrets(r);
  });
  it("refuses any key that is not the published root key (the rules key, the binary key, a stranger)", () => {
    const s = sandbox();
    for (const k of [s.rk, s.bk, s.other]) {
      const r = sh("sign-keyset.sh", [k.priv], env(s));
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/does not match/);
    }
    expect(fs.existsSync(`${s.keyset}.sig`)).toBe(false);
  });
  it("refuses a keyset that lists the root key, is already expired, or is dated in the future", () => {
    const rootListed = sandbox(); const ks = JSON.parse(read(rootListed.keyset));
    ks.keys.push({ id: "oops", use: "rules", public_key_b64: rootListed.root.raw, not_after: iso(Date.now() + DAY) });
    fs.writeFileSync(rootListed.keyset, JSON.stringify(ks));
    expect(signKeyset(rootListed).stderr).toMatch(/ROOT key must never be listed/);
    expect(signKeyset(sandbox({ keyset: { not_after: iso(Date.now() - DAY) } })).stderr).toMatch(/past its not_after/);
    expect(signKeyset(sandbox({ keyset: { issued_at: iso(Date.now() + 5 * DAY) } })).stderr).toMatch(/future/);
  });
  it("refuses an invalid keyset and a missing key argument", () => {
    const s = sandbox();
    fs.writeFileSync(s.keyset, JSON.stringify({ schema: 2 }));
    expect(signKeyset(s).status).not.toBe(0);
    expect(sh("sign-keyset.sh", [], env(s)).status).not.toBe(0);
  });
});

describe.skipIf(!can)("sign-keyset.sh refuses to go backwards (previous keyset = the floor)", () => {
  /** A signed first keyset, kept as the "previous" one, then the working keyset replaced by `next`. */
  function withPrevious(next, tamper) {
    const s = sandbox(); expect(signKeyset(s).status).toBe(0);
    const prev = path.join(s.d, "prev-keyset.json");
    fs.copyFileSync(s.keyset, prev); fs.copyFileSync(`${s.keyset}.sig`, `${prev}.sig`);
    fs.writeFileSync(path.join(s.keys, "UNSIGNED"), "x");
    const ks = { ...JSON.parse(read(prev)), ...next(JSON.parse(read(prev))) };
    fs.writeFileSync(s.keyset, JSON.stringify(ks, null, 2) + "\n");
    fs.rmSync(`${s.keyset}.sig`);
    tamper?.(s, prev);
    return { s, prev, sign: () => sh("sign-keyset.sh", [s.root.priv], { ...env(s), CBB_PREVIOUS_KEYSET: prev }) };
  }
  const later = (p, days) => iso(Date.parse(p) + days * DAY);

  it("signs a keyset that is newer and lasts at least as long", () => {
    const { s, sign } = withPrevious((p) => ({ issued_at: iso(Date.now() - 1000), not_after: later(p.not_after, 30), revoked: ["rules-1"] }));
    const r = sign();
    expect(r.status, r.stderr).toBe(0);
    expect(keysetState(s).state).toBe("valid");
  });
  it("refuses a not_after earlier than the previous keyset's", () => {
    const { s, sign } = withPrevious((p) => ({ issued_at: iso(Date.now() - 1000), not_after: later(p.not_after, -10) }));
    const r = sign();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not_after .* is earlier than the previous keyset's/);
    expect(fs.existsSync(`${s.keyset}.sig`)).toBe(false);
  });
  it("refuses an issued_at that is not after the previous keyset's (installs would ignore it)", () => {
    const { s, sign } = withPrevious((p) => ({ issued_at: p.issued_at, revoked: ["x"], not_after: later(p.not_after, 5) }));
    const r = sign();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/issued_at .* is not after/);
    expect(fs.existsSync(`${s.keyset}.sig`)).toBe(false);
  });
  it("re-signing the unchanged keyset is allowed", () => {
    const { sign } = withPrevious(() => ({}));
    const r = sign();
    expect(r.status, r.stderr).toBe(0);
  });
  it("refuses a previous keyset that the root did not sign, or whose signature is missing, instead of ignoring it", () => {
    const forged = withPrevious((p) => ({ issued_at: iso(Date.now() - 1000), not_after: later(p.not_after, 5) }), (_s, prev) => {
      const other = keypair(path.dirname(prev));
      execFileSync(openssl, ["pkeyutl", "-sign", "-rawin", "-inkey", other.priv, "-in", prev, "-out", `${prev}.bin`]);
      fs.writeFileSync(`${prev}.sig`, fs.readFileSync(`${prev}.bin`).toString("base64") + "\n");
    });
    expect(forged.sign().stderr).toMatch(/not signed by the root key/);
    const unsigned = withPrevious((p) => ({ issued_at: iso(Date.now() - 1000), not_after: later(p.not_after, 5) }), (_s, prev) => fs.rmSync(`${prev}.sig`));
    expect(unsigned.sign().stderr).toMatch(/previous keyset or its signature is missing/);
  });
  it("without a previous keyset (the first one) there is nothing to compare with", () => {
    const s = sandbox();
    expect(signKeyset(s).status).toBe(0);
  });
  it("uses the committed keyset as the previous one when the file is in a git repository", () => {
    const s = sandbox(); expect(signKeyset(s).status).toBe(0);
    const git = (...a) => execFileSync("git", ["-C", s.d, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q"); git("add", "keys/keyset.json", "keys/keyset.json.sig"); git("commit", "-q", "-m", "first");
    const ks = JSON.parse(read(s.keyset)); ks.issued_at = iso(Date.now() - 500); ks.not_after = iso(Date.parse(ks.not_after) - 20 * DAY);
    fs.writeFileSync(s.keyset, JSON.stringify(ks, null, 2) + "\n");
    const r = signKeyset(s);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/earlier than the previous/);
    ks.not_after = iso(Date.parse(ks.not_after) + 40 * DAY);
    fs.writeFileSync(s.keyset, JSON.stringify(ks, null, 2) + "\n");
    expect(signKeyset(s).status).toBe(0);
  });
});

describe.skipIf(!can)("verify-keyset.sh", () => {
  it("accepts the signed keyset, rejects a tampered one and an expired one, and warns when it expires soon", () => {
    const s = sandbox(); expect(signKeyset(s).status).toBe(0);
    const ok = sh("verify-keyset.sh", [], env(s));
    expect(ok.status, ok.stderr).toBe(0);
    fs.writeFileSync(s.keyset, read(s.keyset).replace('"revoked": []', '"revoked": ["x"]'));
    expect(sh("verify-keyset.sh", [], env(s)).status).not.toBe(0);
    const soon = sandbox({ keyset: { not_after: iso(Date.now() + 10 * DAY) } }); expect(signKeyset(soon).status).toBe(0);
    expect(sh("verify-keyset.sh", [], env(soon)).stdout).toMatch(/::warning::.*expires/);
    const expired = sandbox(); expect(signKeyset(expired).status).toBe(0);
    const ks = JSON.parse(read(expired.keyset)); ks.not_after = iso(Date.now() - DAY);
    fs.writeFileSync(expired.keyset, JSON.stringify(ks, null, 2) + "\n");
    expect(sh("verify-keyset.sh", [], env(expired)).status).not.toBe(0);
  });
});

describe.skipIf(!can)("sign-rules.sh (rules key)", () => {
  it("signs the index and every listed rules file; the Node trust check accepts them with the keyset", () => {
    const s = sandbox(); signKeyset(s);
    const r = sh("sign-rules.sh", [s.rk.priv], env(s));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/muse\.json\.sig \(key rules-1/);
    const keyset = keysetState(s);
    for (const f of ["muse.json", "index.json"]) {
      const file = path.join(s.rulesDir, f);
      const check = (data) => verifyWithTrust({ data, signature: read(`${file}.sig`), keyId: JSON.parse(read(file)).key_id, use: "rules", pubPem: s.root.pubPem, keyset });
      expect(check(fs.readFileSync(file)), f).toMatchObject({ ok: true, keyId: "rules-1" });
      expect(check(Buffer.concat([fs.readFileSync(file), Buffer.from(" ")])).ok).toBe(false);
    }
    expect(fs.existsSync(path.join(s.rulesDir, "UNSIGNED"))).toBe(false);
    noSecrets(r);
  });
  it("refuses the root key, the binary key and a stranger", () => {
    const s = sandbox(); signKeyset(s);
    for (const k of [s.root, s.bk, s.other]) {
      const r = sh("sign-rules.sh", [k.priv], env(s));
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/does not match/);
    }
    expect(fs.existsSync(path.join(s.rulesDir, "muse.json.sig"))).toBe(false);
  });
  it("refuses to sign before the keyset is signed (it would have to trust a hand-written keyset)", () => {
    const s = sandbox();
    const r = sh("sign-rules.sh", [s.rk.priv], env(s));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/keyset is not signed yet/);
  });
  it("refuses a keyset that was edited after the root signed it", () => {
    const s = sandbox(); signKeyset(s);
    fs.writeFileSync(s.keyset, read(s.keyset).replace('"revoked": []', '"revoked": []\n'));
    expect(sh("sign-rules.sh", [s.rk.priv], env(s)).stderr).toMatch(/does not verify/);
  });
  it("refuses a file whose key_id is not the id of this key", () => {
    const s = sandbox({ rules: { key_id: "rules-9" } }); signKeyset(s);
    const r = sh("sign-rules.sh", [s.rk.priv], env(s));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/"key_id" must be "rules-1"/);
    expect(fs.existsSync(path.join(s.rulesDir, "index.json.sig"))).toBe(false);
  });
  it("refuses a revoked or expired key", () => {
    const revoked = sandbox({ keyset: { revoked: ["rules-1"] } }); signKeyset(revoked);
    expect(sh("sign-rules.sh", [revoked.rk.priv], env(revoked)).stderr).toMatch(/revoked/);
    const old = sandbox(); const ks = JSON.parse(read(old.keyset)); ks.keys[0].not_after = iso(Date.now() - DAY);
    fs.writeFileSync(old.keyset, JSON.stringify(ks)); signKeyset(old);
    expect(sh("sign-rules.sh", [old.rk.priv], env(old)).stderr).toMatch(/past its not_after/);
  });
  it("refuses an invalid rules document, a bot that differs from the file name, and rules that already expired", () => {
    const bad = sandbox({ rules: { schema: 2 } }); signKeyset(bad);
    expect(sh("sign-rules.sh", [bad.rk.priv], env(bad)).stderr).toMatch(/not a valid rules document/);
    const wrongBot = sandbox({ rules: { bot: "other" } }); signKeyset(wrongBot);
    expect(sh("sign-rules.sh", [wrongBot.rk.priv], env(wrongBot)).stderr).toMatch(/must equal the file name/);
    const expired = sandbox({ rules: { not_after: iso(Date.now() - DAY) } }); signKeyset(expired);
    expect(sh("sign-rules.sh", [expired.rk.priv], env(expired)).stderr).toMatch(/past its not_after/);
  });
  it("signs one explicit file, and fails on a missing key argument", () => {
    const s = sandbox(); signKeyset(s);
    const only = path.join(s.rulesDir, "muse.json");
    expect(sh("sign-rules.sh", [s.rk.priv, only], env(s)).status).toBe(0);
    expect(fs.existsSync(`${only}.sig`) && !fs.existsSync(path.join(s.rulesDir, "index.json.sig"))).toBe(true);
    expect(sh("sign-rules.sh", [], env(s)).status).not.toBe(0);
  });
});

describe.skipIf(!can)("verify-rules.sh", () => {
  const prepared = () => { const s = sandbox(); signKeyset(s); sh("sign-rules.sh", [s.rk.priv], env(s)); return s; };
  it("verifies a document the way a client does: key_id, keyset, root", () => {
    const s = prepared();
    const r = sh("verify-rules.sh", [path.join(s.rulesDir, "muse.json")], env(s));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/by key rules-1/);
    expect(sh("verify-rules.sh", [path.join(s.rulesDir, "index.json")], env(s)).status).toBe(0);
  });
  it("fails on a changed file, a revoked key, an unknown key id and a bad explicit key", () => {
    const s = prepared(); const file = path.join(s.rulesDir, "muse.json");
    expect(sh("verify-rules.sh", [file, s.other.pub], env(s)).status).not.toBe(0);
    expect(sh("verify-rules.sh", [file, s.rk.pub], env(s)).status).toBe(0);
    const orig = read(file);
    fs.writeFileSync(file, orig.replace(/"revision": (\d+)/, (_m, n) => `"revision": ${Number(n) + 1}`));
    expect(sh("verify-rules.sh", [file], env(s)).status).not.toBe(0);
    fs.writeFileSync(file, orig.replace('"key_id": "rules-1"', '"key_id": "rules-7"'));
    expect(sh("verify-rules.sh", [file], env(s)).stderr).toMatch(/not a current rules key/);
    const rev = sandbox({ keyset: { revoked: ["rules-1"] } }); signKeyset(rev);
    fs.copyFileSync(file, path.join(rev.rulesDir, "muse.json")); fs.writeFileSync(path.join(rev.rulesDir, "muse.json"), orig);
    fs.copyFileSync(`${file}.sig`, path.join(rev.rulesDir, "muse.json.sig"));
    expect(sh("verify-rules.sh", [path.join(rev.rulesDir, "muse.json")], env(rev)).stderr).toMatch(/revoked/);
  });
  it("a document without key_id is refused, even when the root signed it (there is no compatibility path)", () => {
    const s = sandbox(); signKeyset(s);
    const file = path.join(s.rulesDir, "legacy.json"), real = JSON.parse(read(REAL_RULES));
    delete real.key_id; fs.writeFileSync(file, JSON.stringify(real));
    execFileSync(openssl, ["pkeyutl", "-sign", "-rawin", "-inkey", s.root.priv, "-in", file, "-out", `${file}.bin`]);
    fs.writeFileSync(`${file}.sig`, fs.readFileSync(`${file}.bin`).toString("base64") + "\n");
    const r = sh("verify-rules.sh", [file], env(s));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no key_id/);
  });
});

describe.skipIf(!can)("sign-manifest.sh (binary key; what the release workflow runs)", () => {
  const sample = { version: "1.2.3", url: "https://github.com/qualixar/claude-bot-bridge/releases/download/v1.2.3/muse-ax-macos-universal.tar.gz", sha256: "ab".repeat(32), signature: "" };
  const trust = (s) => ({ pubPem: s.root.pubPem, keyset: keysetState(s) });
  const manifest = (s, m = sample) => { const f = path.join(s.d, `m-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify(m, null, 2)); return f; };
  it("writes key_id and a signature the Node verifier accepts, regardless of key order in the file", () => {
    const s = sandbox(); signKeyset(s);
    const file = manifest(s, { signature: "<old>", url: sample.url, sha256: sample.sha256, version: sample.version });
    const r = sh("sign-manifest.sh", [s.bk.priv, file], env(s));
    expect(r.status, r.stderr).toBe(0);
    const m = JSON.parse(read(file));
    expect(m).toMatchObject({ version: "1.2.3", key_id: "binary-1" });
    expect(verifyManifestWithTrust(m, trust(s))).toMatchObject({ ok: true, keyId: "binary-1" });
    expect(verifyManifestWithTrust({ ...m, sha256: "cd".repeat(32) }, trust(s)).ok).toBe(false);
    expect(verifyManifestWithTrust({ ...m, key_id: "rules-1" }, trust(s)).ok).toBe(false);
    noSecrets(r);
  });
  it("--key-env takes the key from an environment variable, leaves no key file behind and never prints it", () => {
    const s = sandbox(); signKeyset(s);
    const file = manifest(s), scratch = tmp("scratch");
    const r = sh("sign-manifest.sh", ["--key-env", "CBB_BINARY_SIGNING_KEY", file], { ...env(s), CBB_BINARY_SIGNING_KEY: read(s.bk.priv), TMPDIR: scratch });
    expect(r.status, r.stderr).toBe(0);
    expect(verifyManifestWithTrust(JSON.parse(read(file)), trust(s)).ok).toBe(true);
    expect(fs.readdirSync(scratch)).toEqual([]);
    noSecrets(r);
  });
  it("--key-env fails when the variable is unset or empty, or holds a wrong key", () => {
    const s = sandbox(); signKeyset(s);
    const file = manifest(s);
    expect(sh("sign-manifest.sh", ["--key-env", "CBB_BINARY_SIGNING_KEY", file], env(s)).status).not.toBe(0);
    expect(sh("sign-manifest.sh", ["--key-env", "CBB_BINARY_SIGNING_KEY", file], { ...env(s), CBB_BINARY_SIGNING_KEY: "" }).status).not.toBe(0);
    const bad = sh("sign-manifest.sh", ["--key-env", "CBB_BINARY_SIGNING_KEY", file], { ...env(s), CBB_BINARY_SIGNING_KEY: read(s.other.priv) });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).not.toContain("PRIVATE KEY");
    expect(JSON.parse(read(file)).signature).toBe("");
  });
  it("refuses the root key and the RULES key: only a binary key signs manifests", () => {
    const s = sandbox(); signKeyset(s);
    for (const k of [s.root, s.rk, s.other]) {
      const file = manifest(s);
      expect(sh("sign-manifest.sh", [k.priv, file], env(s)).status).not.toBe(0);
      expect(JSON.parse(read(file)).signature).toBe("");
    }
  });
  it("refuses to sign before the keyset is signed, and with a revoked binary key", () => {
    const s = sandbox();
    expect(sh("sign-manifest.sh", [s.bk.priv, manifest(s)], env(s)).stderr).toMatch(/keyset is not signed yet/);
    const rev = sandbox({ keyset: { revoked: ["binary-1"] } }); signKeyset(rev);
    expect(sh("sign-manifest.sh", [rev.bk.priv, manifest(rev)], env(rev)).stderr).toMatch(/revoked/);
  });
  it("rejects a variable name that is not a plain identifier (it is expanded in the shell)", () => {
    const s = sandbox(); signKeyset(s);
    const r = sh("sign-manifest.sh", ["--key-env", "X;touch /tmp/cbb-pwned", manifest(s)], env(s));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not a valid environment variable name/);
  });
  it("the signature covers the key_id: the plain single-key verifier, given the signer's own key, accepts exactly what was written", () => {
    const s = sandbox(); signKeyset(s);
    const file = manifest(s); sh("sign-manifest.sh", [s.bk.priv, file], env(s));
    expect(verifyManifest(JSON.parse(read(file)), s.bk.pubPem)).toBe(true);   // plain signature check with the signer's own key
  });
});

describe.skipIf(!can)("sync-builtin-rules.sh (what compiles the signed keyset into the binary and the bundle)", () => {
  const sync = (s, out) => sh("sync-builtin-rules.sh", [REAL_RULES], { CBB_KEYS_DIR: s.keys, CBB_SWIFT_OUT_DIR: out, CBB_JS_OUT: path.join(out, "keyset-data.js") });
  const outDir = () => { const o = tmp("sync-out"); return o; };

  it("embeds the exact bytes of a signed keyset and its signature, in both the Swift and the JS sources", async () => {
    const s = sandbox(); signKeyset(s);
    const out = outDir();
    const r = sync(s, out);
    expect(r.status, r.stderr).toBe(0);
    const swift = read(path.join(out, "BuiltinKeysetData.swift"));
    const b64 = /jsonBase64 = "([^"]*)"/.exec(swift)[1], sig = /signature = "([^"]*)"/.exec(swift)[1];
    expect(Buffer.from(b64, "base64").equals(fs.readFileSync(s.keyset))).toBe(true);
    expect(sig).toBe(read(`${s.keyset}.sig`).trim());
    const mod = await import(`${path.join(out, "keyset-data.js")}?${Date.now()}`);
    expect(mod.BUNDLED_KEYSET).toEqual({ jsonBase64: b64, signature: sig });
    expect(verifyKeyset({ json: Buffer.from(b64, "base64").toString("utf8"), signature: sig, pubPem: s.root.pubPem }).state).toBe("valid");
    expect(read(path.join(out, "BuiltinRulesData.swift"))).toContain('"bot": "muse"');
  });
  it("compiles in an EMPTY keyset while the keyset is unsigned, so an unsigned keyset can never be trusted", async () => {
    const s = sandbox();
    const out = outDir();
    const r = sync(s, out);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/keyset is unsigned/);
    expect(read(path.join(out, "BuiltinKeysetData.swift"))).toMatch(/jsonBase64 = ""[\s\S]*signature = ""/);
    expect((await import(`${path.join(out, "keyset-data.js")}?${Date.now()}`)).BUNDLED_KEYSET).toEqual({ jsonBase64: "", signature: "" });
  });
});
