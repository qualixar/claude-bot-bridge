import { runCli } from "./cli.js";
import { readState, mergeState } from "./state.js";

const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const age = (iso, now) => (Number.isFinite(Date.parse(iso)) ? now - Date.parse(iso) : Infinity);

/** Routine refresh: at most once per 24 h. */
export const rulesDue = (state, now) => age(state?.rulesUpdate?.checkedAt, now) >= DAY_MS;

/**
 * Immediate refresh when muse_status shows a Muse version the rules do not list (probe or unverified).
 * Returns that version, or null. Once per version, again after an hour so a fixed rules file is picked up.
 */
export function unknownVersionTrigger(state, status, now) {
  const version = status?.muse_version?.short;
  if (!status?.ok || !version || !["unverified", "probe"].includes(status.version_check)) return null;
  const r = state?.rulesUpdate ?? {};
  if (r.unknownVersion === version && age(r.unknownTriggeredAt, now) < HOUR_MS) return null;
  return version;
}

/** Runs `muse-ax rules update` and records the outcome in state.json. Never throws. */
export async function runRulesUpdate({ dir, bin, exec, now = Date.now, forVersion }) {
  const stamp = new Date(now()).toISOString();
  const record = (patch) => mergeState(dir, { rulesUpdate: { ...readState(dir).rulesUpdate, ...patch } });
  if (forVersion) record({ unknownVersion: forVersion, unknownTriggeredAt: stamp });
  const result = await runCli(["rules", "update"], { bin, timeoutMs: 45_000, exec });
  record({ checkedAt: stamp, reason: result.reason ?? result.error?.code ?? "error", updated: result.updated === true });
  return result;
}
