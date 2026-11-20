#!/bin/sh
# Signs binary-manifest.json with a BINARY key: writes .key_id (the id the keyset gives the key) and .signature = base64
# Ed25519 over the canonical manifest (jq -S -c 'del(.signature)', no trailing newline; key_id is part of it). Used by the
# release workflow.
# Usage: sign-manifest.sh <binary-private-key-path> <manifest.json>
#        sign-manifest.sh --key-env VAR <manifest.json>   (the PEM is read from $VAR; used by the release workflow)
set -eu
SIGN_TOOL=sign-manifest.sh
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib-sign.sh"

# Key source: a file path, or --key-env VAR (the PEM comes from that environment variable; it is written only to
# a private 0600 file inside this script's own temp directory, which is removed on exit).
key_env=""
if [ "${1:-}" = "--key-env" ]; then key_env="${2:-}"; shift 2 2>/dev/null || sign_fail "--key-env needs a variable name"; fi
key="${1:-}"; manifest="${2:-}"
if [ -n "$key_env" ]; then manifest="${1:-}"; key=""; fi
[ -f "$manifest" ] && { [ -n "$key" ] || [ -n "$key_env" ]; } || sign_fail "usage: sign-manifest.sh <binary-private-key-path> <manifest.json>   or   sign-manifest.sh --key-env VAR <manifest.json>"
pub="${CBB_PUBLIC_KEY_PEM:-$(repo_keys_dir)/binary-public.pem}"
need_jq

find_openssl
umask 077
work=$(mktemp -d) || sign_fail "mktemp failed"
trap 'rm -rf "$work"' EXIT
if [ -n "$key_env" ]; then
  case "$key_env" in "" | [0-9]* | *[!A-Za-z0-9_]*) sign_fail "not a valid environment variable name: $key_env" ;; esac
  eval "key_value=\${$key_env:-}"
  [ -n "$key_value" ] || sign_fail "environment variable $key_env is not set or empty"
  printf '%s\n' "$key_value" > "$work/key.pem"
  unset key_value
  key="$work/key.pem"
fi
assert_release_key "$key" "$pub"
resolve_key_id "$key" binary "$work"
jq --arg id "$KEY_ID" '.key_id = $id' "$manifest" > "$work/with-id.json"
canon=$(jq -S -c 'del(.signature)' "$work/with-id.json")
printf '%s' "$canon" > "$work/canonical.json"
sig=$(sign_file_b64 "$key" "$work/canonical.json" "$work")
verify_sig_b64 "$key" "$work/canonical.json" "$sig" "$work" || sign_fail "the new signature does not verify; not writing it"
jq --arg s "$sig" '.signature = $s' "$work/with-id.json" > "$work/signed.json"
cat "$work/signed.json" > "$manifest"
echo "signed $manifest with key $KEY_ID"
