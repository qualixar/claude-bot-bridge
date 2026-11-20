// Input validation at the MCP boundary. Mirrors the Swift SendRules; the CLI re-checks.
// Shared test vectors: ../../test-vectors/send-validation.json (used by both test suites).
export const SEND_PREFIX = "[Claude Code]";
export const MAX_SEND = 500;

export class InputError extends Error {}

export function chatName(v) {
  if (typeof v !== "string" || v.length === 0 || v.length > 200) throw new InputError("chat must be a non-empty string of at most 200 characters");
  if (/[\u0000-\u001f\u007f]/.test(v)) throw new InputError("chat must not contain control characters");
  return v;
}

// Cc (incl. U+0085), Zl, Zp and bidirectional controls. Mirrors SendRules.isForbidden in Validation.swift.
const FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/u;
// Anything that is not whitespace, a space separator or an invisible format character (zero-width, soft hyphen...).
const VISIBLE = /[^\s\p{Cf}\p{Zs}]/u;

/** Both validators count Unicode scalars (code points here), never UTF-16 units or grapheme clusters. */
export function sendText(v) {
  if (typeof v !== "string") throw new InputError("text must be a string");
  if (!v.startsWith(SEND_PREFIX)) throw new InputError(`text must start with "${SEND_PREFIX}"`);
  if (!v.isWellFormed()) throw new InputError("text contains an unpaired surrogate");
  const scalars = [...v].length;
  if (scalars > MAX_SEND) throw new InputError(`text must be at most ${MAX_SEND} characters`);
  if (FORBIDDEN.test(v)) throw new InputError("text must be a single line without control or direction-changing characters");
  if (!VISIBLE.test(v.slice(SEND_PREFIX.length))) throw new InputError("text has no visible content after the prefix");
  return v;
}

export function intInRange(name, v, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) throw new InputError(`${name} must be an integer in [${min}, ${max}]`);
  return v;
}

export function numInRange(name, v, min, max) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new InputError(`${name} must be a number in [${min}, ${max}]`);
  return v;
}

/** undefined passes as false; anything but a boolean is refused. */
export function optionalBoolean(name, v) {
  if (v === undefined) return false;
  if (typeof v !== "boolean") throw new InputError(`${name} must be true or false`);
  return v;
}
