---
name: setup
description: Build and install the muse-ax helper that the Bot Bridge plugin needs, then check that Muse can be reached. Run once after installing the plugin.
disable-model-invocation: true
---

Set up the Bot Bridge helper on this Mac. It needs macOS 14 or later; check with `sw_vers -productVersion` and stop with a one-line explanation if the Mac is older.

1. Run `sh "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh"`. It builds the Swift helper with the Xcode Command Line Tools (about a minute the first time) and copies it to `~/.claude-bot-bridge/bin/muse-ax`. It is safe to run again, and it leaves a marker (`~/.claude-bot-bridge/.setup-done`): from then on the plugin may rebuild the helper itself when an update has no prebuilt binary. If it fails, show the user the last lines of its output and the fix it names; do not retry in a loop.
2. Run `~/.claude-bot-bridge/bin/muse-ax status` and report the JSON in plain words: is Muse running, is Accessibility trusted.
3. If Accessibility is not trusted, tell the user to enable it for the app that runs Claude Code in System Settings, Privacy & Security, Accessibility, then restart that app.
4. Tell the user two things about privacy, in plain words: when Accessibility cannot show the Muse composer's text, the helper reads it back by select-all and copy, up to twice per send, which puts a marker string and then the composer text on the clipboard (the previous clipboard is restored afterwards, but a clipboard manager may record the values in between); and every send attempt is journaled locally in `~/.claude-bot-bridge/sends.jsonl` as a hash, never the text. Also say that `muse_send` should not be added to a permission allowlist.
5. Tell the user to restart Claude Code (or run `/reload-plugins`) if the `muse` tools reported `binary_missing` earlier in this session. Do not call `muse_send`; setup never types into Muse.
6. Only if the user asks for a watcher that tells them when a Muse update changes its screen: run `sh "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh" --with-canary` (an hourly launchd agent), and tell them it needs `~/.claude-bot-bridge/bin/muse-ax` added under Accessibility too. `--remove-canary` uninstalls it. To remove everything later: `sh "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh" --uninstall` (then remove the Accessibility entry and run `claude plugin uninstall bot-bridge@claude-bot-bridge`).
