# Muse UI rules

`muse.json` describes what the Muse app looks like to the macOS Accessibility API: which elements to find, how the chat list is laid out for each Muse version, how messages and timestamps are written. `muse-ax` reads it instead of having those strings in code, so a Muse UI change can be fixed by publishing a new rules file, without a new binary and without anyone rebuilding anything.

The file is signed by a RULES key, not by the root key. `muse-ax rules update` first refreshes the keyset (`keys/keyset.json`, signed by the root key, the only key built into the binary), then downloads `muse.json` and `muse.json.sig` from this repository, finds the rules key named by the document's `key_id` in the keyset (it must have the purpose `rules` and be neither expired nor revoked), checks the Ed25519 signature with it, checks the schema, and only then replaces its cached copy in `~/.claude-bot-bridge/rules/current/` (`muse.json` and `muse.json.sig`, swapped together by one symlink). Anything that fails a check is ignored and the rules already in use stay. The key hierarchy, rotation and revocation are in `.github/RELEASING.md`.

`index.json` lists the bots that have rules here (`{"schema": 1, "revision": 1, "key_id": "rules-1", "bots": [{"id": "muse", "rules": "muse.json"}]}`) and is signed the same way. The updater reads it first (when it can) to find the rules file of the bot it drives; a bot the index does not list is not updated, and a missing index is not an error (the rules file next to it is still verified on its own).

## Format

```json
{
  "schema": 1,
  "bot": "muse",
  "revision": 2,
  "key_id": "rules-1",
  "not_after": "2027-06-01T00:00:00Z",
  "profiles": [ { "id": "muse-13.1", "match": { "versions": [">=13.1 <13.2"] }, "elements": {...}, "layout": {...},
                  "anchors": {...}, "composer": {...}, "messages": {...}, "labels": [...] } ]
}
```

`schema` is the format version. A binary that only knows schema 1 ignores a file with a higher number (it reports `schema_unsupported`), so a breaking change to the format needs a new plugin release first and the file switches schema afterwards. `revision` grows with every published change; a binary never goes back to a lower revision than the one it has, and the rules compiled into the binary count as a revision too (the cache wins ties).

`bot` must be the name of the file (`muse.json` has `"bot": "muse"`) and the id of a driver in the binary; a document for another bot is refused. `key_id` names the signing key in the keyset and sits inside the signed bytes. `not_after` is optional: after that moment the file is ignored and the built-in rules are used (the built-in rules never expire), so rules that were only meant to bridge a gap can retire themselves. A profile's optional `labels` are the fixed UI strings of the app (button names, the composer's words); `muse-ax doctor --dump-tree` leaves only those readable in a redacted tree.

A profile covers one generation of the Muse UI. `match.versions` lists version specs, any of which may match: a bare version (`12.1`, exact) or comparators that must all hold (`>=13.1 <14`; operators `>=`, `<=`, `>`, `<`, `=`). When no profile matches the running Muse version, `muse-ax` tries the profiles from newest to oldest and uses the first one whose required anchors are all present in the live UI ("probe mode", reported as `version_check: "probe"`). If none fits, `send` refuses with `ui_unavailable` and Claude hands the task over through the board.

`elements` holds one matcher per UI element: `role`, a `title` condition (`equals`, `prefix`, `suffix`, `contains`, `nonEmpty`, `notIn`; all given conditions must hold) and optionally `childRole` (a direct child with that role must exist). `layout.detect` says which element decides the chat-list layout (`sidebar` or `chat_switcher`), `layout.extraAnchors` lists the extra elements each layout needs, `anchors.required` lists the elements every layout needs, `composer` describes the composer button title, `messages` has the user/assistant prefixes and the timestamp regex. Unknown keys are ignored, so additive fields do not need a schema bump.

## The Muse 12.1 chat list is a denylist, so the bridge never presses it

In the 12.1 sidebar profile, `chat_button` is "any AXButton inside the `Side chats` group whose title is non-empty and not one of `New side chat`, `Side chats`, `Channels`, `Search`". Nothing in the fixtures from real 12.1 windows (titles like `Main chat` and `Check assistant availability`, roles AXButton and AXGroup) gives a positive signal that tells a chat button from some other button Meta might add to that group, so the rule cannot be made an allowlist without guessing. Instead of mitigating that risk, the bridge removes it: it never presses a chat-list button on any layout, and it never presses `New side chat`. `chat_button` is used only to READ the names of the chats (`muse_list_chats`) and to notice that a name appears twice (`chat_ambiguous`); a wrong guess there costs a wrong entry in a list, not a click on the wrong control. Opening a chat succeeds only when the requested chat is already the open one (the composer title names it exactly); any other chat is refused with `chat_switch_unsupported` and the caller is told to open it in Muse. Muse 12.1 itself is superseded by Meta's auto-update, and reading and sending in the open chat work on every layout. If Meta adds a button to the sidebar, extending `notIn` (and raising `revision`) only keeps the chat list clean; it is no longer a safety matter.

## Publishing a change

1. Edit `muse.json` and raise `revision`. Add a profile for a new Muse UI, or widen `match.versions` of an existing one after checking it live (`muse-ax status` shows `all_anchors_found`, `muse-ax selftest` checks every anchor). Keep `key_id` equal to the current rules key.
2. Regenerate what is compiled into the binary, refresh the badge and run the tests. A test fails if the compiled-in rules drift from the file, and the replay test (below) checks the new rules against every recorded Muse tree:
   ```bash
   sh plugin/scripts/sync-builtin-rules.sh
   node plugin/scripts/badge.mjs
   bash plugin/bridge/muse/test.sh
   ```
3. Sign with the rules private key (it stays on your machine; the script only hands its path to openssl, refuses a key that does not match `keys/rules-public.pem`, looks the key's id up in the root-signed keyset and refuses a file whose `key_id` differs, a revoked or expired key, and a `bot` that is not the file name). It needs OpenSSL 3 and jq (`brew install openssl@3 jq`):
   ```bash
   sh plugin/scripts/sign-rules.sh /path/to/rules-private.pem
   ```
   This signs `rules/index.json` and every rules file it lists, writes the `.sig` files and removes `rules/UNSIGNED`. `sh plugin/scripts/verify-rules.sh rules/muse.json` checks a file the way a client does.
4. Commit `rules/muse.json`, `rules/index.json` and the signatures together and push to `main`. Running installs pick the file up within a day, or immediately when `muse_status` meets a Muse version the rules do not list.

Never edit `muse.json` after signing without signing again: the signature covers the exact bytes, so even a trailing newline makes it fail. While `rules/UNSIGNED` exists the rules are not signed: clients ignore them, and the release workflow refuses to run.

## The `next` channel

`rules/next/` holds rules that are still being proven (a profile for a Muse beta, a loosened matcher). They are signed exactly like the stable rules (`sh plugin/scripts/sign-rules.sh <key> rules/next/muse.json`) and a client only fetches them when `CBB_RULES_CHANNEL=next` is set. Revisions are still monotonic: a client that tried `next` keeps those rules until a newer stable revision arrives; delete `~/.claude-bot-bridge/rules/` to go back at once. Promote a proven file by copying it over `rules/muse.json` with a higher revision.

## Replaying recorded trees

`plugin/bridge/muse/test-fixtures/trees/*.json` are accessibility trees of Muse windows in the format `muse-ax doctor --dump-tree` writes (redacted: chat names are hashes, message text is dropped). Each carries what every profile must make of it: the layout, the anchors missing for typing, the profile chosen for its own Muse version and for an unknown future version, the chat list and the open chat. `TreeReplayTests` (run by CI in a named step) replays every fixture against EVERY profile in `rules/muse.json` itself, so a rules change that breaks a known Muse version fails before it is signed. A profile you add must be given an expectation in each fixture. To add a tree: run `muse-ax doctor --dump-tree` on the new Muse, read through the file, add an `"expect"` block to it and put it in the folder. The fixtures that exist now were built by hand from the real 12.1 and 13.1 strings in the unit tests (their `source` field says so); replace them with real captures when you have them.
