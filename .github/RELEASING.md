# Releasing

A release is a `vX.Y.Z` tag. The `release` workflow builds the universal `muse-ax`, signs the manifest with the binary key,
attests the build provenance and attaches `muse-ax-macos-universal.tar.gz` and `binary-manifest.json` to the GitHub release. The
plugin's updater downloads that manifest from `releases/download/v<plugin version>/binary-manifest.json`, so the tag,
`plugin/.claude-plugin/plugin.json`, `plugin/bridge/muse/mcp/package.json`, `plugin/bridge/muse/mcp/src/version.js`,
`plugin/bridge/muse/binary-manifest.json` and `BridgeInfo.version` (Canary.swift) must all carry the same version. The workflow
fails otherwise. It also fails while `keys/UNSIGNED` or `rules/UNSIGNED` exist.

## The key hierarchy

Three kinds of Ed25519 keys, three different jobs. The binary and the MCP server embed only the root public key
(`plugin/release-signing-public.pem`, the same file as `keys/root-public.pem`).

| Key | Signs | Private key lives | Public key |
| --- | --- | --- | --- |
| root | `keys/keyset.json` and nothing else | offline, on your machine only. Never in GitHub: not a secret, not an environment secret, not a file in the repo | `keys/root-public.pem` |
| rules key (`rules-1`) | `rules/index.json`, `rules/<bot>.json` | your machine (signing is a manual step) | `keys/rules-public.pem`, and listed in the keyset |
| binary key (`binary-1`) | `binary-manifest.json` | the `release` environment secret `CBB_BINARY_SIGNING_KEY` | `keys/binary-public.pem`, and listed in the keyset |

`keys/keyset.json` lists the rules and binary public keys by id, with a purpose (`use`: `rules` or `binary`), an expiry
(`not_after`) and a `revoked` list. `keys/keyset.json.sig` is the root's detached signature over the exact bytes. The binary and
the MCP server ship a copy and refresh it from `raw.githubusercontent.com/qualixar/claude-bot-bridge/main/keys/keyset.json`
(`muse-ax rules update`, once a day; the MCP server when it has to install a binary).

Every machine remembers the newest keyset it has verified, in `<CBB_HOME>/keys/current` (default `~/.claude-bot-bridge/keys/current`;
one folder, written atomically, shared by the helper and the MCP server). That keyset's `issued_at` is a floor, for rules and for binary
manifests alike: a keyset that verifies against the root key but is not NEWER than the one already known is refused, so a failed fetch,
a stale mirror or a replayed old copy can never bring a revoked key back. Among the cached, the compiled-in and the downloaded copy the
newest `issued_at` wins. If that newest keyset has expired, nothing is trusted (the error says `keyset expired`) and an older keyset that
has not lapsed yet does not take over: renew the keyset before its `not_after`.

Rules and manifests carry a `key_id`, inside the signed bytes. A client accepts a document only when its `key_id` names a keyset key
of the right purpose that is neither expired nor revoked, and the signature verifies with that key. The root key signs no rules and no
manifests, and the rules key cannot sign a binary. There is no root-signed fallback: a document without a `key_id` is never accepted,
and a client with no keyset at all trusts nothing (it keeps its built-in rules and cannot install a prebuilt binary).

## One-time setup: signing the trust material (offline)

The repository holds a draft `keys/keyset.json` listing the published rules and binary keys, with `keys/UNSIGNED` and
`rules/UNSIGNED` as markers. On the machine that holds the private keys (OpenSSL 3 and jq installed: `brew install openssl@3 jq`):

```bash
sh plugin/scripts/sign-keyset.sh /path/to/root-private.pem        # root key: writes keys/keyset.json.sig, removes keys/UNSIGNED
sh plugin/scripts/sign-rules.sh  /path/to/rules-private.pem       # rules key: signs rules/index.json and rules/muse.json, removes rules/UNSIGNED
sh plugin/scripts/sync-builtin-rules.sh                           # compiles the signed keyset (and the rules) into the binary and the MCP sources
(cd plugin/bridge/muse/mcp && npm run build)                      # rebuilds dist/index.mjs with the keyset inside
bash plugin/bridge/muse/test.sh && (cd plugin/bridge/muse/mcp && npx vitest run)
```

Each script refuses a key that is not the published one for its job (`keys/root-public.pem`, `keys/rules-public.pem`,
`keys/binary-public.pem`), and `sign-rules.sh` and `sign-manifest.sh` also refuse to run until the keyset is signed (they look the
key's id up in it), and refuse a revoked or expired key. `sign-keyset.sh` compares the new keyset with the previous one (the committed
`keys/keyset.json` and its signature, or `CBB_PREVIOUS_KEYSET=<file>`; it must be root-signed) and refuses a `not_after` earlier than
the previous keyset's, or an `issued_at` that is not after it (clients would ignore such a keyset as not newer). Edit `keys/keyset.json` (issue date, expiry, keys) BEFORE signing: any change
after signing needs a new signature, because the signature covers the exact bytes. Commit the keyset, the rules and all signatures
together.

## One-time repository setup

1. Settings, Environments, New environment: `release`.
   - Required reviewers: at least one account that is allowed to approve a release. The signing job does not start until a
     reviewer approves it. A one-person project should still turn this on: it is the pause in which the tag, the commit and the
     build artifact get looked at. Leave "Prevent self-review" on if a second reviewer exists.
   - Deployment branches and tags: "Selected branches and tags", add the tag rule `v*`.
2. Environment secrets of `release`: `CBB_BINARY_SIGNING_KEY` = the Ed25519 private key (PEM) whose public half is
   `keys/binary-public.pem`. Do not create a repository-level secret of that name, so no other workflow or job can read it, and delete
   the old `CBB_SIGNING_KEY` if it exists. The signing script refuses any key that is not the published binary key, so a wrong paste
   fails the release instead of producing a manifest nobody can verify. The root key and the rules key are NOT stored in GitHub.
3. Settings, Rules, New tag ruleset: target `v*`, restrict creations and block updates and deletions, so only the maintainers
   can create a release tag and a published tag cannot be moved.
4. Settings, Actions, General: workflow permissions "Read repository contents", and "Require actions to be pinned to a full-length
   commit SHA" (the workflow already is). Build provenance needs nothing else: the `sign-and-publish` job is the only one that asks for
   `id-token: write` and `attestations: write`.

## Cutting a release

0. CI (`.github/workflows/ci.yml`) must be green on `main`. It does not run `claude plugin validate` (that needs the whole Claude Code CLI), so run it yourself:
   `claude plugin validate ./plugin && claude plugin validate ./plugin/optional/board && claude plugin validate .`
1. Bump the version in the six places above and merge to `main`. If `rules/muse.json` changed, `node plugin/scripts/badge.mjs` refreshes
   the verified-version badge (CI checks it).
2. `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The `build` job runs without secrets and with a read-only token; it checks that no key material is still `UNSIGNED`, runs
   `verify-keyset.sh` and `verify-rules.sh` (the signatures must verify, not just exist), then the Swift and MCP tests, and stops if
   any of them fail. When it finishes, `sign-and-publish` waits for the reviewer. Check that the tag points at the
   commit you mean, then approve.
4. After publishing, confirm `https://github.com/qualixar/claude-bot-bridge/releases/download/vX.Y.Z/binary-manifest.json`
   downloads and that its `signature` is not empty and its `key_id` is `binary-1` (or the current binary key id). Anyone can check the build provenance:
   `gh attestation verify muse-ax-macos-universal.tar.gz --repo qualixar/claude-bot-bridge`.

## Publishing new rules

Edit `rules/muse.json` (raise `revision`; keep `key_id` equal to the current rules key), run `node plugin/scripts/badge.mjs` and
`sh plugin/scripts/sync-builtin-rules.sh`, then `sh plugin/scripts/sign-rules.sh /path/to/rules-private.pem`, run the tests (the replay
test checks the new rules against every recorded Muse tree) and commit the rules and signatures together. `rules/next/` is an opt-in
channel (`CBB_RULES_CHANNEL=next`) for rules that are still being proven; it uses the same signing. Details: `rules/README.md`.

## Rotating keys

Rotation is routine and needs no client update: publish a keyset that lists the new key, then sign with it. The order matters; the wrong
order fails closed (clients ignore what they cannot verify and keep working with what they have).

1. Offline: generate the new key.
   ```bash
   openssl genpkey -algorithm ed25519 -out rules-2-private.pem
   openssl pkey -in rules-2-private.pem -pubout -out keys/rules-public.pem               # the script checks against this file
   openssl pkey -in rules-2-private.pem -pubout -outform DER | tail -c 32 | base64        # the public_key_b64 for the keyset
   ```
2. Edit `keys/keyset.json`: add `{"id": "rules-2", "use": "rules", "public_key_b64": "...", "not_after": "..."}`, keep the old key until
   its rules have been replaced, and set `issued_at` to now (UTC; it must be newer than the keyset already published). Sign it with the
   root key (`sign-keyset.sh`). For the binary key do the same with `binary-2`, `keys/binary-public.pem` and the `CBB_BINARY_SIGNING_KEY` environment secret.
3. Set `"key_id": "rules-2"` in `rules/index.json` and `rules/muse.json`, raise the `revision`, sign with `sign-rules.sh`, run
   `sync-builtin-rules.sh`, rebuild the bundle and push everything in one commit. A client that sees the new rules before the new keyset
   refuses them (`key_unknown`) and tries again at its next refresh.
4. When nothing is signed with the old key any more, remove it from the keyset (or let its `not_after` pass) and issue a new keyset.

Renew the keyset itself before its `not_after` (one year; CI warns 60 days ahead): bump `issued_at` and `not_after`, sign with the root
key, commit. An expired keyset stops all update verification with the error `keyset expired` (clients keep working on their built-in
rules and the binary they have), and the machines that already saw it do not fall back to an older one.

## Revoking a key

A key that may be exposed (a leaked rules key, a stolen binary key) is revoked by a NEWER keyset. Do it at once:

1. Offline: edit `keys/keyset.json`: add the key id (or its `public_key_b64`) to `revoked`, add a replacement key as in "Rotating keys", set
   `issued_at` to now, sign with the root key. Commit and push that first.
2. Re-sign what the revoked key had signed with the replacement key (`sign-rules.sh`), or cut a new release for a binary key. Push.
3. Effect: clients that refresh pick up the revocation at their next `muse-ax rules update` (daily, and whenever the MCP server installs a
   binary). Cached rules signed with the revoked key stop being used immediately at the next load (the built-in rules apply until the new
   ones arrive), and a manifest signed with it is refused. Nothing a revoked key signs afterwards verifies.
4. If the key was the binary key and a bad release went out: delete the release, tell users to `claude plugin update`, and note that an
   already installed binary stays until the next release replaces it (`muse-ax.prev` is the rollback, see `plugin/README.md`).

If the ROOT key itself is lost or leaked, the keyset cannot fix it: nothing signs above the root. Generate a new root, put its public key
into `plugin/release-signing-public.pem`, `keys/root-public.pem`, `ReleaseKey.publicKeyBase64` (RulesVerifier.swift) and
`mcp/src/release-key.js`, sign a new keyset with it, and ship a new plugin release. Installs get the new root through
`claude plugin update` (the plugin code is the trust anchor, see the trust boundary in `plugin/README.md`), which is why `main` is
protected and the root private key is never anywhere but offline.

## Updating pinned actions

Every `uses:` line is a full commit SHA with the tag it came from in a comment. To move one:
`gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`, replace the SHA and the comment, and read the diff between the two
versions before merging. (`actions/attest-build-provenance` is pinned to the SHA of `v4.2.2`, resolved that way.)
