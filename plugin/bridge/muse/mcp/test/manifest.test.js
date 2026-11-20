import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { PLUGIN_VERSION } from "../src/version.js";
import { isReleased, loadManifest } from "../src/binary-update.js";

const read = (rel) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), "utf8"));

describe("version bookkeeping", () => {
  it("plugin.json, package.json, binary-manifest.json and the constant agree", () => {
    const plugin = read("../../../../.claude-plugin/plugin.json");
    const manifest = read("../../binary-manifest.json");
    expect(PLUGIN_VERSION).toBe(plugin.version);
    expect(manifest.version).toBe(plugin.version);
    expect(read("../package.json").version).toBe(plugin.version);
  });
  it("the manifest has the documented shape and points at the GitHub release", () => {
    const m = read("../../binary-manifest.json");
    expect(Object.keys(m).sort()).toEqual(["sha256", "signature", "url", "version"]);
    expect(m.url).toBe(`https://github.com/qualixar/claude-bot-bridge/releases/download/v${m.version}/muse-ax-macos-universal.tar.gz`);
  });
  it("loadManifest reads it, and the shipped placeholder is not treated as a release", () => {
    const m = loadManifest(new URL("../../binary-manifest.json", import.meta.url).pathname);
    expect(m.version).toBe(PLUGIN_VERSION);
    if (!/^[0-9a-f]{64}$/.test(m.sha256)) expect(isReleased(m)).toBe(false);
  });
  it("loadManifest returns null for a missing or broken file", () => {
    expect(loadManifest("/nonexistent/manifest.json")).toBeNull();
  });
});
