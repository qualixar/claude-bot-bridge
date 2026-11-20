import { describe, it, expect } from "vitest";
import fs from "node:fs";

const json = (rel) => JSON.parse(fs.readFileSync(new URL(`../../../../../${rel}`, import.meta.url), "utf8"));

describe("plugin manifests", () => {
  it("the board plugin points at the privacy section of the plugin README", () => {
    const url = json("plugin/optional/board/.claude-plugin/plugin.json").privacyPolicyUrl;
    expect(url).toBe("https://github.com/qualixar/claude-bot-bridge/blob/main/plugin/README.md#privacy");
    const readme = fs.readFileSync(new URL("../../../../README.md", import.meta.url), "utf8");
    expect(readme).toMatch(/^## Privacy$/m);
  });
  it("the tracked wrangler.jsonc carries only the placeholder database id", () => {
    const w = fs.readFileSync(new URL("../../../../../board/wrangler.jsonc", import.meta.url), "utf8");
    expect(w).toContain('"database_id": "00000000-0000-0000-0000-000000000000"');
  });
  it("wrangler.local.jsonc stays untracked", () => {
    expect(fs.readFileSync(new URL("../../../../../.gitignore", import.meta.url), "utf8")).toMatch(/^board\/wrangler\.local\.jsonc$/m);
  });
});
