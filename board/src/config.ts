import { DEFAULT_WORKER_NAME } from "./types";

/** Every setting the board reads. Workers pass `env`, Node passes `process.env`. */
export interface ConfigEnv {
  OWNER_TOKEN?: string;
  WORKER_TOKEN?: string;
  OWNER_KEY_SHA256?: string;
  WORKER_KEY_SHA256?: string;
  VIEWER_KEY_SHA256?: string;
  BOARD_ENCRYPTION_KEY?: string;
  BOARD_ENCRYPTION_KEY_PREVIOUS?: string;
  ALLOW_PLAINTEXT_STORAGE?: string;
  STRICT_ENCRYPTION?: string;
  SESSION_SECRET?: string;
  WORKER_NAME?: string;
  WORKER_RATE_LIMIT_PER_MIN?: string;
  TRUST_PROXY?: string;
}

export type IssueScope = "storage" | "auth" | "session" | "config";

export interface ConfigIssue {
  scope: IssueScope;
  message: string;
}

export interface RoleKeyConfig {
  /** Lowercase hex SHA-256 of the key, when set and well formed. */
  hash?: string;
  /** Legacy plaintext token, used only when no hash is set. */
  plaintext?: string;
  /** A hash was set but is not 64 hex characters: the role is disabled. */
  hashInvalid?: boolean;
}

export interface AppConfig {
  readonly owner: RoleKeyConfig;
  readonly worker: RoleKeyConfig;
  readonly viewer: RoleKeyConfig;
  readonly encryptionKey?: string;
  readonly encryptionKeyPrevious?: string;
  readonly allowPlaintext: boolean;
  readonly strictEncryption: boolean;
  readonly sessionSecret?: string;
  readonly workerName: string;
  readonly workerRateLimit: number;
  readonly trustProxy: boolean;
  readonly issues: readonly ConfigIssue[];
}

export const DEFAULT_RATE_LIMIT = 60;
export const MIN_SECRET_LENGTH = 16;
export const MIN_SESSION_SECRET_LENGTH = 32;
const HEX64 = /^[0-9a-f]{64}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const clean = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

function roleKey(hash: string | undefined, plaintext: string | undefined): RoleKeyConfig {
  const h = clean(hash);
  if (h !== undefined) return HEX64.test(h) ? { hash: h.toLowerCase() } : { hashInvalid: true };
  const p = plaintext ?? "";
  return p.length >= MIN_SECRET_LENGTH ? { plaintext: p } : {};
}

function rateLimit(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_RATE_LIMIT;
}

function key32(value: string | undefined): boolean {
  if (value === undefined) return true;
  try {
    const std = value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
    if (!/^[A-Za-z0-9+/]+$/.test(std)) return false;
    return atob(std + "=".repeat((4 - (std.length % 4)) % 4)).length === 32;
  } catch {
    return false;
  }
}

export function configFromEnv(env: ConfigEnv): AppConfig {
  const workerName = clean(env.WORKER_NAME) ?? DEFAULT_WORKER_NAME;
  const base = {
    owner: roleKey(env.OWNER_KEY_SHA256, env.OWNER_TOKEN),
    worker: roleKey(env.WORKER_KEY_SHA256, env.WORKER_TOKEN),
    viewer: roleKey(env.VIEWER_KEY_SHA256, undefined),
    encryptionKey: clean(env.BOARD_ENCRYPTION_KEY),
    encryptionKeyPrevious: clean(env.BOARD_ENCRYPTION_KEY_PREVIOUS),
    allowPlaintext: env.ALLOW_PLAINTEXT_STORAGE === "1",
    strictEncryption: env.STRICT_ENCRYPTION === "1",
    sessionSecret: clean(env.SESSION_SECRET),
    workerName,
    workerRateLimit: rateLimit(env.WORKER_RATE_LIMIT_PER_MIN),
    trustProxy: env.TRUST_PROXY === "1",
  };
  return { ...base, issues: collectIssues(base) };
}

function collectIssues(c: Omit<AppConfig, "issues">): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const add = (scope: IssueScope, message: string) => issues.push({ scope, message });
  if (!c.encryptionKey && !c.allowPlaintext) {
    add("storage", "BOARD_ENCRYPTION_KEY is not set. Generate one with `board keygen --encryption-key`, or set ALLOW_PLAINTEXT_STORAGE=1 (not for production).");
  }
  if (c.strictEncryption && !c.encryptionKey) add("storage", "STRICT_ENCRYPTION=1 needs BOARD_ENCRYPTION_KEY.");
  if (!key32(c.encryptionKey)) add("storage", "BOARD_ENCRYPTION_KEY must be base64 of exactly 32 bytes.");
  if (!key32(c.encryptionKeyPrevious)) add("storage", "BOARD_ENCRYPTION_KEY_PREVIOUS must be base64 of exactly 32 bytes.");
  for (const [name, role] of [["OWNER", c.owner], ["WORKER", c.worker], ["VIEWER", c.viewer]] as const) {
    if (role.hashInvalid) add("auth", `${name}_KEY_SHA256 must be 64 hex characters (SHA-256 of the key).`);
  }
  if (!c.owner.hash && !c.owner.plaintext) add("auth", "No owner key: set OWNER_KEY_SHA256 (or the legacy OWNER_TOKEN, 16+ characters).");
  if (!c.worker.hash && !c.worker.plaintext) add("auth", "No worker key: set WORKER_KEY_SHA256 (or the legacy WORKER_TOKEN, 16+ characters).");
  if (!c.sessionSecret || c.sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    add("session", `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters. Generate one with \`board keygen --session-secret\`.`);
  }
  if (c.workerName.length > 64 || CONTROL.test(c.workerName)) add("config", "WORKER_NAME must be 64 characters or fewer with no control characters.");
  return issues;
}

export const issuesIn = (c: AppConfig, scope: IssueScope): ConfigIssue[] => c.issues.filter((i) => i.scope === scope);
