#!/bin/sh
# Signs the rules documents with a RULES key and writes the detached signatures (base64 Ed25519 over the exact bytes of each
# file). Without file arguments it signs rules/index.json and every rules file the index lists.
# Usage: sign-rules.sh <rules-private-key-path> [file...]
# Each file's own "key_id" must be the id the (root-signed) keys/keyset.json gives this key with use "rules": edit it into the
# file first if needed, because the signature covers it. The key is only ever passed to openssl by path; never printed.
set -eu
SIGN_TOOL=sign-rules.sh
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib-sign.sh"

key="${1:-}"; [ -n "$key" ] || sign_fail "usage: sign-rules.sh <rules-private-key-path> [file...]"
shift
rules_dir="${CBB_RULES_DIR:-$here/../../rules}"
pub="${CBB_PUBLIC_KEY_PEM:-$(repo_keys_dir)/rules-public.pem}"

need_jq
find_openssl
assert_release_key "$key" "$pub"
work=$(mktemp -d) || sign_fail "mktemp failed"
trap 'rm -rf "$work"' EXIT
resolve_key_id "$key" rules "$work"

if [ "$#" -eq 0 ]; then
  [ -f "$rules_dir/index.json" ] || sign_fail "no $rules_dir/index.json"
  set -- "$rules_dir/index.json"
  for r in $(jq -r '.bots[].rules' "$rules_dir/index.json"); do set -- "$@" "$rules_dir/$r"; done
fi

now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
check_doc() { # <file>
  f="$1"
  [ -f "$f" ] || sign_fail "file not found: $f"
  jq -e . "$f" >/dev/null 2>&1 || sign_fail "$f is not JSON"
  jq -e --arg id "$KEY_ID" '.key_id == $id' "$f" >/dev/null \
    || sign_fail "$f: \"key_id\" must be \"$KEY_ID\" (the id of this key in the keyset); edit it in, then sign again"
  if jq -e 'has("bots")' "$f" >/dev/null; then
    jq -e '.schema == 1 and (.revision | type == "number" and . >= 1) and (.bots | length > 0) and all(.bots[]; (.id | type == "string") and (.rules | test("^[A-Za-z0-9._-]+[.]json$")))' "$f" >/dev/null \
      || sign_fail "$f is not a valid bot index (schema 1, revision, bots with id and rules file)"
  else
    jq -e '.schema == 1 and (.bot | type == "string") and (.revision | type == "number" and . >= 1) and (.profiles | length > 0)' "$f" >/dev/null \
      || sign_fail "$f is not a valid rules document (schema 1, bot, revision, profiles)"
    stem=$(basename "$f" .json)
    jq -e --arg s "$stem" '.bot == $s' "$f" >/dev/null || sign_fail "$f: \"bot\" must equal the file name ($stem)"
  fi
  if jq -e 'has("not_after")' "$f" >/dev/null; then
    jq -e --arg now "$now" '.not_after > $now' "$f" >/dev/null || sign_fail "$f is already past its not_after"
  fi
}

for f in "$@"; do check_doc "$f"; done
for f in "$@"; do
  sig=$(sign_file_b64 "$key" "$f" "$work")
  verify_sig_b64 "$key" "$f" "$sig" "$work" || sign_fail "the new signature of $f does not verify; not writing it"
  printf '%s\n' "$sig" > "$f.sig"
  echo "wrote $f.sig (key $KEY_ID, revision $(jq -r .revision "$f"))"
done
rm -f "$rules_dir/UNSIGNED"
echo "Commit the files and their signatures together."
