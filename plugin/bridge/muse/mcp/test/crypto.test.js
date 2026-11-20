import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { canonicalManifest, verifyDetached, verifyManifest, sha256File } from "../src/crypto.js";
import { RELEASE_PUBLIC_KEY_PEM } from "../src/release-key.js";
import { newKey, signB64, signManifest, tmp } from "./helpers.js";
import path from "node:path";

describe("canonicalManifest", () => {
  it("sorts keys, drops the signature, is compact", () => {
    const m = { version: "1.0.0", url: "https://x/y", sha256: "ab", signature: "zzz" };
    expect(canonicalManifest(m)).toBe('{"sha256":"ab","url":"https://x/y","version":"1.0.0"}');
  });
  it("does not depend on input key order", () => {
    expect(canonicalManifest({ b: 1, a: 2 })).toBe(canonicalManifest({ a: 2, b: 1 }));
  });
});

describe("verifyDetached / verifyManifest", () => {
  const k = newKey();
  it("accepts a valid signature", () => {
    expect(verifyDetached(k.pubPem, "hello", signB64(k.privateKey, "hello"))).toBe(true);
  });
  it("rejects tampered data, wrong key, garbage and empty signatures without throwing", () => {
    const sig = signB64(k.privateKey, "hello");
    expect(verifyDetached(k.pubPem, "hellO", sig)).toBe(false);
    expect(verifyDetached(newKey().pubPem, "hello", sig)).toBe(false);
    expect(verifyDetached(k.pubPem, "hello", "%%%not base64")).toBe(false);
    expect(verifyDetached(k.pubPem, "hello", "")).toBe(false);
    expect(verifyDetached("not a pem", "hello", sig)).toBe(false);
  });
  it("verifies a signed manifest and rejects any edited field", () => {
    const m = signManifest({ version: "1.0.0", url: "https://x/y", sha256: "ab" }, k.privateKey);
    expect(verifyManifest(m, k.pubPem)).toBe(true);
    expect(verifyManifest({ ...m, url: "https://evil/y" }, k.pubPem)).toBe(false);
    expect(verifyManifest({ ...m, version: "1.0.1" }, k.pubPem)).toBe(false);
    expect(verifyManifest({ ...m, signature: undefined }, k.pubPem)).toBe(false);
  });
});

describe("release key", () => {
  it("is the root key published in keys/root-public.pem, and is neither the rules key nor the binary key", () => {
    const pem = (f) => fs.readFileSync(new URL(`../../../../../keys/${f}`, import.meta.url), "utf8").trim();
    expect(RELEASE_PUBLIC_KEY_PEM.trim()).toBe(pem("root-public.pem"));
    expect(pem("rules-public.pem")).not.toBe(pem("root-public.pem"));
    expect(pem("binary-public.pem")).not.toBe(pem("root-public.pem"));
    expect(pem("binary-public.pem")).not.toBe(pem("rules-public.pem"));
  });
  it("is the published key in plugin/release-signing-public.pem", () => {
    const pem = fs.readFileSync(new URL("../../../../release-signing-public.pem", import.meta.url), "utf8");
    expect(RELEASE_PUBLIC_KEY_PEM.trim()).toBe(pem.trim());
  });
});

describe("sha256File", () => {
  it("hashes file content", async () => {
    const f = path.join(tmp(), "a"); fs.writeFileSync(f, "abc");
    expect(await sha256File(f)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
