// Shared fixtures for the update tests: throwaway Ed25519 keys, signed manifests, fake binaries, a local HTTP server.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { canonicalManifest } from "../src/crypto.js";
import { run as realRun } from "../src/exec.js";

/**
 * `run` for tests that go through the real installer path: the real thing, except `codesign`, which only exists on macOS.
 * Where it cannot be started at all (Linux, or a PATH without it: exit code -1), it answers "verified" so the suite does not
 * depend on the platform. Everything else, and every codesign result that did start, is passed through untouched; tests that
 * need a failing codesign inject their own `run`.
 */
export async function run(file, args, opts) {
  const r = await realRun(file, args, opts);
  return file === "codesign" && r.code === -1 ? { code: 0, stdout: "", stderr: "" } : r;
}

export const tmp = (p = "cbb") => fs.mkdtempSync(path.join(os.tmpdir(), `${p}-`));

export function newKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { privateKey, pubPem: publicKey.export({ type: "spki", format: "pem" }) };
}

export const signB64 = (privateKey, bytes) => crypto.sign(null, Buffer.from(bytes), privateKey).toString("base64");

export function signManifest(m, privateKey) {
  return { ...m, signature: signB64(privateKey, canonicalManifest(m)) };
}

/** A shell script that answers `version` like muse-ax does. */
export const fakeBinaryScript = (version) => `#!/bin/sh\nif [ "$1" = "version" ]; then echo '{"ok":true,"name":"muse-ax","version":"${version}"}'; else echo '{"ok":true}'; fi\n`;

export function writeBinary(file, version) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fakeBinaryScript(version), { mode: 0o755 });
}

/** tar.gz containing the given files (name -> content), built outside the tree it archives. */
export function makeTarball(files, name = "muse-ax-macos-universal.tar.gz") {
  const src = tmp("tar-src");
  for (const [n, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, n)), { recursive: true });
    fs.writeFileSync(path.join(src, n), c, { mode: 0o755 });
  }
  const out = path.join(tmp("tar-out"), name);
  execFileSync("tar", ["-czf", out, "-C", src, ...Object.keys(files)], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return fs.readFileSync(out);
}

export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** Serves routes (path -> Buffer|string|{status,body}) on 127.0.0.1; counts requests. */
export async function serve(routes) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const r = routes[req.url];
    if (r === undefined) { res.statusCode = 404; return res.end("nope"); }
    const { status = 200, body } = typeof r === "object" && !Buffer.isBuffer(r) ? r : { body: r };
    res.statusCode = status; res.end(body);
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, hits, close: () => new Promise((ok) => server.close(ok)) };
}

/** A complete signed-release fixture: server, signed manifest, tarball. */
export async function release({ version = "9.9.9", key = newKey(), files, tamper } = {}) {
  const tarball = makeTarball(files ?? { "muse-ax": fakeBinaryScript(version) });
  const srv = await serve({ "/rel/muse-ax.tar.gz": tarball });
  const base = { version, url: `${srv.base}/rel/muse-ax.tar.gz`, sha256: sha256(tarball) };
  const manifest = { ...signManifest({ ...base, ...(tamper?.pre ?? {}) }, key.privateKey), ...(tamper?.post ?? {}) };
  return { ...srv, key, manifest, tarball };
}

/** Raw 32-byte Ed25519 public key (base64) of a key pair, as keys/keyset.json lists it. */
export const rawPublicB64 = (pubPem) => crypto.createPublicKey(pubPem).export({ type: "spki", format: "der" }).subarray(12).toString("base64");

/** A throwaway root, rules key and binary key, plus a signed keyset that lists the last two. */
export function hierarchy({ now = Date.parse("2027-01-15T00:00:00Z"), revoked = [], keysetNotAfter, rulesNotAfter, issuedAt } = {}) {
  const root = newKey(), rules = newKey(), binary = newKey();
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const year = 365 * 86400000;
  const object = {
    schema: 1, issued_at: iso(issuedAt ?? now - 86400000), not_after: keysetNotAfter ?? iso(now + year),
    keys: [
      { id: "rules-1", use: "rules", public_key_b64: rawPublicB64(rules.pubPem), not_after: rulesNotAfter ?? iso(now + 2 * year) },
      { id: "binary-1", use: "binary", public_key_b64: rawPublicB64(binary.pubPem), not_after: iso(now + 2 * year) },
    ],
    revoked,
  };
  const json = JSON.stringify(object, null, 2) + "\n";
  return { root, rules, binary, now, iso, object, json, signature: signB64(root.privateKey, json) };
}
