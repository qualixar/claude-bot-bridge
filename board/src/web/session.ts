import { fromB64, toB64Url, utf8 } from "../crypto/b64";

export const SESSION_COOKIE = "cbb_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export type SessionRole = "viewer" | "owner";

const VERSION = "v2";

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/**
 * Session value: `v2.<role>.<expiryMs>.<generation>.<HMAC-SHA256>`, keyed by SESSION_SECRET. The generation is a
 * counter kept in the database (`meta.session_gen`); logout raises it, which invalidates every older cookie.
 */
export async function signSession(secret: string, role: SessionRole, expiryMs: number, generation = 0): Promise<string> {
  const data = `${VERSION}.${role}.${expiryMs}.${generation}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), utf8(data));
  return `${data}.${toB64Url(new Uint8Array(sig))}`;
}

/** Returns the session's role, or null when it is malformed, forged, expired or from an older generation. */
export async function verifySession(secret: string, value: string, nowMs: number, generation = 0): Promise<SessionRole | null> {
  const parts = value.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) return null;
  const [, role, expiry, gen, sig] = parts;
  if ((role !== "viewer" && role !== "owner") || !/^\d{1,15}$/.test(expiry) || !/^\d{1,15}$/.test(gen)) return null;
  if (Number(gen) !== generation) return null;
  let sigBytes: Uint8Array<ArrayBuffer>;
  try {
    sigBytes = fromB64(sig);
  } catch {
    return null;
  }
  // subtle.verify compares the MAC in constant time.
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), sigBytes, utf8(`${VERSION}.${role}.${expiry}.${gen}`));
  return valid && Number(expiry) > nowMs ? role : null;
}

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionCookie(value: string, https: boolean): string {
  const maxAge = value === "" ? 0 : SESSION_TTL_MS / 1000;
  return `${SESSION_COOKIE}=${value}; Path=/board; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${https ? "; Secure" : ""}`;
}
