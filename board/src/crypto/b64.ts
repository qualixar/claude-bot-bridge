const encoder = new TextEncoder();

export const utf8 = (value: string): Uint8Array<ArrayBuffer> => encoder.encode(value) as Uint8Array<ArrayBuffer>;

export function toB64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Accepts base64 or base64url, padded or not. Throws on anything else. */
export function fromB64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(value)) throw new Error("not base64");
  const std = value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
