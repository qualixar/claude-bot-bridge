#!/bin/sh
# Verifies a rules document (default rules/muse.json) against its detached signature <file>.sig.
# Usage: verify-rules.sh [file] [public-key-pem]
# With a key, that key is used. Without one the way a client does it: the file's key_id is looked up in the root-signed
# keys/keyset.json (purpose "rules", not revoked, not expired). A file without a key_id is refused: the root signs keysets
# only, there is no root-signed fallback. Exit 0 only when the signature is valid. Needs OpenSSL 3 (Ed25519 -rawin) and jq.
set -eu
SIGN_TOOL=verify-rules.sh
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib-sign.sh"
file="${1:-$here/../../rules/muse.json}"
pub="${2:-}"
[ -f "$file" ] || sign_fail "file not found: $file"
[ -f "$file.sig" ] || sign_fail "signature not found: $file.sig"
find_openssl
work=$(mktemp -d) || sign_fail "mktemp failed"
trap 'rm -rf "$work"' EXIT
if [ -z "$pub" ]; then
  need_jq
  id=$(jq -r '.key_id // empty' "$file")
  [ -n "$id" ] || sign_fail "$file has no key_id; every rules document names the keyset key that signs it (there is no root-signed fallback)"
  require_signed_keyset "$work"
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  entry=$(jq -c --arg id "$id" --arg now "$now" '.keys[] | select(.id == $id and .use == "rules" and .not_after > $now)' "$KEYSET_FILE")
  [ -n "$entry" ] || sign_fail "key $id is not a current rules key in $KEYSET_FILE"
  raw=$(printf '%s' "$entry" | jq -r .public_key_b64)
  jq -e --arg id "$id" --arg k "$raw" '(.revoked // []) | (index($id) == null) and (index($k) == null)' "$KEYSET_FILE" >/dev/null || sign_fail "key $id is revoked in $KEYSET_FILE"
  pem_from_raw_b64 "$raw" "$work/rules-pub.pem" "$work" || sign_fail "cannot build the public key of $id"
  pub="$work/rules-pub.pem"
fi
[ -r "$pub" ] || sign_fail "public key not found: $pub"
verify_sigfile_pem "$file" "$file.sig" "$pub" "$work" || sign_fail "the signature of $file does not verify against ${id:+key $id}${id:-$pub}"
echo "OK: $file is signed${id:+ by key $id}"
