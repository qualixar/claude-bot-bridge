import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { readStoredKeyset, writeStoredKeyset } from "../src/keyset-store.js";
import { tmp } from "./helpers.js";

const pair = (n) => ({ json: `{"n":${n}}`, signature: `sig${n}` });

describe("keyset store (the folder layout the Swift helper shares)", () => {
  it("nothing stored reads as null", () => { expect(readStoredKeyset(tmp("bridge"))).toBeNull(); });

  it("writes one v-<id> directory with keyset.json and keyset.json.sig behind a `current` symlink", async () => {
    const dir = tmp("bridge");
    expect(await writeStoredKeyset(dir, pair(1))).toBe(true);
    const link = fs.readlinkSync(path.join(dir, "keys", "current"));
    expect(link).toMatch(/^v-[0-9A-F-]{36}$/);
    expect(fs.readdirSync(path.join(dir, "keys", link)).sort()).toEqual(["keyset.json", "keyset.json.sig"]);
    expect(readStoredKeyset(dir)).toEqual(pair(1));
    expect(fs.existsSync(path.join(dir, "keys", ".lock"))).toBe(false);
  });
  it("keeps the new directory and the one before it, and no others", async () => {
    const dir = tmp("bridge");
    for (const n of [1, 2, 3, 4]) await writeStoredKeyset(dir, pair(n));
    const dirs = fs.readdirSync(path.join(dir, "keys")).filter((n) => n.startsWith("v-"));
    expect(dirs).toHaveLength(2);
    expect(readStoredKeyset(dir)).toEqual(pair(4));
  });
  it("reads a pair written by the Swift helper (relative symlink, trailing newline on the signature)", () => {
    const dir = tmp("bridge");
    const v = path.join(dir, "keys", "v-ABC");
    fs.mkdirSync(v, { recursive: true });
    fs.writeFileSync(path.join(v, "keyset.json"), "{}"); fs.writeFileSync(path.join(v, "keyset.json.sig"), "c2ln\n");
    fs.symlinkSync("v-ABC", path.join(dir, "keys", "current"));
    expect(readStoredKeyset(dir)).toEqual({ json: "{}", signature: "c2ln" });
  });
  it("a half-written or oversized cache reads as null instead of throwing", () => {
    const dir = tmp("bridge");
    const v = path.join(dir, "keys", "v-X");
    fs.mkdirSync(v, { recursive: true });
    fs.symlinkSync("v-X", path.join(dir, "keys", "current"));
    expect(readStoredKeyset(dir)).toBeNull();                       // no files
    fs.writeFileSync(path.join(v, "keyset.json"), "x".repeat(70 * 1024)); fs.writeFileSync(path.join(v, "keyset.json.sig"), "s");
    expect(readStoredKeyset(dir)).toBeNull();                       // over the 64 KiB cap
  });
  it("two writers never interleave: the lock serialises them and every read sees a matching pair", async () => {
    const dir = tmp("bridge");
    await Promise.all([1, 2, 3, 4, 5, 6].map((n) => writeStoredKeyset(dir, pair(n))));
    const got = readStoredKeyset(dir);
    expect(got.signature).toBe(`sig${JSON.parse(got.json).n}`);
    expect(fs.existsSync(path.join(dir, "keys", ".lock"))).toBe(false);
  });
  it("gives up (false) while another live process holds the lock, and leaves the old pair alone", async () => {
    const dir = tmp("bridge");
    await writeStoredKeyset(dir, pair(1));
    fs.writeFileSync(path.join(dir, "keys", ".lock"), `${process.pid}\nsomeone-else\n`);
    const waits = [];
    expect(await writeStoredKeyset(dir, pair(2), { sleep: async (ms) => { waits.push(ms); } })).toBe(false);
    expect(waits.length).toBeGreaterThan(10);
    expect(readStoredKeyset(dir)).toEqual(pair(1));
  });
  it("reports failure (false) instead of throwing when the folder cannot be created", async () => {
    const dir = tmp("bridge");
    fs.writeFileSync(path.join(dir, "keys"), "not a folder");
    expect(await writeStoredKeyset(dir, pair(1))).toBe(false);
  });
});
