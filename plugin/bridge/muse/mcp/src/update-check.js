import { readState, mergeState } from "./state.js";

export const LATEST_URL = "https://api.github.com/repos/qualixar/claude-bot-bridge/releases/latest";
export const HOW_TO_UPDATE = "claude plugin update bot-bridge@claude-bot-bridge or turn on auto-update in /plugin → Marketplaces";
const DAY_MS = 24 * 3600 * 1000;
const TIMEOUT_MS = 3000;

const disabled = (env) => ["1", "true"].includes(String(env?.CBB_NO_UPDATE_CHECK ?? ""));
const parse = (v) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v))?.slice(1).map(Number) ?? null;

/** Positive when a > b, negative when a < b, 0 when equal, NaN when either is not x.y.z. */
export function compareVersions(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return NaN;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

const fresh = (checkedAt, now) => Number.isFinite(Date.parse(checkedAt)) && now - Date.parse(checkedAt) < DAY_MS;

/**
 * At most once per 24 h: ask GitHub for the latest release and cache the tag in state.json.
 * Silent on every failure; a failed attempt still counts so the next try is a day away.
 * The only request is a GET with Accept and a generic User-Agent: no identifiers, no telemetry.
 */
export async function checkLatest({ dir, now = Date.now, fetchImpl = globalThis.fetch, env = process.env }) {
  if (disabled(env)) return;
  const prev = readState(dir).updateCheck ?? {};
  if (fresh(prev.checkedAt, now())) return;
  let latest = prev.latest;
  try {
    const res = await fetchImpl(LATEST_URL, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "claude-bot-bridge" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      const tag = (await res.json())?.tag_name;
      if (parse(tag)) latest = String(tag).replace(/^v/, "");
    }
  } catch { /* offline, timeout, rate limit: stay silent */ }
  mergeState(dir, { updateCheck: { checkedAt: new Date(now()).toISOString(), ...(latest ? { latest } : {}) } });
}

/** The `update_available` object for muse_status, from the cached check (no network). */
export function updateAvailable({ state, current, env = process.env }) {
  if (disabled(env)) return null;
  const latest = state?.updateCheck?.latest;
  if (!latest || !(compareVersions(latest, current) > 0)) return null;
  return { current, latest, how: HOW_TO_UPDATE };
}
