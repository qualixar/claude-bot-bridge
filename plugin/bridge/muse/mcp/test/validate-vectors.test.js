import { describe, it, expect } from "vitest";
import fs from "node:fs";
import * as v from "../src/validate.js";

// Same file as Tests/MuseAXCoreTests/SendSafetyTests.swift: the two validators must give the same answer.
const { cases } = JSON.parse(fs.readFileSync(new URL("../../test-vectors/send-validation.json", import.meta.url), "utf8"));
const textOf = (c) => c.text ?? c.head + c.repeat.s.repeat(c.repeat.n) + (c.tail ?? "");
const accepts = (t) => { try { v.sendText(t); return true; } catch (e) { if (e instanceof v.InputError) return false; throw e; } };

describe("send validation vectors (shared with Swift)", () => {
  it("has a meaningful number of vectors", () => expect(cases.length).toBeGreaterThan(30));
  for (const c of cases) {
    it(`${c.valid ? "accepts" : "refuses"}: ${c.name}`, () => expect(accepts(textOf(c))).toBe(c.valid));
  }
  it("counts Unicode scalars, the same unit as the Swift side", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    expect(accepts("[Claude Code] " + family.repeat(97) + "a")).toBe(true);
    expect(accepts("[Claude Code] " + family.repeat(97) + "ab")).toBe(false);
  });
  it("refuses a lone surrogate (it cannot survive the trip through argv)", () => {
    expect(accepts("[Claude Code] a\ud800b")).toBe(false);
  });
});
