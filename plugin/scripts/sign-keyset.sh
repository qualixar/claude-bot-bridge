#!/bin/sh
# Signs keys/keyset.json with the ROOT private key and writes keys/keyset.json.sig (base64 Ed25519 signature over the
# exact bytes of the file). Run this on an offline machine; the root key never goes to GitHub.
# Usage: sign-keyset.sh <root-private-key-path> [keyset-file]
# The key is only ever passed to openssl by path; it is never read into a variable or printed.
# The previous keyset (CBB_PREVIOUS_KEYSET=<file>, its .sig next to it; else the committed keys/keyset.json when the file is in a
# git repository) sets two floors: the new keyset must be issued after it, and its not_after must not be earlier than the previous
# one's, so a keyset can never quietly shorten the life of the one it replaces. Nothing to compare with (the first keyset) = no check.
set -eu
SIGN_TOOL=sign-keyset.sh
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib-sign.sh"

key="${1:-}"; [ -n "$key" ] || sign_fail "usage: sign-keyset.sh <root-private-key-path> [keyset-file]"
file="${2:-$(repo_keys_dir)/keyset.json}"
pub="${CBB_PUBLIC_KEY_PEM:-$(repo_keys_dir)/root-public.pem}"
[ -f "$file" ] || sign_fail "keyset not found: $file"

need_jq
find_openssl
assert_release_key "$key" "$pub"

now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -e '.schema == 1 and (.issued_at | type == "string") and (.not_after | type == "string") and (.keys | type == "array" and length > 0)
       and all(.keys[]; (.id | type == "string") and (.use == "rules" or .use == "binary") and (.public_key_b64 | type == "string") and (.not_after | type == "string"))
       and ([.keys[].id] | length == (unique | length)) and ((.revoked // []) | type == "array")' "$file" >/dev/null \
  || sign_fail "$file is not a valid keyset (schema 1, issued_at, not_after, keys with id/use/public_key_b64/not_after, no duplicate ids)"
jq -e --arg now "$now" '.issued_at <= $now' "$file" >/dev/null || sign_fail "issued_at is in the future; set it to now (UTC) so installs accept it as the newest keyset"
jq -e --arg now "$now" '.not_after > $now' "$file" >/dev/null || sign_fail "the keyset is already past its not_after"
work=$(mktemp -d) || sign_fail "mktemp failed"
trap 'rm -rf "$work"' EXIT
check_against_previous() {
  prev="${CBB_PREVIOUS_KEYSET:-}"
  if [ -z "$prev" ] && command -v git >/dev/null 2>&1; then
    dir=$(cd "$(dirname "$file")" && pwd)
    if git -C "$dir" ls-files --error-unmatch "$(basename "$file")" >/dev/null 2>&1 \
       && git -C "$dir" show "HEAD:./$(basename "$file")" > "$work/prev.json" 2>/dev/null \
       && git -C "$dir" show "HEAD:./$(basename "$file").sig" > "$work/prev.json.sig" 2>/dev/null; then
      prev="$work/prev.json"
    fi
  fi
  [ -n "$prev" ] || return 0
  [ -f "$prev" ] && [ -f "$prev.sig" ] || sign_fail "the previous keyset or its signature is missing: $prev"
  # Only a keyset the root really signed can be a floor; an unverifiable one is refused rather than ignored.
  verify_sigfile_pem "$prev" "$prev.sig" "$pub" "$work" || sign_fail "the previous keyset $prev is not signed by the root key; fix CBB_PREVIOUS_KEYSET"
  cmp -s "$prev" "$file" && return 0   # re-signing the unchanged keyset is fine
  jq -e --slurpfile p "$prev" '.not_after >= $p[0].not_after' "$file" >/dev/null \
    || sign_fail "not_after ($(jq -r .not_after "$file")) is earlier than the previous keyset's ($(jq -r .not_after "$prev")); a new keyset must not shorten the life of the old one"
  jq -e --slurpfile p "$prev" '.issued_at > $p[0].issued_at' "$file" >/dev/null \
    || sign_fail "issued_at ($(jq -r .issued_at "$file")) is not after the previous keyset's ($(jq -r .issued_at "$prev")); installs would ignore it as not newer"
}
check_against_previous
root_raw=$(raw_pub_b64 "$key")
jq -e --arg k "$root_raw" 'all(.keys[]; .public_key_b64 != $k)' "$file" >/dev/null || sign_fail "the ROOT key must never be listed in the keyset"

sig=$(sign_file_b64 "$key" "$file" "$work")
verify_sig_b64 "$key" "$file" "$sig" "$work" || sign_fail "the new signature does not verify; not writing it"
printf '%s\n' "$sig" > "$file.sig"
rm -f "$(dirname "$file")/UNSIGNED"
echo "wrote $file.sig (issued $(jq -r .issued_at "$file"), expires $(jq -r .not_after "$file"), keys: $(jq -r '[.keys[].id] | join(", ")' "$file"), revoked: $(jq -r '(.revoked // []) | length' "$file"))."
echo "Next: sh plugin/scripts/sign-rules.sh <rules-private-key>, then sh plugin/scripts/sync-builtin-rules.sh and rebuild the bundle. Commit everything."
