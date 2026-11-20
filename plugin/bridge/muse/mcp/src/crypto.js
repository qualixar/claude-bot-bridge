import crypto from "node:crypto";
import fs from "node:fs";

/** The bytes that get signed: the manifest without `signature`, keys sorted, compact JSON.
 *  Equivalent to `jq -S -c 'del(.signature)'` as used by the release workflow. */
export function canonicalManifest(manifest) {
  const { signature: _signature, ...rest } = manifest;
  const sorted = Object.fromEntries(Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return JSON.stringify(sorted);
}

/** True only for a valid detached Ed25519 signature (base64) over `data`. Never throws. */
export function verifyDetached(pubPem, data, signatureB64) {
  try {
    if (typeof signatureB64 !== "string" || signatureB64.trim() === "") return false;
    const sig = Buffer.from(signatureB64.trim(), "base64");
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.from(data), crypto.createPublicKey(pubPem), sig);
  } catch { return false; }
}

export const verifyManifest = (manifest, pubPem) => verifyDetached(pubPem, canonicalManifest(manifest), manifest?.signature);

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (c) => h.update(c)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}
