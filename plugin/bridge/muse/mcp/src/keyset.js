// The key hierarchy, MCP side. The server embeds ONE public key, the root (release-key.js). The root signs a keyset
// (keys/keyset.json) listing short-lived keys by id and purpose: `rules` keys sign rules, `binary` keys sign binary
// manifests. This mirrors the Swift side (Keyset.swift: Trust.verify); both must keep the same rules.
//
// Rules of trust, the same on both sides:
//  - Every document names its signing key (`key_id`); a document without one is never accepted. The root signs keysets only.
//  - The newest verified keyset (by `issued_at`) is the only one that counts. Older ones, validly signed or not, are refused,
//    so a failed fetch or a replayed old copy can never bring a revoked key back. The newest one is remembered in
//    <CBB_HOME>/keys/current (keyset-store.js), shared with the Swift helper.
//  - When that newest keyset is expired, nothing is trusted ("keyset_expired"); an older, still-valid one never takes over.
import { verifyDetached, canonicalManifest } from "./crypto.js";
import { BUNDLED_KEYSET } from "./keyset-data.js";
import { readCapped } from "./net.js";
import { readStoredKeyset, writeStoredKeyset } from "./keyset-store.js";

export const KEYSET_URL = "https://raw.githubusercontent.com/qualixar/claude-bot-bridge/main/keys/keyset.json";
const MAX_KEYSET_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const USES = new Set(["rules", "binary"]);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SPKI_HEADER = Buffer.from("302a300506032b6570032100", "hex");

const parseDate = (v, what) => {
  if (typeof v !== "string" || !ISO.test(v) || !Number.isFinite(Date.parse(v))) throw new Error(`${what} must be an ISO 8601 UTC time such as 2027-11-20T00:00:00Z`);
  return Date.parse(v);
};

const spkiPem = (raw) => `-----BEGIN PUBLIC KEY-----\n${Buffer.concat([SPKI_HEADER, raw]).toString("base64")}\n-----END PUBLIC KEY-----\n`;

/** Parses and validates keyset JSON. { ok: true, keyset } or { ok: false, error }. Never throws. */
export function decodeKeyset(text) {
  try {
    const o = JSON.parse(text);
    if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("not a keyset");
    if (o.schema !== 1) throw new Error(`keyset schema ${o.schema} is not supported`);
    const issuedAt = parseDate(o.issued_at, "issued_at"), notAfter = parseDate(o.not_after, "not_after");
    if (!Array.isArray(o.keys) || o.keys.length === 0) throw new Error("keys must be a non-empty list");
    const keys = o.keys.map((k) => {
      if (typeof k?.id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(k.id)) throw new Error("a key id must be 1-64 characters of letters, digits, . _ -");
      if (!USES.has(k.use)) throw new Error(`key ${k.id}: use must be rules or binary`);
      const raw = typeof k.public_key_b64 === "string" ? Buffer.from(k.public_key_b64, "base64") : Buffer.alloc(0);
      if (raw.length !== 32) throw new Error(`key ${k.id}: public_key_b64 must be a base64 Ed25519 public key (32 bytes)`);
      return { id: k.id, use: k.use, publicKeyB64: k.public_key_b64, publicKey: raw, notAfter: parseDate(k.not_after, `key ${k.id} not_after`) };
    });
    if (new Set(keys.map((k) => k.id)).size !== keys.length) throw new Error("duplicate key id");
    const revoked = o.revoked ?? [];
    if (!Array.isArray(revoked) || !revoked.every((r) => typeof r === "string")) throw new Error("revoked must be a list of strings");
    return { ok: true, keyset: { schema: 1, issuedAt, notAfter, keys, revoked } };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}

/** The root's detached signature over the exact bytes, then shape, then the keyset's own expiry.
 *  -> { state: "valid" | "expired" | "invalid", keyset?, reason? } */
export function verifyKeyset({ json, signature, pubPem, now = Date.now() }) {
  if (typeof json !== "string" || json.length > MAX_KEYSET_BYTES || !verifyDetached(pubPem, json, signature)) return { state: "invalid", reason: "bad_signature" };
  const d = decodeKeyset(json);
  if (!d.ok) return { state: "invalid", reason: `keyset_invalid: ${d.error}` };
  return now > d.keyset.notAfter ? { state: "expired", keyset: d.keyset } : { state: "valid", keyset: d.keyset };
}

/** The keyset to go by among several verified states: the one with the newest `issued_at`, valid OR expired (the first listed wins
 *  a tie). An expired newest one is returned as expired: an older valid keyset must not win just because it has not lapsed yet.
 *  With nothing verified: invalid when something exists, else absent. */
export function chooseKeyset(states) {
  let best = null;
  for (const s of states) {
    if ((s.state === "valid" || s.state === "expired") && (best === null || s.keyset.issuedAt > best.keyset.issuedAt)) best = s;
  }
  return best ?? states.find((s) => s.state === "invalid") ?? { state: "absent" };
}

function keyFor(keyset, id, use, now) {
  const k = keyset.keys.find((x) => x.id === id);
  if (!k) return { reason: "key_unknown" };
  if (k.use !== use) return { reason: "key_wrong_use" };
  if (keyset.revoked.includes(k.id) || keyset.revoked.includes(k.publicKeyB64)) return { reason: "key_revoked" };
  if (now > k.notAfter) return { reason: "key_expired" };
  return { key: k };
}

/** A document is checked with the keyset key it names, for the purpose it is used for. No key_id, no trust.
 *  -> { ok: true, keyId } | { ok: false, reason } with reason key_id_required, keyset_expired, keyset_unavailable, key_unknown,
 *  key_wrong_use, key_revoked, key_expired or bad_signature. */
export function verifyWithTrust({ data, signature, keyId, use, keyset = { state: "absent" }, now = Date.now() }) {
  if (typeof keyId !== "string" || keyId === "") return { ok: false, reason: "key_id_required" };
  if (keyset.state === "expired") return { ok: false, reason: "keyset_expired" };
  if (keyset.state !== "valid") return { ok: false, reason: "keyset_unavailable" };
  const { key, reason } = keyFor(keyset.keyset, keyId, use, now);
  if (!key) return { ok: false, reason };
  return verifyDetached(spkiPem(key.publicKey), data, signature) ? { ok: true, keyId } : { ok: false, reason: "bad_signature" };
}

/** Binary manifests are signed by a `binary` key; `key_id` is part of the signed bytes. trust = { keyset, now? }. */
export function verifyManifestWithTrust(manifest, trust) {
  return verifyWithTrust({ data: canonicalManifest(manifest), signature: manifest?.signature, keyId: manifest?.key_id, use: "binary", ...trust });
}

/** The keyset compiled into this bundle, or null while the maintainer has not signed one. */
export function bundledKeyset() {
  if (!BUNDLED_KEYSET.jsonBase64 || !BUNDLED_KEYSET.signature) return null;
  return { json: Buffer.from(BUNDLED_KEYSET.jsonBase64, "base64").toString("utf8"), signature: BUNDLED_KEYSET.signature };
}

async function fetchText(url, fetchImpl) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
    if (!res.ok) return null;
    return (await readCapped(res, MAX_KEYSET_BYTES)).toString("utf8");   // stops at the cap while streaming
  } catch { return null; }
}

/**
 * The keyset to trust now, from the cached copy (<dir>/keys/current), the bundled one and, unless `fetch` is false, a fresh copy
 * from GitHub; each is verified with the root key. The newest `issued_at` wins (chooseKeyset), so a network copy can add a
 * revocation but an older copy, or a failed fetch, can never undo one; when the winner is not the cached copy and is valid it is
 * written to the cache (atomically), which is what remembers it next time. Without `dir` nothing is read or written. Never throws.
 * -> { state, keyset?, reason?, source? }  (source: cache | bundled | release)
 */
export async function resolveKeyset({ pubPem, now = Date.now(), bundled = bundledKeyset(), fetchImpl = globalThis.fetch, url = KEYSET_URL, fetch: allowFetch = true, dir, sleep }) {
  const found = [];
  const tag = (s, source) => (s.keyset ? { ...s, source } : s);
  const stored = dir ? readStoredKeyset(dir) : null;
  if (stored) found.push(tag(verifyKeyset({ ...stored, pubPem, now }), "cache"));
  if (bundled) found.push(tag(verifyKeyset({ ...bundled, pubPem, now }), "bundled"));
  const pairs = { bundled };
  if (allowFetch) {
    const json = await fetchText(url, fetchImpl);
    const signature = json === null ? null : await fetchText(`${url}.sig`, fetchImpl);
    if (json !== null && signature !== null) { found.push(tag(verifyKeyset({ json, signature, pubPem, now }), "release")); pairs.release = { json, signature }; }
  }
  const chosen = chooseKeyset(found);
  if (dir && chosen.state === "valid" && chosen.source !== "cache") await writeStoredKeyset(dir, pairs[chosen.source], { sleep });
  return chosen;
}
