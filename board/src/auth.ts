import { equalBytes, toHex, utf8 } from "./crypto/b64";
import { configFromEnv, type AppConfig, type ConfigEnv, type RoleKeyConfig } from "./config";
import type { Role } from "./types";

export async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(value)));
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await sha256(value));
}

/** Constant-time equality: both sides are hashed to 32 bytes, then every byte is compared. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  return equalBytes(da, db);
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m ? m[1] : null;
}

const ZERO_HASH = new Uint8Array(32);
const hexBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

async function roleHash(key: RoleKeyConfig): Promise<Uint8Array | null> {
  if (key.hash) return hexBytes(key.hash);
  if (key.plaintext) return sha256(key.plaintext);
  return null;
}

interface ResolvedKeys {
  hashes: Record<Role, Uint8Array | null>;
  conflict: boolean;
}

async function resolveKeys(config: AppConfig): Promise<ResolvedKeys> {
  const [owner, worker, viewer] = await Promise.all([roleHash(config.owner), roleHash(config.worker), roleHash(config.viewer)]);
  const present = [owner, worker, viewer].filter((h): h is Uint8Array => h !== null);
  const conflict = present.some((a, i) => present.some((b, j) => i < j && equalBytes(a, b)));
  return { hashes: { owner, worker, viewer }, conflict };
}

export interface Authenticator {
  /** The role the token belongs to, or null. All three hashes are always compared. */
  identify(token: string): Promise<Role | null>;
  /** Human-readable reasons the key set is unusable (empty when it is fine). */
  problems(): Promise<string[]>;
}

/**
 * Keys are compared as SHA-256 digests in constant time, with no early exit between roles. The board
 * fails closed: it needs both an owner and a worker key, and no two roles may share a key.
 */
export function createAuthenticator(config: AppConfig): Authenticator {
  let resolved: Promise<ResolvedKeys> | undefined;
  const keys = () => (resolved ??= resolveKeys(config));
  return {
    async identify(token) {
      const k = await keys();
      if (k.conflict || !k.hashes.owner || !k.hashes.worker) return null;
      const given = await sha256(token);
      const isOwner = equalBytes(given, k.hashes.owner);
      const isWorker = equalBytes(given, k.hashes.worker);
      const isViewer = equalBytes(given, k.hashes.viewer ?? ZERO_HASH) && k.hashes.viewer !== null;
      if (isOwner) return "owner";
      if (isWorker) return "worker";
      return isViewer ? "viewer" : null;
    },
    async problems() {
      const k = await keys();
      return k.conflict ? ["Two roles share the same key. Every role needs its own key."] : [];
    },
  };
}

/** Convenience for callers that hold raw settings rather than a config object. */
export async function authenticate(req: Request, env: ConfigEnv): Promise<Role | null> {
  const token = bearerToken(req);
  return token ? createAuthenticator(configFromEnv(env)).identify(token) : null;
}
