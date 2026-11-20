import { describe, expect, it } from "vitest";
import { SESSION_COOKIE, readCookie, sessionCookie, signSession, verifySession } from "../src/web/session";

const SECRET = "unit-test-session-secret-0123456789abcdef";
const NOW = 1_800_000_000_000;

describe("session cookie value", () => {
  it("signs and verifies v2.<role>.<expiry>.<generation>.<hmac>", async () => {
    const v = await signSession(SECRET, "viewer", NOW + 1000);
    expect(v).toMatch(/^v2\.viewer\.1800000001000\.0\.[A-Za-z0-9_-]{43}$/);
    expect(await verifySession(SECRET, v, NOW)).toBe("viewer");
    expect(await verifySession(SECRET, await signSession(SECRET, "owner", NOW + 1000), NOW)).toBe("owner");
  });

  it("rejects expired, forged, role-swapped and wrong-secret values", async () => {
    const v = await signSession(SECRET, "viewer", NOW + 1000);
    expect(await verifySession(SECRET, v, NOW + 1000)).toBeNull();
    expect(await verifySession(SECRET, v, NOW + 5000)).toBeNull();
    expect(await verifySession(SECRET, v.replace(".viewer.", ".owner."), NOW)).toBeNull();
    expect(await verifySession(SECRET, v.replace("1800000001000", "1900000001000"), NOW)).toBeNull();
    expect(await verifySession(SECRET, v.replace(".0.", ".1."), NOW, 1)).toBeNull();
    expect(await verifySession("another-secret-0123456789abcdef0123", v, NOW)).toBeNull();
    expect(await verifySession(SECRET, v.slice(0, -2) + (v.endsWith("AA") ? "BB" : "AA"), NOW)).toBeNull();
  });

  it("rejects malformed input without throwing", async () => {
    for (const bad of ["", "v2", "v2.viewer.1.2", "v1.viewer.9999999999999.AAAA", "v3.viewer.9999999999999.0.AAAA", "v2.worker.9999999999999.0.AAAA", "v2.viewer.abc.0.AAAA", "v2.viewer.9999999999999.x.AAAA", "v2.viewer.9999999999999.0.***", "a.b.c.d.e.f"]) {
      expect(await verifySession(SECRET, bad, NOW)).toBeNull();
    }
  });
});

describe("session generation", () => {
  it("only accepts a cookie signed for the current generation", async () => {
    const v = await signSession(SECRET, "owner", NOW + 1000, 3);
    expect(v).toMatch(/^v2\.owner\.\d+\.3\./);
    expect(await verifySession(SECRET, v, NOW, 3)).toBe("owner");
    expect(await verifySession(SECRET, v, NOW, 4)).toBeNull();
    expect(await verifySession(SECRET, v, NOW, 0)).toBeNull();
  });
});

describe("cookie helpers", () => {
  it("reads one cookie out of a header", () => {
    const req = new Request("https://x", { headers: { cookie: `a=1; ${SESSION_COOKIE}=abc.def; b=2` } });
    expect(readCookie(req, SESSION_COOKIE)).toBe("abc.def");
    expect(readCookie(req, "missing")).toBeNull();
    expect(readCookie(new Request("https://x"), "a")).toBeNull();
  });

  it("builds a HttpOnly, SameSite=Strict, Path=/board cookie, Secure only over https, 12 h", () => {
    const http = sessionCookie("v", false);
    expect(http).toContain("HttpOnly");
    expect(http).toContain("SameSite=Strict");
    expect(http).toContain("Path=/board");
    expect(http).toContain("Max-Age=43200");
    expect(http).not.toContain("Secure");
    expect(sessionCookie("v", true)).toContain("; Secure");
    expect(sessionCookie("", true)).toContain("Max-Age=0");
  });
});
