import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { decodeKeyset, verifyKeyset, chooseKeyset, verifyWithTrust, verifyManifestWithTrust, resolveKeyset, bundledKeyset, KEYSET_URL } from "../src/keyset.js";
import { readStoredKeyset, writeStoredKeyset } from "../src/keyset-store.js";
import { hierarchy, newKey, signB64, signManifest, tmp } from "./helpers.js";
import { canonicalManifest } from "../src/crypto.js";

const reply = (body, status = 200) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const state = (h, over = {}) => verifyKeyset({ json: h.json, signature: h.signature, pubPem: h.root.pubPem, now: h.now, ...over });

describe("decodeKeyset", () => {
  const h = hierarchy();
  const bad = (f) => { const o = structuredClone(h.object); f(o); return decodeKeyset(JSON.stringify(o)); };
  it("decodes a valid keyset", () => {
    const r = decodeKeyset(h.json);
    expect(r.ok).toBe(true);
    expect(r.keyset.keys.map((k) => k.id)).toEqual(["rules-1", "binary-1"]);
  });
  it("rejects every broken shape with a reason, never throws", () => {
    for (const r of [
      decodeKeyset("nope"), decodeKeyset("[]"),
      bad((o) => { o.schema = 2; }), bad((o) => { o.keys = []; }), bad((o) => { o.issued_at = "yesterday"; }),
      bad((o) => { delete o.not_after; }), bad((o) => { o.keys[1].id = "rules-1"; }), bad((o) => { o.keys[0].use = "root"; }),
      bad((o) => { o.keys[0].public_key_b64 = "AAAA"; }), bad((o) => { o.keys[0].id = "has space"; }), bad((o) => { o.revoked = [1]; }),
    ]) { expect(r.ok).toBe(false); expect(typeof r.error).toBe("string"); }
  });
});

describe("verifyKeyset", () => {
  it("is valid only when the ROOT signed the exact bytes", () => {
    const h = hierarchy();
    expect(state(h).state).toBe("valid");
    expect(state(h, { signature: signB64(h.rules.privateKey, h.json) })).toMatchObject({ state: "invalid", reason: "bad_signature" });
    expect(state(h, { json: h.json + " " })).toMatchObject({ state: "invalid" });
    expect(state(h, { pubPem: newKey().pubPem })).toMatchObject({ state: "invalid" });
  });
  it("reports an expired keyset as expired and a malformed signed one as invalid", () => {
    const h = hierarchy({ keysetNotAfter: "2027-01-01T00:00:00Z", issuedAt: Date.parse("2026-01-01T00:00:00Z") });
    expect(state(h).state).toBe("expired");
    const bad = "{\"schema\":1}";
    expect(verifyKeyset({ json: bad, signature: signB64(h.root.privateKey, bad), pubPem: h.root.pubPem, now: h.now }).state).toBe("invalid");
  });
});

describe("chooseKeyset", () => {
  it("takes the newest valid keyset, and says absent only when nothing exists", () => {
    const old = hierarchy({ issuedAt: Date.parse("2027-01-01T00:00:00Z") }), neu = hierarchy({ issuedAt: Date.parse("2027-01-10T00:00:00Z") });
    neu.root = old.root; neu.signature = signB64(old.root.privateKey, neu.json);
    const a = state(old), b = verifyKeyset({ json: neu.json, signature: neu.signature, pubPem: old.root.pubPem, now: old.now });
    expect(chooseKeyset([a, b]).keyset.issuedAt).toBe(b.keyset.issuedAt);
    expect(chooseKeyset([]).state).toBe("absent");
    expect(chooseKeyset([{ state: "invalid", reason: "bad_signature" }]).state).toBe("invalid");
    expect(chooseKeyset([{ state: "invalid", reason: "x" }, state(old)]).state).toBe("valid");
  });
  it("the newest wins even when it has expired: an older, still-valid keyset never takes over (fail closed)", () => {
    const now = Date.parse("2027-01-15T00:00:00Z");
    const older = hierarchy({ issuedAt: Date.parse("2026-12-01T00:00:00Z") });
    const newer = hierarchy({ issuedAt: Date.parse("2027-01-01T00:00:00Z"), keysetNotAfter: "2027-01-10T00:00:00Z" });
    newer.root = older.root; newer.signature = signB64(older.root.privateKey, newer.json);
    const a = verifyKeyset({ json: older.json, signature: older.signature, pubPem: older.root.pubPem, now });
    const b = verifyKeyset({ json: newer.json, signature: newer.signature, pubPem: older.root.pubPem, now });
    expect([a.state, b.state]).toEqual(["valid", "expired"]);
    for (const order of [[a, b], [b, a]]) expect(chooseKeyset(order).state).toBe("expired");
  });
  it("a tie goes to the first one listed", () => {
    const x = { state: "valid", keyset: { issuedAt: 5 }, source: "cache" }, y = { state: "valid", keyset: { issuedAt: 5 }, source: "bundled" };
    expect(chooseKeyset([x, y]).source).toBe("cache");
  });
});

describe("verifyWithTrust (same rules as Swift Trust.verify)", () => {
  const h = hierarchy();
  const keyset = state(h);
  const data = "payload";
  const v = (sig, o = {}) => verifyWithTrust({ data, signature: sig, keyId: "rules-1", use: "rules", pubPem: h.root.pubPem, keyset, now: h.now, ...o });
  it("accepts the keyset key of the right purpose", () => {
    expect(v(signB64(h.rules.privateKey, data))).toEqual({ ok: true, keyId: "rules-1" });
    expect(v(signB64(h.binary.privateKey, data), { keyId: "binary-1", use: "binary" })).toMatchObject({ ok: true });
  });
  it("a binary key cannot sign rules and a rules key cannot sign binaries", () => {
    expect(v(signB64(h.binary.privateKey, data), { keyId: "binary-1" })).toEqual({ ok: false, reason: "key_wrong_use" });
    expect(v(signB64(h.rules.privateKey, data), { use: "binary" })).toEqual({ ok: false, reason: "key_wrong_use" });
  });
  it("the root never signs in place of a key once a keyset exists", () => {
    expect(v(signB64(h.root.privateKey, data))).toEqual({ ok: false, reason: "bad_signature" });
    expect(v(signB64(h.root.privateKey, data), { keyId: undefined })).toEqual({ ok: false, reason: "key_id_required" });
  });
  it("refuses unknown, revoked and expired keys and a key_id without a usable keyset", () => {
    expect(v(signB64(h.rules.privateKey, data), { keyId: "rules-9" })).toEqual({ ok: false, reason: "key_unknown" });
    const rev = hierarchy({ revoked: ["rules-1"] });
    expect(verifyWithTrust({ data, signature: signB64(rev.rules.privateKey, data), keyId: "rules-1", use: "rules", pubPem: rev.root.pubPem, keyset: state(rev), now: rev.now }).reason).toBe("key_revoked");
    const revKey = hierarchy(); revKey.object.revoked = [revKey.object.keys[0].public_key_b64];
    const rj = JSON.stringify(revKey.object); const rs = verifyKeyset({ json: rj, signature: signB64(revKey.root.privateKey, rj), pubPem: revKey.root.pubPem, now: revKey.now });
    expect(verifyWithTrust({ data, signature: signB64(revKey.rules.privateKey, data), keyId: "rules-1", use: "rules", pubPem: revKey.root.pubPem, keyset: rs, now: revKey.now }).reason).toBe("key_revoked");
    const exp = hierarchy({ rulesNotAfter: "2027-01-01T00:00:00Z" });
    expect(verifyWithTrust({ data, signature: signB64(exp.rules.privateKey, data), keyId: "rules-1", use: "rules", pubPem: exp.root.pubPem, keyset: state(exp), now: exp.now }).reason).toBe("key_expired");
    for (const k of [{ state: "absent" }, { state: "invalid", reason: "x" }]) expect(v(signB64(h.rules.privateKey, data), { keyset: k }).reason).toBe("keyset_unavailable");
  });
  it("an expired keyset trusts nothing, and says so", () => {
    const old = hierarchy({ keysetNotAfter: "2027-01-01T00:00:00Z", issuedAt: Date.parse("2026-01-01T00:00:00Z") });
    const expired = state(old);
    expect(expired.state).toBe("expired");
    expect(verifyWithTrust({ data, signature: signB64(old.rules.privateKey, data), keyId: "rules-1", use: "rules", keyset: expired, now: old.now })).toEqual({ ok: false, reason: "keyset_expired" });
  });
  it("a document without a key_id is never accepted: the root signs keysets only, whatever the keyset state", () => {
    const rootSig = signB64(h.root.privateKey, data);
    for (const k of [{ state: "absent" }, { state: "invalid", reason: "x" }, { state: "expired", keyset: keyset.keyset }, keyset]) {
      expect(v(rootSig, { keyId: undefined, keyset: k })).toEqual({ ok: false, reason: "key_id_required" });
      expect(v(rootSig, { keyId: "", keyset: k })).toEqual({ ok: false, reason: "key_id_required" });
    }
  });
});

describe("verifyManifestWithTrust", () => {
  const h = hierarchy();
  const base = { version: "1.0.0", url: "https://x/y", sha256: "ab".repeat(32) };
  const trust = { pubPem: h.root.pubPem, keyset: state(h), now: h.now };
  const signedBy = (key, over = {}) => { const m = { ...base, ...over }; return { ...m, signature: signB64(key.privateKey, canonicalManifest(m)) }; };
  it("a manifest signed by the binary key and naming it verifies; key_id is covered by the signature", () => {
    const m = signedBy(h.binary, { key_id: "binary-1" });
    expect(verifyManifestWithTrust(m, trust)).toMatchObject({ ok: true, keyId: "binary-1" });
    expect(verifyManifestWithTrust({ ...m, key_id: "rules-1" }, trust).ok).toBe(false);
    expect(verifyManifestWithTrust({ ...m, sha256: "cd".repeat(32) }, trust).ok).toBe(false);
  });
  it("the rules key and the root cannot sign a manifest once a keyset exists", () => {
    expect(verifyManifestWithTrust(signedBy(h.rules, { key_id: "rules-1" }), trust)).toEqual({ ok: false, reason: "key_wrong_use" });
    expect(verifyManifestWithTrust(signedBy(h.root), trust).reason).toBe("key_id_required");
  });
  it("without any keyset, or without a key_id, no manifest verifies (there is no root-signed compatibility path)", () => {
    expect(verifyManifestWithTrust(signedBy(h.root), { keyset: { state: "absent" }, now: h.now })).toEqual({ ok: false, reason: "key_id_required" });
    expect(verifyManifestWithTrust(signedBy(h.binary, { key_id: "binary-1" }), { keyset: { state: "absent" }, now: h.now })).toEqual({ ok: false, reason: "keyset_unavailable" });
  });
});

describe("resolveKeyset", () => {
  const h = hierarchy();
  const bundled = { json: h.json, signature: h.signature };
  const go = (o) => resolveKeyset({ pubPem: h.root.pubPem, now: h.now, bundled, ...o });
  it("fetches the keyset and its signature from raw GitHub and prefers the newer one", async () => {
    const neu = hierarchy({ issuedAt: h.now - 1000, revoked: ["rules-1"] });
    const seen = [];
    const fetchImpl = async (u) => { seen.push(u); const body = u.endsWith(".sig") ? signB64(h.root.privateKey, neu.json) : neu.json; return new Response(body); };
    const s = await go({ fetchImpl });
    expect(seen).toEqual([KEYSET_URL, `${KEYSET_URL}.sig`]);
    expect(s.state).toBe("valid"); expect(s.keyset.revoked).toEqual(["rules-1"]); expect(s.source).toBe("release");
  });
  it("an older validly-signed keyset from the network cannot undo what the bundled one revokes", async () => {
    const withRevocation = hierarchy({ revoked: ["rules-1"], issuedAt: h.now - 1000 });
    const old = hierarchy({ issuedAt: h.now - 5 * 86400000 });
    const b = { json: withRevocation.json, signature: signB64(h.root.privateKey, withRevocation.json) };
    const fetchImpl = async (u) => new Response(u.endsWith(".sig") ? signB64(h.root.privateKey, old.json) : old.json);
    const s = await go({ bundled: b, fetchImpl });
    expect(s.keyset.revoked).toEqual(["rules-1"]);
  });
  it("falls back to the bundled keyset on any network trouble, and ignores a keyset signed by another key", async () => {
    for (const fetchImpl of [reply("nope", 404), async () => { throw new Error("offline"); }, reply("{not json")]) {
      expect((await go({ fetchImpl })).state).toBe("valid");
    }
    const evil = hierarchy();
    const fetchImpl = async (u) => new Response(u.endsWith(".sig") ? evil.signature : evil.json);
    const s = await go({ fetchImpl });
    expect(s.source).toBe("bundled");
  });
  it("is absent when nothing is bundled and nothing can be fetched", async () => {
    expect((await go({ bundled: null, fetchImpl: reply("nope", 404) })).state).toBe("absent");
  });
  it("never fetches when told not to (auto-update off)", async () => {
    let called = false;
    const s = await go({ fetchImpl: async () => { called = true; return new Response(""); }, fetch: false });
    expect(called).toBe(false); expect(s.state).toBe("valid");
  });
});

describe("resolveKeyset remembers the newest keyset (<CBB_HOME>/keys/current)", () => {
  const h = hierarchy();
  const root = h.root;
  const signedAt = (issuedMs, over = {}) => {
    const x = hierarchy({ ...over, now: h.now, issuedAt: issuedMs });
    // every keyset in this block is signed by the same root and lists the same keys, only issued_at / revoked / not_after differ
    const object = { ...h.object, issued_at: x.iso(issuedMs), revoked: over.revoked ?? [], not_after: over.keysetNotAfter ?? h.object.not_after };
    const json = JSON.stringify(object, null, 2) + "\n";
    return { json, signature: signB64(root.privateKey, json) };
  };
  const day = 86400000;
  const serving = (k) => async (u) => new Response(u.endsWith(".sig") ? k.signature : k.json);
  const go = (o) => resolveKeyset({ pubPem: root.pubPem, now: h.now, ...o });

  it("writes a fetched newer keyset to the cache in the shared layout (v-<id>/ behind a `current` symlink)", async () => {
    const dir = tmp("bridge");
    const older = signedAt(h.now - 5 * day), newer = signedAt(h.now - day, { revoked: ["rules-1"] });
    const s = await go({ dir, bundled: older, fetchImpl: serving(newer) });
    expect(s.source).toBe("release"); expect(s.keyset.revoked).toEqual(["rules-1"]);
    expect(fs.readlinkSync(path.join(dir, "keys", "current"))).toMatch(/^v-/);
    expect(readStoredKeyset(dir)).toEqual({ json: newer.json, signature: newer.signature });
    expect(fs.readFileSync(path.join(dir, "keys", "current", "keyset.json.sig"), "utf8")).toBe(newer.signature + "\n");
  });
  it("a failed fetch cannot bring a revoked key back: the remembered keyset beats an older bundled one", async () => {
    const dir = tmp("bridge");
    const older = signedAt(h.now - 5 * day), revoking = signedAt(h.now - day, { revoked: ["rules-1"] });
    await go({ dir, bundled: older, fetchImpl: serving(revoking) });
    for (const fetchImpl of [async () => new Response("nope", { status: 503 }), async () => { throw new Error("offline"); }]) {
      const s = await go({ dir, bundled: older, fetchImpl });
      expect(s).toMatchObject({ state: "valid", source: "cache" });
      expect(s.keyset.revoked).toEqual(["rules-1"]);
    }
    expect((await go({ dir, bundled: older, fetch: false })).keyset.revoked).toEqual(["rules-1"]);
  });
  it("an older validly-signed keyset served later is refused (issued_at floor), and the cache keeps the newer one", async () => {
    const dir = tmp("bridge");
    const older = signedAt(h.now - 5 * day), revoking = signedAt(h.now - day, { revoked: ["rules-1"] });
    await go({ dir, bundled: null, fetchImpl: serving(revoking) });
    const s = await go({ dir, bundled: older, fetchImpl: serving(older) });
    expect(s.keyset.revoked).toEqual(["rules-1"]); expect(s.source).toBe("cache");
    expect(readStoredKeyset(dir).json).toBe(revoking.json);
  });
  it("a newer bundled keyset (a plugin update) is written over an older cached one", async () => {
    const dir = tmp("bridge");
    const old = signedAt(h.now - 5 * day), neu = signedAt(h.now - day);
    await writeStoredKeyset(dir, old);
    const s = await go({ dir, bundled: neu, fetch: false });
    expect(s.source).toBe("bundled");
    expect(readStoredKeyset(dir).json).toBe(neu.json);
  });
  it("fails closed when the newest keyset has expired, even though an older one has not (and the cache is not overwritten)", async () => {
    const dir = tmp("bridge");
    const valid = signedAt(h.now - 30 * day);
    const expired = signedAt(h.now - 10 * day, { keysetNotAfter: h.iso(h.now - day) });
    await writeStoredKeyset(dir, valid);
    const s = await go({ dir, bundled: null, fetchImpl: serving(expired) });
    expect(s.state).toBe("expired");
    expect(readStoredKeyset(dir).json).toBe(valid.json);
    const t = await go({ dir: tmp("bridge"), bundled: valid, fetchImpl: serving(expired) });
    expect(t.state).toBe("expired");
  });
  it("ignores a cached keyset that does not verify (planted or corrupt), and a cache that cannot be written is not fatal", async () => {
    const dir = tmp("bridge");
    const evil = hierarchy();   // another root
    await writeStoredKeyset(dir, { json: evil.json, signature: evil.signature });
    const good = signedAt(h.now - day);
    expect((await go({ dir, bundled: good, fetch: false })).source).toBe("bundled");
    const blocked = tmp("bridge"); fs.writeFileSync(path.join(blocked, "keys"), "a file where the folder should be");
    expect((await go({ dir: blocked, bundled: good, fetch: false })).state).toBe("valid");
  });
  it("without a dir nothing is read or written", async () => {
    const s = await go({ bundled: signedAt(h.now - day), fetch: false });
    expect(s.state).toBe("valid");
  });
});

describe("bundledKeyset", () => {
  it("is empty while the keyset is unsigned and verifies against the root key once it is signed", async () => {
    const root = await import("../src/release-key.js");
    const b = bundledKeyset();
    if (b === null) return;
    expect(verifyKeyset({ json: b.json, signature: b.signature, pubPem: root.RELEASE_PUBLIC_KEY_PEM, now: Date.now() }).state).toBe("valid");
  });
});
