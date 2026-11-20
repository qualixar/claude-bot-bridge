import { describe, it, expect } from "vitest";
import { rulesDue, unknownVersionTrigger, runRulesUpdate } from "../src/rules-schedule.js";
import { readState, mergeState } from "../src/state.js";
import { tmp } from "./helpers.js";

const NOW = Date.UTC(2026, 10, 20, 12);
const iso = (ms) => new Date(ms).toISOString();

describe("rulesDue", () => {
  it("is due with no record, or after 24 h", () => {
    expect(rulesDue({}, NOW)).toBe(true);
    expect(rulesDue({ rulesUpdate: { checkedAt: iso(NOW - 25 * 3600e3) } }, NOW)).toBe(true);
    expect(rulesDue({ rulesUpdate: { checkedAt: iso(NOW - 23 * 3600e3) } }, NOW)).toBe(false);
    expect(rulesDue({ rulesUpdate: { checkedAt: "garbage" } }, NOW)).toBe(true);
  });
});

describe("unknownVersionTrigger", () => {
  const status = (check, short = "14.0") => ({ ok: true, version_check: check, muse_version: { short } });
  it("fires for an unverified or probe-mode Muse version", () => {
    expect(unknownVersionTrigger({}, status("unverified"), NOW)).toBe("14.0");
    expect(unknownVersionTrigger({}, status("probe"), NOW)).toBe("14.0");
  });
  it("does not fire for verified versions, failures or missing fields", () => {
    expect(unknownVersionTrigger({}, status("verified"), NOW)).toBeNull();
    expect(unknownVersionTrigger({}, { ok: false, error: {} }, NOW)).toBeNull();
    expect(unknownVersionTrigger({}, { ok: true, running: false }, NOW)).toBeNull();
    expect(unknownVersionTrigger({}, status("unknown", null), NOW)).toBeNull();
  });
  it("fires once per version, and again after an hour", () => {
    const state = { rulesUpdate: { unknownVersion: "14.0", unknownTriggeredAt: iso(NOW - 10 * 60e3) } };
    expect(unknownVersionTrigger(state, status("probe"), NOW)).toBeNull();
    expect(unknownVersionTrigger(state, status("probe"), NOW + 61 * 60e3)).toBe("14.0");
    expect(unknownVersionTrigger(state, status("probe", "14.1"), NOW)).toBe("14.1");
  });
});

describe("runRulesUpdate", () => {
  it("runs `rules update`, records the outcome, and never throws", async () => {
    const dir = tmp(); let args;
    const exec = (bin, a, o, cb) => { args = a; cb(null, '{"ok":true,"updated":true,"reason":"updated","revision":3}'); };
    const r = await runRulesUpdate({ dir, bin: "/x/muse-ax", exec, now: () => NOW });
    expect(args).toEqual(["rules", "update"]);
    expect(r.updated).toBe(true);
    expect(readState(dir).rulesUpdate).toMatchObject({ checkedAt: iso(NOW), reason: "updated", updated: true });
  });
  it("keeps the unknown-version bookkeeping when called for a version", async () => {
    const dir = tmp(); mergeState(dir, { rulesUpdate: { checkedAt: iso(NOW - 99 * 3600e3) } });
    const exec = (b, a, o, cb) => cb(null, '{"ok":true,"updated":false,"reason":"network_error"}');
    await runRulesUpdate({ dir, bin: "x", exec, now: () => NOW, forVersion: "14.0" });
    expect(readState(dir).rulesUpdate).toMatchObject({ unknownVersion: "14.0", unknownTriggeredAt: iso(NOW), reason: "network_error" });
  });
  it("survives a crashing binary", async () => {
    const dir = tmp();
    const exec = (b, a, o, cb) => cb(new Error("boom"), "");
    const r = await runRulesUpdate({ dir, bin: "x", exec, now: () => NOW });
    expect(r.ok).toBe(false);
    expect(readState(dir).rulesUpdate.checkedAt).toBe(iso(NOW));
  });
});
