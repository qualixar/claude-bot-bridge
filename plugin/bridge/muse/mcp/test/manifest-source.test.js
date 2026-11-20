import { describe, it, expect } from "vitest";
import { resolveManifest, manifestUrl, MAX_MANIFEST_BYTES } from "../src/manifest-source.js";
import { verifyKeyset } from "../src/keyset.js";
import { newKey, signManifest, hierarchy } from "./helpers.js";

// Manifests are signed by the `binary` key of a throwaway hierarchy and name it in key_id; the keyset is what makes that key trusted.
const h = hierarchy();
const key = h.binary;
const keyset = verifyKeyset({ json: h.json, signature: h.signature, pubPem: h.root.pubPem, now: h.now });
const base = { key_id: "binary-1", version: "0.1.0", url: "https://github.com/qualixar/claude-bot-bridge/releases/download/v0.1.0/muse-ax-macos-universal.tar.gz", sha256: "ab".repeat(32) };
const signed = (over = {}, k = key) => signManifest({ ...base, ...over }, k.privateKey);
const placeholder = { version: "0.1.0", url: base.url, sha256: "<placeholder until first release>", signature: "<base64 ...>" };
const reply = (body, status = 200) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const resolve = (o) => resolveManifest({ pluginVersion: "0.1.0", pubPem: h.root.pubPem, keyset, now: h.now, bundled: placeholder, ...o });

describe("manifestUrl", () => {
  it("points at the release asset of exactly this plugin version", () => {
    expect(manifestUrl("0.1.0")).toBe("https://github.com/qualixar/claude-bot-bridge/releases/download/v0.1.0/binary-manifest.json");
  });
});

describe("resolveManifest: the release manifest", () => {
  it("is fetched from the release URL and used when its signature verifies and the version matches", async () => {
    const seen = [];
    const m = signed();
    const out = await resolve({ fetchImpl: async (u, o) => { seen.push(u); expect(o.signal).toBeDefined(); return reply(m)(); } });
    expect(seen).toEqual([manifestUrl("0.1.0")]);
    expect(out).toMatchObject({ source: "release", manifest: m });
  });
  it("is rejected when its version is not the plugin version (a replayed older release)", async () => {
    const out = await resolve({ fetchImpl: reply(signed({ version: "0.0.9" })) });
    expect(out.manifest).toBeNull();
    expect(out.reason).toMatch(/version/);
  });
  it("is rejected when signed by another key", async () => {
    const out = await resolve({ fetchImpl: reply(signed({}, newKey())) });
    expect(out.manifest).toBeNull();
  });
  it("is rejected when edited after signing", async () => {
    const m = signed(); m.sha256 = "cd".repeat(32);
    expect((await resolve({ fetchImpl: reply(m) })).manifest).toBeNull();
  });
  it("is rejected when it is itself a placeholder", async () => {
    expect((await resolve({ fetchImpl: reply(placeholder) })).manifest).toBeNull();
  });
  it("is refused with a clear reason when the keyset has expired (no older keyset takes over)", async () => {
    const old = hierarchy({ keysetNotAfter: "2027-01-01T00:00:00Z", issuedAt: Date.parse("2026-01-01T00:00:00Z") });
    const expired = verifyKeyset({ json: old.json, signature: old.signature, pubPem: old.root.pubPem, now: old.now });
    expect(expired.state).toBe("expired");
    const m = signManifest({ ...base }, old.binary.privateKey);
    const out = await resolve({ keyset: expired, pubPem: old.root.pubPem, now: old.now, fetchImpl: reply(m) });
    expect(out.manifest).toBeNull();
    expect(out.reason).toMatch(/keyset expired/);
  });
  it("is refused when it names no key at all", async () => {
    const { key_id: _k, ...bare } = base;
    expect((await resolve({ fetchImpl: reply(signManifest(bare, key.privateKey)) })).manifest).toBeNull();
  });
  for (const [name, fetchImpl] of [
    ["HTTP 404", reply("nope", 404)],
    ["network error", async () => { throw new Error("offline"); }],
    ["invalid JSON", reply("{not json")],
    ["a body larger than the limit", reply(" ".repeat(MAX_MANIFEST_BYTES + 1))],
    ["a JSON array", reply("[]")],
  ]) {
    it(`falls through quietly on ${name}`, async () => {
      const out = await resolve({ fetchImpl });
      expect(out.manifest).toBeNull();
      expect(typeof out.reason).toBe("string");
    });
  }
});

describe("resolveManifest: the bundled manifest is only a fallback", () => {
  it("is used when the release manifest is unavailable and the bundled one is signed and not a placeholder", async () => {
    const bundled = signed();
    const out = await resolve({ bundled, fetchImpl: reply("nope", 404) });
    expect(out).toMatchObject({ source: "bundled", manifest: bundled });
  });
  it("is used when the release manifest fails verification", async () => {
    const bundled = signed();
    expect((await resolve({ bundled, fetchImpl: reply(signed({}, newKey())) })).source).toBe("bundled");
  });
  it("the placeholder is never used", async () => {
    expect((await resolve({ fetchImpl: reply("nope", 404) })).manifest).toBeNull();
  });
  it("a bundled manifest with a bad signature or another version is never used", async () => {
    const bad = signed(); bad.sha256 = "cd".repeat(32);
    expect((await resolve({ bundled: bad, fetchImpl: reply("nope", 404) })).manifest).toBeNull();
    expect((await resolve({ bundled: signed({ version: "0.0.9" }), fetchImpl: reply("nope", 404) })).manifest).toBeNull();
  });
  it("no bundled manifest at all is fine", async () => {
    expect((await resolve({ bundled: null, fetchImpl: reply("nope", 404) })).manifest).toBeNull();
  });
});
