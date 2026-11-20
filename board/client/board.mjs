#!/usr/bin/env node
// `board`: owner-side client for the Claude Bot Bridge Board (used by Claude Code).
// Reads CBB_BOARD_URL (the /mcp endpoint) and CBB_BOARD_OWNER_KEY (legacy: MUSE_BOARD_URL, MUSE_BOARD_OWNER_TOKEN).
// The token is only ever sent as a bearer header and is never printed.
// `board keygen` is the one command that prints a secret: a freshly generated key, once.
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { LOCAL_WRANGLER_CONFIG, boardEnv, parseJsonc, upgrade } from "./upgrade.mjs";

const USAGE = `Usage: board <command> [options]
  create --title T (--brief TEXT | --brief-file PATH) --deliverable D [--acceptance A] [--priority 1-3] [--deadline ISO]
  list [--status open|claimed|in_progress|needs_owner|done|failed|cancelled] [--limit N]
  get ID            full task, event log and result
  results [ID]      one result, or the latest results
  wait [ID] [--since-rev N] [--timeout S]
                    block until the board (or task ID) changes, or S seconds pass (1-50, default 25);
                    prints rev, the task and, when it is done or failed, its results. Pass rev as --since-rev next time.
  answer ID (--reply TEXT | --reply-file PATH)
  cancel ID [--reason TEXT]
  pause | resume    board kill switch
  rotate            re-encrypt stored text with the current BOARD_ENCRYPTION_KEY (repeats passes, then verifies)
  upgrade (--cloudflare | --docker | --node) [--yes] [--db NAME] [--config FILE] [--pull] [--force] [--skip-preflight]
                    show live -> target version and pending migrations, then run the upgrade steps (asks y/N for each).
                    --docker builds the local image (docker compose build); --pull fetches a registry image instead.
                    --cloudflare uses wrangler.local.jsonc when it exists; --config FILE picks another Wrangler config.
  init (--cloudflare | --docker | --node) [--yes] [--name NAME] [--url URL] [--force]
                    first-time setup in one command (same as cbb-board-init; run: board init --help)
  keygen --role owner|worker|viewer     new access key: prints it once, with its SHA-256 for the server
  keygen --encryption-key               new BOARD_ENCRYPTION_KEY (32 random bytes, base64)
  keygen --session-secret               new SESSION_SECRET
Environment: CBB_BOARD_URL, CBB_BOARD_OWNER_KEY (legacy MUSE_BOARD_URL, MUSE_BOARD_OWNER_TOKEN; not needed for keygen)`;

const BOOLEAN_FLAGS = new Set(["encryption-key", "session-secret", "help", "cloudflare", "docker", "node", "yes", "build", "pull", "force", "skip-preflight"]);

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const key = a.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`Option --${key} needs a value`);
    flags[key] = next;
    i++;
  }
  return { positional, flags };
}

const text = (flags, key) => (flags[`${key}-file`] ? readFileSync(flags[`${key}-file`], "utf8") : flags[key]);
const num = (v, name) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`--${name} must be an integer`);
  return n;
};
const need = (value, what) => {
  if (value === undefined || value === "") throw new Error(`Missing ${what}`);
  return value;
};
const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** Maps a CLI command to an MCP tool call. Pure, so it is easy to test. */
export function buildCall(positional, flags) {
  const [cmd, id] = positional;
  switch (cmd) {
    case "create":
      return ["task_create", strip({
        title: need(flags.title, "--title"),
        brief: need(text(flags, "brief"), "--brief or --brief-file"),
        deliverable: need(flags.deliverable, "--deliverable"),
        acceptance: flags.acceptance,
        priority: num(flags.priority, "priority"),
        deadline: flags.deadline,
      })];
    case "list":
      return ["task_list", strip({ status: flags.status, limit: num(flags.limit, "limit") })];
    case "get":
      return ["task_get", { id: need(id, "task id") }];
    case "results":
      return ["task_results", strip({ id })];
    case "wait":
      return ["task_wait", strip({ id, since_rev: num(flags["since-rev"], "since-rev"), timeout_s: num(flags.timeout, "timeout") })];
    case "answer":
      return ["task_answer", { id: need(id, "task id"), reply: need(text(flags, "reply"), "--reply or --reply-file") }];
    case "cancel":
      return ["task_cancel", strip({ id: need(id, "task id"), reason: flags.reason })];
    case "pause":
      return ["board_pause", {}];
    case "resume":
      return ["board_resume", {}];
    default:
      throw new Error(`Unknown command${cmd ? `: ${cmd}` : ""}`);
  }
}

const ROLES = {
  owner: { hashVar: "OWNER_KEY_SHA256", where: "Keep it for the `board` client: CBB_BOARD_OWNER_KEY=<key>. Never give it to Muse." },
  worker: { hashVar: "WORKER_KEY_SHA256", where: "Give it only to Muse's connector, through its secure credential prompt." },
  viewer: { hashVar: "VIEWER_KEY_SHA256", where: "Use it to sign in at /board. It cannot call /mcp." },
};

/** Version and schema number of this checkout: package.json and the highest migrations/NNNN_*.sql. */
export function loadTarget(root = new URL("..", import.meta.url)) {
  const version = JSON.parse(readFileSync(new URL("package.json", root), "utf8")).version;
  const schema = Math.max(0, ...readdirSync(new URL("migrations/", root)).map((f) => Number(/^(\d+)_/.exec(f)?.[1] ?? 0)));
  let allowPlaintext = false;
  try {
    // The untracked local config (real deployment) wins over the tracked example when both exist.
    const file = existsSync(new URL(LOCAL_WRANGLER_CONFIG, root)) ? LOCAL_WRANGLER_CONFIG : "wrangler.jsonc";
    const cfg = parseJsonc(readFileSync(new URL(file, root), "utf8"));
    allowPlaintext = cfg.vars?.ALLOW_PLAINTEXT_STORAGE === "1";
  } catch {
    // No readable wrangler.jsonc: assume the stricter default (the encryption key is required).
  }
  return { version, schema, allowPlaintext };
}

/** The board package directory as a real filesystem path (URL.pathname would leave spaces as %20). */
export const packageDir = (base = import.meta.url) => fileURLToPath(new URL("..", base));

const run = (cmd, args, { cwd }) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    child.on("error", (err) => {
      console.error(`board: could not run ${cmd}: ${err.message}`);
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });

/** Runs a command and returns its exit code and stdout (stderr is passed through). Used only for `wrangler secret list`. */
const capture = (cmd, args, { cwd }) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("error", () => resolve({ code: 127, stdout: "" }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
  });

async function askYesNo(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/** Builds the keygen output. `rng` is injectable so tests are deterministic. */
export function keygen(flags, rng = randomBytes) {
  if (flags["encryption-key"]) {
    return [
      `BOARD_ENCRYPTION_KEY=${rng(32).toString("base64")}`,
      "Set it on the server. Back it up: without it the stored task text cannot be read. This is shown once.",
    ];
  }
  if (flags["session-secret"]) {
    return [`SESSION_SECRET=${rng(32).toString("base64url")}`, "Set it on the server. Changing it signs everyone out of the web board. This is shown once."];
  }
  const role = ROLES[flags.role];
  if (!role) throw new Error("keygen needs --role owner|worker|viewer, --encryption-key or --session-secret");
  const key = rng(32).toString("base64url");
  const hash = createHash("sha256").update(key).digest("hex");
  return [
    `Role:     ${flags.role}`,
    `Key:      ${key}`,
    `SHA-256:  ${hash}`,
    `Server:   ${role.hashVar}=${hash}`,
    role.where,
    "The key is shown once and the server stores only the hash.",
  ];
}

const MAX_PASSES = 10;

async function pass(env, fetchImpl, verify) {
  const t = { scanned: 0, rewritten: 0, skipped: 0, unreadable: 0, stale: 0 };
  let cursor;
  do {
    const args = { limit: 50, ...(cursor ? { cursor } : {}), ...(verify ? { verify: true } : {}) };
    const res = await callBoard(env, "admin_rotate_encryption", args, fetchImpl);
    if (!res.ok) throw new Error(`Rotation stopped: ${res.error?.message ?? "unknown error"}`);
    for (const k of Object.keys(t)) t[k] += res[k] ?? 0;
    cursor = res.next_cursor ?? undefined;
  } while (cursor);
  return t;
}

/**
 * Re-encrypts stored text: repeats full passes until one rewrites and skips nothing (a write that raced
 * a pass is picked up by the next), then runs a verify pass that writes nothing. `verified` is true only
 * when every value is on the current key, which is when BOARD_ENCRYPTION_KEY_PREVIOUS may be removed.
 */
export async function rotate(env, fetchImpl = fetch) {
  const total = { scanned: 0, rewritten: 0, skipped: 0 };
  let passes = 0;
  let last;
  do {
    last = await pass(env, fetchImpl, false);
    passes++;
    for (const k of Object.keys(total)) total[k] += last[k];
  } while ((last.rewritten > 0 || last.skipped > 0) && passes < MAX_PASSES);
  const check = await pass(env, fetchImpl, true);
  return { passes, ...total, unreadable: check.unreadable, stale: check.stale, verified: check.stale === 0 && check.unreadable === 0 && last.skipped === 0 };
}

function config(env) {
  const { url, token } = boardEnv(env);
  if (!url) throw new Error("CBB_BOARD_URL is not set");
  if (!token) throw new Error("CBB_BOARD_OWNER_KEY is not set");
  if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url)) {
    throw new Error("CBB_BOARD_URL must be https (http is allowed for localhost only)");
  }
  return { url, token };
}

export async function callBoard(env, name, args, fetchImpl = fetch) {
  const { url, token } = config(env);
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  if (res.status === 401) throw new Error("Board rejected the token (401)");
  if (res.status === 429) throw new Error("Rate limited (429); try again in a minute");
  const body = await res.json().catch(() => null);
  if (!body) throw new Error(`Unexpected response (HTTP ${res.status})`);
  if (body.error) throw new Error(`Protocol error: ${body.error.message}`);
  return JSON.parse(body.result.content[0].text);
}

/** `deps` is handed to `init` (injectable exec, fs, prompts) so tests never run wrangler or docker. */
export async function main(argv, env, out = console, fetchImpl = fetch, deps = {}) {
  if (argv[0] === "init") {
    // Loaded on demand: init.mjs imports this file, so a static import would be a cycle.
    const { main: initMain } = await import("./init.mjs");
    return initMain(argv.slice(1), env, { out, ...deps });
  }
  const { positional, flags } = parseArgs(argv);
  if (positional.length === 0 || flags.help !== undefined) {
    out.log(USAGE);
    return 0;
  }
  if (positional[0] === "keygen") {
    for (const line of keygen(flags)) out.log(line);
    return 0;
  }
  if (positional[0] === "upgrade") {
    const cwd = packageDir();
    return upgrade({ flags, env, target: loadTarget(), out, fetchImpl, exec: run, capture, ask: askYesNo, cwd });
  }
  if (positional[0] === "rotate") {
    const report = await rotate(env, fetchImpl);
    out.log(JSON.stringify({ ok: report.verified, ...report }, null, 2));
    if (report.verified) out.log("Verified: every stored value decrypts with the current key. BOARD_ENCRYPTION_KEY_PREVIOUS may now be removed.");
    else out.log("NOT verified: do not remove BOARD_ENCRYPTION_KEY_PREVIOUS. Some values are unreadable or still on an old key; fix that and run `rotate` again.");
    return report.verified ? 0 : 2;
  }
  const [name, args] = buildCall(positional, flags);
  const result = await callBoard(env, name, args, fetchImpl);
  out.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 2;
}

/** True when this file is the entry module, also when started through a symlink (`npm link`) or from a path with spaces. */
export function isEntryModule(argv1 = process.argv[1], metaUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === metaUrl;
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`board: ${err.message}`);
      process.exit(1);
    },
  );
}
