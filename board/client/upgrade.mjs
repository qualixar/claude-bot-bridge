// Upgrade planning for `cbb-board upgrade`. Pure functions plus an injectable runner, so the logic is
// tested without running wrangler or docker. Nothing here reads or prints a secret.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const HOMES = ["cloudflare", "docker", "node"];

/** Board URL and owner key: CBB_BOARD_URL / CBB_BOARD_OWNER_KEY, or the legacy MUSE_BOARD_URL / MUSE_BOARD_OWNER_TOKEN. */
export function boardEnv(env) {
  return {
    url: env.CBB_BOARD_URL || env.MUSE_BOARD_URL || undefined,
    token: env.CBB_BOARD_OWNER_KEY || env.MUSE_BOARD_OWNER_TOKEN || undefined,
  };
}
export const DEFAULT_D1_NAME = "qualixar-task-board";
/** Untracked, per-maintainer Wrangler config (real database id). Used automatically when it exists next to wrangler.jsonc. */
export const LOCAL_WRANGLER_CONFIG = "wrangler.local.jsonc";

const withConfig = (args, config) => (config ? [...args, "--config", config] : args);

/** "1.2.3" or "v1.2.3-rc1" to [1, 2, 3]; null when it is not a version. */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1 when a is older than b, 0 when equal, 1 when newer, null when either is not a version. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/** Picks the home from flags, then CBB_BOARD_HOME. Exactly one is allowed. */
export function detectHome(flags, env) {
  const chosen = HOMES.filter((h) => flags[h] === true);
  if (chosen.length > 1) throw new Error(`Choose one home, not several: ${chosen.map((h) => `--${h}`).join(" ")}`);
  if (chosen.length === 1) return chosen[0];
  const fromEnv = env.CBB_BOARD_HOME;
  if (fromEnv) {
    if (!HOMES.includes(fromEnv)) throw new Error(`CBB_BOARD_HOME must be one of ${HOMES.join(", ")}`);
    return fromEnv;
  }
  throw new Error("Say where the board runs: --cloudflare, --docker or --node (or set CBB_BOARD_HOME).");
}

/** The /version URL for the board whose MCP endpoint is `mcpUrl`. (/healthz reports no version.) */
export function versionUrl(mcpUrl) {
  const u = new URL(mcpUrl);
  u.pathname = "/version";
  u.search = "";
  u.hash = "";
  return u.toString();
}

/**
 * Compares the live board with the target. `live` is the parsed /version body, or null when the board
 * is too old to report a version (the first release answered 401 on every path but /mcp).
 */
export function assess(live, target) {
  if (!live || typeof live.version !== "string") {
    return { known: false, order: null, migrationsPending: null, summary: `live board: unknown (no version reported) -> ${target.version}; migrations: will be checked and applied` };
  }
  const order = compareVersions(live.version, target.version);
  const pending = typeof live.schema === "number" ? live.schema < target.schema : null;
  const pendingText = pending === null ? "unknown" : pending ? `pending (schema ${live.schema} -> ${target.schema})` : "none";
  return { known: true, order, migrationsPending: pending, summary: `live board: ${live.version} -> ${target.version}; migrations: ${pendingText}` };
}

/** The commands that upgrade a board in `home`. `restart` lists what the user must do themselves. */
export function planUpgrade(home, opts = {}) {
  switch (home) {
    case "cloudflare":
      return {
        commands: [
          { cmd: "npx", args: withConfig(["wrangler", "d1", "migrations", "apply", opts.db || DEFAULT_D1_NAME, "--remote"], opts.config), why: "apply new database migrations (already-applied ones are skipped)" },
          { cmd: "npx", args: withConfig(["wrangler", "deploy"], opts.config), why: "deploy the new Worker code" },
        ],
        restart: [],
      };
    case "docker":
      return {
        // docker-compose.yml builds a local image from this checkout, so a plain `pull` would fetch nothing.
        commands: opts.pull
          ? [
              { cmd: "docker", args: ["compose", "pull"], why: "fetch the newer image from the registry" },
              { cmd: "docker", args: ["compose", "up", "-d"], why: "restart the container; migrations run at start" },
            ]
          : [
              { cmd: "docker", args: ["compose", "build"], why: "rebuild the image from this checkout" },
              { cmd: "docker", args: ["compose", "up", "-d"], why: "restart the container; migrations run at start" },
            ],
        restart: [],
      };
    case "node":
      return {
        commands: [{ cmd: "npm", args: ["run", "build:node"], why: "rebuild dist/node from this checkout" }],
        restart: [
          "Restart the server yourself so it loads the new build (migrations run automatically at start):",
          "  launchd:  launchctl kickstart -k gui/$(id -u)/<your label>",
          "  systemd:  sudo systemctl restart <your unit>",
          "  by hand:  stop the running `npm start`, then run it again",
        ],
      };
    default:
      throw new Error(`Unknown home: ${home}`);
  }
}

const show = (c) => [c.cmd, ...c.args].join(" ");

/** Prints the plan, asks y/N for each command unless `yes`, runs it, stops on the first failure. Returns an exit code. */
export async function runPlan(plan, { yes, ask, exec, out, cwd }) {
  for (const c of plan.commands) {
    out.log(`\n$ ${show(c)}\n  (${c.why})`);
    if (!yes && !(await ask("Run it? [y/N] "))) {
      out.log("Stopped. Nothing further was run.");
      return 3;
    }
    const code = await exec(c.cmd, c.args, { cwd });
    if (code !== 0) {
      out.log(`Command failed with exit code ${code}. Stopped.`);
      return 1;
    }
  }
  for (const line of plan.restart) out.log(line);
  return 0;
}

/** GET /version with the owner key (any valid key works). Null for boards too old to have the route, or unreachable. */
export async function fetchVersion(url, token, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json", authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const body = await res.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

/** JSON with // and /* *\/ comments (wrangler.jsonc). String-aware, so "https://x" survives. */
export function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) throw new Error("Unterminated comment");
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const D1_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** The D1 database name a Wrangler config (jsonc text) deploys to: the `DB` binding's, else the first entry's. Undefined when it names none. */
export function d1NameFromConfig(text) {
  try {
    const list = parseJsonc(text).d1_databases;
    if (!Array.isArray(list)) return undefined;
    const entry = list.find((d) => d?.binding === "DB") ?? list[0];
    const name = entry?.database_name;
    return typeof name === "string" && D1_NAME.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Secret names from `wrangler secret list` (JSON). Names only: the command never returns values. */
export function parseSecretNames(stdout) {
  try {
    const list = JSON.parse(stdout);
    return Array.isArray(list) ? list.filter((x) => x && typeof x.name === "string").map((x) => x.name) : null;
  } catch {
    return null;
  }
}

const PUT_HINT = {
  BOARD_ENCRYPTION_KEY: "node client/board.mjs keygen --encryption-key   # paste the value when wrangler asks",
  SESSION_SECRET: "node client/board.mjs keygen --session-secret   # paste the value when wrangler asks",
};

/** The deployed Worker refuses requests without these, so do not deploy without them. */
export function checkSecrets(names, { allowPlaintext }) {
  const required = [...(allowPlaintext ? [] : ["BOARD_ENCRYPTION_KEY"]), "SESSION_SECRET"];
  const missing = required.filter((n) => !names.includes(n));
  return { ok: missing.length === 0, missing, commands: missing.map((n) => `npx wrangler secret put ${n}`) };
}

async function cloudflarePreflight({ target, capture, cwd, out, config }) {
  const res = await capture("npx", withConfig(["wrangler", "secret", "list", "--format", "json"], config), { cwd });
  const names = res.code === 0 ? parseSecretNames(res.stdout) : null;
  if (!names) {
    out.log("Preflight: could not list secrets with `npx wrangler secret list` (not logged in, or wrangler failed). Fix that, or pass --skip-preflight.");
    return false;
  }
  const check = checkSecrets(names, { allowPlaintext: target.allowPlaintext === true });
  if (check.ok) return true;
  out.log(`Preflight: the Worker would answer 503 or refuse logins, because these secrets are not set: ${check.missing.join(", ")}.`);
  out.log("Set them first (each command asks for the value; nothing is printed here):");
  for (const [i, c] of check.commands.entries()) out.log(`  ${c}\n    generate: ${PUT_HINT[check.missing[i]]}`);
  return false;
}

/** `--config PATH` wins; otherwise wrangler.local.jsonc next to wrangler.jsonc, when it exists. */
function pickConfig(flags, cwd, fileExists, out) {
  if (typeof flags.config === "string") return flags.config;
  if (fileExists(join(cwd, LOCAL_WRANGLER_CONFIG))) {
    out.log(`Using ${LOCAL_WRANGLER_CONFIG} (your untracked Wrangler config).`);
    return LOCAL_WRANGLER_CONFIG;
  }
  return undefined;
}

/** The database name in the Wrangler config that is in use (the one passed with --config, else wrangler.local.jsonc), when it has one. */
function configuredDb(config, cwd, readFile) {
  if (!config) return undefined;
  try {
    return d1NameFromConfig(readFile(isAbsolute(config) ? config : join(cwd, config)));
  } catch {
    return undefined;
  }
}

/** Full `upgrade` command. `target` is { version, schema, allowPlaintext } from this checkout. */
export async function upgrade({ flags, env, target, out, fetchImpl, exec, capture, ask, cwd, fileExists = existsSync, readFile = (p) => readFileSync(p, "utf8") }) {
  const home = detectHome(flags, env);
  const board = boardEnv(env);
  const live = board.url && board.token ? await fetchVersion(versionUrl(board.url), board.token, fetchImpl) : null;
  out.log(`Home: ${home}`);
  const a = assess(live, target);
  out.log(a.summary);
  if (a.order === 1 && !flags.force) {
    out.log("The live board is newer than this checkout. Update the checkout first, or pass --force.");
    return 1;
  }
  if (a.order === 0 && a.migrationsPending === false && !flags.force) {
    out.log("Already up to date. Pass --force to run the steps anyway.");
    return 0;
  }
  const config = home === "cloudflare" ? pickConfig(flags, cwd, fileExists, out) : undefined;
  if (home === "cloudflare" && flags["skip-preflight"] !== true && !(await cloudflarePreflight({ target, capture, cwd, out, config }))) return 1;
  // --db wins; else the database named in the config in use (so a renamed database is not migrated under the default name).
  const fromConfig = typeof flags.db === "string" ? undefined : configuredDb(config, cwd, readFile);
  if (fromConfig && home === "cloudflare") out.log(`Database: ${fromConfig} (from ${config}).`);
  const plan = planUpgrade(home, { db: typeof flags.db === "string" ? flags.db : fromConfig, config, pull: flags.pull === true });
  return runPlan(plan, { yes: flags.yes === true, ask, exec, out, cwd });
}
