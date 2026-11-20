import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run as realRun } from "./exec.js";
import { bridgeDir, installScriptPath, resolveBinary } from "./binary.js";
import { updateBinary } from "./binary-update.js";
import { resolveManifest } from "./manifest-source.js";
import { RELEASE_PUBLIC_KEY_PEM } from "./release-key.js";
import { resolveKeyset } from "./keyset.js";
import { PLUGIN_VERSION } from "./version.js";
import { readState } from "./state.js";
import { checkLatest, updateAvailable } from "./update-check.js";
import { rulesDue, runRulesUpdate, unknownVersionTrigger } from "./rules-schedule.js";

const RETRY_AFTER_SECONDS = { downloading: 15, building: 180, waiting: 30 };
const BUSY_POLL_MS = 10_000;
const BUSY_POLLS = 120;
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;

const flag = (env, name) => ["1", "true"].includes(String(env?.[name] ?? ""));
const sleepReal = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function canBuildReal(run) { return (await run("xcode-select", ["-p"])).code === 0; }

/** A local `swift build` at session start needs consent: CBB_ALLOW_LOCAL_BUILD=1, or setup was run before
 *  (install.sh leaves `.setup-done`; an older install.sh run left its `build/` directory). */
export function localBuildAllowed(env, dir) {
  return flag(env, "CBB_ALLOW_LOCAL_BUILD") || fs.existsSync(path.join(dir, ".setup-done")) || fs.existsSync(path.join(dir, "build"));
}

/**
 * Keeps the bridge current without ever blocking a tool call for long:
 *  - start(): update the muse-ax binary, then refresh rules (daily), then check for a newer plugin release (daily).
 *    Run it without awaiting. The binary comes from the signed manifest attached to this plugin version's GitHub
 *    release (the bundled manifest only as a signed fallback); a local build happens only with consent, see localBuildAllowed.
 *  - gate(): an `updating` error while the binary is being replaced, else null.
 *  - after(cmd, result): for muse_status, adds update_available and refreshes rules at once for an unknown Muse version.
 * Network is limited to GitHub (raw rules, release manifest + download, releases API). Nothing identifying is sent.
 */
export function createManager(opts) {
  const { env = process.env, home = os.homedir(), manifest, now = Date.now, exec, run = realRun, sleep = sleepReal } = opts;
  const pubPem = opts.pubPem ?? RELEASE_PUBLIC_KEY_PEM;
  const pluginVersion = opts.pluginVersion ?? PLUGIN_VERSION;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const installScript = opts.installScript ?? installScriptPath(env);
  const canBuild = opts.canBuild ?? (() => canBuildReal(run));
  const buildFallback = opts.buildFallback ?? (async () => {
    const r = await run("sh", [installScript], { timeoutMs: BUILD_TIMEOUT_MS, env: { ...process.env, CBB_NO_SETUP_MARKER: "1" } });
    return { ok: r.code === 0, message: r.stderr.trim().split("\n").pop() };
  });
  const dir = bridgeDir(home, env);
  const pending = new Set();
  let stage = null;
  let failure = null;

  const track = (p) => { pending.add(p); p.finally(() => pending.delete(p)); return p; };
  const autoUpdate = () => !flag(env, "CBB_NO_AUTO_UPDATE");

  async function ensureBinary() {
    let out;
    for (let i = 0; i < BUSY_POLLS; i++) {
      out = await updateBinary({
        env, home, pubPem, fetchImpl, run, canBuild, buildFallback, installScript, now,
        targetVersion: pluginVersion,
        // The keyset says which keys may sign the manifest: the newest of the cached, bundled and GitHub copies (the winner is
        // remembered in <dir>/keys/current, so an older copy can never bring a revoked key back). Fetched only when a binary has
        // to be replaced.
        resolveKeyset: () => resolveKeyset({ pubPem, now: now(), fetchImpl, dir, ...(opts.bundledKeyset === undefined ? {} : { bundled: opts.bundledKeyset }) }),
        resolveManifest: (keyset) => resolveManifest({ bundled: manifest, pluginVersion, pubPem, keyset, now: now(), fetchImpl }),
        allowBuild: localBuildAllowed(env, dir),
        onPhase: (p) => { stage = p; },
      });
      if (out.action !== "busy") break;
      stage = "waiting";
      await sleep(BUSY_POLL_MS);
    }
    stage = null;
    failure = out.action === "failed" ? out.error : null;
  }

  async function backgroundChecks() {
    const found = resolveBinary({ env, home });
    if (autoUpdate() && found.ok && rulesDue(readState(dir), now())) await runRulesUpdate({ dir, bin: found.bin, exec, now });
    await checkLatest({ dir, now, fetchImpl, env });
  }

  async function start() {
    try {
      if (autoUpdate()) await ensureBinary();
      await backgroundChecks();
    } catch (e) {
      stage = null;
      process.stderr.write(`claude-bot-bridge: background update skipped (${e?.message ?? e})\n`);
    }
  }

  function gate() {
    if (!stage) return null;
    const retry = RETRY_AFTER_SECONDS[stage] ?? 30;
    return { ok: false, error: { code: "updating", retry_after_seconds: retry,
      message: `muse-ax is being updated (${stage}). Retry in about ${retry} seconds; do not loop.` } };
  }

  function after(cmd, result) {
    if (cmd !== "status" || !result?.ok) return result;
    const state = readState(dir);
    const version = autoUpdate() ? unknownVersionTrigger(state, result, now()) : null;
    const found = version ? resolveBinary({ env, home }) : null;
    if (found?.ok) track(runRulesUpdate({ dir, bin: found.bin, exec, now, forVersion: version }));
    const nudge = updateAvailable({ state, current: pluginVersion, env });
    return nudge ? { ...result, update_available: nudge } : result;
  }

  return { start, gate, after, failure: () => failure, idle: () => Promise.allSettled([...pending]) };
}
