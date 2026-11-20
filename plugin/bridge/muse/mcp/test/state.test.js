import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { readState, mergeState } from "../src/state.js";
import { tmp } from "./helpers.js";

describe("state.json", () => {
  it("reads missing and corrupt files as empty", () => {
    const d = tmp();
    expect(readState(d)).toEqual({});
    fs.writeFileSync(path.join(d, "state.json"), "{broken");
    expect(readState(d)).toEqual({});
  });
  it("merges shallowly, keeps unknown keys, creates the directory", () => {
    const d = path.join(tmp(), "nested");
    mergeState(d, { a: 1, keep: "x" });
    mergeState(d, { a: 2, b: { n: true } });
    expect(readState(d)).toEqual({ a: 2, keep: "x", b: { n: true } });
  });
  it("leaves no temp files behind", () => {
    const d = tmp(); mergeState(d, { a: 1 });
    expect(fs.readdirSync(d)).toEqual(["state.json"]);
  });
  it("never throws on an unwritable location", () => {
    expect(() => mergeState("/proc/definitely/not/writable", { a: 1 })).not.toThrow();
  });
});
