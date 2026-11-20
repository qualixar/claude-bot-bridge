// Static checks on .github/workflows/ci.yml and on the test gates in release.yml.
import { describe, it, expect } from "vitest";
import fs from "node:fs";

const read = (n) => fs.readFileSync(new URL(`../../../../../.github/workflows/${n}`, import.meta.url), "utf8");
const ci = read("ci.yml");
const release = read("release.yml");
const idx = (t, needle) => { const i = t.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };

describe("ci workflow", () => {
  it("runs on push and pull_request, with a read-only token", () => {
    expect(ci).toMatch(/^on:\n\s+push:[\s\S]*?pull_request:/m);
    expect(ci).toMatch(/^permissions:\n\s+contents: read$/m);
    expect(ci).not.toMatch(/contents: write/);
    expect(ci).not.toMatch(/secrets\./);
  });
  it("pins every action by a full commit SHA, and the same SHAs as release.yml where shared", () => {
    const uses = ci.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l));
    expect(uses.length).toBeGreaterThan(0);
    for (const l of uses) expect(l, l).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40}\s+# v\d/);
    const checkout = (t) => /actions\/checkout@([0-9a-f]{40})/.exec(t)?.[1];
    expect(checkout(ci)).toBe(checkout(release));
    expect((ci.match(/uses: actions\/checkout/g) ?? []).length).toBe((ci.match(/persist-credentials: false/g) ?? []).length);
  });
  it("covers the board (Node 22), the MCP server, Swift on macOS, the key hierarchy signatures and the badge", () => {
    expect(ci).toMatch(/node-version: "?22/);
    expect(ci).toMatch(/npm run typecheck/);
    expect(ci).toMatch(/npm test/);
    expect(ci).toMatch(/npx vitest run|npm test/);
    expect(ci).toMatch(/npm run build\b/);
    expect(ci).toMatch(/git diff --exit-code[^\n]*dist/);
    expect(ci).toMatch(/runs-on: macos-/);
    expect(ci).toMatch(/plugin\/bridge\/muse\/test\.sh/);
    expect(ci).toMatch(/verify-rules\.sh/);
    expect(ci).toMatch(/verify-keyset\.sh/);
    expect(ci).toMatch(/cmp keys\/root-public\.pem plugin\/release-signing-public\.pem/);
  });
  it("replays the recorded accessibility trees in a named step, with the repo files required", () => {
    const swift = ci.slice(ci.indexOf("  swift:"), ci.indexOf("  trust-material:"));
    expect(swift).toMatch(/CBB_REQUIRE_REPO_FILES: "1"/);
    expect(swift).toMatch(/- name: Replay recorded Muse accessibility trees against every rules profile/);
    expect(swift).toMatch(/test\.sh --filter TreeReplayTests/);
    expect(swift.indexOf("Replay recorded")).toBeGreaterThan(swift.indexOf("- name: Swift tests"));
  });
  it("runs the mcp job on a pinned macOS runner (the installer tests call the real codesign)", () => {
    const mcp = ci.slice(ci.indexOf("  mcp:"), ci.indexOf("  swift:"));
    expect(mcp).toMatch(/runs-on: macos-\d+/);
    expect(mcp).not.toMatch(/ubuntu|-latest/);
  });
  it("checks that the verified-version badge is current", () => {
    expect(ci).toMatch(/node plugin\/scripts\/badge\.mjs --check/);
  });
  it("warns about UNSIGNED trust material instead of failing, because the release workflow is the gate", () => {
    expect(ci).toMatch(/::warning::keys\/keyset\.json is still UNSIGNED/);
    expect(release).toMatch(/keys\/UNSIGNED rules\/UNSIGNED/);
  });
  it("says why `claude plugin validate` is not run in CI", () => {
    expect(ci).toMatch(/claude plugin validate/);
    expect(ci).not.toMatch(/npm (i|install) -g @anthropic-ai\/claude-code/);
  });
});

describe("release workflow test gates", () => {
  const build = release.slice(idx(release, "  build:"), idx(release, "  sign-and-publish:"));
  it("runs the Swift and MCP tests in the build job, before building the binary", () => {
    expect(build).toMatch(/plugin\/bridge\/muse\/test\.sh/);
    expect(build).toMatch(/npx vitest run/);
    expect(build.indexOf("test.sh")).toBeLessThan(build.indexOf("- name: Build universal binary"));
    expect(build.indexOf("npx vitest run")).toBeLessThan(build.indexOf("- name: Build universal binary"));
  });
  it("still gives the build job no secrets", () => { expect(build).not.toMatch(/secrets\./); });
});

describe("codesign in the MCP tests", () => {
  it("is stubbed where it cannot run, so the suite passes on any platform", async () => {
    const { run } = await import("./helpers.js");
    const r = await run("codesign", ["--version"], { env: { PATH: "/nonexistent-cbb-path" } });
    expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
  });
  it("passes every other command through untouched", async () => {
    const { run } = await import("./helpers.js");
    expect((await run("sh", ["-c", "echo hi"], { env: { PATH: "/bin:/usr/bin" } })).stdout.trim()).toBe("hi");
    expect((await run("definitely-not-a-command-cbb", [], { env: { PATH: "/bin" } })).code).toBe(-1);
  });
});

describe("docs match the workflows and the key hierarchy", () => {
  const doc = (p) => fs.readFileSync(new URL(`../../../../../${p}`, import.meta.url), "utf8");
  it("docs/github-repo-settings.md requires exactly the jobs ci.yml defines", () => {
    const jobs = [...ci.slice(ci.indexOf("\njobs:")).matchAll(/^  ([a-z][a-z-]*):\s*$/gm)].map((m) => m[1]);
    expect(jobs.sort()).toEqual(["badge", "board", "mcp", "swift", "trust-material"]);
    const line = doc("docs/github-repo-settings.md").split("\n").find((l) => l.includes("Require status checks"));
    for (const j of jobs) expect(line, j).toContain(`\`${j}\``);
    expect(doc("docs/github-repo-settings.md")).not.toContain("rules-signature");
  });
  it("SECURITY.md describes the hierarchy: offline root, keyset, separate rules and binary keys, revocation, how to report a compromise", () => {
    const s = doc("SECURITY.md");
    for (const needle of [/root key.*offline/i, /keys\/keyset\.json/, /rules key/i, /binary key/i, /separate/i, /Revocation/, /Reporting a key compromise/, /newest keyset/i]) expect(s).toMatch(needle);
  });
  it("no document still describes a root-signed compatibility path", () => {
    for (const p of [".github/RELEASING.md", "plugin/README.md", "rules/README.md", "SECURITY.md"]) {
      expect(doc(p), p).not.toMatch(/rootFallbackAllowed|compatibility path|viaRootFallback/);
    }
  });
});
