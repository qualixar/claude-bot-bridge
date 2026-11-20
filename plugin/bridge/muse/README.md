# muse-ax

A small bridge that lets Claude Code read from, and send short messages to, the Meta Muse desktop app
(bundle id `com.meta.endo`) on this Mac through macOS Accessibility. A Swift CLI does the work; a tiny
Node MCP server wraps it. Every CLI command prints one JSON line (`"ok": true|false`).

## Build and install

Normally the plugin installer does this: `plugin/scripts/install.sh` builds with `swift build -c release`
and installs the binary to `~/.claude-bot-bridge/bin/muse-ax`. By hand:

```bash
swift build -c release          # binary: .build/release/muse-ax
(cd mcp && npm install && npm run build)   # MCP layer, Node 20+; rebuilds dist/index.mjs
```

The calling app (Terminal, Claude desktop, etc.) needs Accessibility permission:
System Settings > Privacy & Security > Accessibility. `muse-ax status` reports `ax_trusted`.

## CLI

| Command | What it does |
|---|---|
| `status` | running? AX trusted? each UI anchor found? current chat |
| `chats` | list the chat names (read-only: on a sidebar layout every chat, otherwise only the open one) |
| `open <name>` | succeeds only when that chat is already open; any other chat is refused with `chat_switch_unsupported` (the bridge never presses a chat-list button) |
| `new-side-chat` | always refused with `chat_switch_unsupported` (the bridge never presses "New side chat"); create it in Muse yourself |
| `read [--chat n] [--last N]` | messages as `{role: user\|assistant, text, time?}` |
| `send [--dry-run] --chat n <text>` | send one short message, then verify it appeared; `--dry-run` types, verifies and clears without Return |
| `history [--last N]` | the send journal (`sends.jsonl`: time, chat, SHA-256, length, outcome; never the text) |
| `wait-reply --chat n [--timeout s]` | wait for a new, finished assistant reply (default 120 s) |
| `selftest` | check every anchor; fails loudly if Meta changed the UI (a hidden chat list is reported as `chat_list_visible: false`, not a failure) |

`time` is the most recent centred time separator above the message, as Muse shows it. Consecutive
assistant blocks are merged into one message. Muse only renders the messages near the viewport, so
`read` returns what is currently loaded.

## MCP server

Tools: `muse_status`, `muse_list_chats`, `muse_open_chat`, `muse_read`, `muse_send`,
`muse_wait_reply`, `muse_selftest`. Inputs are validated at the boundary (chat names, `last` 1-200,
`timeout` 1-600, send rules) before the CLI is spawned. Binary location: `$CBB_MUSE_AX`, then
`~/.claude-bot-bridge/bin/muse-ax`; if neither exists the tools return `binary_missing` with the fix.
Muse-specific code is in `mcp/src/bots/muse.js`. The plugin runs the bundled `mcp/dist/index.mjs`.

## Safety rules for `send`

- Text must start with `[Claude Code]`, have content after it, be one line, and be at most 500 characters.
- Refused if Muse is not running, a sheet/dialog is open, or the composer frame is not found. Length is counted in Unicode scalars, and control characters, line/paragraph separators, bidirectional controls and empty or invisible-only bodies are refused (`test-vectors/send-validation.json` is shared by the Swift and Node tests).
- The target chat must already be the open one (the bridge never switches chats, see `open`); it checks the composer belongs to EXACTLY that chat (no prefix matching), and checks it again right before clicking and right before Return (`chat_changed`).
- Before clicking, the element under the click point must belong to Muse and lie inside the composer frame (`click_target_mismatch`); focusing through Accessibility is tried first.
- Typing goes in chunks of up to 20 UTF-16 units (cut between grapheme clusters). Before Return the composer's text must EQUAL the intended text (normalised); otherwise it is cleared and the send refused with `composer_mismatch`. A draft already in the composer is never typed over or cleared.
- The composer text is read from the focused native text element when Accessibility exposes it; otherwise by select-all + copy (up to twice per send), with the clipboard saved and restored; clipboard managers may record the values in between. The message itself is typed, never pasted. The pre-Return comparison collapses whitespace (it is not whitespace-blind); the arrival check after Return tolerates Muse's line wrapping.
- Every posted key and mouse event carries explicit modifier flags, so a key the user is holding cannot leak in.
- Concurrency: send, open, new-side-chat and chat-targeted read/wait-reply hold `<CBB_HOME>/.ui.lock` (10 s, then `busy`). `send` also refuses with `user_active` when keyboard or mouse input happened in the last `CBB_IDLE_SECONDS` (default 3, `0` = off). The helper's own events are recognised by the moment of each post (within 0.4 s of one, over at most the last 30 s), not by the span of the whole send.
- Verification after Return: the last "You:" message must EQUAL the text (not merely contain it) and be new; otherwise `sent=false`.
- If an accidental Attach-file sheet appears, it is cancelled and reported as `sheet_opened`.
- Never AXPress the composer placeholder (it opens the Attach-file panel); typing uses a real click instead.

## How it works (proven mechanics)

`AXEnhancedUserInterface=true` is set on the app so the web content appears in the AX tree. Sidebar items
are AXButtons; they are only read (to list chat names), never pressed. Messages are AXStaticText under the AXGroup "Chat messages". The
composer is a native view hidden from AX; its web placeholder button gives the frame. To type: activate
Muse, HID click at 40% of the frame width, type chunks of up to 20 UTF-16 units via `keyboardSetUnicodeString` +
`postToPid`, check the composer, press Return, then restore the mouse position and the previously frontmost app.

## Tests

```bash
./test.sh                       # Swift Testing (140 tests); no Muse needed
(cd mcp && npm test)            # vitest (220 tests)
```

`test.sh` adds the Swift Testing framework paths because Command Line Tools place them outside the
default search path; with full Xcode plain `swift test` works.

## Known limits

- `send` takes over Muse, the mouse and the keyboard for about 3 to 5 s (typing 500 characters is 1 to 2 s of that). Do not touch the keyboard or mouse meanwhile; whatever is typed in that time is caught by the composer check and the send is refused.
- The Mac must be awake and unlocked, Muse open with a window.
- Depends on Muse's current UI labels; if Meta changes them, `selftest` fails with the missing anchors.
- Only the first Muse window is used. Only text lines; no attachments.
