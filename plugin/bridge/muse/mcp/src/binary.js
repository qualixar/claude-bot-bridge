import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Environment variable that overrides the muse-ax binary location. */
export const BIN_ENV = "CBB_MUSE_AX";

/** Directory holding bin/, rules/ and state.json: $CBB_HOME, else ~/.claude-bot-bridge. */
export const bridgeDir = (home = os.homedir(), env = {}) => (env.CBB_HOME ? env.CBB_HOME : path.join(home, ".claude-bot-bridge"));

export const installedBinPath = (home = os.homedir(), env = {}) => path.join(bridgeDir(home, env), "bin", "muse-ax");

/** Where install.sh lives: CLAUDE_PLUGIN_ROOT when the plugin host sets it, else relative to this file (plugin/bridge/muse/mcp/<src|dist>). */
export function installScriptPath(env = process.env, here = path.dirname(new URL(import.meta.url).pathname)) {
  const root = env.CLAUDE_PLUGIN_ROOT || path.resolve(here, "../../../..");
  return path.join(root, "scripts", "install.sh");
}

export function isExecutableFile(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

const missing = (message) => ({ ok: false, error: { code: "binary_missing", message } });

/**
 * Finds the muse-ax binary: $CBB_MUSE_AX, then ~/.claude-bot-bridge/bin/muse-ax.
 * A set-but-broken $CBB_MUSE_AX is an error (never silently replaced by the default).
 * Pure apart from the injected isExecutable check.
 */
export function resolveBinary({ env = process.env, home = os.homedir(), isExecutable = isExecutableFile, here } = {}) {
  const override = env[BIN_ENV];
  if (override) {
    return isExecutable(override)
      ? { ok: true, bin: override, source: "env" }
      : missing(`${BIN_ENV} points to ${override}, which is not an executable file. Fix or unset ${BIN_ENV}.`);
  }
  const def = installedBinPath(home, env);
  if (isExecutable(def)) return { ok: true, bin: def, source: "default" };
  return missing(`muse-ax is not installed (looked in ${def}). Fix: run ${installScriptPath(env, here)} (or /bot-bridge:setup), then retry.`);
}
