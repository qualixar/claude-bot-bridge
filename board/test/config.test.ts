import { describe, expect, it } from "vitest";
import { createAuthenticator } from "../src/auth";
import { configFromEnv, issuesIn } from "../src/config";
import { toB64Url } from "../src/crypto/b64";

const KEY = toB64Url(new Uint8Array(32).fill(7));
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const SESSION = "s".repeat(40);
const good = { OWNER_KEY_SHA256: HASH_A, WORKER_KEY_SHA256: HASH_B, BOARD_ENCRYPTION_KEY: KEY, SESSION_SECRET: SESSION };

describe("configFromEnv", () => {
  it("accepts a complete hashed configuration with no issues", () => {
    const c = configFromEnv(good);
    expect(c.issues).toEqual([]);
    expect(c.workerName).toBe("Muse");
    expect(c.workerRateLimit).toBe(60);
    expect(c.trustProxy).toBe(false);
  });

  it("reports a missing encryption key unless plaintext storage is explicitly allowed", () => {
    const { BOARD_ENCRYPTION_KEY: _k, ...rest } = good;
    expect(issuesIn(configFromEnv(rest), "storage")[0].message).toMatch(/BOARD_ENCRYPTION_KEY is not set/);
    expect(issuesIn(configFromEnv({ ...rest, ALLOW_PLAINTEXT_STORAGE: "1" }), "storage")).toEqual([]);
    expect(issuesIn(configFromEnv({ ...rest, ALLOW_PLAINTEXT_STORAGE: "yes" }), "storage")).toHaveLength(1);
  });

  it("validates key lengths, hashes, the session secret and the worker name", () => {
    expect(issuesIn(configFromEnv({ ...good, BOARD_ENCRYPTION_KEY: "c2hvcnQ" }), "storage")[0].message).toMatch(/32 bytes/);
    expect(issuesIn(configFromEnv({ ...good, BOARD_ENCRYPTION_KEY_PREVIOUS: "###" }), "storage")[0].message).toMatch(/PREVIOUS/);
    expect(issuesIn(configFromEnv({ ...good, VIEWER_KEY_SHA256: "xyz" }), "auth")[0].message).toMatch(/VIEWER_KEY_SHA256/);
    expect(issuesIn(configFromEnv({ ...good, SESSION_SECRET: "short" }), "session")).toHaveLength(1);
    expect(issuesIn(configFromEnv({ ...good, WORKER_NAME: "x".repeat(65) }), "config")).toHaveLength(1);
    expect(issuesIn(configFromEnv({ ...good, WORKER_NAME: "a\nb" }), "config")).toHaveLength(1);
    expect(configFromEnv({ ...good, WORKER_NAME: "  Bot  " }).workerName).toBe("Bot");
    expect(configFromEnv({ ...good, WORKER_NAME: "   " }).workerName).toBe("Muse");
  });

  it("requires an owner and a worker key, from a hash or the legacy token", () => {
    expect(issuesIn(configFromEnv({ BOARD_ENCRYPTION_KEY: KEY, SESSION_SECRET: SESSION }), "auth")).toHaveLength(2);
    expect(issuesIn(configFromEnv({ ...good, OWNER_KEY_SHA256: undefined, OWNER_TOKEN: "short" }), "auth")).toHaveLength(1);
    expect(issuesIn(configFromEnv({ ...good, OWNER_KEY_SHA256: undefined, OWNER_TOKEN: "x".repeat(20) }), "auth")).toEqual([]);
  });

  it("parses the rate limit and the proxy flag", () => {
    expect(configFromEnv({ ...good, WORKER_RATE_LIMIT_PER_MIN: "5", TRUST_PROXY: "1" })).toMatchObject({ workerRateLimit: 5, trustProxy: true });
    expect(configFromEnv({ ...good, WORKER_RATE_LIMIT_PER_MIN: "0" }).workerRateLimit).toBe(60);
  });
});

describe("authenticator problems", () => {
  it("reports two roles sharing a key", async () => {
    expect(await createAuthenticator(configFromEnv({ ...good, VIEWER_KEY_SHA256: HASH_A })).problems()).toHaveLength(1);
    expect(await createAuthenticator(configFromEnv(good)).problems()).toEqual([]);
  });
});
