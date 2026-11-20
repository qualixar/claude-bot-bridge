import { spawnSync } from "node:child_process";
import { copyFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const CLI = resolve(import.meta.dirname, "../../client/board.mjs");
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "cbb-cli-"));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const run = (file: string) => spawnSync(process.execPath, [file], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });

describe("package directory", () => {
  it("decodes spaces instead of leaving %20 in the working directory", async () => {
    // @ts-expect-error plain ESM script without types
    const { packageDir } = await import("../../client/board.mjs");
    expect(packageDir("file:///tmp/with%20space/client/board.mjs")).toBe("/tmp/with space/");
  });
});

describe("CLI entry detection", () => {
  it("runs when invoked directly", () => {
    expect(run(CLI).stdout).toContain("Usage: board");
  });

  it("runs through a symlink (npm link, ln -s)", () => {
    const link = join(tmp(), "cbb-board");
    symlinkSync(CLI, link);
    const r = run(link);
    expect(r.stdout).toContain("Usage: board");
    expect(r.status).toBe(0);
  });

  it("runs from a real directory whose path contains a space", () => {
    const dir = join(tmp(), "with space");
    mkdirSync(dir);
    for (const f of ["board.mjs", "upgrade.mjs"]) copyFileSync(join(resolve(import.meta.dirname, "../../client"), f), join(dir, f));
    expect(run(join(dir, "board.mjs")).stdout).toContain("Usage: board");
  });

  it("runs through a symlink inside a path that contains a space", () => {
    const dir = join(tmp(), "with space");
    mkdirSync(dir);
    const link = join(dir, "board.mjs");
    symlinkSync(CLI, link);
    const r = run(link);
    expect(r.stdout).toContain("Usage: board");
  });
});

describe("loadTarget", () => {
  it("prefers wrangler.local.jsonc over wrangler.jsonc when both exist", async () => {
    // @ts-expect-error plain ESM script without types
    const { loadTarget } = await import("../../client/board.mjs");
    const root = join(tmp(), "pkg");
    mkdirSync(join(root, "migrations"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
    writeFileSync(join(root, "migrations", "0003_x.sql"), "");
    writeFileSync(join(root, "wrangler.jsonc"), "{}");
    const url = new URL(`file://${root}/`);
    expect(loadTarget(url)).toEqual({ version: "1.2.3", schema: 3, allowPlaintext: false });
    writeFileSync(join(root, "wrangler.local.jsonc"), '{ "vars": { "ALLOW_PLAINTEXT_STORAGE": "1" } }');
    expect(loadTarget(url).allowPlaintext).toBe(true);
  });
});
