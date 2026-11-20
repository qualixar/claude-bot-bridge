# Claude Bot Bridge plugin (`bot-bridge`)

Lets Claude Code read from and send short messages to the Meta Muse desktop app on your Mac, through the macOS Accessibility API. An optional second plugin adds a task board for longer jobs. Requires macOS 14 or later.

The plugin id is `bot-bridge` because Claude Code reserves plugin names that start with `claude-`. The marketplace keeps the name `claude-bot-bridge`.

## Install

```bash
claude plugin marketplace add qualixar/claude-bot-bridge
claude plugin install bot-bridge@claude-bot-bridge
```

Then, in Claude Code, run `/bot-bridge:setup`, or run the installer yourself:

```bash
sh <plugin directory>/scripts/install.sh
```

The installer needs macOS 14 or later, the Xcode Command Line Tools (`xcode-select --install`) and Node 20 or newer. It builds the Swift helper with `swift build -c release` and copies it to `~/.claude-bot-bridge/bin/muse-ax`. Build output stays in `~/.claude-bot-bridge/build`, not in the plugin directory. Running it again is safe. The installer leaves a marker, `~/.claude-bot-bridge/.setup-done`. Without that marker (and without `CBB_ALLOW_LOCAL_BUILD=1`) the MCP server never compiles anything at session start, so installing the plugin alone never builds code behind your back; it may still download the signed prebuilt helper (see "The helper binary").

Restart Claude Code after the first install so the `muse` MCP server is picked up. You normally run the installer only once: after that the helper keeps itself current (see "How updates work").

## What you get

MCP server `muse` with eight tools: `muse_status`, `muse_list_chats`, `muse_open_chat`, `muse_read`, `muse_send`, `muse_wait_reply`, `muse_selftest` and the read-only `muse_doctor` (a diagnostic you can paste into a bug report, see Troubleshooting). The skill `bot-bridge` tells Claude when to use direct chat and when to use the board. The skill `setup` runs the installer.

`muse_send` rules, enforced in code: the text must start with `[Claude Code]`, be one line, at most 500 characters, and it is refused when a dialog is open or Muse is answering, or when you used the keyboard or mouse in the last 3 seconds (`user_active`, nothing typed, `retry_after_seconds` says when to retry; `CBB_IDLE_SECONDS` tunes it, `0` turns it off). The helper's own clicks and key events do not count as your input: it records the moment of every event it posts (`last-post.json` in the bridge home, at most the last 30 seconds of posting) and ignores an input only when it lies within 0.4 seconds of one of those moments, so two sends in a row are not refused with `user_active` because of the first one, while a key you press in the middle of a send still counts as yours. It checks that the message arrived: the last message you sent in the chat must equal the text, not merely contain it. It takes over Muse, the mouse and the keyboard for about 3 to 5 seconds (it brings Muse to the front, clicks the composer and types; typing 500 characters is 1 to 2 seconds of that), so do not type or click until it returns.

Typing is guarded in four ways. The chat is checked to be exactly the requested one (no name prefix matching) before clicking and again before Return (`chat_changed`). The click only happens when the element under the pointer belongs to Muse and lies inside the composer (`click_target_mismatch`). The text goes in chunks of up to 20 UTF-16 units. And before Return the composer must hold exactly the intended text; if anything else is in there, for instance because you typed while the helper was typing, the composer is cleared and the send refused with `composer_mismatch`, so Return is never pressed on a wrong message. A draft you had already written in the composer is never typed over or cleared. The message is typed, never pasted. But when Accessibility cannot show the composer's text, the helper reads it back by selecting all and copying, and that touches your clipboard: it happens up to twice per send (before typing, to look for a draft of yours, and after typing, to check the text). Each time it puts a throwaway marker and then the composer text on the clipboard and restores what was there before; a clipboard manager (or Universal Clipboard) may record those values in between. Every key and mouse event it posts carries explicit modifier flags, so a key you are holding cannot leak into the message.

Three more guards run around a send. Only one `muse-ax` call drives Muse at a time: the MCP server queues every `muse_*` call, and the helper takes a lock file (`~/.claude-bot-bridge/.ui.lock`) around send, open, new-side-chat and any read or wait-reply that names a chat (those last three only succeed for the chat that is already open, see `chat_switch_unsupported`); a caller that cannot get it within 10 seconds fails with `busy` (retry after a few seconds, nothing was typed). After Return the helper checks again that the open chat is still the requested one before it reports `sent: true`; if not, the result is `sent: false` with `note: "chat_changed"`. And two buttons with the same name in the 12.x sidebar are refused (`chat_ambiguous`), because the helper cannot tell which chat you mean.

`muse_send` also accepts `dry_run: true` (`muse-ax send --dry-run`): it runs every check, types the text, verifies the composer holds it, then clears it without pressing Return, and answers `dry_run: true, would_send: true`. Every send attempt is appended to `~/.claude-bot-bridge/sends.jsonl` (time, chat, SHA-256 of the text, length, outcome code; never the text); `muse-ax history [--last N]` prints it. The file stays on your Mac.

Do not put `muse_send` on a Claude Code permission allowlist. It types into an app you are logged in to, as you, and every call should be a decision you (or a reviewed hook) can see. Allowlisting the read tools (`muse_status`, `muse_list_chats`, `muse_read`, `muse_selftest`) is fine; `muse_read` and `muse_wait_reply` results carry a note that Muse's text is untrusted data.

## Binary lookup

The MCP server looks for `muse-ax` in this order: the `CBB_MUSE_AX` environment variable, then `~/.claude-bot-bridge/bin/muse-ax`. If `CBB_MUSE_AX` is set but does not point to an executable file, the tools report that rather than falling back. If nothing is found, every tool returns `binary_missing` with the path of `install.sh`; the server itself still starts.

## Optional task board

The board is a remote MCP server you deploy yourself (the `board/` folder of this repository). Its connection lives in a separate plugin, so people without a board do not get a failing server in `/mcp`:

```bash
claude plugin install bot-bridge-board@claude-bot-bridge
```

Claude Code then asks for two settings: the board URL (ending in `/mcp`) and the owner key. The owner key is marked sensitive, so it is stored in your system's secure credential store (the macOS keychain), never in `settings.json` and never in an environment variable. Change them later with `claude plugin configure bot-bridge-board@claude-bot-bridge`.

## How updates work

Muse changes its screen without warning (it did twice in one day), so the bridge has an update path for each layer. Everything that is downloaded is signed, through a three-level key hierarchy (Ed25519). The only key built into the helper and the MCP server is the root public key, `release-signing-public.pem`. The root key signs one document, the keyset (`keys/keyset.json` in this repository, with a detached `.sig`), and nothing else; its private half stays offline on the maintainer's machine and is not in GitHub. The keyset lists the short-lived signing keys by id and purpose: a `rules` key signs the rules, a `binary` key signs the release manifest (the binary key's private half is the `release` environment secret `CBB_BINARY_SIGNING_KEY`). Rules and manifests carry a `key_id` inside their signed bytes. A client accepts a document only when that `key_id` names a keyset key of the right purpose that is neither expired nor revoked and the signature verifies with it; a rules key cannot sign a binary and the root signs neither. A key that leaks is revoked by publishing a newer keyset, without a plugin update. The keyset is compiled into both programs and refreshed from `raw.githubusercontent.com/qualixar/claude-bot-bridge/main/keys/keyset.json` together with the rules (and by the MCP server when it has to install a binary). Each machine remembers the newest keyset it has verified in `~/.claude-bot-bridge/keys/current` (one folder, shared by the helper and the MCP server) and refuses anything older, for rules and for binary manifests, so a failed download or a replayed old copy cannot undo a revocation. If the newest keyset has expired, nothing is trusted (`keyset expired`) and an older keyset does not take over. There is no root-signed fallback: a document without a `key_id` is never accepted (rotation and revocation: `../.github/RELEASING.md`).

**Rules (the Muse screen description), fastest.** What `muse-ax` looks for in Muse (element roles and titles, chat-list layout, message prefixes) is data, not code: `rules/muse.json` in this repository, plus a detached signature `rules/muse.json.sig`; `rules/index.json` (also signed) lists which bots have rules, and the helper only updates a bot the index lists. A copy of the verified-live rules is also compiled into the binary. `muse-ax rules update` refreshes the keyset, then downloads the repository file, checks the signature (by the `rules` key named in its `key_id`) and the schema, refuses rules past their optional `not_after`, and writes the pair to `~/.claude-bot-bridge/rules/current/` (`muse.json` and `muse.json.sig`); a file that fails any check, a network error or a rules file in a newer schema is ignored and the current rules stay. At start-up the helper uses the cached rules only if their signature still verifies and they are at least as new as the built-in ones. The MCP server runs the update in the background at most once every 24 hours, and at once when `muse_status` meets a Muse version the rules do not list. `muse-ax rules show` prints which rules are in use (source, revision, `key_id`, channel, keyset state). Rules still being proven can be tried with `CBB_RULES_CHANNEL=next` (opt-in, `rules/next/`). How to publish new rules: `../rules/README.md`.

**Safe degrade.** For a Muse version that no profile lists, the helper tries each profile and uses the newest whose anchors are all on screen (probe mode, `version_check: "probe"`); sending is still verified on arrival. If none fits, `muse_send` refuses with `ui_unavailable`, types nothing, and the skill sends the task through the board. Before every send the matched profile's anchors are re-checked, so a patch release that moved things falls back the same way.

**The helper binary.** When the MCP server starts it compares `~/.claude-bot-bridge/bin/muse-ax version` with the plugin version. If the helper is missing or differs, it fetches the manifest that the release workflow attaches to that exact version, `https://github.com/qualixar/claude-bot-bridge/releases/download/v<plugin version>/binary-manifest.json`, and checks its Ed25519 signature: the manifest must name (`key_id`) a `binary` key of the keyset, which the server takes from its compiled-in copy refreshed from GitHub; a manifest whose version is not the plugin version, or that is a placeholder, is rejected. Only if that manifest is unavailable or invalid does it fall back to `bridge/muse/binary-manifest.json`, and only when that bundled copy is itself signed, not a placeholder and for the same version (the copy in the repository is a placeholder, so in practice the release manifest is what delivers the binary). With a good manifest it downloads the archive to a temporary file, checks the sha256, checks that the archive holds exactly one entry, named `muse-ax` (an AppleDouble `._muse-ax` entry or anything else rejects it), runs `codesign --verify` (an unsigned binary is accepted because the manifest signature and the sha256 already vouch for it; a broken signature, or a `codesign` that cannot run, is a failure), runs the new binary's `version`, and only then swaps it in with an atomic rename. The previous binary is kept as `muse-ax.prev`. Concurrent starts are serialised by a lock file that records the owner's pid and a nonce: it is only released by its owner and only taken over when the owning process is gone and the lock is more than 20 minutes old.

If the download or any check fails, the server compiles the helper with `install.sh` (a local `swift build`) only when you consented: you ran `/bot-bridge:setup` or `install.sh` before (it leaves `~/.claude-bot-bridge/.setup-done`, and an older install's `build/` directory counts too), or `CBB_ALLOW_LOCAL_BUILD=1` is set, and the Xcode Command Line Tools exist. Otherwise nothing is built: the tools answer `binary_missing` with a one-line fix (run `/bot-bridge:setup`). A failed version is not retried for 24 hours, but only while an older WORKING binary exists; with no helper, or a broken one, every start retries. While this runs, tools answer `updating` with `retry_after_seconds` instead of hanging. It is skipped when `CBB_MUSE_AX` is set.

**The plugin itself.** The MCP server checks `releases/latest` on GitHub at most once every 24 hours (3 second timeout, failures silent) and adds `update_available: {current, latest, how}` to `muse_status` when a newer release exists. Plugin updates themselves go through Claude Code: `claude plugin update bot-bridge@claude-bot-bridge`, or turn on auto-update for the marketplace in `/plugin`.

**Canary (optional).** `sh scripts/install.sh --with-canary` installs an hourly launchd agent that runs `muse-ax canary`. When the Muse version differs from `lastSeenMuseVersion` in `~/.claude-bot-bridge/state.json`, it runs the read-only selftest, refreshes the rules, records the result and shows a notification: "Muse updated to X.Y: bridge OK" or "Muse X.Y changed its layout: tasks will go through the board until rules update". The first run only records a baseline. Because launchd starts `muse-ax` itself, add `~/.claude-bot-bridge/bin/muse-ax` under Accessibility (and again after a rebuild, which changes its signature). `sh scripts/install.sh --remove-canary` uninstalls it. Logs are in `~/.claude-bot-bridge/logs/`; `canary.log` and `canary.err.log` are trimmed to their newest 1 MB whenever they pass 2 MB.

### Rolling back

If a new binary misbehaves, restore the previous one: `mv ~/.claude-bot-bridge/bin/muse-ax.prev ~/.claude-bot-bridge/bin/muse-ax` and set `CBB_NO_AUTO_UPDATE=1` (or `CBB_MUSE_AX` set to the full path of that binary) so the server does not replace it again. To go back to the rules compiled into the binary, delete `~/.claude-bot-bridge/rules/`.

### Environment variables

| Variable | Effect |
| --- | --- |
| `CBB_MUSE_AX` | Use this binary; disables binary auto-update. |
| `CBB_NO_AUTO_UPDATE=1` | No binary download and no rules refresh from the MCP server. |
| `CBB_ALLOW_LOCAL_BUILD=1` | Lets the MCP server compile the helper with `install.sh` when no verified prebuilt binary can be installed, without having run setup first. |
| `CBB_NO_UPDATE_CHECK=1` | No plugin-release check; `update_available` never appears. |
| `CBB_RULES_URL` | Where `muse-ax rules update` fetches `muse.json` (the signature is read from the same URL plus `.sig`; the bot index is looked for next to it). https, or http to this machine; the signature must still verify. With it set and no `CBB_KEYSET_URL`, the keyset is not fetched at all. |
| `CBB_RULES_CHANNEL` | `next` fetches the rules of the opt-in channel `rules/next/`; anything else is `stable`. To go back, delete `~/.claude-bot-bridge/rules/`. |
| `CBB_KEYSET_URL` | Where the keyset (`keyset.json` plus `.sig`) is fetched. Default: the one in this repository. It must still be signed by the root key. |
| `CBB_BOT` | Which bot driver `muse-ax` uses. Default `muse`, the only one there is. |
| `CBB_IDLE_SECONDS` | How long you must have been idle (no key or mouse input) before `muse_send` takes over. Default `3`; `0` turns the check off. |
| `CBB_HOME` | State directory instead of `~/.claude-bot-bridge`. `install.sh` (build, binary, markers, canary) and `--uninstall` honour it too. |

## Troubleshooting

`ax_trusted` is false in `muse_status`: give the app that runs Claude Code (Terminal, iTerm, the Claude app, or your IDE) permission in System Settings, Privacy & Security, Accessibility, then restart that app.

`muse_status` says Muse is not running, or no window is found: open Muse and leave one window open. The Mac must be awake and unlocked.

`binary_missing`: run `/bot-bridge:setup` or `install.sh`. If `swift` is not found, run `xcode-select --install`. When the automatic install failed, the message says why.

`updating`: the helper is being replaced in the background (a download takes seconds, a local build a few minutes). The result carries `retry_after_seconds`; retry once after that.

`ui_unavailable` from `muse_send`: Muse changed its screen, no rules profile fits it and probe mode found no usable layout, so nothing was typed. The error lists `muse_version` and the anchors that were missing. Claude hands the task to the board instead (see the skill). Rules are re-fetched automatically; you can force it with `~/.claude-bot-bridge/bin/muse-ax rules update`.

`sheet_open` or a refusal about a dialog: close the dialog in Muse, then retry.

`composer_mismatch`: the composer did not hold exactly the message before Return (you typed at the same time, there was already a draft, or its text could not be read back), so nothing was sent; the composer was cleared unless it was your own draft. Retry when you are not typing. `click_target_mismatch`: something other than Muse's composer was under the pointer (another window on top), so nothing was typed. `chat_changed`: the open chat was not the requested one at the moment of clicking or of pressing Return.

`user_active` or `busy` from `muse_send`: nothing was typed. You were using the keyboard or mouse a moment ago, or another call holds the Muse window. Wait `retry_after_seconds` and retry.

`chat_list_hidden`: Muse hides its chat list when the window is narrow (the error gives the width), so `muse_list_chats` cannot read it. Widen the Muse window, about 900 px works, and retry. `muse_status` and `muse_selftest` still report OK in a narrow window and say `chat_list_visible: false`; reading and sending in the open chat do not need the list.

`chat_ambiguous`: two sidebar buttons in Muse 12.x have the requested name, so the helper cannot tell which chat is the open one. Rename one of the chats in Muse, then retry.

`chat_switch_unsupported`: the bridge never presses a chat-list button, on any Muse version (the 12.x sidebar, the 13.x "Chats" button, or a layout it does not know), and it never presses "New side chat". `muse_open_chat`, or `muse_read`, `muse_send` and `muse_wait_reply` with a `chat`, succeed only when that chat is already the open one; for any other chat the answer is `chat_switch_unsupported` and nothing is clicked or typed. Open (or create) the chat you want in Muse yourself, then retry. Reading and sending in the open chat work on every layout. `muse-ax status` shows `layout`, `muse_version`, `profile`, `rules` (where they came from) and `version_check`: `verified` (this Muse version is listed in the rules), `probe` (not listed, but the screen matches a known layout; sending still works and is verified on arrival) or `unverified` (no rules fit).

A chat name is refused although it is open: Muse renames side chats after the first message. Run `muse_status` (`current_chat`) or `muse_list_chats` again and use the new name.

`muse_selftest` fails with missing anchors: Meta changed the Muse UI. The helper depends on Muse's current labels, so a Muse update can break it until the rules are updated (see below).

Reporting a problem: run `~/.claude-bot-bridge/bin/muse-ax doctor --text` (or ask Claude to call `muse_doctor`) and paste the output. It is read-only and prints the Muse version and build, the chat-list layout, which anchors matched, the window size, which rules are in use (source, revision, `key_id`), the keyset state, the helper version, the lock state and the time and outcome of the last 5 sends; it never contains a chat name or message text. For a Muse version the rules do not know, `muse-ax doctor --dump-tree [path]` also writes a REDACTED accessibility tree (default `~/.claude-bot-bridge/doctor/tree-<version>-<time>.json`, mode 0600) and prints a draft profile for that version. Roles, subroles, identifiers and frames are kept; every title, value and description is replaced by a short hash (stable inside the file, different in every dump) unless it is a fixed UI label from the rules, chat names are always hashed, and message text is never read at all. Look through the file before you attach it anyway; the MCP tool never writes it.

Check the helper without Claude: `~/.claude-bot-bridge/bin/muse-ax status` prints one JSON line.

## Trust boundary

The plugin's code comes from the default branch of this repository through Claude Code's marketplace, and that includes the pinned ROOT public key inside `bridge/muse/mcp/dist/index.mjs` and `release-signing-public.pem` (and the compiled-in keyset). Whoever can change `main` can change which key the helper trusts, so protect `main` (pull request required, CI required, no force pushes; see `../docs/github-repo-settings.md`). The signatures protect what is downloaded after install (rules, helper binary, keyset), not the plugin code itself. Release binaries also carry a build provenance attestation from the release workflow: `gh attestation verify muse-ax-macos-universal.tar.gz --repo qualixar/claude-bot-bridge`.

## Uninstall

```bash
sh <plugin directory>/scripts/install.sh --uninstall
claude plugin uninstall bot-bridge@claude-bot-bridge
```

`--uninstall` removes `~/.claude-bot-bridge` (or `CBB_HOME`): the helper, build output, rules cache, state, send journal and logs. It also boots out and deletes the canary launchd agent if you installed it. It refuses to run when `CBB_HOME` is not an absolute path strictly inside your home directory, and also when the folder does not prove it is ours: it must hold one of the markers the installer leaves (`.cbb-home`, written by every install; `.setup-done`; or an installed `bin/muse-ax`), and without `CBB_HOME` the folder must be called `.claude-bot-bridge`. Pointing `CBB_HOME` at a project folder therefore deletes nothing. It touches nothing else. Two steps stay manual: remove the `muse-ax` entry (and the terminal or app you granted for Claude Code, if you no longer need it) under System Settings, Privacy & Security, Accessibility, and uninstall the plugin as shown above. If you installed the board plugin, `claude plugin uninstall bot-bridge-board@claude-bot-bridge` too.

## Development

```bash
bash bridge/muse/test.sh                       # Swift unit tests, no Muse needed
cd bridge/muse/mcp && npm install && npx vitest run   # Node tests (the end-to-end rules tests run when a debug build exists)
npm run build                                  # rebuild dist/index.mjs
npm run test:e2e                               # builds the debug muse-ax, then runs the rules-update tests against a local HTTP server
sh scripts/sync-builtin-rules.sh               # after editing ../rules/muse.json or signing the keyset: regenerates the rules and keyset compiled into muse-ax and the MCP sources
node scripts/badge.mjs                         # rules/muse.json -> docs/badges/muse-verified.json (CI runs it with --check)
bash bridge/muse/test.sh --filter TreeReplayTests   # replays the recorded Muse trees in bridge/muse/test-fixtures/trees/ against every profile in ../rules/muse.json
```

The plugin ships `bridge/muse/mcp/dist/index.mjs`, a bundle of the MCP server with its dependencies, so the installed plugin needs no `npm install`. A test fails if the bundle is out of date with `src/`. Everything Muse-specific sits behind one boundary on each side: the Swift protocol `BotDriver` (bundle id, rules namespace, profile selection, status/read/send and the rest; `MuseDriver` is the only implementation, chosen through `BotRegistry`) and `mcp/src/bots/<bot>.js`, registered by id in `mcp/src/bots/index.js`. Rules are keyed by the same id: `rules/<bot>.json` with `"bot": "<bot>"`, listed in the signed `rules/index.json`. Another bot would add those three things.

## Privacy

The `muse` server runs locally. It reads and writes only the Muse app on your Mac. The only network calls are plain GETs to GitHub: `raw.githubusercontent.com` (the rules file and its signature), `github.com` release downloads (the signed manifest and the helper binary, only when the helper needs replacing) and `api.github.com` (the latest-release check). They carry no account, no identifier of yours, no usage data and no Muse content (GitHub sees your IP address, as with any download); there is no telemetry of any kind. `CBB_NO_AUTO_UPDATE=1` and `CBB_NO_UPDATE_CHECK=1` switch all of them off. The optional board plugin sends your owner key and task text to the board URL you set, and to nobody else. Text that Muse produces is untrusted input to Claude Code, and the skill tells Claude to treat it that way. The send journal (`sends.jsonl`) holds hashes, never message text, and is never uploaded.

## License

AGPL-3.0-only.
