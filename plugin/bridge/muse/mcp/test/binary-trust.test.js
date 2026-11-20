// Binary manifests under the key hierarchy: a `binary` key named by key_id signs them; the root and the rules key do not.
import { describe, it, expect, afterEach } from "vitest";
import { updateBinary, installedVersion } from "../src/binary-update.js";
import { resolveManifest } from "../src/manifest-source.js";
import { verifyKeyset } from "../src/keyset.js";
import { installedBinPath } from "../src/binary.js";
import { tmp, release, hierarchy, signManifest, run as realRun } from "./helpers.js";

const open = [];
afterEach(async () => { while (open.length) await open.pop().close(); });

async function rig({ signer = "binary", keyId = "binary-1", h = hierarchy(), keysetState } = {}) {
  const key = h[signer];
  const r = await release({ version: "9.9.9", key, tamper: { pre: keyId === null ? {} : { key_id: keyId } } });
  open.push(r);
  const keyset = keysetState ?? verifyKeyset({ json: h.json, signature: h.signature, pubPem: h.root.pubPem, now: h.now });
  const home = tmp("home");
  const deps = { home, env: {}, now: () => h.now, run: realRun, canBuild: async () => false, buildFallback: async () => ({ ok: false }), installScript: "x", allowBuild: false,
    manifest: r.manifest, pubPem: h.root.pubPem, keyset };
  return { r, h, deps, bin: installedBinPath(home), keyset };
}
const version = (bin) => installedVersion(bin, realRun);

describe("updateBinary with a keyset", () => {
  it("installs a manifest signed by the binary key that names itself", async () => {
    const t = await rig();
    expect(await updateBinary(t.deps)).toMatchObject({ action: "installed", version: "9.9.9" });
    expect(await version(t.bin)).toBe("9.9.9");
  });
  it("refuses a manifest signed by the RULES key, even when it names a valid rules key", async () => {
    const t = await rig({ signer: "rules", keyId: "rules-1" });
    const out = await updateBinary(t.deps);
    expect(out.action).toBe("failed");
    expect(out.error.message).toMatch(/not trusted \(key_wrong_use\)/);
    expect(await version(t.bin)).toBeNull();
  });
  it("refuses a manifest signed by the root once a keyset exists (the root signs keysets, nothing else)", async () => {
    const t = await rig({ signer: "root", keyId: null });
    const out = await updateBinary(t.deps);
    expect(out.action).toBe("failed");
    expect(out.error.message).toMatch(/key_id_required/);
  });
  it("refuses a revoked binary key and an unknown key id", async () => {
    const rev = await rig({ h: hierarchy({ revoked: ["binary-1"] }) });
    expect((await updateBinary(rev.deps)).error.message).toMatch(/key_revoked/);
    const unk = await rig({ keyId: "binary-7" });
    expect((await updateBinary(unk.deps)).error.message).toMatch(/key_unknown/);
  });
  it("refuses a manifest whose key_id was changed after signing", async () => {
    const t = await rig();
    const { signature: _s, key_id: _k, ...rest } = t.r.manifest;
    const swapped = { ...t.r.manifest, key_id: "rules-1" };
    expect((await updateBinary({ ...t.deps, manifest: swapped })).action).toBe("failed");
    expect(signManifest(rest, t.h.binary.privateKey).signature).not.toBe(t.r.manifest.signature);
  });
  it("without any keyset even a root-signed manifest is refused (there is no compatibility path any more)", async () => {
    const t = await rig({ signer: "root", keyId: null, keysetState: { state: "absent" } });
    const out = await updateBinary(t.deps);
    expect(out.action).toBe("failed");
    expect(out.error.message).toMatch(/key_id_required/);
    expect(await version(t.bin)).toBeNull();
  });
  it("an expired keyset refuses every manifest with a clear message, even one signed by a listed binary key", async () => {
    const h = hierarchy({ keysetNotAfter: "2027-01-01T00:00:00Z", issuedAt: Date.parse("2026-01-01T00:00:00Z") });
    const keysetState = verifyKeyset({ json: h.json, signature: h.signature, pubPem: h.root.pubPem, now: h.now });
    expect(keysetState.state).toBe("expired");
    const t = await rig({ h, keysetState });
    const out = await updateBinary(t.deps);
    expect(out.action).toBe("failed");
    expect(out.error.message).toMatch(/keyset expired/);
    expect(await version(t.bin)).toBeNull();
  });
  it("resolves the keyset lazily, only when a binary has to be replaced", async () => {
    const t = await rig();
    let asked = 0;
    const { keyset, ...rest } = t.deps;
    const out = await updateBinary({ ...rest, resolveKeyset: async () => { asked += 1; return keyset; } });
    expect(out.action).toBe("installed"); expect(asked).toBe(1);
    asked = 0;
    expect((await updateBinary({ ...rest, resolveKeyset: async () => { asked += 1; return keyset; } })).action).toBe("current");
    expect(asked).toBe(0);
  });
});

describe("resolveManifest with a keyset", () => {
  it("names the untrusted-key reason when the release manifest is signed with the wrong kind of key", async () => {
    const t = await rig({ signer: "rules", keyId: "rules-1" });
    const out = await resolveManifest({ bundled: null, pluginVersion: "9.9.9", pubPem: t.h.root.pubPem, keyset: t.keyset, now: t.h.now, fetchImpl: async () => new Response(JSON.stringify(t.r.manifest)) });
    expect(out.manifest).toBeNull();
    expect(out.reason).toMatch(/signing key is not trusted \(key_wrong_use\)/);
  });
  it("accepts a binary-key manifest from the release URL", async () => {
    const t = await rig();
    const out = await resolveManifest({ bundled: null, pluginVersion: "9.9.9", pubPem: t.h.root.pubPem, keyset: t.keyset, now: t.h.now, fetchImpl: async () => new Response(JSON.stringify(t.r.manifest)) });
    expect(out.source).toBe("release");
  });
});
