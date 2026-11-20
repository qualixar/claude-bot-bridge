import { describe, expect, it } from "vitest";
import { toB64Url } from "../src/crypto/b64";
import { ENC_PREFIX, VaultError, aadFor, createVault } from "../src/crypto/vault";

const key = (fill: number) => toB64Url(new Uint8Array(32).fill(fill));
const K1 = key(1);
const K2 = key(2);
const AAD = aadFor("tasks", "title", "T-0001");

describe("vault", () => {
  it("round-trips text with the documented format and a fresh IV every time", async () => {
    const v = createVault({ key: K1 });
    const a = await v.seal(AAD, "héllo wörld ✓");
    const b = await v.seal(AAD, "héllo wörld ✓");
    expect(a).toMatch(/^enc:v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
    expect(a.startsWith(ENC_PREFIX)).toBe(true);
    expect(await v.open(AAD, a)).toBe("héllo wörld ✓");
    expect(await v.seal(AAD, "")).toMatch(/^enc:v1:/);
    expect(await v.open(AAD, await v.seal(AAD, ""))).toBe("");
  });

  it("accepts standard base64 keys with padding", async () => {
    const std = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    const v = createVault({ key: std });
    expect(await v.open(AAD, await v.seal(AAD, "x"))).toBe("x");
  });

  it("rejects a ciphertext moved to another row, column or table (AAD)", async () => {
    const v = createVault({ key: K1 });
    const sealed = await v.seal(AAD, "secret");
    for (const other of [aadFor("tasks", "title", "T-0002"), aadFor("tasks", "brief", "T-0001"), aadFor("events", "title", "T-0001")]) {
      await expect(v.open(other, sealed)).rejects.toBeInstanceOf(VaultError);
    }
  });

  it("rejects tampered, truncated and malformed values without echoing them", async () => {
    const v = createVault({ key: K1 });
    const sealed = await v.seal(AAD, "secret value");
    const parts = sealed.split(":");
    const flipped = `${parts[0]}:${parts[1]}:${parts[2]}:${parts[3].slice(0, -2)}${parts[3].endsWith("AA") ? "BB" : "AA"}`;
    for (const bad of [flipped, `${ENC_PREFIX}onlyonepart`, `${ENC_PREFIX}AAAA:BBBB`, `${ENC_PREFIX}!!!:???`, `${ENC_PREFIX}${parts[2]}:`]) {
      const err = await v.open(AAD, bad).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(VaultError);
      expect(String((err as Error).message)).not.toContain("secret value");
    }
  });

  it("reads values without the prefix as legacy plaintext, with or without a key", async () => {
    expect(await createVault({ key: K1 }).open(AAD, "plain old text")).toBe("plain old text");
    expect(await createVault({}).open(AAD, "plain old text")).toBe("plain old text");
    const info = await createVault({ key: K1 }).inspect(AAD, "plain old text");
    expect(info).toEqual({ text: "plain old text", current: false });
  });

  it("decrypts with the previous key during rotation and flags it as not current", async () => {
    const old = await createVault({ key: K1 }).seal(AAD, "old data");
    const rotated = createVault({ key: K2, previous: K1 });
    expect(await rotated.inspect(AAD, old)).toEqual({ text: "old data", current: false });
    const fresh = await rotated.seal(AAD, "new data");
    expect(await rotated.inspect(AAD, fresh)).toEqual({ text: "new data", current: true });
    await expect(createVault({ key: K2 }).open(AAD, old)).rejects.toBeInstanceOf(VaultError);
  });

  it("passes values through in plaintext mode but refuses to read ciphertext it has no key for", async () => {
    const plain = createVault({});
    expect(plain.encrypting).toBe(false);
    expect(await plain.seal(AAD, "x")).toBe("x");
    const sealed = await createVault({ key: K1 }).seal(AAD, "x");
    await expect(plain.open(AAD, sealed)).rejects.toBeInstanceOf(VaultError);
  });

  it("rejects keys that are not 32 bytes of base64", async () => {
    await expect(createVault({ key: "c2hvcnQ" }).seal(AAD, "x")).rejects.toThrow(/32 bytes/);
    await expect(createVault({ key: "***not base64***" }).seal(AAD, "x")).rejects.toThrow(/base64/);
  });
});
