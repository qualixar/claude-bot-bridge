// End-to-end: the real muse-ax debug binary against a local HTTP server and throwaway keys.
// Skipped when the debug binary is not built (`swift build` in bridge/muse, or `npm run test:e2e`).
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmp, serve, newKey, signB64, hierarchy } from "./helpers.js";

const BIN = process.env.CBB_E2E_BIN || new URL("../../.build/debug/muse-ax", import.meta.url).pathname;
const have = fs.existsSync(BIN);
const rules = JSON.parse(fs.readFileSync(new URL("../../../../../rules/muse.json", import.meta.url), "utf8"));
const rawKey = (pem) => crypto.createPublicKey(pem).export({ type: "spki", format: "der" }).subarray(12).toString("base64");

// Async on purpose: the HTTP server under test lives on this event loop.
async function cli(args, { home, url, pub, env = {} }) {
  const { stdout: out } = await promisify(execFile)(BIN, args, { encoding: "utf8", env: { PATH: process.env.PATH, CBB_HOME: home, CBB_RULES_URL: url, CBB_TEST_PUBKEY_B64: rawKey(pub), ...env } });
  return JSON.parse(out.trim().split("\n").pop());
}

// The key hierarchy end to end: the real helper, a throwaway root, a keyset and rules served by a local HTTP server.
// There is no root-signed fallback: every rules document names its key, and the keyset must be known first.
describe.skipIf(!have)("muse-ax rules update under the key hierarchy", () => {
  const servers = [];
  afterAll(async () => { for (const s of servers) await s.close(); });
  const rulesDoc = (over = {}) => Buffer.from(JSON.stringify({ ...rules, key_id: "rules-1", revision: 6, ...over }));
  const indexDoc = (bots, keyId = "rules-1") => Buffer.from(JSON.stringify({ schema: 1, revision: 1, key_id: keyId, bots: bots.map((id) => ({ id, rules: `${id}.json` })) }));

  async function world({ rulesBody = rulesDoc(), signedBody = rulesBody, signer = "rules", signWith, noSig = false, index, keysetOver = {} } = {}) {
    const h = hierarchy({ ...keysetOver, now: Date.now() });
    const routes = {
      "/keys/keyset.json": h.json, "/keys/keyset.json.sig": h.signature,
      "/rules/muse.json": rulesBody,
      ...(noSig ? {} : { "/rules/muse.json.sig": signB64((signWith ?? h[signer]).privateKey, signedBody) }),
    };
    if (index) { routes["/rules/index.json"] = index; routes["/rules/index.json.sig"] = signB64(h.rules.privateKey, index); }
    const srv = await serve(routes);
    servers.push(srv);
    return { h, srv, ctx: { home: tmp("e2e-home"), url: `${srv.base}/rules/muse.json`, pub: h.root.pubPem, env: { CBB_KEYSET_URL: `${srv.base}/keys/keyset.json` } } };
  }

  it("fetches the keyset, then installs rules signed by the rules key, reports the key_id, and is unchanged the second time", async () => {
    const { ctx } = await world();
    expect(await cli(["rules", "update"], ctx)).toMatchObject({ ok: true, updated: true, reason: "updated", revision: 6, key_id: "rules-1", keyset: { updated: true, reason: "updated" } });
    expect(await cli(["rules", "show"], ctx)).toMatchObject({ source: "cache", revision: 6, key_id: "rules-1", bot: "muse", channel: "stable", keyset: { state: "valid", source: "cache" } });
    expect(fs.readlinkSync(path.join(ctx.home, "rules", "current"))).toMatch(/^v-/);
    expect(fs.readlinkSync(path.join(ctx.home, "keys", "current"))).toMatch(/^v-/);
    expect(await cli(["rules", "update"], ctx)).toMatchObject({ updated: false, reason: "unchanged", keyset: { reason: "unchanged" } });
  });
  it("rejects a bad signature and a tampered file", async () => {
    const bad = await world({ signWith: newKey() });
    expect(await cli(["rules", "update"], bad.ctx)).toMatchObject({ ok: true, updated: false, reason: "bad_signature" });
    expect(await cli(["rules", "show"], bad.ctx)).toMatchObject({ source: "builtin" });
    const body = rulesDoc();
    const t = await world({ rulesBody: Buffer.from(body.toString().replace('"revision":6', '"revision":7')), signedBody: body });   // signed as it was, edited after
    expect(await cli(["rules", "update"], t.ctx)).toMatchObject({ updated: false, reason: "bad_signature" });
  });
  it("rejects a truncated file (it has no readable key_id any more)", async () => {
    const json = rulesDoc();
    const { ctx } = await world({ rulesBody: json.subarray(0, json.length - 40) });
    expect(await cli(["rules", "update"], ctx)).toMatchObject({ updated: false, reason: "untrusted_key", detail: "key_id_required" });
  });
  it("rejects a newer schema gracefully", async () => {
    const body = Buffer.from(JSON.stringify({ schema: 2, bot: "muse", revision: 9, key_id: "rules-1", profiles: { shape: "changed" } }));
    const { ctx } = await world({ rulesBody: body });
    expect(await cli(["rules", "update"], ctx)).toMatchObject({ ok: true, updated: false, reason: "schema_unsupported" });
  });
  it("keeps current rules when the server has no signature or is down", async () => {
    const { ctx } = await world({ noSig: true });
    expect(await cli(["rules", "update"], ctx)).toMatchObject({ ok: true, updated: false, reason: "network_error" });
    expect(await cli(["rules", "update"], { ...ctx, url: "http://127.0.0.1:1/muse.json" })).toMatchObject({ ok: true, updated: false, reason: "network_error" });
  });
  it("an unsigned (planted) rules cache is ignored", async () => {
    const { ctx } = await world();
    await cli(["rules", "update"], ctx);   // brings in the keyset, so the planted cache is judged on its signature
    const rulesDir = path.join(ctx.home, "rules");
    fs.mkdirSync(path.join(rulesDir, "v-planted"), { recursive: true });
    fs.writeFileSync(path.join(rulesDir, "v-planted", "muse.json"), rulesDoc({ revision: 99 }));
    fs.writeFileSync(path.join(rulesDir, "v-planted", "muse.json.sig"), "AAAA");
    fs.rmSync(path.join(rulesDir, "current")); fs.symlinkSync("v-planted", path.join(rulesDir, "current"));
    expect(await cli(["rules", "show"], ctx)).toMatchObject({ source: "builtin", note: "cache_bad_signature" });
  });
  it("version prints the build version", async () => {
    const { ctx } = await world();
    const plugin = JSON.parse(fs.readFileSync(new URL("../../../../.claude-plugin/plugin.json", import.meta.url), "utf8"));
    expect(await cli(["version"], ctx)).toMatchObject({ ok: true, name: "muse-ax", version: plugin.version });
  });
  it("refuses rules signed by the binary key or by the root, once a keyset is known", async () => {
    for (const signer of ["binary", "root"]) {
      const { ctx } = await world({ signer });
      expect(await cli(["rules", "update"], ctx)).toMatchObject({ ok: true, updated: false, reason: "bad_signature" });
      expect(await cli(["rules", "show"], ctx)).toMatchObject({ source: "builtin" });
    }
  });
  it("refuses root-signed rules without a key_id: there is no compatibility path", async () => {
    const { ctx } = await world({ rulesBody: rulesDoc({ key_id: undefined }), signer: "root" });
    expect(await cli(["rules", "update"], ctx)).toMatchObject({ updated: false, reason: "untrusted_key", detail: "key_id_required" });
  });
  it("a revoked rules key is refused with the reason, and the built-in rules stay in use", async () => {
    const { ctx } = await world({ keysetOver: { revoked: ["rules-1"] } });
    expect(await cli(["rules", "update"], ctx)).toMatchObject({ updated: false, reason: "untrusted_key", detail: "key_revoked" });
    expect(await cli(["rules", "show"], ctx)).toMatchObject({ source: "builtin", keyset: { state: "valid" } });
  });
  it("an expired keyset is not installed, and nothing is trusted without one", async () => {
    const { ctx } = await world({ keysetOver: { keysetNotAfter: new Date(Date.now() - 3600e3).toISOString().replace(/\.\d{3}Z$/, "Z"), issuedAt: Date.now() - 400 * 86400000 } });
    expect(await cli(["rules", "update"], ctx)).toMatchObject({ updated: false, reason: "untrusted_key", detail: "keyset_unavailable", keyset: { updated: false, reason: "expired" } });
  });
  it("uses the signed bot index to find the rules file, and stops when the bot is not listed", async () => {
    const listed = await world({ index: indexDoc(["muse"]) });
    expect(await cli(["rules", "update"], listed.ctx)).toMatchObject({ updated: true });
    const missing = await world({ index: indexDoc(["other"]) });
    expect(await cli(["rules", "update"], missing.ctx)).toMatchObject({ updated: false, reason: "bot_not_listed" });
  });
  it("skips the keyset fetch when only CBB_RULES_URL is set (a test server never makes the helper call GitHub), and then trusts nothing", async () => {
    const key = newKey(), json = rulesDoc();
    const srv = await serve({ "/muse.json": json, "/muse.json.sig": signB64(key.privateKey, json) }); servers.push(srv);
    const out = await cli(["rules", "update"], { home: tmp("e2e-home"), url: `${srv.base}/muse.json`, pub: key.pubPem });
    expect(out).toMatchObject({ updated: false, reason: "untrusted_key", detail: "keyset_unavailable", keyset: { updated: false, reason: "skipped" } });
  });
  it("rules show reports the channel and its update URL", async () => {
    const key = newKey();
    const out = await cli(["rules", "show"], { home: tmp("e2e-home"), url: "", pub: key.pubPem, env: { CBB_RULES_CHANNEL: "next" } });
    expect(out).toMatchObject({ channel: "next", bot: "muse" });
    expect(out.update_url).toMatch(/\/rules\/next\/muse\.json$/);
  });

  // The newest keyset is remembered; an older, validly signed one is refused (the issued_at floor).
  it("an older keyset served later cannot undo a revocation that is already cached", async () => {
    const now = Date.now(), day = 86400000;
    const root = newKey();
    const base = hierarchy({ now });
    const mk = (issued, revoked) => { const o = { ...base.object, issued_at: base.iso(issued), revoked }; const json = JSON.stringify(o, null, 2) + "\n"; return { json, sig: signB64(root.privateKey, json) }; };
    const revoking = mk(now - day, ["rules-1"]), older = mk(now - 5 * day, []);
    const first = await serve({ "/keys/keyset.json": revoking.json, "/keys/keyset.json.sig": revoking.sig }); servers.push(first);
    const replay = await serve({ "/keys/keyset.json": older.json, "/keys/keyset.json.sig": older.sig }); servers.push(replay);
    const home = tmp("e2e-home");
    const at = (srv) => ({ home, url: `${srv.base}/rules/muse.json`, pub: root.pubPem, env: { CBB_KEYSET_URL: `${srv.base}/keys/keyset.json` } });
    expect(await cli(["rules", "update"], at(first))).toMatchObject({ keyset: { updated: true } });
    expect(await cli(["rules", "update"], at(replay))).toMatchObject({ keyset: { updated: false, reason: "not_newer" } });
    expect(await cli(["rules", "show"], at(replay))).toMatchObject({ keyset: { state: "valid", revoked: 1 } });
  });
  it("shares the keyset cache with the MCP server: what one writes the other reads", async () => {
    const { readStoredKeyset, writeStoredKeyset } = await import("../src/keyset-store.js");
    const { h, ctx } = await world();
    await cli(["rules", "update"], ctx);                                   // the helper writes keys/current
    expect(readStoredKeyset(ctx.home)).toEqual({ json: h.json, signature: h.signature.trim() });
    const home2 = tmp("e2e-home");                                          // the MCP server writes it, the helper reads it
    expect(await writeStoredKeyset(home2, { json: h.json, signature: h.signature })).toBe(true);
    expect(await cli(["rules", "show"], { ...ctx, home: home2 })).toMatchObject({ keyset: { state: "valid", source: "cache" } });
  });
  it("drops an oversized download while it streams: the server is still sending when the helper hangs up", async () => {
    let sent = 0, closed = false;
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      if (req.url.startsWith("/keys/")) { res.statusCode = 404; return res.end(); }
      res.on("close", () => { closed = true; });
      const timer = setInterval(() => { sent += 65536; res.write(Buffer.alloc(65536, 0x20)); }, 2);
      res.on("close", () => clearInterval(timer));
    });
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    servers.push({ close: async () => { server.closeAllConnections?.(); await new Promise((ok) => server.close(ok)); } });
    const key = newKey();
    const out = await cli(["rules", "update"], { home: tmp("e2e-home"), url: `http://127.0.0.1:${server.address().port}/muse.json`, pub: key.pubPem, env: { CBB_KEYSET_URL: `http://127.0.0.1:${server.address().port}/keys/keyset.json` } });
    expect(out).toMatchObject({ updated: false, reason: "invalid_rules" });
    await new Promise((ok) => setTimeout(ok, 300));
    expect(closed).toBe(true);
    expect(sent).toBeLessThan(16 * 1024 * 1024);
  });
});

describe.skipIf(!have)("muse-ax doctor (read-only)", () => {
  const key = newKey();
  const env = (home) => ({ PATH: process.env.PATH, CBB_HOME: home, CBB_TEST_PUBKEY_B64: rawKey(key.pubPem) });
  const run = (args, home) => promisify(execFile)(BIN, args, { encoding: "utf8", env: env(home) });

  it("prints a JSON diagnostic with the facts a maintainer needs and nothing private", async () => {
    const home = tmp("e2e-home");
    fs.writeFileSync(path.join(home, "sends.jsonl"), JSON.stringify({ at: "2026-11-01T10:00:00Z", chat: "Secret Chat Name", sha256: "ab", length: 9, outcome: "sent" }) + "\n");
    const { stdout } = await run(["doctor"], home);
    const out = JSON.parse(stdout.trim().split("\n").pop());
    expect(out).toMatchObject({ ok: true, bot: "muse", binary_version: expect.any(String), app: { running: expect.any(Boolean) }, rules: { source: "builtin", channel: "stable" }, keyset: { state: "absent" }, lock: { held: false } });
    expect(out.last_sends).toEqual([{ at: "2026-11-01T10:00:00Z", outcome: "sent" }]);
    expect(stdout).not.toContain("Secret Chat Name");
    expect(out.report).toMatch(/claude-bot-bridge doctor/);
    expect(out.dump_tree).toBeUndefined();
  });
  it("--text prints the report as plain lines", async () => {
    const { stdout } = await run(["doctor", "--text"], tmp("e2e-home"));
    expect(stdout.startsWith("claude-bot-bridge doctor\n")).toBe(true);
    expect(stdout).toMatch(/^keyset /m);
    expect(() => JSON.parse(stdout)).toThrow();
  });
  it("is read-only: it writes nothing under the bridge home", async () => {
    const home = tmp("e2e-home");
    await run(["doctor"], home);
    expect(fs.readdirSync(home)).toEqual([]);
  });
  it("rejects unknown flags with an argument error", async () => {
    await expect(run(["doctor", "--bogus"], tmp("e2e-home"))).rejects.toMatchObject({ code: 2 });
  });
});
