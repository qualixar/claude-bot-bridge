import { describe, it, expect } from "vitest";
import { compareVersions, checkLatest, updateAvailable, HOW_TO_UPDATE, LATEST_URL } from "../src/update-check.js";
import { tmp } from "./helpers.js";
import { readState, mergeState } from "../src/state.js";

const NOW = Date.UTC(2026, 10, 20, 12);
const api = (tag, extra = {}) => async (url, opts) => ({ ok: true, status: 200, json: async () => ({ tag_name: tag, ...extra }), url, opts });

describe("compareVersions", () => {
  it("orders semver triples numerically", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.1.0", "0.1.1")).toBeLessThan(0);
  });
  it("returns NaN for non-versions", () => {
    expect(compareVersions("latest", "1.0.0")).toBeNaN();
  });
});

describe("checkLatest", () => {
  it("fetches the GitHub latest release with a short timeout and caches it", async () => {
    const dir = tmp(); let seen;
    const f = async (url, opts) => { seen = { url, opts }; return api("v0.3.0")(url, opts); };
    await checkLatest({ dir, now: () => NOW, fetchImpl: f, env: {} });
    expect(seen.url).toBe(LATEST_URL);
    expect(LATEST_URL).toBe("https://api.github.com/repos/qualixar/claude-bot-bridge/releases/latest");
    expect(seen.opts.signal).toBeDefined();
    expect(Object.keys(seen.opts.headers).sort()).toEqual(["Accept", "User-Agent"]);
    expect(seen.opts.headers["User-Agent"]).toBe("claude-bot-bridge");
    expect(readState(dir).updateCheck).toEqual({ checkedAt: new Date(NOW).toISOString(), latest: "0.3.0" });
  });
  it("is silent on failure but still counts as a check (once per 24 h)", async () => {
    const dir = tmp();
    mergeState(dir, { updateCheck: { latest: "0.2.0", checkedAt: new Date(NOW - 48 * 3600e3).toISOString() } });
    await checkLatest({ dir, now: () => NOW, fetchImpl: async () => { throw new Error("offline"); }, env: {} });
    expect(readState(dir).updateCheck).toEqual({ checkedAt: new Date(NOW).toISOString(), latest: "0.2.0" });
  });
  it("does not fetch again within 24 h", async () => {
    const dir = tmp(); let calls = 0;
    const f = async (...a) => { calls += 1; return api("v0.3.0")(...a); };
    await checkLatest({ dir, now: () => NOW, fetchImpl: f, env: {} });
    await checkLatest({ dir, now: () => NOW + 23 * 3600e3, fetchImpl: f, env: {} });
    expect(calls).toBe(1);
    await checkLatest({ dir, now: () => NOW + 25 * 3600e3, fetchImpl: f, env: {} });
    expect(calls).toBe(2);
  });
  it("CBB_NO_UPDATE_CHECK=1 disables it", async () => {
    const dir = tmp(); let calls = 0;
    await checkLatest({ dir, now: () => NOW, fetchImpl: async () => { calls += 1; return api("v9.0.0")(); }, env: { CBB_NO_UPDATE_CHECK: "1" } });
    expect(calls).toBe(0);
    expect(readState(dir).updateCheck).toBeUndefined();
  });
  it("ignores HTTP errors and malformed tags", async () => {
    const dir = tmp();
    await checkLatest({ dir, now: () => NOW, fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }), env: {} });
    expect(readState(dir).updateCheck.latest).toBeUndefined();
    const dir2 = tmp();
    await checkLatest({ dir: dir2, now: () => NOW, fetchImpl: api("nightly"), env: {} });
    expect(readState(dir2).updateCheck.latest).toBeUndefined();
  });
});

describe("updateAvailable", () => {
  it("is null without a cached release or when current is the latest", () => {
    expect(updateAvailable({ state: {}, current: "0.1.0", env: {} })).toBeNull();
    expect(updateAvailable({ state: { updateCheck: { latest: "0.1.0" } }, current: "0.1.0", env: {} })).toBeNull();
    expect(updateAvailable({ state: { updateCheck: { latest: "0.0.9" } }, current: "0.1.0", env: {} })).toBeNull();
  });
  it("describes the newer release and how to update", () => {
    expect(updateAvailable({ state: { updateCheck: { latest: "0.2.0" } }, current: "0.1.0", env: {} })).toEqual({
      current: "0.1.0", latest: "0.2.0",
      how: "claude plugin update bot-bridge@claude-bot-bridge or turn on auto-update in /plugin → Marketplaces",
    });
    expect(HOW_TO_UPDATE).toContain("claude plugin update bot-bridge@claude-bot-bridge");
  });
  it("is hidden when the check is disabled", () => {
    expect(updateAvailable({ state: { updateCheck: { latest: "0.2.0" } }, current: "0.1.0", env: { CBB_NO_UPDATE_CHECK: "1" } })).toBeNull();
  });
});
