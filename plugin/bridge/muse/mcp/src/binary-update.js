import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { bridgeDir, installedBinPath, isExecutableFile } from "./binary.js";
import { verifyManifestWithTrust } from "./keyset.js";
import { readState, mergeState } from "./state.js";
import { acquireLockFile, pidAlive } from "./lock.js";
import { readCapped, TooLargeError } from "./net.js";

const DAY_MS = 24 * 3600 * 1000;
const LOCK_STALE_MS = 20 * 60 * 1000;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const BINARY_NAME = "muse-ax";

export class UpdateError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const oneLine = (s) => String(s).replace(/\s+/g, " ").trim().slice(0, 300);

/** True when the manifest describes a real release (not the placeholder shipped before the first release). */
export function isReleased(m) {
  const sig = m?.signature;
  return /^[0-9a-f]{64}$/.test(m?.sha256 ?? "") && typeof sig === "string" && sig.length > 0 && !sig.startsWith("<") && typeof m?.url === "string";
}

export function manifestPath(env = process.env, here = path.dirname(new URL(import.meta.url).pathname)) {
  const root = env.CLAUDE_PLUGIN_ROOT ? path.join(env.CLAUDE_PLUGIN_ROOT, "bridge", "muse") : path.resolve(here, "../..");
  return path.join(root, "binary-manifest.json");
}

export function loadManifest(file) {
  try {
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof m?.version === "string" && typeof m?.url === "string" ? m : null;
  } catch { return null; }
}

/** `muse-ax version` -> version string, or null when the binary is missing, too old to know the command, or broken. */
export async function installedVersion(bin, run) {
  const r = await run(bin, ["version"], { timeoutMs: 10_000 });
  if (r.code !== 0) return null;
  try { const v = JSON.parse(r.stdout.trim().split("\n").pop()).version; return typeof v === "string" ? v : null; } catch { return null; }
}

const LOCK_NAME = ".update.lock";

export { pidAlive };

/** The update lock in `binDir` (see lock.js). */
export function acquireLock(binDir, { nowMs = Date.now(), isAlive = pidAlive, staleMs = LOCK_STALE_MS } = {}) {
  return acquireLockFile(path.join(binDir, LOCK_NAME), { nowMs, isAlive, staleMs });
}

function assertDownloadUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new UpdateError("bad_url", "the manifest url is not a valid URL"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new UpdateError("bad_url", "the manifest url must be https");
}

/** The archive, read with the size cap enforced while it streams (readCapped): an oversized or endless response is cut off. */
async function download(url, fetchImpl, maxBytes) {
  let res;
  try { res = await fetchImpl(url, { signal: AbortSignal.timeout(120_000), redirect: "follow" }); } catch (e) {
    throw new UpdateError("download_failed", `download failed (${oneLine(e.message)})`);
  }
  if (!res.ok) throw new UpdateError("download_failed", `download failed (HTTP ${res.status})`);
  try { return await readCapped(res, maxBytes); } catch (e) {
    if (e instanceof TooLargeError) throw new UpdateError("download_failed", "download is larger than expected");
    throw new UpdateError("download_failed", `download failed (${oneLine(e?.message ?? e)})`);
  }
}

/** Unpacks the archive into `into` and returns the path of the binary. Exactly one entry, named muse-ax: an AppleDouble
 *  `._*` entry or anything else makes the archive unacceptable. */
async function extract(archive, into, run) {
  const listing = await run("tar", ["-tzf", archive]);
  const entries = listing.stdout.split("\n").map((e) => e.trim().replace(/^\.\//, "")).filter(Boolean);
  if (listing.code !== 0 || entries.length !== 1 || entries[0] !== BINARY_NAME) {
    throw new UpdateError("bad_archive", `the archive must contain exactly one file named ${BINARY_NAME} and nothing else`);
  }
  const x = await run("tar", ["-xzf", archive, "-C", into]);
  const out = path.join(into, BINARY_NAME);
  if (x.code !== 0 || !fs.lstatSync(out, { throwIfNoEntry: false })?.isFile()) throw new UpdateError("bad_archive", "could not unpack the archive");
  return out;
}

/** An unsigned binary is fine (sha256 and the manifest signature already vouch for it); a signed-but-broken one is not,
 *  and neither is a codesign that could not run at all (that proves nothing). */
async function checkCodeSignature(file, run) {
  const r = await run("codesign", ["--verify", "--strict", file]);
  if (r.code === 0) return;
  if (r.code === -1) throw new UpdateError("codesign_failed", `could not run codesign to check the binary (${oneLine(r.stderr)})`);
  if (/not signed at all/i.test(r.stderr)) return;
  throw new UpdateError("codesign_failed", `code signature check failed (${oneLine(r.stderr)})`);
}

/** Keeps the current binary as muse-ax.prev, then swaps the staged one in with a single rename. */
async function swapIn(staged, bin) {
  if (fs.existsSync(bin)) {
    const prevTmp = `${bin}.prev.tmp.${process.pid}`;
    await fsp.copyFile(bin, prevTmp);
    await fsp.rename(prevTmp, `${bin}.prev`);
  }
  await fsp.rename(staged, bin);
}

/** The user-facing reason a manifest was refused; an expired keyset gets its own clear message. */
export function untrustedMessage(reason) {
  if (reason === "bad_signature") return "the release manifest signature does not verify";
  if (reason === "keyset_expired") return "the key list (keys/keyset.json) has expired, so no release can be trusted until a newer one is published (keyset expired); update the plugin or wait for the maintainer to renew it";
  return `the release manifest is signed with a key that is not trusted (${reason})`;
}

async function installPrebuilt({ manifest, pubPem, keyset, now, fetchImpl, run, bin, dir, maxArchiveBytes = MAX_ARCHIVE_BYTES }) {
  const trusted = verifyManifestWithTrust(manifest, { pubPem, keyset, now: now() });
  if (!trusted.ok) throw new UpdateError("bad_manifest_signature", untrustedMessage(trusted.reason));
  assertDownloadUrl(manifest.url);
  const buf = await download(manifest.url, fetchImpl, maxArchiveBytes);
  if (crypto.createHash("sha256").update(buf).digest("hex") !== manifest.sha256) throw new UpdateError("sha256_mismatch", "the download does not match the manifest sha256");
  const work = await fsp.mkdtemp(await tempRoot(dir));
  const staged = `${bin}.new.${process.pid}`;
  try {
    const archive = path.join(work, "archive.tar.gz");
    await fsp.writeFile(archive, buf);
    const unpacked = await extract(archive, work, run);
    await checkCodeSignature(unpacked, run);
    await fsp.mkdir(path.dirname(bin), { recursive: true });
    await fsp.copyFile(unpacked, staged);
    await fsp.chmod(staged, 0o755);
    if ((await installedVersion(staged, run)) !== manifest.version) throw new UpdateError("version_mismatch", "the downloaded binary does not report the manifest version");
    await swapIn(staged, bin);
  } finally {
    await fsp.rm(staged, { force: true });
    await fsp.rm(work, { recursive: true, force: true });
  }
}

async function tempRoot(dir) {
  const root = path.join(dir, "tmp");
  await fsp.mkdir(root, { recursive: true });
  return path.join(root, "update-");
}

const asUpdateError = (e) => (e instanceof UpdateError ? e : new UpdateError("update_failed", oneLine(e?.message ?? e)));

const SETUP_COMMAND = "/bot-bridge:setup";

function failureMessage(version, reason, build, installScript) {
  const buildPart = build.message ? ` The local build also failed (${oneLine(build.message)}).` : "";
  let tail;
  if (build.tried) tail = `Run ${installScript} to see the build output, then retry.`;
  else if (build.skipped === "no_consent") tail = `Run ${SETUP_COMMAND} (or: sh ${installScript}) to build it on this Mac.`;
  else tail = `Install the Xcode Command Line Tools ("xcode-select --install"), then run ${SETUP_COMMAND} (or: sh ${installScript}) and retry.`;
  return oneLine(`muse-ax ${version} could not be installed automatically (${reason.message}).${buildPart} ${tail}`);
}

/** After a failed download/verify: build locally with install.sh, but only with consent (allowBuild) and when the tools exist. */
async function buildInstead(o, reason) {
  const { version, bin, dir, run, canBuild, buildFallback, installScript, onPhase, now, allowBuild } = o;
  const build = { tried: false, message: "", skipped: null };
  if (!allowBuild) build.skipped = "no_consent";
  else if (await canBuild()) {
    build.tried = true;
    onPhase("building");
    const b = await buildFallback();
    if (b.ok) {
      const v = await installedVersion(bin, run);
      mergeState(dir, { binaryUpdate: v === version ? null : failureRecord(version, now, "built version differs from the plugin version") });
      return { action: "built", version: v };
    }
    build.message = b.message ?? "build failed";
  }
  const error = { code: reason.code, message: failureMessage(version, reason, build, installScript) };
  mergeState(dir, { binaryUpdate: failureRecord(version, now, error.message) });
  return { action: "failed", error };
}

const failureRecord = (version, now, reason) => ({ failedVersion: version, failedAt: new Date(now()).toISOString(), reason });

/** The manifest handed in, else the one the resolver finds (release asset first, then a signed bundled one). */
async function obtainManifest(o) {
  if (o.manifest) return o.manifest;
  const r = await o.resolveManifest(o.keyset);
  if (!r?.manifest) throw new UpdateError("not_released", r?.reason ?? "no signed release manifest is available");
  return r.manifest;
}

async function replaceBinary(o) {
  o.onPhase("downloading");
  try {
    // The keyset is only needed (and only fetched) when a binary really has to be replaced.
    if (!o.keyset && o.resolveKeyset) o = { ...o, keyset: await o.resolveKeyset() };
    const manifest = await obtainManifest(o);
    if (!isReleased(manifest)) throw new UpdateError("not_released", "no prebuilt binary has been published for this version yet");
    if (manifest.version !== o.version) throw new UpdateError("version_mismatch", `the manifest is for ${manifest.version}, not ${o.version}`);
    await installPrebuilt({ ...o, manifest });
    mergeState(o.dir, { binaryUpdate: null });
    return { action: "installed", version: o.version };
  } catch (e) {
    return buildInstead(o, asUpdateError(e));
  }
}

const recentFailure = (state, version, nowMs) => {
  const f = state.binaryUpdate;
  return f?.failedVersion === version && nowMs - Date.parse(f.failedAt) < DAY_MS;
};

/**
 * Brings ~/.claude-bot-bridge/bin/muse-ax to the target version (deps.targetVersion, else manifest.version). Returns
 * { action: "current" | "installed" | "built" | "skipped" | "busy" | "failed", ... }; never throws.
 * deps: home, env, manifest | resolveManifest (async -> { manifest, reason }), targetVersion, pubPem, fetchImpl, run,
 * keyset | resolveKeyset (state from keyset.js; anything but "valid" refuses every manifest), maxArchiveBytes (download cap, default 64 MiB), allowBuild (false unless the user consented to a local build), canBuild, buildFallback, installScript, now, onPhase, force, isPidAlive.
 * A failed version is not retried for 24 h only while a WORKING binary is installed; with none, every start retries.
 */
export async function updateBinary(deps) {
  const o = { env: {}, now: Date.now, onPhase: () => {}, force: false, allowBuild: false, fetchImpl: globalThis.fetch, ...deps };
  o.version = o.targetVersion ?? o.manifest?.version;
  if (o.env.CBB_MUSE_AX) return { action: "skipped", reason: "env_override" };
  o.dir = bridgeDir(o.home, o.env);
  o.bin = installedBinPath(o.home, o.env);
  const current = isExecutableFile(o.bin) ? await installedVersion(o.bin, o.run) : null;
  if (current === o.version) return { action: "current", version: current };
  if (!o.force && current !== null && recentFailure(readState(o.dir), o.version, o.now())) return { action: "skipped", reason: "recent_failure" };
  const lock = acquireLock(path.dirname(o.bin), { nowMs: o.now(), isAlive: o.isPidAlive });
  if (!lock) return { action: "busy" };
  try { return await replaceBinary(o); } catch (e) {
    return { action: "failed", error: { code: "update_failed", message: oneLine(e?.message ?? e) } };
  } finally { lock.release(); }
}
