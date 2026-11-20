# bot-bridge-board (optional)

Adds one remote MCP server, `board`, to Claude Code. It points at your own Claude Bot Bridge task board (the Cloudflare Worker in this repository's `board/` folder) and signs in with the owner key. Install it only if you deployed a board; the main `bot-bridge` plugin works without it.

Set two environment variables in the shell that starts Claude Code, then install the plugin:

```bash
export CBB_BOARD_URL="https://<your-worker>.workers.dev/mcp"
export CBB_BOARD_OWNER_KEY="<owner key>"
claude plugin install bot-bridge-board@claude-bot-bridge
```

If either variable is unset, Claude Code warns that the variable is missing and the `board` server fails to connect. That is why this server is a separate plugin: people who do not use a board never see the error. The owner key is sent only as the `Authorization: Bearer` header to the URL you set. Tools: `task_create`, `task_list`, `task_get`, `task_results`, `task_answer`, `task_cancel`, `board_pause`, `board_resume`.
