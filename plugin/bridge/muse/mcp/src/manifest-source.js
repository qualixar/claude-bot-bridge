import { verifyManifestWithTrust } from "./keyset.js";
import { isReleased } from "./binary-update.js";
import { readCapped, TooLargeError } from "./net.js";

export const RELEASE_BASE = "https://github.com/qualixar/claude-bot-bridge/releases/download";
export const MAX_MANIFEST_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

/** Where the release workflow publishes the signed manifest of one version. */
export const manifestUrl = (version) => `${RELEASE_BASE}/v${version}/binary-manifest.json`;

const oneLine = (s) => String(s).replace(/\s+/g, " ").trim().slice(0, 200);

/** Why a manifest cannot be used for `pluginVersion`, or null when it can. Needs the embedded root key and the keyset
 *  (a `binary` key named by the manifest's key_id; a manifest without a key_id is never accepted). */
function problem(m, { pluginVersion, pubPem, keyset, now }) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return "not a manifest";
  if (m.version !== pluginVersion) return `its version (${oneLine(m.version)}) is not the plugin version (${pluginVersion})`;
  if (!isReleased(m)) return "it is a placeholder, not a release";
  const v = verifyManifestWithTrust(m, { pubPem, keyset, now });
  if (!v.ok) return v.reason === "bad_signature" ? "its signature does not verify" : v.reason === "keyset_expired" ? "the keyset expired (keyset expired)" : `its signing key is not trusted (${v.reason})`;
  return null;
}

async function fetchRelease({ url, fetchImpl }) {
  let res;
  try { res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" }); } catch (e) {
    return { error: `could not fetch it (${oneLine(e?.message ?? e)})` };
  }
  if (!res.ok) return { error: `HTTP ${res.status}` };
  let text;
  try { text = (await readCapped(res, MAX_MANIFEST_BYTES)).toString("utf8"); } catch (e) {
    return { error: e instanceof TooLargeError ? "it is larger than expected" : `could not read it (${oneLine(e?.message ?? e)})` };
  }
  try { return { manifest: JSON.parse(text) }; } catch { return { error: "it is not valid JSON" }; }
}

/**
 * The manifest to install `pluginVersion` from: the signed binary-manifest.json attached to that version's GitHub
 * release, else the bundled manifest, but only when that one is signed, not a placeholder and for the same version.
 * Both are checked against the embedded root key through the keyset (see keyset.js). Returns { manifest, source: "release" | "bundled" } or
 * { manifest: null, reason }. Never throws.
 */
export async function resolveManifest({ bundled, pluginVersion, pubPem, keyset, now = Date.now(), fetchImpl = globalThis.fetch, url = manifestUrl(pluginVersion) }) {
  const ctx = { pluginVersion, pubPem, keyset, now };
  const remote = await fetchRelease({ url, fetchImpl });
  const remoteWhy = remote.error ?? problem(remote.manifest, ctx);
  if (!remoteWhy) return { manifest: remote.manifest, source: "release" };
  const bundledWhy = bundled ? problem(bundled, ctx) : "none is bundled";
  if (!bundledWhy) return { manifest: bundled, source: "bundled" };
  return { manifest: null, reason: `no usable signed manifest for ${pluginVersion}: the release manifest failed (${remoteWhy}); the bundled one failed (${bundledWhy})` };
}
