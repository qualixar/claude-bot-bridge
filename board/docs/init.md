# cbb-board-init

**Run `cbb-board-init` in your own terminal, not through Claude (and not inside a Claude Code session, a script that logs its output, or a shared screen).** It prints your owner, worker and viewer keys once, at the end, and never stores them. Output that passes through Claude lands in the conversation and its transcript, so a key printed there is no longer yours alone. If you ever ran it through Claude, treat those keys as exposed: run it again with `--force` to set fresh ones.

First-time setup of a board in one command. It plans the steps, shows each command, asks y/N before it runs (`--yes` skips the questions), and prints the keys once at the end.

```bash
cbb-board-init --cloudflare [--name qualixar-task-board] [--yes] [--force] [--database-id ID] [--url URL]
cbb-board-init --docker [--url https://board.example.com] [--yes] [--force]
cbb-board-init --node   [--url https://board.example.com] [--yes] [--force]
```

Run it from the `board/` directory of a checkout after `npm install --legacy-peer-deps`. It is for a new board. To update an existing one use `board upgrade`.

## --cloudflare

1. `wrangler whoami`: must be logged in (`npx wrangler login`, or `CLOUDFLARE_API_TOKEN`). Its output is not printed.
2. `wrangler d1 create <name>`: the database id is read from the output.
3. Writes `wrangler.local.jsonc`: a copy of `wrangler.jsonc` with that id, and `<name>` as the database and Worker name. Comments are kept. The file is git-ignored. It is never overwritten without `--force`, and that check happens before anything is created.
4. `wrangler d1 migrations apply <name> --remote --config wrangler.local.jsonc`.
5. Generates the owner, worker and viewer keys plus `BOARD_ENCRYPTION_KEY` and `SESSION_SECRET` in memory (32 random bytes each, through the same code as `board keygen`), then runs `wrangler secret put` for `OWNER_KEY_SHA256`, `WORKER_KEY_SHA256`, `VIEWER_KEY_SHA256`, `BOARD_ENCRYPTION_KEY` and `SESSION_SECRET`. Each value goes in on stdin, never on the command line. The server stores only the key hashes.
6. `wrangler deploy --config wrangler.local.jsonc`. The `workers.dev` URL is read from the output; `--url` overrides it (use it with a custom domain).

## --docker and --node

Writes a new `.env` (mode 600, refused if it exists unless `--force`) with the three key hashes, `BOARD_ENCRYPTION_KEY` and `SESSION_SECRET`, then prints the next command: `docker compose up -d --build`, or `npm run build:node` then `set -a; . ./.env; set +a; npm start`. It does not start anything. Muse cannot reach `localhost`, so pass `--url` with your tunnel or proxy URL (Tailscale Funnel or a named Cloudflare Tunnel); without it the output uses `http://127.0.0.1:8787` and says so.

## What it prints, once

- The board URL and `/board`.
- `export CBB_BOARD_URL=<url>/mcp CBB_BOARD_OWNER_KEY=<owner key>` for Claude Code.
- The viewer key, for signing in at `/board`.
- A message to paste into a Muse chat that asks it to create the custom connector "Claude Bot Bridge Board" with your `/mcp` URL and to ask you for the worker key in its secure credential prompt. This message contains the URL and no key.
- The worker key, labelled to be pasted only into Muse's secure prompt.
- The recurring-job prompt (every 15 minutes), word for word as in the README.

## What it never does

The owner, worker and viewer keys are written nowhere: not to disk, not to a log, not to a command line. If a step fails after keys were generated they are lost, which is safe: run again. After a failure past the database step it prints the resume command: `cbb-board-init --cloudflare --database-id <id> --force` reuses the existing database and sets fresh secrets. Child-process error output is scrubbed of every secret value before it is shown.

## Exit codes

0 done. 1 a step failed, you were not logged in, or a file would have been overwritten. 3 you answered no at a prompt (nothing further ran). Bad arguments print a message and exit 1.

## Tests

`test/init.test.ts` runs the whole flow through an injected `exec` and file system, so no wrangler or docker is needed. It asserts that no secret value reaches argv or a log, that the Muse message holds the URL and no owner key, and that nothing is overwritten without `--force`.
