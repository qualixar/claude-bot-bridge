#!/bin/sh
# Verifies keys/keyset.json against keys/keyset.json.sig with the ROOT public key, and checks its dates.
# Usage: verify-keyset.sh [keyset-file] [root-public-key-pem]. Exit 0 only when the signature is valid and the keyset has not
# expired. Prints a ::warning:: line when it expires within 60 days (renew it: .github/RELEASING.md).
set -eu
SIGN_TOOL=verify-keyset.sh
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib-sign.sh"
file="${1:-$(repo_keys_dir)/keyset.json}"
pub="${2:-$(repo_keys_dir)/root-public.pem}"
[ -f "$file" ] || sign_fail "keyset not found: $file"
[ -f "$file.sig" ] || sign_fail "signature not found: $file.sig"
[ -r "$pub" ] || sign_fail "root public key not found: $pub"
need_jq
find_openssl
work=$(mktemp -d) || sign_fail "mktemp failed"
trap 'rm -rf "$work"' EXIT
verify_sigfile_pem "$file" "$file.sig" "$pub" "$work" || sign_fail "the signature of $file does not verify against $pub"
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -e --arg now "$now" '.not_after > $now' "$file" >/dev/null || sign_fail "the keyset expired on $(jq -r .not_after "$file"); issue a new one"
soon=$(date -u -v+60d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+60 days' +%Y-%m-%dT%H:%M:%SZ)
jq -e --arg soon "$soon" '.not_after > $soon' "$file" >/dev/null || echo "::warning::the keyset expires on $(jq -r .not_after "$file"); issue a new one before then (.github/RELEASING.md)"
echo "OK: $file is signed by the root key in $pub (expires $(jq -r .not_after "$file"))"
