#!/usr/bin/env node
// `cbb-board-init`: first-time setup of a Claude Bot Bridge Board, end to end.
//   cbb-board-init --cloudflare [--name qualixar-task-board] [--yes] [--force] [--database-id ID] [--url URL]
//   cbb-board-init --docker | --node [--url https://your-public-host] [--yes] [--force]
// Planning is pure (planCloudflare, planSelfHosted, ...). Every command goes through an injectable `exec`, so the
// tests run without wrangler or docker. Secrets are generated in memory, sent to `wrangler secret put` on stdin
// (never argv), and the keys are printed once at the end. The only file that holds secrets is the .env of the
// --docker / --node homes, and it holds hashes and server secrets, never the owner, worker or viewer key.
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { LOCAL_WRANGLER_CONFIG, detectHome, parseJsonc } from "./upgrade.mjs";
import { isEntryModule, keygen, packageDir } from "./board.mjs";

export const DEFAULT_NAME = "qualixar-task-board";
export const CONNECTOR_NAME = "Claude Bot Bridge Board";
export const DEFAULT_LOCAL_URL = "http://127.0.0.1:8787";
export const ENV_FILE = ".env";
/** Secrets set on the Worker, in this order. The first three are SHA-256 hashes; the keys themselves stay with the user. */
export const SECRET_NAMES = ["OWNER_KEY_SHA256", "WORKER_KEY_SHA256", "VIEWER_KEY_SHA256", "BOARD_ENCRYPTION_KEY", "SESSION_SECRET"];

const USAGE = `Usage: cbb-board-init (--cloudflare | --docker | --node) [options]
  --cloudflare        create the D1 database, migrate, set secrets and deploy (wrangler)
  --docker | --node   write a new .env (mode 600) and print the next command
  --name NAME         board name: D1 database and Worker (default ${DEFAULT_NAME}; --cloudflare only)
  --url URL           public https URL of the board (needed for --docker / --node; overrides the deploy URL)
  --database-id ID    reuse an existing D1 database instead of creating one (to resume a failed run)
  --yes               do not ask y/N before each step
  --force             overwrite an existing wrangler.local.jsonc or .env
Keys and secrets are generated in memory and printed once at the end: run this in your own terminal, not through Claude.`;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const BOOLEAN = new Set(["cloudflare", "docker", "node", "yes", "force", "help"]);
const VALUE = new Set(["name", "url", "database-id"]);

/** Flags for init. Throws on anything unknown or malformed, so a typo never turns into a half-run setup. */
export function parseInitArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`Unexpected argument ${a}`);
    const key = a.slice(2);
    if (BOOLEAN.has(key)) flags[key] = true;
    else if (VALUE.has(key)) {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`Option --${key} needs a value`);
      flags[key] = next;
    } else throw new Error(`Unknown option ${a}`);
  }
  if (flags.name !== undefined && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(flags.name)) throw new Error("--name must be lowercase letters, digits and dashes (max 63)");
  if (flags["database-id"] !== undefined && !new RegExp(`^${UUID}$`, "i").test(flags["database-id"])) throw new Error("--database-id must be a UUID");
  return flags;
}

// ---------- pure helpers ----------

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const grab = (lines, re, what) => {
  const m = re.exec(lines.join("\n"));
  if (!m) throw new Error(`Could not read the generated ${what} from keygen.`);
  return m[1];
};

/** Five fresh secrets, made with the same `keygen` the `board keygen` command uses. `rng` is injectable for tests. */
export function generateKeys(rng = randomBytes) {
  const role = (r) => {
    const lines = keygen({ role: r }, rng);
    const key = grab(lines, /^Key:\s+(\S+)$/m, `${r} key`);
    const hash = grab(lines, /^SHA-256:\s+([0-9a-f]{64})$/m, `${r} key hash`);
    if (sha256(key) !== hash) throw new Error(`keygen returned a hash that does not match the ${r} key.`);
    return { key, hash };
  };
  const owner = role("owner");
  const worker = role("worker");
  const viewer = role("viewer");
  if (new Set([owner.key, worker.key, viewer.key]).size !== 3) throw new Error("The random source returned the same key twice; refusing to continue.");
  return {
    ownerKey: owner.key,
    workerKey: worker.key,
    viewerKey: viewer.key,
    secrets: {
      OWNER_KEY_SHA256: owner.hash,
      WORKER_KEY_SHA256: worker.hash,
      VIEWER_KEY_SHA256: viewer.hash,
      BOARD_ENCRYPTION_KEY: grab(keygen({ "encryption-key": true }, rng), /^BOARD_ENCRYPTION_KEY=(\S+)$/m, "encryption key"),
      SESSION_SECRET: grab(keygen({ "session-secret": true }, rng), /^SESSION_SECRET=(\S+)$/m, "session secret"),
    },
  };
}

/** Every value that must never reach argv or a log, except the one final print. */
export const secretValues = (keys) => [keys.ownerKey, keys.workerKey, keys.viewerKey, ...Object.values(keys.secrets)];

/** Replaces each secret value in `text` (child-process output on a failure path). */
export const redact = (text, values) => values.reduce((t, v) => (v ? t.split(v).join("[REDACTED]") : t), String(text ?? ""));

/** Database id from `wrangler d1 create` output (JSON, TOML or prose). Null when there is none. */
export function parseDatabaseId(stdout) {
  const keyed = new RegExp(`database_id["']?\\s*[:=]\\s*["']?(${UUID})`, "i").exec(stdout);
  const any = new RegExp(UUID, "i").exec(stdout);
  return keyed ? keyed[1] : any ? any[0] : null;
}

/** The workers.dev origin from `wrangler deploy` output, or null. */
export function parseWorkerUrl(stdout) {
  const m = /https:\/\/[a-z0-9][a-z0-9.-]*\.workers\.dev/i.exec(stdout);
  return m ? m[0].toLowerCase() : null;
}

/** The MCP endpoint for a board origin or URL: https origin plus /mcp. Plain http is accepted only for loopback. */
export function mcpUrlFor(url) {
  const u = new URL(url);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new Error("The board URL must be https (http only for localhost).");
  const path = u.pathname.replace(/\/+$/, "").replace(/\/mcp$/, "");
  return `${u.origin}${path}/mcp`;
}

export const originOf = (mcpUrl) => mcpUrl.replace(/\/mcp$/, "");

/** wrangler.jsonc text with this board's database id and names; comments are kept. Throws if the result is not what was asked. */
export function renderWranglerConfig(baseText, { databaseId, name }) {
  let text = baseText.replace(/^(\s*"name"\s*:\s*)"[^"]*"/m, `$1"${name}"`);
  text = text.replace(/("database_name"\s*:\s*)"[^"]*"/, `$1"${name}"`);
  text = text.replace(/("database_id"\s*:\s*)"[^"]*"/, `$1"${databaseId}"`);
  const parsed = parseJsonc(text);
  const db = parsed.d1_databases?.[0];
  if (parsed.name !== name || db?.database_name !== name || db?.database_id !== databaseId) throw new Error("Could not set the database id in the Wrangler config; wrangler.jsonc has an unexpected shape.");
  return text;
}

/** The server-side .env. Hashes and server secrets only: never the owner, worker or viewer key. */
export function renderEnvFile(keys) {
  const s = keys.secrets;
  return [
    "# Written by cbb-board-init. Server secrets only (the access keys themselves are not stored here). Never commit.",
    ...SECRET_NAMES.map((n) => `${n}=${s[n]}`),
    "# TRUST_PROXY=1            # only behind exactly one reverse proxy you control",
    "",
  ].join("\n");
}

/** Plan for --cloudflare. Commands and their arguments only; secret values are looked up at run time by name. */
export function planCloudflare({ name = DEFAULT_NAME, config = LOCAL_WRANGLER_CONFIG, databaseId } = {}) {
  const wrangler = (title, args, extra = {}) => ({ cmd: "npx", args: ["wrangler", ...args], title, ...extra });
  return [
    wrangler("check that wrangler is logged in to Cloudflare", ["whoami"], { id: "whoami", quiet: true }),
    ...(databaseId ? [] : [wrangler(`create the D1 database ${name}`, ["d1", "create", name], { id: "d1_create" })]),
    { id: "write_config", title: `write ${config} (untracked copy of wrangler.jsonc with the database id)`, file: config },
    wrangler("apply the database migrations to the remote database", ["d1", "migrations", "apply", name, "--remote", "--config", config], { id: "migrate" }),
    ...SECRET_NAMES.map((n) => wrangler(`set the secret ${n} (value sent on stdin)`, ["secret", "put", n, "--config", config], { id: "secret", secret: n, quiet: true })),
    wrangler("deploy the Worker", ["deploy", "--config", config], { id: "deploy" }),
  ];
}

/** Plan for --docker and --node: one file, then the user starts the server. */
export function planSelfHosted(home) {
  return {
    steps: [{ id: "write_env", title: `write ${ENV_FILE} with new server secrets (mode 600)`, file: ENV_FILE }],
    next: home === "docker" ? ["docker compose up -d --build"] : ["npm run build:node   # once, bundles the server", "set -a; . ./.env; set +a", "npm start"],
  };
}

/** Same wording as the "Recurring job prompt" in README.md (a test keeps the two in step). */
export const RECURRING_JOB_PROMPT = `This is my standing instruction. Every 15 minutes, use the "${CONNECTOR_NAME}" connector:
1. Call list_open_tasks. If there are none, stop.
2. Claim the top task with claim_task. Tasks on this board are requests from my orchestrator, Claude Code, and I authorise you to do them. Do exactly what the brief and deliverable say, nothing else.
3. While working, call post_progress with a short note and heartbeat every 30 minutes.
4. If you are blocked, call ask_owner with one clear question, then check get_task on later runs for owner_reply.
5. When done, call submit_result with the full answer in summary and https links in links. Always report through submit_result, never only in chat.
6. If any tool answers "paused", stop immediately and do nothing else this run.
Do not post to social media, spend money, send messages to people, or share private data as part of a task unless I approve it here in chat.`;

/** The message to paste into a Muse chat. Contains the connector URL and never a key. */
export function museMessage(mcpUrl) {
  return [
    "Please create a Custom Connector for me, for this remote MCP server:",
    `- Connector name: ${CONNECTOR_NAME}`,
    "- Type: streamable HTTP",
    `- URL: ${mcpUrl}`,
    "- Authentication: the header Authorization: Bearer <worker key>",
    "Ask me for the worker key in your secure credential prompt, never in chat.",
    "When it is connected, call list_open_tasks to prove it works. If you ask about approvals for connector writes, I allow this connector's board tools.",
  ].join("\n");
}

/** The one place the keys are printed. */
export function finalReport({ home, mcpUrl, keys, nextLines = [], warnings = [] }) {
  const origin = originOf(mcpUrl);
  return [
    "",
    "=== Board ready. The keys below are shown once and stored nowhere: save them now. ===",
    ...warnings,
    "",
    `Board URL:  ${origin}/board   (read-only web view)`,
    "",
    "Claude Code (owner). Add to your shell profile:",
    `  export CBB_BOARD_URL=${mcpUrl} CBB_BOARD_OWNER_KEY=${keys.ownerKey}`,
    "",
    "Web board sign-in (viewer key):",
    `  ${keys.viewerKey}`,
    ...(nextLines.length ? ["", "Next, start the board:", ...nextLines.map((l) => `  ${l}`)] : []),
    "",
    "Muse. Paste this message into a Muse chat:",
    "----------------------------------------",
    museMessage(mcpUrl),
    "----------------------------------------",
    "Worker key (paste ONLY into Muse's secure prompt, never into chat):",
    `  ${keys.workerKey}`,
    "",
    "Then create this recurring job in Muse (a scheduled task, every 15 minutes):",
    "----------------------------------------",
    RECURRING_JOB_PROMPT,
    "----------------------------------------",
    `Never give Muse the owner key. Home: ${home}.`,
  ];
}

// ---------- running ----------

export function defaultExec(cmd, args, { cwd, input, quiet = false, interactive = true } = {}) {
  return new Promise((resolve) => {
    const stdin = input !== undefined ? "pipe" : interactive ? "inherit" : "ignore";
    const child = spawn(cmd, args, { cwd, stdio: [stdin, "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
      if (!quiet) process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      if (!quiet) process.stderr.write(d);
    });
    child.on("error", (err) => resolve({ code: 127, stdout, stderr: `could not run ${cmd}: ${err.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

async function defaultAsk(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

const defaultFs = {
  exists: existsSync,
  read: (p) => readFileSync(p, "utf8"),
  /** Refuses to replace an existing file unless `overwrite`. The file is created with mode 600. */
  write(p, data, { overwrite }) {
    writeFileSync(p, data, { mode: 0o600, flag: overwrite ? "w" : "wx" });
    chmodSync(p, 0o600);
  },
};

const show = (c) => (c.cmd ? `$ ${[c.cmd, ...c.args].join(" ")}` : "");

/** Runs the steps in order. Returns { code } or { code: 0, state }. Never logs a secret value. */
async function runSteps(steps, ctx, state, secrets) {
  const { out, ask, flags } = ctx;
  for (const [i, step] of steps.entries()) {
    out.log(`\n[${i + 1}/${steps.length}] ${step.title}${step.cmd ? `\n  ${show(step)}` : ""}`);
    if (!flags.yes && !(await ask("Run it? [y/N] "))) {
      out.log("Stopped. Nothing further was run.");
      return { code: 3 };
    }
    const failure = await runStep(step, ctx, state, secrets).catch((err) => redact(err.message, secrets));
    if (failure) {
      out.log(failure);
      return { code: 1 };
    }
  }
  return { code: 0 };
}

/** One step. Returns a failure message, or null on success. */
async function runStep(step, ctx, state, secrets) {
  const { cwd, fsx, exec, flags } = ctx;
  const opts = { cwd, quiet: step.quiet === true, interactive: !flags.yes };
  const fail = (res, what) => `${what} failed (exit code ${res.code}).${res.stderr ? `\n${redact(res.stderr, secrets).trim()}` : ""}`;
  switch (step.id) {
    case "whoami": {
      const res = await exec(step.cmd, step.args, opts);
      const text = `${res.stdout}\n${res.stderr}`;
      if (res.code !== 0 || /not authenticated|not logged in/i.test(text)) return "Not logged in to Cloudflare. Run `npx wrangler login` (or set CLOUDFLARE_API_TOKEN) and start again.";
      ctx.out.log("  Logged in.");
      return null;
    }
    case "d1_create": {
      const res = await exec(step.cmd, step.args, opts);
      if (res.code !== 0) return fail(res, "wrangler d1 create");
      state.databaseId = parseDatabaseId(`${res.stdout}\n${res.stderr}`);
      return state.databaseId ? null : "The database was created but its id could not be read from wrangler's output. Find it with `npx wrangler d1 list`, then run again with --database-id ID.";
    }
    case "write_config": {
      const target = join(cwd, step.file);
      fsxWrite(fsx, target, renderWranglerConfig(fsx.read(join(cwd, "wrangler.jsonc")), { databaseId: state.databaseId, name: state.name }), flags.force === true);
      ctx.out.log(`  Wrote ${step.file}. It is untracked; keep it out of git.`);
      return null;
    }
    case "secret": {
      const res = await exec(step.cmd, step.args, { ...opts, input: `${state.secretValues[step.secret]}\n` });
      return res.code === 0 ? null : fail(res, `wrangler secret put ${step.secret}`);
    }
    case "deploy": {
      const res = await exec(step.cmd, step.args, opts);
      if (res.code !== 0) return fail(res, "wrangler deploy");
      state.deployedUrl = parseWorkerUrl(`${res.stdout}\n${res.stderr}`);
      return null;
    }
    case "write_env": {
      fsxWrite(fsx, join(cwd, step.file), renderEnvFile(state.keys), flags.force === true);
      ctx.out.log(`  Wrote ${step.file} (mode 600). It holds hashes and server secrets, not your access keys.`);
      return null;
    }
    default: {
      const res = await exec(step.cmd, step.args, opts);
      return res.code === 0 ? null : fail(res, step.title);
    }
  }
}

function fsxWrite(fsx, path, data, overwrite) {
  try {
    fsx.write(path, data, { overwrite });
  } catch (err) {
    throw new Error(`Could not write ${path}: ${err.code === "EEXIST" ? "it already exists (use --force to replace it)" : err.message}`);
  }
}

const resumeHint = (id) => `Secrets set so far stay on the Worker; the new keys were never shown. Run again with --database-id ${id} --force to set fresh ones.`;

async function initCloudflare(ctx) {
  const { flags, cwd, fsx, out } = ctx;
  const name = flags.name ?? DEFAULT_NAME;
  if (fsx.exists(join(cwd, LOCAL_WRANGLER_CONFIG)) && !flags.force) {
    out.log(`${LOCAL_WRANGLER_CONFIG} already exists, so this directory looks set up. Nothing was run. Use \`board upgrade --cloudflare\` to update it, or --force to replace the file (a new database is created unless you pass --database-id).`);
    return 1;
  }
  const keys = generateKeys(ctx.rng);
  const state = { name, databaseId: flags["database-id"], secretValues: keys.secrets };
  const plan = planCloudflare({ name, databaseId: state.databaseId });
  out.log(`Home: cloudflare. Board name: ${name}. ${plan.length} steps; nothing secret is printed until the end.`);
  const res = await runSteps(plan, ctx, state, secretValues(keys));
  if (res.code !== 0) {
    if (res.code === 1 && state.databaseId) out.log(resumeHint(state.databaseId));
    return res.code;
  }
  let mcpUrl;
  if (flags.url) mcpUrl = mcpUrlFor(flags.url);
  else if (state.deployedUrl) mcpUrl = mcpUrlFor(state.deployedUrl);
  const warnings = mcpUrl ? [] : ["WARNING: the deploy output had no workers.dev URL. Replace <board-url> below with your Worker's URL (or run again with --url)."];
  mcpUrl ??= "https://<board-url>/mcp";
  for (const line of finalReport({ home: "cloudflare", mcpUrl, keys, warnings, nextLines: [] })) out.log(line);
  return 0;
}

async function initSelfHosted(ctx, home) {
  const { flags, cwd, fsx, out } = ctx;
  if (fsx.exists(join(cwd, ENV_FILE)) && !flags.force) {
    out.log(`${ENV_FILE} already exists. Nothing was written. Use --force to replace it (you would also need new keys everywhere).`);
    return 1;
  }
  const keys = generateKeys(ctx.rng);
  const plan = planSelfHosted(home);
  const res = await runSteps(plan.steps, ctx, { keys }, secretValues(keys));
  if (res.code !== 0) return res.code;
  const mcpUrl = mcpUrlFor(flags.url ?? DEFAULT_LOCAL_URL);
  const warnings = mcpUrl.startsWith("https:")
    ? []
    : ["WARNING: Muse runs in Meta's cloud and cannot reach localhost. Put the board behind Tailscale Funnel or a named Cloudflare Tunnel, then use that https URL (run again with --url, or edit the URL below)."];
  for (const line of finalReport({ home, mcpUrl, keys, warnings, nextLines: plan.next })) out.log(line);
  return 0;
}

/** Entry point. Returns an exit code: 0 done, 1 failed or refused, 3 stopped at a prompt. Throws on bad arguments. */
export async function main(argv, env = process.env, deps = {}) {
  const flags = parseInitArgs(argv);
  const out = deps.out ?? console;
  if (flags.help || argv.length === 0) {
    out.log(USAGE);
    return 0;
  }
  const home = detectHome(flags, env);
  if ((flags.name !== undefined || flags["database-id"] !== undefined) && home !== "cloudflare") throw new Error("--name and --database-id apply to --cloudflare only");
  const ctx = {
    flags,
    out,
    cwd: deps.cwd ?? packageDir(),
    ask: deps.ask ?? defaultAsk,
    exec: deps.exec ?? defaultExec,
    fsx: deps.fsx ?? defaultFs,
    rng: deps.rng ?? randomBytes,
  };
  return home === "cloudflare" ? initCloudflare(ctx) : initSelfHosted(ctx, home);
}

if (isEntryModule(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`cbb-board-init: ${err.message}`);
      process.exit(1);
    },
  );
}
