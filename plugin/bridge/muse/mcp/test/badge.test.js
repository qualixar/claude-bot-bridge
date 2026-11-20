// plugin/scripts/badge.mjs: rules/muse.json -> docs/badges/muse-verified.json (shields.io endpoint format).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmp } from "./helpers.js";
import { verifiedMessage, badgeFor, specLabel } from "../../../../scripts/badge.mjs";

const SCRIPT = new URL("../../../../scripts/badge.mjs", import.meta.url).pathname;
const REPO = new URL("../../../../../", import.meta.url).pathname;
const rules = (...specs) => ({ profiles: specs.map((v, i) => ({ id: `p${i}`, match: { versions: Array.isArray(v) ? v : [v] } })) });
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

describe("specLabel", () => {
  it("shows a bare version as it is and a one-minor range as that minor", () => {
    expect(specLabel("12.1")).toBe("12.1");
    expect(specLabel(">=13.1 <13.2")).toBe("13.1");
    expect(specLabel(">=13.1 <14")).toBe("13.1+");
    expect(specLabel(">=13.1")).toBe("13.1+");
    expect(specLabel(">=12.0 <13.4")).toBe("12.0–13.4");
    expect(specLabel("=14.2")).toBe("14.2");
  });
});

describe("verifiedMessage", () => {
  it("lists the verified versions oldest first, separated by a middle dot", () => {
    expect(verifiedMessage(rules(">=13.1 <13.2", "12.1"))).toBe("12.1 · 13.1");
  });
  it("drops duplicates and flattens profiles with several specs", () => {
    expect(verifiedMessage(rules(["12.1", "12.2"], "12.1", ">=13.1 <13.2"))).toBe("12.1 · 12.2 · 13.1");
  });
  it("sorts numerically, not alphabetically", () => {
    expect(verifiedMessage(rules("9.5", "12.1", "10.0"))).toBe("9.5 · 10.0 · 12.1");
  });
  it("refuses rules with no profile", () => {
    expect(() => verifiedMessage({ profiles: [] })).toThrow(/no profiles/);
    expect(() => verifiedMessage({})).toThrow();
  });
});

describe("badgeFor", () => {
  it("is the shields.io endpoint document", () => {
    expect(badgeFor(rules(">=13.1 <13.2", "12.1"))).toEqual({ schemaVersion: 1, label: "verified on Muse", message: "12.1 · 13.1", color: "F4A300" });
  });
});

describe("badge.mjs CLI", () => {
  const dir = tmp("badge");
  const rulesFile = path.join(dir, "muse.json"), out = path.join(dir, "badges", "muse-verified.json");
  fs.writeFileSync(rulesFile, JSON.stringify(rules("12.1", ">=13.1 <13.2")));

  it("writes the badge file (creating its folder) and --check then agrees", () => {
    const w = run(["--rules", rulesFile, "--out", out]);
    expect(w.status, w.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual({ schemaVersion: 1, label: "verified on Muse", message: "12.1 · 13.1", color: "F4A300" });
    expect(fs.readFileSync(out, "utf8").endsWith("\n")).toBe(true);
    expect(run(["--check", "--rules", rulesFile, "--out", out]).status).toBe(0);
  });
  it("--check fails, and does not touch the file, when the badge is stale or missing", () => {
    fs.writeFileSync(rulesFile, JSON.stringify(rules("12.1", ">=13.1 <13.2", "14.0")));
    const before = fs.readFileSync(out, "utf8");
    const c = run(["--check", "--rules", rulesFile, "--out", out]);
    expect(c.status).toBe(1);
    expect(c.stderr).toMatch(/out of date.*badge\.mjs/s);
    expect(fs.readFileSync(out, "utf8")).toBe(before);
    expect(run(["--check", "--rules", rulesFile, "--out", path.join(dir, "missing.json")]).status).toBe(1);
  });
  it("fails clearly on unreadable rules or unknown options", () => {
    expect(run(["--rules", path.join(dir, "nope.json"), "--out", out]).status).toBe(1);
    expect(run(["--bogus"]).status).toBe(2);
  });
});

describe("the committed badge", () => {
  it("is current for rules/muse.json", () => {
    const r = run(["--check"]);
    expect(r.status, r.stderr).toBe(0);
    const badge = JSON.parse(fs.readFileSync(path.join(REPO, "docs/badges/muse-verified.json"), "utf8"));
    expect(badge).toMatchObject({ schemaVersion: 1, label: "verified on Muse", color: "F4A300" });
  });
});
