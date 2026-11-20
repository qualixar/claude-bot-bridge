import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runtime } from "#harness";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error plain ESM script without types
import { RECURRING_JOB_PROMPT, SECRET_NAMES, defaultExec, generateKeys, main, mcpUrlFor, museMessage, parseDatabaseId, parseInitArgs, parseWorkerUrl, planCloudflare, planSelfHosted, redact, renderEnvFile, renderWranglerConfig, secretValues } from "../client/init.mjs";
// @ts-expect-error plain ESM script without types
import { parseJsonc } from "../client/upgrade.mjs";

const ROOT = join(import.meta.dirname, "..");
/** The workers test pool has no real file system: there the tests use a small stand-in with the same shape. */
const tryRead = (name: string): string | null => {
  try {
    return readFileSync(join(ROOT, name), "utf8");
  } catch {
    return null;
  }
};
const STAND_IN_CONFIG = `{
  "name": "qualixar-task-board",
  // Secrets (set with \`wrangler secret put NAME\`, never in this file):
  "ratelimits": [{ "name": "AUTH_FAIL_LIMITER", "namespace_id": "1001", "simple": { "limit": 20, "period": 60 } }],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "qualixar-task-board",
      "database_id": "00000000-0000-0000-0000-000000000000",
      "migrations_dir": "migrations"
    }
  ]
}`;
const BASE_CONFIG = tryRead("wrangler.jsonc") ?? STAND_IN_CONFIG;
const README = tryRead("README.md");
const DB_ID = "11111111-2222-4333-8444-555555555555";
const D1_OUTPUT = `✅ Successfully created DB 'qualixar-task-board'\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "qualixar-task-board"\ndatabase_id = "${DB_ID}"\n`;
const DEPLOY_OUTPUT = "Uploaded qualixar-task-board\nDeployed qualixar-task-board triggers\n  https://qualixar-task-board.someone.workers.dev\n";

/** Deterministic random source: each call returns 32 distinct bytes. */
function seqRng() {
  let n = 0;
  return (size: number) => Buffer.alloc(size, ++n * 7 + 1);
}

interface Call {
  cmd: string;
  args: string[];
  input?: string;
}

function setup(over: { exists?: string[]; answers?: boolean[] } = {}) {
  const calls: Call[] = [];
  const files = new Map<string, { data: string; overwrite: boolean }>();
  const existing = new Set(over.exists ?? []);
  const lines: string[] = [];
  const answers = [...(over.answers ?? [])];
  const questions: string[] = [];
  const deps = {
    cwd: "/board",
    rng: seqRng(),
    out: { log: (l: string) => void lines.push(String(l)) },
    ask: vi.fn(async (q: string) => (questions.push(q), answers.length ? (answers.shift() as boolean) : true)),
    exec: vi.fn(async (_cmd: string, _args: string[], _opts: { input?: string }) => ({ code: 0, stdout: "", stderr: "" })),
    fsx: {
      exists: (p: string) => existing.has(p) || files.has(p),
      read: (p: string) => (p.endsWith("wrangler.jsonc") ? BASE_CONFIG : ""),
      write: (p: string, data: string, o: { overwrite: boolean }) => {
        if (files.has(p) && !o.overwrite) throw Object.assign(new Error("exists"), { code: "EEXIST" });
        files.set(p, { data, overwrite: o.overwrite });
      },
    },
  };
  const cf = {
    whoami: { code: 0, stdout: "You are logged in", stderr: "" },
    "d1 create": { code: 0, stdout: D1_OUTPUT, stderr: "" },
    deploy: { code: 0, stdout: DEPLOY_OUTPUT, stderr: "" },
  };
  return { deps, calls, files, lines, questions, text: () => lines.join("\n"), cf };
}

/** Scripted wrangler: logged in, a database id on create, a workers.dev URL on deploy. */
function wranglerExec(s: ReturnType<typeof setup>, special: (joined: string, opts: any) => { code: number; stdout: string; stderr: string } | undefined = () => undefined) {
  return vi.fn(async (cmd: string, args: string[], opts: any) => {
    s.calls.push({ cmd, args, input: opts.input });
    const joined = args.join(" ");
    const custom = special(joined, opts);
    if (custom) return custom;
    if (joined === "wrangler whoami") return s.cf.whoami;
    if (joined.startsWith("wrangler d1 create")) return s.cf["d1 create"];
    if (joined.startsWith("wrangler deploy")) return s.cf.deploy;
    return { code: 0, stdout: "", stderr: "" };
  });
}

describe("arguments", () => {
  it("parses flags and rejects typos, bad names and bad ids", () => {
    expect(parseInitArgs(["--cloudflare", "--name", "my-board", "--yes"])).toEqual({ cloudflare: true, name: "my-board", yes: true });
    expect(parseInitArgs(["--node", "--url", "https://b.example"])).toEqual({ node: true, url: "https://b.example" });
    expect(() => parseInitArgs(["--cloudflar"])).toThrow(/Unknown option/);
    expect(() => parseInitArgs(["--name"])).toThrow(/needs a value/);
    expect(() => parseInitArgs(["--name", "Bad Name"])).toThrow(/lowercase/);
    expect(() => parseInitArgs(["--database-id", "abc"])).toThrow(/UUID/);
    expect(() => parseInitArgs(["stray"])).toThrow(/Unexpected/);
  });

  it("needs exactly one home, and --name only with cloudflare", async () => {
    const s = setup();
    await expect(main(["--yes"], {}, s.deps)).rejects.toThrow(/--cloudflare, --docker or --node/);
    await expect(main(["--docker", "--node"], {}, s.deps)).rejects.toThrow(/one home/);
    await expect(main(["--docker", "--name", "x"], {}, s.deps)).rejects.toThrow(/--cloudflare only/);
    expect(await main(["--help"], {}, s.deps)).toBe(0);
    expect(s.text()).toMatch(/Usage: cbb-board-init/);
  });
});

describe("plans", () => {
  const ids = (plan: any[]) => plan.map((s) => s.id);
  it("cloudflare: login check, create, config, migrate, five secrets, deploy, in that order", () => {
    const plan = planCloudflare({ name: "my-board" });
    expect(ids(plan)).toEqual(["whoami", "d1_create", "write_config", "migrate", "secret", "secret", "secret", "secret", "secret", "deploy"]);
    const cmds = plan.filter((s: any) => s.cmd).map((s: any) => s.args.join(" "));
    expect(cmds[0]).toBe("wrangler whoami");
    expect(cmds[1]).toBe("wrangler d1 create my-board");
    expect(cmds[2]).toBe("wrangler d1 migrations apply my-board --remote --config wrangler.local.jsonc");
    expect(plan.filter((s: any) => s.secret).map((s: any) => s.secret)).toEqual(SECRET_NAMES);
    expect(cmds.at(-1)).toBe("wrangler deploy --config wrangler.local.jsonc");
    expect(JSON.stringify(plan)).not.toMatch(/[A-Za-z0-9_-]{40,}/); // the plan holds names, never values
  });

  it("cloudflare with an existing database id skips the create step", () => {
    expect(ids(planCloudflare({ databaseId: DB_ID }))).not.toContain("d1_create");
  });

  it("docker and node write one .env and name the next command", () => {
    expect(ids(planSelfHosted("docker").steps)).toEqual(["write_env"]);
    expect(planSelfHosted("docker").next).toEqual(["docker compose up -d --build"]);
    expect(planSelfHosted("node").next.at(-1)).toBe("npm start");
  });
});

describe("parsing helpers", () => {
  it("reads the database id from TOML, JSON and prose output", () => {
    expect(parseDatabaseId(D1_OUTPUT)).toBe(DB_ID);
    expect(parseDatabaseId(`{\n  "d1_databases": [{ "binding": "DB", "database_id": "${DB_ID}" }]\n}`)).toBe(DB_ID);
    expect(parseDatabaseId(`created ${DB_ID.toUpperCase()} ok`)).toBe(DB_ID.toUpperCase());
    expect(parseDatabaseId("no id here")).toBeNull();
  });

  it("reads the workers.dev URL from deploy output", () => {
    expect(parseWorkerUrl(DEPLOY_OUTPUT)).toBe("https://qualixar-task-board.someone.workers.dev");
    expect(parseWorkerUrl("Deployed to a custom domain")).toBeNull();
  });

  it("builds the MCP URL and refuses non-https except loopback", () => {
    expect(mcpUrlFor("https://b.example")).toBe("https://b.example/mcp");
    expect(mcpUrlFor("https://b.example/mcp")).toBe("https://b.example/mcp");
    expect(mcpUrlFor("https://b.example/sub/")).toBe("https://b.example/sub/mcp");
    expect(mcpUrlFor("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787/mcp");
    expect(() => mcpUrlFor("http://b.example")).toThrow(/https/);
    expect(() => mcpUrlFor("not a url")).toThrow();
  });

  it("writes the database id and name into a copy of wrangler.jsonc and keeps the comments", () => {
    const text = renderWranglerConfig(BASE_CONFIG, { databaseId: DB_ID, name: "my-board" });
    const cfg = parseJsonc(text);
    expect(cfg.name).toBe("my-board");
    expect(cfg.d1_databases[0]).toMatchObject({ database_id: DB_ID, database_name: "my-board", binding: "DB" });
    expect(cfg.ratelimits[0].name).toBe("AUTH_FAIL_LIMITER");
    expect(text).toContain("// Secrets (set with `wrangler secret put NAME`");
    expect(() => renderWranglerConfig("{}", { databaseId: DB_ID, name: "x" })).toThrow(/unexpected shape/);
  });

  it("redacts every secret value", () => {
    expect(redact("a SECRET1 b SECRET2 SECRET1", ["SECRET1", "SECRET2"])).toBe("a [REDACTED] b [REDACTED] [REDACTED]");
  });

  it("generated keys are distinct and their hashes match", () => {
    const k = generateKeys(seqRng());
    expect(new Set([k.ownerKey, k.workerKey, k.viewerKey]).size).toBe(3);
    expect(Object.keys(k.secrets)).toEqual(SECRET_NAMES);
    expect(k.secrets.OWNER_KEY_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(k.secrets.BOARD_ENCRYPTION_KEY, "base64")).toHaveLength(32);
    expect(() => generateKeys(() => Buffer.alloc(32, 1))).toThrow(/same key twice/);
  });

  it("the .env holds hashes and server secrets, never the access keys", () => {
    const k = generateKeys(seqRng());
    const env = renderEnvFile(k);
    for (const n of SECRET_NAMES) expect(env).toContain(`${n}=${k.secrets[n]}`);
    for (const key of [k.ownerKey, k.workerKey, k.viewerKey]) expect(env).not.toContain(key);
  });

  it("the Muse message names the connector and URL, and the recurring job matches the README", () => {
    const m = museMessage("https://b.example/mcp");
    expect(m).toContain("Claude Bot Bridge Board");
    expect(m).toContain("https://b.example/mcp");
    expect(m).toMatch(/secure credential prompt, never in chat/);
  });

  it.skipIf(README === null)("the recurring job prompt is word for word the one in README.md", () => {
    expect(README).toContain(RECURRING_JOB_PROMPT);
  });
});

describe("--cloudflare run", () => {
  it("with --yes runs every step in order and asks nothing", async () => {
    const s = setup();
    s.deps.exec = wranglerExec(s);
    expect(await main(["--cloudflare", "--yes"], {}, s.deps)).toBe(0);
    expect(s.deps.ask).not.toHaveBeenCalled();
    expect(s.calls.map((c) => c.args.slice(0, 3).join(" "))).toEqual([
      "wrangler whoami",
      "wrangler d1 create",
      "wrangler d1 migrations",
      ...SECRET_NAMES.map((n: string) => `wrangler secret put ${n}`.split(" ").slice(0, 3).join(" ")),
      "wrangler deploy --config",
    ]);
    const written = s.files.get("/board/wrangler.local.jsonc")!;
    expect(parseJsonc(written.data).d1_databases[0].database_id).toBe(DB_ID);
    expect(written.overwrite).toBe(false);
    expect(s.text()).toContain("export CBB_BOARD_URL=https://qualixar-task-board.someone.workers.dev/mcp CBB_BOARD_OWNER_KEY=");
    expect(s.text()).toContain("https://qualixar-task-board.someone.workers.dev/board");
  });

  async function fullRun(extraArgs: string[] = ["--yes"]) {
    const s = setup();
    s.deps.exec = wranglerExec(s);
    const code = await main(["--cloudflare", ...extraArgs], {}, s.deps);
    const keys = generateKeys(seqRng()); // same deterministic sequence as the run
    return { s, code, keys };
  }

  it("secrets travel on stdin only: never in argv, never in a log except the one final print", async () => {
    const { s, code, keys } = await fullRun();
    expect(code).toBe(0);
    const argv = s.calls.map((c) => [c.cmd, ...c.args].join(" ")).join("\n");
    for (const v of secretValues(keys)) expect(argv).not.toContain(v);
    const puts = s.calls.filter((c) => c.args[1] === "secret");
    expect(puts.map((c) => c.args[3])).toEqual(SECRET_NAMES);
    expect(puts.map((c) => c.input)).toEqual(SECRET_NAMES.map((n: string) => `${keys.secrets[n as keyof typeof keys.secrets]}\n`));
    // The three keys appear exactly once in everything printed; the hashes and server secrets never.
    const printed = s.text();
    for (const k of [keys.ownerKey, keys.workerKey, keys.viewerKey]) expect(printed.split(k).length - 1).toBe(1);
    for (const v of Object.values(keys.secrets)) expect(printed).not.toContain(v);
  });

  it("prints the owner export line, viewer key, Muse message, worker key label and the recurring job", async () => {
    const { s, keys } = await fullRun();
    const t = s.text();
    expect(t).toContain(`export CBB_BOARD_URL=https://qualixar-task-board.someone.workers.dev/mcp CBB_BOARD_OWNER_KEY=${keys.ownerKey}`);
    expect(t).toContain(keys.viewerKey);
    expect(t).toContain("Claude Bot Bridge Board");
    expect(t).toContain("Worker key (paste ONLY into Muse's secure prompt");
    expect(t).toContain(RECURRING_JOB_PROMPT);
    // The Muse message block holds the URL and no key at all.
    const start = t.indexOf("Muse. Paste this message");
    expect(start).toBeGreaterThan(0);
    const block = t.slice(start, t.indexOf("Worker key (paste ONLY"));
    expect(block).toContain("https://qualixar-task-board.someone.workers.dev/mcp");
    for (const k of [keys.ownerKey, keys.workerKey, keys.viewerKey]) expect(block).not.toContain(k);
    expect(t.indexOf(keys.workerKey)).toBeGreaterThan(t.indexOf("Worker key (paste ONLY"));
  });

  it("asks y/N before every step without --yes, and stops cleanly on N", async () => {
    const s = setup({ answers: [true, true, false] });
    s.deps.exec = wranglerExec(s);
    expect(await main(["--cloudflare"], {}, s.deps)).toBe(3);
    expect(s.questions).toHaveLength(3);
    expect(s.calls).toHaveLength(2); // whoami, d1 create; the third was declined
    expect(s.text()).toContain("Stopped. Nothing further was run.");
    expect(s.text()).not.toContain("CBB_BOARD_OWNER_KEY=");
  });

  it("stops when wrangler is not logged in, and prints nothing from whoami", async () => {
    const s = setup();
    s.deps.exec = vi.fn(async (cmd: string, args: string[]) => (s.calls.push({ cmd, args }), { code: 0, stdout: "You are not authenticated. user@example.com", stderr: "" }));
    expect(await main(["--cloudflare", "--yes"], {}, s.deps)).toBe(1);
    expect(s.calls).toHaveLength(1);
    expect(s.text()).toMatch(/Not logged in/);
    expect(s.text()).not.toContain("user@example.com");
  });

  it("refuses to overwrite an existing wrangler.local.jsonc, before creating any database", async () => {
    const s = setup({ exists: ["/board/wrangler.local.jsonc"] });
    expect(await main(["--cloudflare", "--yes"], {}, s.deps)).toBe(1);
    expect(s.calls).toHaveLength(0);
    expect(s.text()).toMatch(/already exists/);
    expect(s.files.size).toBe(0);
  });

  it("--force replaces it; --database-id resumes without creating a database", async () => {
    const s = setup({ exists: ["/board/wrangler.local.jsonc"] });
    s.deps.exec = vi.fn(async (cmd: string, args: string[]) => (s.calls.push({ cmd, args }), { code: 0, stdout: args[1] === "whoami" ? "ok" : DEPLOY_OUTPUT, stderr: "" }));
    expect(await main(["--cloudflare", "--yes", "--force", "--database-id", DB_ID], {}, s.deps)).toBe(0);
    expect(s.calls.some((c) => c.args[1] === "d1" && c.args[2] === "create")).toBe(false);
    expect(s.files.get("/board/wrangler.local.jsonc")).toMatchObject({ overwrite: true });
  });

  it("a failing secret step stops the run, redacts output, and gives the resume command without printing keys", async () => {
    const s = setup();
    let leaked = "";
    s.deps.exec = wranglerExec(s, (joined, opts) => {
      if (!joined.includes("secret put WORKER_KEY_SHA256")) return undefined;
      leaked = String(opts.input).trim();
      return { code: 1, stdout: "", stderr: `bad value ${leaked}` };
    });
    expect(await main(["--cloudflare", "--yes"], {}, s.deps)).toBe(1);
    expect(s.calls.filter((c) => c.args[1] === "secret")).toHaveLength(2);
    expect(s.text()).toContain("[REDACTED]");
    expect(s.text()).not.toContain(leaked);
    expect(s.text()).toContain(`--database-id ${DB_ID}`);
    expect(s.text()).not.toContain("CBB_BOARD_OWNER_KEY=");
  });

  it("a deploy without a workers.dev URL still finishes, with a warning and a placeholder (or --url)", async () => {
    const s = setup();
    s.deps.exec = vi.fn(async (cmd: string, args: string[]) => (s.calls.push({ cmd, args }), { code: 0, stdout: args[1] === "d1" && args[2] === "create" ? D1_OUTPUT : "custom domain", stderr: "" }));
    expect(await main(["--cloudflare", "--yes"], {}, s.deps)).toBe(0);
    expect(s.text()).toMatch(/WARNING: the deploy output had no workers.dev URL/);
    const t = setup();
    t.deps.exec = s.deps.exec;
    expect(await main(["--cloudflare", "--yes", "--url", "https://board.example.com"], {}, t.deps)).toBe(0);
    expect(t.text()).toContain("CBB_BOARD_URL=https://board.example.com/mcp");
  });

  it("a d1 create whose output has no id fails with a way forward", async () => {
    const s = setup();
    s.deps.exec = vi.fn(async (cmd: string, args: string[]) => (s.calls.push({ cmd, args }), { code: 0, stdout: "created", stderr: "" }));
    expect(await main(["--cloudflare", "--yes"], {}, s.deps)).toBe(1);
    expect(s.text()).toMatch(/--database-id/);
  });
});

describe("--docker and --node", () => {
  it("write a new .env (hashes and server secrets only) and print the connector steps and next command", async () => {
    const s = setup();
    expect(await main(["--docker", "--yes", "--url", "https://board.example.com"], {}, s.deps)).toBe(0);
    const env = s.files.get("/board/.env")!;
    expect(env.overwrite).toBe(false);
    const keys = generateKeys(seqRng());
    for (const n of SECRET_NAMES) expect(env.data).toContain(`${n}=${keys.secrets[n as keyof typeof keys.secrets]}`);
    for (const k of [keys.ownerKey, keys.workerKey, keys.viewerKey]) {
      expect(env.data).not.toContain(k);
      expect(s.text().split(k).length - 1).toBe(1);
    }
    expect(s.calls).toHaveLength(0); // never runs docker
    expect(s.text()).toContain("docker compose up -d --build");
    expect(s.text()).toContain("CBB_BOARD_URL=https://board.example.com/mcp");
    expect(s.text()).not.toMatch(/WARNING/);
  });

  it("--node prints npm start and warns that localhost is unreachable for Muse", async () => {
    const s = setup();
    expect(await main(["--node", "--yes"], {}, s.deps)).toBe(0);
    expect(s.text()).toContain("npm start");
    expect(s.text()).toContain("CBB_BOARD_URL=http://127.0.0.1:8787/mcp");
    expect(s.text()).toMatch(/WARNING: Muse runs in Meta's cloud/);
  });

  it("refuses to overwrite an existing .env without --force and writes nothing", async () => {
    const s = setup({ exists: ["/board/.env"] });
    expect(await main(["--node", "--yes"], {}, s.deps)).toBe(1);
    expect(s.files.size).toBe(0);
    expect(s.text()).toMatch(/\.env already exists/);
    expect(await main(["--node", "--yes", "--force"], {}, s.deps)).toBe(0);
    expect(s.files.get("/board/.env")).toMatchObject({ overwrite: true });
  });

  it("asks before writing, and a no writes nothing", async () => {
    const s = setup({ answers: [false] });
    expect(await main(["--docker"], {}, s.deps)).toBe(3);
    expect(s.files.size).toBe(0);
  });

  it("reports a write failure instead of crashing, and never prints the keys", async () => {
    const s = setup();
    s.deps.fsx.write = () => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    };
    expect(await main(["--node", "--yes"], {}, s.deps)).toBe(1);
    expect(s.text()).toMatch(/Could not write .*disk full/);
    expect(s.text()).not.toContain("CBB_BOARD_OWNER_KEY=");
  });
});

describe.skipIf(runtime === "workers")("default exec (real child process)", () => {
  it("captures output and the exit code, and feeds stdin without putting it in argv", async () => {
    const script = "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log('got:'+d.trim());process.exit(3)})";
    const res = await defaultExec(process.execPath, ["-e", script], { cwd: ROOT, input: "value-123\n", quiet: true });
    expect(res).toMatchObject({ code: 3, stdout: "got:value-123\n" });
  });

  it("reports a missing command as exit code 127 instead of throwing", async () => {
    const res = await defaultExec("definitely-not-a-command-xyz", [], { cwd: ROOT, quiet: true, interactive: false });
    expect(res.code).toBe(127);
  });
});
