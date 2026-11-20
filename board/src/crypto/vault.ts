import { fromB64, toB64Url, utf8 } from "./b64";

/** Thrown when a stored value cannot be decrypted. The message never contains key or data bytes. */
export class VaultError extends Error {}

export const ENC_PREFIX = "enc:v1:";
/** v2 is used for event notes: the AAD also carries the event id. Everything else stays v1. */
export const ENC_PREFIX_V2 = "enc:v2:";
const PREFIXES = [ENC_PREFIX, ENC_PREFIX_V2] as const;
const isSealed = (stored: string): boolean => PREFIXES.some((p) => stored.startsWith(p));
const KEY_BYTES = 32;
const IV_BYTES = 12;

export interface Opened {
  text: string;
  /** True when the value is already protected with the current key (so rotation can skip it). */
  current: boolean;
}

export interface Vault {
  readonly encrypting: boolean;
  /** When true, `open` rejects values that are not encrypted. `inspect` (used by rotation) still reads them. */
  readonly strict: boolean;
  /** AES-256-GCM with a random IV. With no key configured (plaintext mode) the value is returned unchanged. */
  seal(aad: string, plaintext: string, version?: 1 | 2): Promise<string>;
  /** Decrypts with the current key, then the previous one. Values without the prefix are legacy plaintext. */
  open(aad: string, stored: string): Promise<string>;
  inspect(aad: string, stored: string): Promise<Opened>;
}

/** Additional authenticated data: binds a ciphertext to its table, column and task. */
export const aadFor = (table: string, column: string, taskId: string): string => `${table}.${column}.${taskId}`;

async function importKey(b64: string): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromB64(b64);
  } catch {
    throw new VaultError("Encryption key is not valid base64.");
  }
  if (raw.length !== KEY_BYTES) throw new VaultError("Encryption key must be exactly 32 bytes.");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function parse(stored: string): { iv: Uint8Array<ArrayBuffer>; data: Uint8Array<ArrayBuffer> } {
  const parts = stored.slice(ENC_PREFIX.length).split(":"); // both prefixes are 7 characters
  if (parts.length !== 2) throw new VaultError("Malformed encrypted value.");
  try {
    const iv = fromB64(parts[0]);
    if (iv.length !== IV_BYTES) throw new Error("iv");
    return { iv, data: fromB64(parts[1]) };
  } catch {
    throw new VaultError("Malformed encrypted value.");
  }
}

async function tryDecrypt(key: CryptoKey, iv: Uint8Array<ArrayBuffer>, aad: string, data: Uint8Array<ArrayBuffer>): Promise<string | null> {
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, key, data);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plain);
  } catch {
    return null;
  }
}

export function createVault(keys: { key?: string; previous?: string; strict?: boolean }): Vault {
  let loaded: Promise<{ current: CryptoKey | null; previous: CryptoKey | null }> | undefined;
  const load = () =>
    (loaded ??= (async () => ({
      current: keys.key ? await importKey(keys.key) : null,
      previous: keys.previous ? await importKey(keys.previous) : null,
    }))());

  async function inspect(aad: string, stored: string): Promise<Opened> {
    if (!isSealed(stored)) return { text: stored, current: false };
    const { current, previous } = await load();
    const { iv, data } = parse(stored);
    for (const [key, isCurrent] of [[current, true], [previous, false]] as const) {
      if (!key) continue;
      const text = await tryDecrypt(key, iv, aad, data);
      if (text !== null) return { text, current: isCurrent };
    }
    throw new VaultError("Cannot decrypt a stored value: wrong key, or the value was altered or moved.");
  }

  return {
    encrypting: Boolean(keys.key),
    strict: Boolean(keys.strict),
    async seal(aad, plaintext, version = 1) {
      const { current } = await load();
      if (!current) return plaintext;
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, current, utf8(plaintext));
      return `${version === 2 ? ENC_PREFIX_V2 : ENC_PREFIX}${toB64Url(iv)}:${toB64Url(new Uint8Array(sealed))}`;
    },
    async open(aad, stored) {
      if (keys.strict && !isSealed(stored)) throw new VaultError("Strict mode: a stored value is not encrypted.");
      return (await inspect(aad, stored)).text;
    },
    inspect,
  };
}
