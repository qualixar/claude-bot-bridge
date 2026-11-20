import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { build } from "esbuild";
import { options } from "../build-options.mjs";

describe("dist bundle", () => {
  it("is up to date with src (run `npm run build` if this fails)", async () => {
    const out = await build({ ...options, write: false, outfile: "dist/index.mjs" });
    const fresh = out.outputFiles[0].text;
    expect(fs.readFileSync("dist/index.mjs", "utf8")).toBe(fresh);
  });
});
