#!/bin/sh
# Shared helpers for the sign-*.sh and verify-*.sh scripts. Sourced, not run. Never prints key material.
#
# Key hierarchy (see .github/RELEASING.md): the ROOT key signs keys/keyset.json and nothing else; a `rules` key signs
# rules/*.json; a `binary` key signs the release manifest. The keyset lists the rules and binary public keys by id.

sign_fail() { printf '%s: %s\n' "${SIGN_TOOL:-sign}" "$1" >&2; exit 1; }

# Where the repository's key material lives (overridable for tests).
repo_keys_dir() { printf '%s' "${CBB_KEYS_DIR:-$here/../../keys}"; }

need_jq() { command -v jq >/dev/null 2>&1 || sign_fail "jq is required (brew install jq)"; }

# Finds an openssl that can sign Ed25519 with -rawin (OpenSSL 3+; macOS's built-in LibreSSL cannot).
find_openssl() {
  for c in "${OPENSSL:-}" /opt/homebrew/opt/openssl@3/bin/openssl /opt/homebrew/bin/openssl /usr/local/opt/openssl@3/bin/openssl openssl; do
    [ -n "$c" ] || continue
    command -v "$c" >/dev/null 2>&1 || continue
    if "$c" pkeyutl -help 2>&1 | grep -q rawin; then OPENSSL_BIN="$c"; return 0; fi
  done
  sign_fail "no OpenSSL 3 found (needed for Ed25519 -rawin). Install with: brew install openssl@3, or set OPENSSL=/path/to/openssl"
}

# Refuses a key that is not the one whose public half is published in <published-public-pem>.
assert_release_key() { # <private-key> <published-public-pem>
  [ -r "$1" ] || sign_fail "cannot read the private key file: $1"
  [ -r "$2" ] || sign_fail "published public key not found: $2"
  mine=$("$OPENSSL_BIN" pkey -in "$1" -pubout 2>/dev/null) || sign_fail "$1 is not a usable private key"
  [ "$mine" = "$(cat "$2")" ] || sign_fail "this private key does not match $2; refusing to sign"
}

# Signs <file> (raw bytes) with <key>; prints the base64 signature on one line.
sign_file_b64() { # <private-key> <file> <workdir>
  "$OPENSSL_BIN" pkeyutl -sign -rawin -inkey "$1" -in "$2" -out "$3/sig.bin" || sign_fail "openssl signing failed"
  base64 < "$3/sig.bin" | tr -d '\n'
}

# Verifies a base64 signature over <file> with the public key derived from <key>.
verify_sig_b64() { # <private-key> <file> <sig-b64> <workdir>
  "$OPENSSL_BIN" pkey -in "$1" -pubout -out "$4/pub.pem" 2>/dev/null || return 1
  printf '%s' "$3" | base64 -d > "$4/check.bin" 2>/dev/null || printf '%s' "$3" | base64 -D > "$4/check.bin"
  "$OPENSSL_BIN" pkeyutl -verify -rawin -pubin -inkey "$4/pub.pem" -in "$2" -sigfile "$4/check.bin" >/dev/null 2>&1
}

# Verifies a signature FILE (base64 text) over <file> with a PEM public key. Returns 0 only when valid.
verify_sigfile_pem() { # <file> <sig-file> <public-pem> <workdir>
  tr -d '[:space:]' < "$2" > "$4/sig.b64"
  { base64 -d < "$4/sig.b64" > "$4/sig.bin" 2>/dev/null; } || base64 -D < "$4/sig.b64" > "$4/sig.bin" 2>/dev/null || return 1
  "$OPENSSL_BIN" pkeyutl -verify -rawin -pubin -inkey "$3" -in "$1" -sigfile "$4/sig.bin" >/dev/null 2>&1
}

# The raw 32-byte Ed25519 public key (base64, one line) of a private key, the form keys/keyset.json uses.
raw_pub_b64() { # <private-key>
  "$OPENSSL_BIN" pkey -in "$1" -pubout -outform DER 2>/dev/null | tail -c 32 | base64 | tr -d '\n'
}

# Writes a PEM public key to <out> from a raw base64 key (SPKI header + the 32 key bytes).
pem_from_raw_b64() { # <raw-b64> <out-pem> <workdir>
  { printf '\060\052\060\005\006\003\053\145\160\003\041\000'; printf '%s' "$1" | { base64 -d 2>/dev/null || base64 -D; }; } > "$3/spki.der"
  "$OPENSSL_BIN" pkey -pubin -inform DER -in "$3/spki.der" -out "$2" 2>/dev/null || return 1
}

# The keyset the id lookups use, after checking that the root really signed it (so a hand-edited keyset cannot name keys).
# Sets KEYSET_FILE.
require_signed_keyset() { # <workdir>
  KEYSET_FILE="${CBB_KEYSET:-$(repo_keys_dir)/keyset.json}"
  root_pub="${CBB_ROOT_PUBLIC_KEY_PEM:-$(repo_keys_dir)/root-public.pem}"
  [ -f "$KEYSET_FILE" ] || sign_fail "keyset not found: $KEYSET_FILE"
  [ -f "$KEYSET_FILE.sig" ] || sign_fail "the keyset is not signed yet ($KEYSET_FILE.sig is missing). The root key signs it first: sh plugin/scripts/sign-keyset.sh <root-private-key>"
  [ -r "$root_pub" ] || sign_fail "root public key not found: $root_pub"
  verify_sigfile_pem "$KEYSET_FILE" "$KEYSET_FILE.sig" "$root_pub" "$1" || sign_fail "the keyset signature does not verify against $root_pub"
}

# Sets KEY_ID: the id the keyset gives this private key for purpose <use> (CBB_KEY_ID overrides, for tests).
resolve_key_id() { # <private-key> <use> <workdir>
  if [ -n "${CBB_KEY_ID:-}" ]; then KEY_ID="$CBB_KEY_ID"; return 0; fi
  require_signed_keyset "$3"
  raw=$(raw_pub_b64 "$1")
  KEY_ID=$(jq -r --arg k "$raw" --arg u "$2" '[.keys[] | select(.public_key_b64 == $k and .use == $u) | .id] | first // empty' "$KEYSET_FILE")
  [ -n "$KEY_ID" ] || sign_fail "this key is not listed in $KEYSET_FILE with use \"$2\"; refusing to sign"
  jq -e --arg id "$KEY_ID" --arg k "$raw" '(.revoked // []) | (index($id) == null) and (index($k) == null)' "$KEYSET_FILE" >/dev/null \
    || sign_fail "key $KEY_ID is revoked in $KEYSET_FILE; refusing to sign"
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq -e --arg id "$KEY_ID" --arg now "$now" '.keys[] | select(.id == $id) | .not_after > $now' "$KEYSET_FILE" >/dev/null \
    || sign_fail "key $KEY_ID is past its not_after in $KEYSET_FILE; refusing to sign"
}
