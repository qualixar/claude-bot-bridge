import { describe, expect, it, vi } from "vitest";
// @ts-expect-error plain ESM script without types
import { HOMES, assess, checkSecrets, compareVersions, d1NameFromConfig, detectHome, fetchVersion, parseJsonc, parseSecretNames, parseVersion, planUpgrade, runPlan, upgrade, versionUrl } from "../client/upgrade.mjs";

const target = { version: "0.2.0", schema: 1 };
const cmds = (plan: any) => plan.commands.map((c: any) => [c.cmd, ...c.args].join(" "));
const out = () => ({ log: vi.fn(), text: function (this: any) { return this.log.mock.calls.map((c: unknown[]) => c[0]).join("\n"); } });

describe("version comparison", () => {
  it("parses plain, v-prefixed and pre-release versions and rejects junk", () => {
    expect(parseVersion("0.2.0")).toEqual([0, 2, 0]);
    expect(parseVersion("v1.10.3-rc.1")).toEqual([1, 10, 3]);
    for (const bad of ["", "abc", "1.2", undefined, null]) expect(parseVersion(bad)).toBeNull();
  });

  it("compares numerically, not as strings", () => {
    expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(compareVersions("0.2.0", "v0.2.0")).toBe(0);
    expect(compareVersions("0.2.0", "junk")).toBeNull();
  });
});

describe("home detection", () => {
  it("takes one flag, falls back to CBB_BOARD_HOME, and refuses ambiguity", () => {
    expect(detectHome({ docker: true }, {})).toBe("docker");
    expect(detectHome({}, { CBB_BOARD_HOME: "node" })).toBe("node");
    expect(detectHome({ cloudflare: true }, { CBB_BOARD_HOME: "node" })).toBe("cloudflare");
    expect(() => detectHome({ docker: true, node: true }, {})).toThrow(/one home/);
    expect(() => detectHome({}, {})).toThrow(/--cloudflare, --docker or --node/);
    expect(() => detectHome({}, { CBB_BOARD_HOME: "vps" })).toThrow(/CBB_BOARD_HOME/);
    expect(HOMES).toEqual(["cloudflare", "docker", "node"]);
  });

  it("derives the version URL from the MCP URL", () => {
    expect(versionUrl("https://board.example.com/mcp")).toBe("https://board.example.com/version");
    expect(versionUrl("http://localhost:8787/mcp?x=1")).toBe("http://localhost:8787/version");
  });
});

describe("assessing the live board", () => {
  it("reports the version change and pending migrations", () => {
    expect(assess({ version: "0.1.0", schema: 1 }, target)).toMatchObject({ order: -1, migrationsPending: false });
    const pending = assess({ version: "0.1.0", schema: 0 }, { version: "0.3.0", schema: 2 });
    expect(pending.migrationsPending).toBe(true);
    expect(pending.summary).toBe("live board: 0.1.0 -> 0.3.0; migrations: pending (schema 0 -> 2)");
    expect(assess({ version: "0.2.0", schema: 1 }, target)).toMatchObject({ order: 0, migrationsPending: false });
    expect(assess({ version: "0.9.0", schema: 1 }, target).order).toBe(1);
  });

  it("copes with a board too old to report a version", () => {
    for (const live of [null, {}, { ok: true }]) {
      const a = assess(live, target);
      expect(a).toMatchObject({ known: false, order: null, migrationsPending: null });
      expect(a.summary).toContain("unknown");
    }
    expect(assess({ version: "0.2.0" }, target).summary).toContain("migrations: unknown");
  });
});

describe("planning", () => {
  it("Cloudflare: migrations first, then deploy, with a configurable database name", () => {
    expect(cmds(planUpgrade("cloudflare"))).toEqual(["npx wrangler d1 migrations apply qualixar-task-board --remote", "npx wrangler deploy"]);
    expect(cmds(planUpgrade("cloudflare", { db: "my-board" }))[0]).toBe("npx wrangler d1 migrations apply my-board --remote");
  });

  it("Docker: builds the local image then up -d; --pull is the opt-in for registry images", () => {
    expect(cmds(planUpgrade("docker"))).toEqual(["docker compose build", "docker compose up -d"]);
    expect(cmds(planUpgrade("docker", { build: true }))).toEqual(["docker compose build", "docker compose up -d"]);
    expect(cmds(planUpgrade("docker", { pull: true }))).toEqual(["docker compose pull", "docker compose up -d"]);
  });

  it("Cloudflare: --config is passed to migrations and deploy", () => {
    expect(cmds(planUpgrade("cloudflare", { config: "wrangler.local.jsonc" }))).toEqual([
      "npx wrangler d1 migrations apply qualixar-task-board --remote --config wrangler.local.jsonc",
      "npx wrangler deploy --config wrangler.local.jsonc",
    ]);
  });

  it("Node: rebuild, then tell the user how to restart", () => {
    const plan = planUpgrade("node");
    expect(cmds(plan)).toEqual(["npm run build:node"]);
    expect(plan.restart.join("\n")).toMatch(/launchctl kickstart/);
    expect(() => planUpgrade("vps")).toThrow(/Unknown home/);
  });

  it("never puts a secret-looking value in any command", () => {
    for (const home of HOMES) expect(cmds(planUpgrade(home)).join(" ")).not.toMatch(/token|key|secret|bearer/i);
  });
});

describe("running a plan", () => {
  const plan = planUpgrade("cloudflare");

  it("asks before every command and stops when declined", async () => {
    const o = out();
    const exec = vi.fn(async () => 0);
    const ask = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await runPlan(plan, { yes: false, ask, exec, out: o, cwd: "/x" })).toBe(3);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("npx", ["wrangler", "d1", "migrations", "apply", "qualixar-task-board", "--remote"], { cwd: "/x" });
    expect(o.text()).toContain("$ npx wrangler deploy");
  });

  it("runs everything without asking under --yes, and prints each command first", async () => {
    const o = out();
    const exec = vi.fn(async () => 0);
    const ask = vi.fn();
    expect(await runPlan(plan, { yes: true, ask, exec, out: o, cwd: "/x" })).toBe(0);
    expect(ask).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("stops at the first failing command", async () => {
    const o = out();
    const exec = vi.fn(async () => 2);
    expect(await runPlan(plan, { yes: true, ask: vi.fn(), exec, out: o, cwd: "/x" })).toBe(1);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(o.text()).toContain("exit code 2");
  });

  it("prints restart instructions for the Node home", async () => {
    const o = out();
    expect(await runPlan(planUpgrade("node"), { yes: true, ask: vi.fn(), exec: async () => 0, out: o, cwd: "/x" })).toBe(0);
    expect(o.text()).toContain("Restart the server yourself");
  });
});

describe("Cloudflare preflight (secret names only)", () => {
  it("reads names from `wrangler secret list` output and ignores anything else", () => {
    expect(parseSecretNames('[{"name":"OWNER_TOKEN","type":"secret_text"},{"name":"SESSION_SECRET","type":"secret_text"}]')).toEqual(["OWNER_TOKEN", "SESSION_SECRET"]);
    expect(parseSecretNames("not json")).toBeNull();
    expect(parseSecretNames('{"name":"x"}')).toBeNull();
    expect(parseSecretNames('[{"nope":1},{"name":"A"}]')).toEqual(["A"]);
  });

  it("requires SESSION_SECRET and BOARD_ENCRYPTION_KEY, with the exact put commands", () => {
    const r = checkSecrets(["OWNER_TOKEN", "WORKER_TOKEN"], { allowPlaintext: false });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["BOARD_ENCRYPTION_KEY", "SESSION_SECRET"]);
    expect(r.commands).toEqual(["npx wrangler secret put BOARD_ENCRYPTION_KEY", "npx wrangler secret put SESSION_SECRET"]);
    expect(checkSecrets(["BOARD_ENCRYPTION_KEY", "SESSION_SECRET"], { allowPlaintext: false })).toMatchObject({ ok: true, missing: [] });
  });

  it("does not need the encryption key when ALLOW_PLAINTEXT_STORAGE is \"1\" in the config", () => {
    expect(checkSecrets(["SESSION_SECRET"], { allowPlaintext: true })).toMatchObject({ ok: true });
    expect(checkSecrets([], { allowPlaintext: true }).missing).toEqual(["SESSION_SECRET"]);
  });

  it("parses wrangler.jsonc comments without touching strings that contain slashes", () => {
    const text = '{\n // a comment\n "url": "https://x.example/a//b", /* block */ "vars": { "ALLOW_PLAINTEXT_STORAGE": "1" /* , "X": "y" */ }\n}';
    expect(parseJsonc(text)).toEqual({ url: "https://x.example/a//b", vars: { ALLOW_PLAINTEXT_STORAGE: "1" } });
    expect(() => parseJsonc("{ nope")).toThrow();
  });
});

describe("upgrade command", () => {
  const live = (body: unknown, status = 200) => vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  const secrets = (names: string[]) => vi.fn(async () => ({ code: 0, stdout: JSON.stringify(names.map((name) => ({ name, type: "secret_text" }))) }));
  const base = { target: { ...target, allowPlaintext: false }, exec: vi.fn(async () => 0), ask: vi.fn(async () => true), cwd: "/x", capture: secrets(["BOARD_ENCRYPTION_KEY", "SESSION_SECRET"]) };
  const env = { MUSE_BOARD_URL: "https://board.example.com/mcp", MUSE_BOARD_OWNER_TOKEN: "owner-secret-value-123456" };

  it("reads /version with the owner key, prints current -> target and pending migrations, then runs the plan", async () => {
    const o = out();
    const exec = vi.fn(async () => 0);
    const fetchImpl = live({ ok: true, version: "0.1.0", schema: 0, api: 1 });
    const code = await upgrade({ ...base, exec, flags: { cloudflare: true, yes: true }, env, out: o, fetchImpl });
    expect(code).toBe(0);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://board.example.com/version");
    expect((fetchImpl.mock.calls[0][1]!.headers as Record<string, string>).authorization).toBe(`Bearer ${env.MUSE_BOARD_OWNER_TOKEN}`);
    expect(o.text()).toContain("live board: 0.1.0 -> 0.2.0; migrations: pending (schema 0 -> 1)");
    expect(exec).toHaveBeenCalledTimes(2);
    expect(o.text()).not.toContain(env.MUSE_BOARD_OWNER_TOKEN);
  });

  it("refuses to deploy to Cloudflare when a required secret is missing, and prints the put commands", async () => {
    const o = out();
    const exec = vi.fn(async () => 0);
    const code = await upgrade({ ...base, exec, capture: secrets(["OWNER_TOKEN", "WORKER_TOKEN"]), flags: { cloudflare: true, yes: true }, env, out: o, fetchImpl: live({}, 404) });
    expect(code).toBe(1);
    expect(exec).not.toHaveBeenCalled();
    expect(o.text()).toContain("npx wrangler secret put BOARD_ENCRYPTION_KEY");
    expect(o.text()).toContain("npx wrangler secret put SESSION_SECRET");
    expect(o.text()).toContain("keygen --encryption-key");
  });

  it("lets a plaintext-storage config skip the encryption key, but never the session secret", async () => {
    const exec = vi.fn(async () => 0);
    const plain = { ...base, target: { ...target, allowPlaintext: true } };
    expect(await upgrade({ ...plain, exec, capture: secrets(["SESSION_SECRET"]), flags: { cloudflare: true, yes: true }, env, out: out(), fetchImpl: live({}, 404) })).toBe(0);
    expect(await upgrade({ ...plain, exec, capture: secrets([]), flags: { cloudflare: true, yes: true }, env, out: out(), fetchImpl: live({}, 404) })).toBe(1);
  });

  it("refuses when the secret list cannot be read, unless --skip-preflight; other homes skip it", async () => {
    const failing = vi.fn(async () => ({ code: 1, stdout: "" }));
    const exec = vi.fn(async () => 0);
    const o = out();
    expect(await upgrade({ ...base, exec, capture: failing, flags: { cloudflare: true, yes: true }, env, out: o, fetchImpl: live({}, 404) })).toBe(1);
    expect(o.text()).toMatch(/could not list secrets/i);
    expect(await upgrade({ ...base, exec, capture: failing, flags: { cloudflare: true, yes: true, "skip-preflight": true }, env, out: out(), fetchImpl: live({}, 404) })).toBe(0);
    const capture = vi.fn();
    expect(await upgrade({ ...base, exec, capture, flags: { docker: true, yes: true }, env, out: out(), fetchImpl: live({}, 404) })).toBe(0);
    expect(capture).not.toHaveBeenCalled();
  });

  it("uses an untracked wrangler.local.jsonc automatically, and --config overrides it", async () => {
    const exec = vi.fn(async () => 0);
    const capture = secrets(["BOARD_ENCRYPTION_KEY", "SESSION_SECRET"]);
    const auto = { ...base, exec, capture, fileExists: (p: string) => p === "/x/wrangler.local.jsonc" };
    expect(await upgrade({ ...auto, flags: { cloudflare: true, yes: true }, env, out: out(), fetchImpl: live({}, 404) })).toBe(0);
    expect(capture).toHaveBeenCalledWith("npx", ["wrangler", "secret", "list", "--format", "json", "--config", "wrangler.local.jsonc"], { cwd: "/x" });
    expect(exec).toHaveBeenCalledWith("npx", ["wrangler", "deploy", "--config", "wrangler.local.jsonc"], { cwd: "/x" });
    exec.mockClear();
    expect(await upgrade({ ...auto, flags: { cloudflare: true, yes: true, config: "other.jsonc" }, env, out: out(), fetchImpl: live({}, 404) })).toBe(0);
    expect(exec).toHaveBeenCalledWith("npx", ["wrangler", "deploy", "--config", "other.jsonc"], { cwd: "/x" });
    exec.mockClear();
    expect(await upgrade({ ...base, exec, fileExists: () => false, flags: { cloudflare: true, yes: true }, env, out: out(), fetchImpl: live({}, 404) })).toBe(0);
    expect(exec).toHaveBeenCalledWith("npx", ["wrangler", "deploy"], { cwd: "/x" });
  });

  it("takes the D1 database name from the Wrangler config in use instead of the default, and --db still wins", async () => {
    const exec = vi.fn(async (_cmd: string, _args: string[], _opts?: unknown) => 0);
    const capture = secrets(["BOARD_ENCRYPTION_KEY", "SESSION_SECRET"]);
    const cfg = `{ // my deployment
      "name": "my-board",
      "d1_databases": [{ "binding": "DB", "database_name": "my-board-db", "database_id": "11111111-1111-1111-1111-111111111111" }],
    }`;
    const reads: string[] = [];
    const readFile = (p: string) => { reads.push(p); return cfg; };
    const auto = { ...base, exec, capture, readFile, fileExists: (p: string) => p === "/x/wrangler.local.jsonc" };
    const o = out();
    expect(await upgrade({ ...auto, flags: { cloudflare: true, yes: true }, env, out: o, fetchImpl: live({}, 404) })).toBe(0);
    expect(reads).toEqual(["/x/wrangler.local.jsonc"]);
    expect(exec).toHaveBeenCalledWith("npx", ["wrangler", "d1", "migrations", "apply", "my-board-db", "--remote", "--config", "wrangler.local.jsonc"], { cwd: "/x" });
    expect(o.text()).toContain("my-board-db");
    // the config passed with --config is the one read; a relative path is resolved against the checkout
    exec.mockClear(); reads.length = 0;
    expect(await upgrade({ ...auto, flags: { cloudflare: true, yes: true, config: "other.jsonc" }, env, out: out(), fetchImpl: live({}, 404) })).toBe(0);
    expect(reads).toEqual(["/x/other.jsonc"]);
    expect(exec.mock.calls[0][1]).toContain("my-board-db");
    // an explicit --db beats the file
    exec.mockClear();
    expect(await upgrade({ ...auto, flags: { cloudflare: true, yes: true, db: "forced-db" }, env, out: out(), fetchImpl: live({}, 404) })).toBe(0);
    expect(exec.mock.calls[0][1]).toContain("forced-db");
  });

  it("falls back to the default name when there is no config, it cannot be read, or it names no database", async () => {
    const exec = vi.fn(async (_cmd: string, _args: string[], _opts?: unknown) => 0);
    const capture = secrets(["BOARD_ENCRYPTION_KEY", "SESSION_SECRET"]);
    const withFile = (readFile: (p: string) => string) => ({ ...base, exec, capture, readFile, fileExists: (p: string) => p === "/x/wrangler.local.jsonc" });
    const names = async (deps: object) => { exec.mockClear(); expect(await upgrade({ ...deps, flags: { cloudflare: true, yes: true }, env, out: out(), fetchImpl: live({}, 404) } as never)).toBe(0); return exec.mock.calls[0][1]; };
    expect(await names({ ...base, exec, capture, fileExists: () => false })).toContain("qualixar-task-board");
    expect(await names(withFile(() => { throw new Error("EACCES"); }))).toContain("qualixar-task-board");
    expect(await names(withFile(() => "{ not json"))).toContain("qualixar-task-board");
    expect(await names(withFile(() => `{ "d1_databases": [] }`))).toContain("qualixar-task-board");
    expect(await names(withFile(() => `{ "d1_databases": [{ "binding": "OTHER", "database_name": "x" }, { "binding": "DB" }] }`))).toContain("qualixar-task-board");
  });

  it("d1NameFromConfig prefers the DB binding and ignores everything else", () => {
    expect(d1NameFromConfig(`{"d1_databases":[{"binding":"X","database_name":"a"},{"binding":"DB","database_name":"b"}]}`)).toBe("b");
    expect(d1NameFromConfig(`{"d1_databases":[{"database_name":"only"}]}`)).toBe("only");
    expect(d1NameFromConfig(`{"d1_databases":[{"binding":"DB","database_name":"  "}]}`)).toBeUndefined();
    expect(d1NameFromConfig(`{"d1_databases":[{"binding":"DB","database_name":"has space"}]}`)).toBeUndefined();
    expect(d1NameFromConfig(`{}`)).toBeUndefined();
    expect(d1NameFromConfig("nope")).toBeUndefined();
  });

  it("does nothing when already current, unless forced", async () => {
    const same = { ok: true, version: "0.2.0", schema: 1, api: 1 };
    const exec = vi.fn(async () => 0);
    expect(await upgrade({ ...base, exec, flags: { docker: true, yes: true }, env, out: out(), fetchImpl: live(same) })).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    expect(await upgrade({ ...base, exec, flags: { docker: true, yes: true, force: true }, env, out: out(), fetchImpl: live(same) })).toBe(0);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("refuses to downgrade without --force", async () => {
    const o = out();
    const exec = vi.fn(async () => 0);
    expect(await upgrade({ ...base, exec, flags: { node: true, yes: true }, env, out: o, fetchImpl: live({ version: "0.9.0", schema: 1 }) })).toBe(1);
    expect(exec).not.toHaveBeenCalled();
    expect(o.text()).toContain("newer than this checkout");
  });

  it("proceeds when the old board answers 401/404 or is unreachable, and without a URL or key", async () => {
    for (const fetchImpl of [live({}, 401), live({}, 404), vi.fn(async (_u: string) => { throw new Error("down"); })]) {
      const exec = vi.fn(async () => 0);
      const o = out();
      expect(await upgrade({ ...base, exec, flags: { cloudflare: true, yes: true }, env, out: o, fetchImpl })).toBe(0);
      expect(o.text()).toContain("unknown");
    }
    const exec = vi.fn(async () => 0);
    const none = vi.fn();
    expect(await upgrade({ ...base, exec, flags: { node: true, yes: true }, env: {}, out: out(), fetchImpl: none })).toBe(0);
    expect(await upgrade({ ...base, exec, flags: { node: true, yes: true }, env: { MUSE_BOARD_URL: env.MUSE_BOARD_URL }, out: out(), fetchImpl: none })).toBe(0);
    expect(none).not.toHaveBeenCalled();
    expect(await fetchVersion("https://x/version", "k", live("not an object-ish", 200) as any)).toBe(null);
  });

  it("needs a home", async () => {
    await expect(upgrade({ ...base, flags: {}, env, out: out(), fetchImpl: live({}) })).rejects.toThrow(/--cloudflare/);
  });
});
