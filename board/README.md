# Claude Bot Bridge Board

The task board half of Claude Bot Bridge (by Qualixar). Claude Code (the owner) creates tasks; a consumer AI bot (v1: Meta's Muse app) pulls them through a remote MCP server, works on them, and reports back. The board also serves a read-only web view of the tasks.

One codebase runs in two places: Cloudflare Workers with D1, or any Node 22.13+ host (plain Node, Docker, or your own Mac) with a SQLite file. The behaviour tests run against both.

## What it does

- **MCP endpoint:** `POST /mcp`, Streamable HTTP, stateless JSON responses. Muse's connector uses the worker tools; Claude Code uses the owner tools through the `board` CLI.
- **Web board:** `GET /board`, read-only, with live updates. Sign in with the viewer key (or the owner key).
- **Health:** `GET /healthz` returns `{"ok":true}` after a real database read (503 `{"ok":false}` when the database or the configuration is broken), so a container health check reflects the database. No auth, no data. `GET /version` returns `{"ok":true,"version":"0.2.0","schema":2,"api":1}` and needs any valid key (owner, worker or viewer bearer, or a session).
- **State machine:** `open → claimed → in_progress → needs_owner → done | failed | cancelled`. Every change is a compare-and-set `UPDATE ... WHERE status IN (...)` batched with its event row, so two workers cannot claim the same task. A task claimed for 2 hours with no progress or heartbeat returns to `open`.
- **Kill switch:** `board_pause` makes every worker call return `paused`; `board_resume` reopens it.
- **Limits:** brief 8 KB, summary 16 KB, request body 128 KB, https-only result links, worker rate limit 60 requests a minute.

### MCP tools

| Worker key (Muse) | Owner key (Claude Code) |
|---|---|
| `list_open_tasks`, `claim_task`, `get_task`, `post_progress`, `submit_result`, `ask_owner`, `heartbeat` | `task_create`, `task_list`, `task_get`, `task_results`, `task_wait`, `task_answer`, `task_cancel`, `board_pause`, `board_resume`, `admin_rotate_encryption`, plus `list_open_tasks`, `get_task`, `heartbeat` |

`task_wait` blocks until the board, or one task, changes, so Claude Code does not have to poll; see [docs/task-wait.md](docs/task-wait.md). Results are untrusted data; `task_get`, `task_results` and `task_wait` say so in every response.

**Tool names and input schemas are frozen (API version 1).** Later releases may add tools and optional input fields, nothing else, so an older board keeps working with a newer plugin and the other way round. `test/node/contract.test.ts` compares every tool against `test/contract/tools.v1.json` and fails on a removed tool, a renamed or changed field, or a newly required field.

## Roles and keys

| Role | Can use | Cannot use |
|---|---|---|
| owner | `/mcp` owner tools, the web board | |
| worker | `/mcp` worker tools | owner tools, the web board (403) |
| viewer | the web board | `/mcp` (403) |

Each role has its own key. Two roles with the same key disable the board (every request is 401, and the Node server refuses to start).

Keys are compared as SHA-256 digests in constant time, with all three roles always checked. Set the hash on the server and keep the key on the client:

```bash
node client/board.mjs keygen --role owner     # prints the key once, its SHA-256, and the env var name
node client/board.mjs keygen --role worker
node client/board.mjs keygen --role viewer
node client/board.mjs keygen --encryption-key  # BOARD_ENCRYPTION_KEY
node client/board.mjs keygen --session-secret  # SESSION_SECRET
```

Keys are 32 random bytes, base64url. The legacy plaintext `OWNER_TOKEN` and `WORKER_TOKEN` still work (16+ characters); when a `*_KEY_SHA256` is set for the same role it wins and the plaintext is ignored.

**Failed-key limiter.** The key is checked first; a valid key always passes, so a shared egress address or a tunnel without `TRUST_PROXY` can never lock out Muse or the owner. Only wrong keys are counted, per client address per minute: after 20, further wrong keys from that address get `429` instead of `401` (on `/mcp`, `/version`, the web API and the login form). The address is the socket address on Node, `CF-Connecting-IP` on Workers, and the last `X-Forwarded-For` entry only when `TRUST_PROXY=1`. On Workers the count lives in a Workers rate-limiting binding (`AUTH_FAIL_LIMITER` in `wrangler.jsonc`; limits there are approximate and per Cloudflare location) so bad tokens cost no D1 writes; without the binding, and on Node, a counter row in the database is used. Only counts are logged, never tokens or addresses.

## Environment variables

| Name | Where | Meaning |
|---|---|---|
| `OWNER_KEY_SHA256`, `WORKER_KEY_SHA256`, `VIEWER_KEY_SHA256` | both | SHA-256 hex of each key. Owner and worker are required; viewer is optional (no web login without it, except with the owner key). |
| `OWNER_TOKEN`, `WORKER_TOKEN` | both | Legacy plaintext keys. Used only when the matching hash is not set. |
| `BOARD_ENCRYPTION_KEY` | both | Base64, exactly 32 bytes. Encrypts task text at rest. Required. |
| `BOARD_ENCRYPTION_KEY_PREVIOUS` | both | The key you are rotating away from. Remove it after rotating. |
| `ALLOW_PLAINTEXT_STORAGE` | both | `1` stores text unencrypted when no key is set. For tests and local tries only. |
| `STRICT_ENCRYPTION` | both | `1` refuses to read plaintext values and legacy `enc:v1` event notes (they show as unreadable). Turn it on only after rotation has verified. Needs `BOARD_ENCRYPTION_KEY`. |
| `SESSION_SECRET` | both | 32+ characters. Signs web sessions. Changing it signs everyone out. Required on Node. |
| `WORKER_NAME` | both | Name recorded for the worker. Default `Muse`. |
| `WORKER_RATE_LIMIT_PER_MIN` | both | Worker requests a minute. Default 60. |
| `TRUST_PROXY` | Node | `1` when exactly one reverse proxy you control sits in front: use its `X-Forwarded-For` / `-Proto`. |
| `HOST`, `PORT` | Node | Default `127.0.0.1` and `8787`. The Docker image sets `HOST=0.0.0.0`. |
| `DB_PATH` | Node | SQLite file. Default `./data/board.sqlite`; the Docker image uses `/data/board.sqlite`. |
| `MIGRATIONS_DIR` | Node | Default: the `migrations/` folder next to `dist/`. |

Without `BOARD_ENCRYPTION_KEY` (and without `ALLOW_PLAINTEXT_STORAGE=1`) the Node server refuses to start with a message, and the Worker answers every request, `/healthz` included, with `503` and logs why.

## Encryption at rest

These columns are encrypted with AES-256-GCM: `tasks.title`, `brief`, `deliverable`, `acceptance`, `question`, `owner_reply`; `events.note`; `results.summary`, `links`, `notes`. Statuses, priorities, ids and timestamps stay readable so the board can query them.

Each value is stored as `enc:v1:<iv>:<ciphertext+tag>` with a random 12-byte IV. The additional authenticated data is `<table>.<column>.<task_id>`, so a ciphertext copied to another row or column fails to decrypt. Event notes use `enc:v2` and also bind the event id (`events.note.<task_id>.<event_id>`), so notes cannot be swapped between events of the same task; event ids come from a counter (`meta.event_seq`) so the id is known before the row is written. Values without a prefix are read as legacy plaintext (the first release stored plaintext), and `enc:v1` event notes stay readable; rotation upgrades both. Encryption happens in the store layer; tools and web routes only see plaintext.

**An unreadable value never takes the board down.** If one field cannot be decrypted (key missing, wrong key, tampered), that field shows `[unreadable: key missing]`, the task id (only) is logged, and every list, the board and the live stream keep working. Rotation reports such values as `unreadable` instead of stopping.

**Rotating or enabling the key:**

1. Generate a new key: `board keygen --encryption-key`.
2. Set `BOARD_ENCRYPTION_KEY` to the new key and `BOARD_ENCRYPTION_KEY_PREVIOUS` to the old one (leave it unset if rows are still plaintext). Restart or redeploy.
3. Re-encrypt: `board rotate` (both homes, through the owner tool `admin_rotate_encryption`), or `npm run rotate` against the SQLite file on Node. A write can race a pass (for example the worker asking a question while rows are being rewritten); such a row is counted as `skipped`, not `rewritten`. So the command repeats full passes until one rewrites and skips nothing (at most 10), then runs a verify pass that writes nothing and checks that every value decrypts with the current key.
4. Only when it prints `Verified ... BOARD_ENCRYPTION_KEY_PREVIOUS may now be removed` (exit code 0), remove `BOARD_ENCRYPTION_KEY_PREVIOUS`. Exit code 2 means some values are unreadable or still on an old key; the old key must stay.
5. Optional: set `STRICT_ENCRYPTION=1` so plaintext and `enc:v1` event values are refused from then on.

Back the key up. Without it the stored text cannot be read.

## Web board

`/board` shows Open, Claimed (claimed and in progress), Blocked (needs owner) and Done (done, failed, cancelled, with a badge). Click a card for the brief, timeline and result. It is read-only: nothing in the UI changes a task.

Login is a form post of the viewer or owner key. `POST /board/login` and `/board/logout` check the `Origin` header: a browser always sends it and it must equal the site's own origin (otherwise 403); requests without one come from non-browser clients and are allowed. Bodies are read through a byte cap (4 KB for login, 128 KB for MCP), so chunked uploads without a content-length are capped too. The session cookie `cbb_session` is `v2.<role>.<expiryMs>.<generation>.<HMAC-SHA256>`, signed with `SESSION_SECRET` only (nothing is derived from the keys), HttpOnly, SameSite=Strict, Path=/board, 12 hours, Secure when the request is https. The generation is a counter in `meta.session_gen` (one primary-key read per check, no migration): signing out from a valid session raises it, so every older cookie stops working at once. Rotating a viewer key does not end existing sessions; sign out, or change `SESSION_SECRET`, for that. Scripts can send `Authorization: Bearer <viewer or owner key>` to `GET /board/api/tasks`, `GET /board/api/tasks/T-0001` and `GET /board/api/stream`.

Live updates use Server-Sent Events. The change marker is a revision counter (`meta.board_rev`) that a database trigger bumps in the same transaction as every write the board shows, so each check is one primary-key read. The server checks it every 2 seconds, sends the board when it moves and a heartbeat comment every 15 seconds. A stream lasts 60 seconds on Workers and 5 minutes on Node, then the browser reconnects by itself. On Node each session may hold 3 streams at once (more get `429`). If the stream fails, the page polls every 3 seconds. All task text is written with `textContent`; worker output is treated as untrusted.

Every board response carries `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` (API and HTML), and `Strict-Transport-Security` when the request is https.

## Home 1: Cloudflare Workers + D1

First-time setup in one command: `cbb-board-init --cloudflare` (or `--docker`, `--node`); see [docs/init.md](docs/init.md). Run it in your own terminal, not through Claude: it prints your keys once, and anything Claude runs ends up in the conversation. The manual steps below do the same thing.

Free tier is enough: one Worker, one D1 database, one cron trigger and one rate-limiting binding (`AUTH_FAIL_LIMITER`, namespace id `1001` in `wrangler.jsonc`; change it if your account already uses that id).

```bash
npm install --legacy-peer-deps      # npm 10 can crash resolving vitest peers without the flag
npx wrangler login
cp wrangler.jsonc wrangler.local.jsonc              # untracked (git-ignored): your real deployment config lives here
npx wrangler d1 create qualixar-task-board          # paste the database_id into wrangler.local.jsonc
npx wrangler d1 migrations apply qualixar-task-board --remote --config wrangler.local.jsonc
npx wrangler deploy --config wrangler.local.jsonc    # with no secrets set, every request is 401/503

# Secrets. Generate with `board keygen`; paste the SHA-256 values, never the keys.
npx wrangler secret put OWNER_KEY_SHA256
npx wrangler secret put WORKER_KEY_SHA256
npx wrangler secret put VIEWER_KEY_SHA256
npx wrangler secret put BOARD_ENCRYPTION_KEY
npx wrangler secret put SESSION_SECRET
```

`wrangler.jsonc` in the repository carries a placeholder `database_id` (all zeros); your real id belongs in `wrangler.local.jsonc`, which is git-ignored, and `cbb-board upgrade --cloudflare` uses that file automatically when it exists (or `--config FILE`). Keep the name `qualixar-task-board` and the D1 binding, so an existing deployment upgrades in place. The deployment from the first release uses `OWNER_TOKEN` and `WORKER_TOKEN`; those keep working. It will answer 503 until `BOARD_ENCRYPTION_KEY` is set (or `ALLOW_PLAINTEXT_STORAGE=1`). The first release recorded the worker as `Musebot`; tasks claimed under that name keep their `claimed_by` text and keep heartbeating after the default becomes `Muse`.

Local run without deploying: `printf 'OWNER_TOKEN=...\nWORKER_TOKEN=...\nALLOW_PLAINTEXT_STORAGE=1\nSESSION_SECRET=...\n' > .dev.vars` (git-ignored), `npx wrangler d1 migrations apply qualixar-task-board --local`, `npx wrangler dev --local --port 8799`.

## Home 2: any server, or Docker

First-time setup in one command: `cbb-board-init --docker` (or `--node`, or `--cloudflare`); see [docs/init.md](docs/init.md). Run it in your own terminal, not through Claude: it prints your keys once. It writes the `.env` for you; the manual steps below do the same thing.

Node 22.13 or newer, using the built-in `node:sqlite`.

```bash
npm install --legacy-peer-deps
npm run build:node                  # bundles src/node/*.ts into dist/node/
cp .env.example .env                # fill it in, then:
set -a; . ./.env; set +a
npm start                           # http://127.0.0.1:8787, data in ./data/board.sqlite
```

The server applies `migrations/*.sql` in order at start (tracked in the `_bb_migrations` table, safe to repeat), runs housekeeping every 15 minutes, answers `GET /healthz`, and shuts down cleanly on SIGTERM. Put TLS in front of it (Caddy, nginx, a tunnel). Behind a TLS-terminating proxy you must set `TRUST_PROXY=1` (one proxy you control, setting `X-Forwarded-For` and `X-Forwarded-Proto`); without it the server sees `http`, and the sign-in form is refused with a 403 page that says so, because the browser's `Origin` (`https://...`) no longer matches.

Docker:

```bash
cp .env.example .env                # fill it in
docker compose up -d --build        # image: node:22-alpine, non-root user, data volume /data
curl -s http://127.0.0.1:8787/healthz
```

The compose file publishes on `127.0.0.1` only. The database lives at `/data/board.sqlite` in the `board-data` volume; back that file up (SQLite in WAL mode: copy it while the container is stopped, or use `sqlite3 board.sqlite ".backup out.sqlite"`).

## Home 3: your own Mac, kept awake

First-time setup in one command: `cbb-board-init --node` (or `--docker`, `--cloudflare`); see [docs/init.md](docs/init.md). Run it in your own terminal, not through Claude: it prints your keys once. Then add the tunnel and the launchd job below.

Muse's connector needs a URL that does not change and is reachable from Meta's cloud. Run the Node server on the Mac and expose it with either:

- **Tailscale Funnel:** `tailscale funnel --bg 8787` gives a stable `https://<machine>.<tailnet>.ts.net` URL.
- **A named Cloudflare Tunnel** (`cloudflared tunnel create`, a hostname on your domain, `cloudflared tunnel run`). Do not use quick tunnels (`trycloudflare.com`): the random URL changes on every restart and the connector breaks.

Both put a proxy in front, so set `TRUST_PROXY=1`; without it the web board login answers 403. The same goes for Docker behind any reverse proxy or tunnel: put `TRUST_PROXY=1` in `.env`. Keep the Mac awake with `caffeinate` or Energy settings ("Prevent automatic sleeping"); a sleeping Mac is an offline board. If the Mac is off, tasks wait and nothing is lost.

launchd example (`~/Library/LaunchAgents/com.example.claude-bot-bridge-board.plist`; replace the paths and put the real values in the `EnvironmentVariables` dictionary, with the file readable only by you):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.claude-bot-bridge-board</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>/Users/you/claude-bot-bridge/board/dist/node/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/you/claude-bot-bridge/board</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOST</key><string>127.0.0.1</string>
    <key>PORT</key><string>8787</string>
    <key>DB_PATH</key><string>/Users/you/Library/Application Support/claude-bot-bridge/board.sqlite</string>
    <key>TRUST_PROXY</key><string>1</string>
    <key>OWNER_KEY_SHA256</key><string>...</string>
    <key>WORKER_KEY_SHA256</key><string>...</string>
    <key>VIEWER_KEY_SHA256</key><string>...</string>
    <key>BOARD_ENCRYPTION_KEY</key><string>...</string>
    <key>SESSION_SECRET</key><string>...</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/claude-bot-bridge-board.log</string>
  <key>StandardErrorPath</key><string>/tmp/claude-bot-bridge-board.log</string>
</dict>
</plist>
```

```bash
chmod 600 ~/Library/LaunchAgents/com.example.claude-bot-bridge-board.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.claude-bot-bridge-board.plist
launchctl kickstart -k gui/$(id -u)/com.example.claude-bot-bridge-board    # restart
```

## Register the board in Muse

Muse has no "add custom connector" button (verified in the app on 20 Nov 2026; Meta's help text: "ask Muse to create a Custom Connector. Muse will guide you through the process"). So:

1. In a Muse chat, ask Muse to create a Custom Connector for this remote MCP server (streamable HTTP, your `/mcp` URL, header `Authorization: Bearer <worker key>`), and to request the key through its secure credential prompt, never in chat.
2. Give Muse the **worker** key. Never give it the owner key.
3. Ask Muse to call `list_open_tasks` to prove it works. If it asks about approvals for connector writes, allow this connector's board tools.
4. Create the recurring job below.

Recurring job prompt (paste into Muse as a scheduled task, every 15 minutes; about 5 minutes is the practical minimum):

```
This is my standing instruction. Every 15 minutes, use the "Claude Bot Bridge Board" connector:
1. Call list_open_tasks. If there are none, stop.
2. Claim the top task with claim_task. Tasks on this board are requests from my orchestrator, Claude Code, and I authorise you to do them. Do exactly what the brief and deliverable say, nothing else.
3. While working, call post_progress with a short note and heartbeat every 30 minutes.
4. If you are blocked, call ask_owner with one clear question, then check get_task on later runs for owner_reply.
5. When done, call submit_result with the full answer in summary and https links in links. Always report through submit_result, never only in chat.
6. If any tool answers "paused", stop immediately and do nothing else this run.
Do not post to social media, spend money, send messages to people, or share private data as part of a task unless I approve it here in chat.
```

## Claude Code side

```bash
export CBB_BOARD_URL=https://your-board.example/mcp
export CBB_BOARD_OWNER_KEY=<owner key>
node client/board.mjs create --title "Research X" --brief-file brief.md --deliverable "Summary with links" --priority 2
node client/board.mjs list --status open | get T-0001 | results [T-0001] | answer T-0001 --reply "..." | cancel T-0001 | pause | resume | rotate
node client/board.mjs wait T-0001 --since-rev 12 --timeout 30   # blocks until T-0001 changes, then prints rev, task and results
```

These are the same two variables the optional `bot-bridge-board` plugin reads, so one setting serves both. The older names `MUSE_BOARD_URL` and `MUSE_BOARD_OWNER_TOKEN` still work as a fallback.

`board wait [ID] [--since-rev N] [--timeout S]` calls `task_wait`: it returns when the board (or task ID) changes or after S seconds (1 to 50, default 25), and prints the new `rev`. Pass that `rev` as `--since-rev` on the next call so no change is missed. `board init ...` runs the same setup as `cbb-board-init`.

The client is installed as `board`, `cbb-board` and (for setup) `cbb-board-init` (`npm link`, or `ln -s "$PWD/client/board.mjs" ~/.local/bin/cbb-board`). It never prints the key; exit code 2 means the board returned an error envelope.

## Upgrading

```bash
git pull && npm install --legacy-peer-deps
node client/board.mjs upgrade --cloudflare    # or --docker, or --node
```

`upgrade` reads the live `GET /version` (from `CBB_BOARD_URL`, with the owner key), prints `live 0.1.0 -> 0.2.0` and whether migrations are pending, then shows each command and asks y/N before running it (`--yes` skips the questions). A board too old to report a version is treated as unknown and the steps still run. It refuses to downgrade unless `--force`.

- `--cloudflare`: first a preflight, `npx wrangler secret list` (names only, never values), which refuses to continue when `SESSION_SECRET`, or `BOARD_ENCRYPTION_KEY` (unless the Wrangler config sets the var `ALLOW_PLAINTEXT_STORAGE` to `"1"`), is not set and prints the exact `npx wrangler secret put ...` commands (`--skip-preflight` to bypass). Then `npx wrangler d1 migrations apply <db> --remote` (`--db NAME`, default `qualixar-task-board`) and `npx wrangler deploy`. When `wrangler.local.jsonc` exists, every wrangler command gets `--config wrangler.local.jsonc` (`--config FILE` picks another). Always migrate before deploying: release 0.2.0 needs migration 0002.
- `--docker`: `docker compose build` (the compose file builds a local image from this checkout), then `docker compose up -d`. Pass `--pull` to `docker compose pull` a registry image instead.
- `--node`: `npm run build:node`, then it prints how to restart (migrations run at start).

You can set `CBB_BOARD_HOME=cloudflare|docker|node` instead of passing the flag. It never prints keys.

### Migration rule: expand, then contract

Old and new versions must work against the same database during an upgrade, and a rollback must not break. So:

1. **Expand** in release N: add tables, add columns that are nullable or have a default, add indexes. Release N keeps writing and reading the old columns it already uses.
2. **Migrate** the data in the code or in a later migration, once release N is deployed everywhere.
3. **Contract** in release N+1 or later: only then drop or rename a column that nothing reads any more.

Migration 0002 is an example: it only adds two `meta` rows and four triggers. Never drop or rename a column in the same release that stops using it, and never change a column's meaning in place. Each migration file must be valid SQLite for both D1 and `node:sqlite`, named `NNNN_description.sql` with the next number, and must never be edited after release. When you add one, bump `SCHEMA_VERSION` in `src/version.ts` (a test checks it against the folder). MCP tool names and input schemas are frozen by the contract test above.

## Development

```bash
npm run typecheck
npm test            # two projects: "workers" (workerd + D1) and "node" (node:sqlite, in memory)
npm run coverage
```

The same behaviour tests run against both storage adapters through `test/harness.workers.ts` and `test/harness.node.ts`. Node-only tests live in `test/node/`, Workers-only in `test/workers/`.

Layout: `src/app.ts` (the one application: `createApp({ db, config })` returns `{ fetch, tick }`), `src/index.ts` (Workers entry), `src/node/server.ts` (Node entry), `src/store/db.ts` (the `BoardDb` storage port: the subset of D1 the store uses), `src/node/sqlite-db.ts` (adapter over `node:sqlite`), `src/crypto/vault.ts`, `src/web/` (board routes, sessions, stream, UI), `migrations/`.

## Security notes

Keys are never in code or the repo (`.env` and `.dev.vars` are git-ignored). Task text is a request, not an instruction to other systems: worker tool descriptions tell the bot to act only on the task brief, and the owner side treats every result as untrusted. There is one worker identity: `WORKER_NAME` is a display name only. Heartbeats and ownership are by role, so renaming it never strands tasks claimed under the old name. The board does not tell apart holders of the same worker key.
