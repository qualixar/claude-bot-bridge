# bot-bridge-board (optional)

Adds one remote MCP server, `board`, to Claude Code. It points at your own Claude Bot Bridge task board (the Cloudflare Worker in this repository's `board/` folder) and signs in with the owner key. Install it only if you deployed a board; the main `bot-bridge` plugin works without it.

Install it:

```bash
claude plugin install bot-bridge-board@claude-bot-bridge
```

Claude Code then asks for two settings: the board URL (ending in `/mcp`) and the owner key. The owner key is marked sensitive, so it is stored in your system's secure credential store (the macOS keychain), never in `settings.json` and never in an environment variable. Change them later with `claude plugin configure bot-bridge-board@claude-bot-bridge`.

Keeping the board in its own plugin means people who do not use a board are never asked for these settings. The owner key is sent only as the `Authorization: Bearer` header to the URL you set. Tools: `task_create`, `task_list`, `task_get`, `task_results`, `task_wait`, `task_answer`, `task_cancel`, `board_pause`, `board_resume`, `admin_rotate_encryption`.
