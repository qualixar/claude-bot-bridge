import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without types
import { loadTarget } from "../../client/board.mjs";
import { API_VERSION, BOARD_VERSION, SCHEMA_VERSION } from "../../src/version";
import pkg from "../../package.json";

describe("version single source of truth", () => {
  const latest = Math.max(...readdirSync(join(import.meta.dirname, "../../migrations")).map((f) => Number(/^(\d+)_/.exec(f)?.[1] ?? 0)));

  it("BOARD_VERSION is package.json's version, 0.2.0 for this release", () => {
    expect(BOARD_VERSION).toBe(pkg.version);
    expect(BOARD_VERSION).toBe("0.2.0");
    expect(API_VERSION).toBe(1);
  });

  it("SCHEMA_VERSION is the latest migration number", () => {
    expect(SCHEMA_VERSION).toBe(latest);
  });

  it("the CLI reads the same target from the checkout", () => {
    expect(loadTarget()).toEqual({ version: BOARD_VERSION, schema: SCHEMA_VERSION, allowPlaintext: false });
  });

  it("package.json exposes both bin names", () => {
    expect(pkg.bin).toMatchObject({ board: "client/board.mjs", "cbb-board": "client/board.mjs" });
  });
});
