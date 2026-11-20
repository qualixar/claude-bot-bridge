// `install.sh --uninstall`, run against a throwaway HOME with a fake launchctl: it must remove the bridge home and the
// canary agent and nothing else, and refuse any CBB_HOME that is not strictly inside HOME.
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmp } from "./helpers.js";

const script = new URL("../../../../scripts/install.sh", import.meta.url).pathname;
const made = [];
afterEach(() => { while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true }); });

function sandbox() {
  const root = fs.realpathSync(tmp("cbb-un"));
  made.push(root);
  const home = path.join(root, "home");
  const bin = path.join(root, "fakebin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(home, "Library", "LaunchAgents"), { recursive: true });
  const calls = path.join(root, "launchctl.log");
  fs.writeFileSync(path.join(bin, "launchctl"), `#!/bin/sh\necho "$@" >> "${calls}"\n`, { mode: 0o755 });
  return { root, home, bin, calls };
}

function populate(dir) {
  for (const f of ["bin/muse-ax", "build/release/x", "rules/current/muse.json", "state.json", "logs/canary.log", "sends.jsonl", ".setup-done", ".ui.lock"]) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), "x");
  }
}

const run = (sb, env = {}) => spawnSync("sh", [script, "--uninstall"], {
  encoding: "utf8",
  env: { PATH: `${sb.bin}:/usr/bin:/bin`, HOME: sb.home, ...env },
});

describe("install.sh --uninstall", () => {
  it("removes ~/.claude-bot-bridge and the canary agent, and prints the manual steps", () => {
    const sb = sandbox();
    const dir = path.join(sb.home, ".claude-bot-bridge");
    populate(dir);
    const plist = path.join(sb.home, "Library", "LaunchAgents", "com.qualixar.cbb.canary.plist");
    fs.writeFileSync(plist, "<plist/>");
    const neighbour = path.join(sb.home, "keep-me.txt");
    fs.writeFileSync(neighbour, "keep");
    const r = run(sb);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(plist)).toBe(false);
    expect(fs.existsSync(neighbour)).toBe(true);
    expect(fs.existsSync(sb.home)).toBe(true);
    expect(fs.readFileSync(sb.calls, "utf8")).toMatch(/bootout gui\/\d+\/com\.qualixar\.cbb\.canary/);
    expect(r.stdout).toMatch(/Accessibility/);
    expect(r.stdout).toContain("claude plugin uninstall bot-bridge@claude-bot-bridge");
  });

  it("honours CBB_HOME inside HOME", () => {
    const sb = sandbox();
    const dir = path.join(sb.home, "custom", "bridge");
    populate(dir);
    const r = run(sb, { CBB_HOME: dir });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(path.join(sb.home, "custom"))).toBe(true);
  });

  it("is a no-op that still succeeds when nothing is installed", () => {
    const sb = sandbox();
    const r = run(sb);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/nothing to remove|not installed/i);
  });

  it("refuses a CBB_HOME that is HOME, outside HOME, relative, empty-looking or contains ..", () => {
    const sb = sandbox();
    const outside = path.join(sb.root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "precious"), "x");
    fs.writeFileSync(path.join(sb.home, "precious"), "x");
    const bad = [sb.home, sb.home + "/", outside, "/", "relative/dir", path.join(sb.home, "..", "outside"), path.join(sb.home, "a", "..", "..", "outside"), "/Users"];
    for (const v of bad) {
      const r = run(sb, { CBB_HOME: v });
      expect(r.status, `CBB_HOME=${v}`).not.toBe(0);
      expect(r.stderr).toMatch(/refusing/i);
    }
    expect(fs.existsSync(path.join(outside, "precious"))).toBe(true);
    expect(fs.existsSync(path.join(sb.home, "precious"))).toBe(true);
  });

  it("refuses a CBB_HOME that is a symlink leading outside HOME", () => {
    const sb = sandbox();
    const outside = path.join(sb.root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "precious"), "x");
    const link = path.join(sb.home, "linked");
    fs.symlinkSync(outside, link);
    const r = run(sb, { CBB_HOME: link });
    expect(r.status).not.toBe(0);
    expect(fs.existsSync(path.join(outside, "precious"))).toBe(true);
  });

  it("refuses a folder without one of our markers, and deletes nothing", () => {
    const sb = sandbox();
    // An explicit CBB_HOME that merely lives inside HOME, e.g. a project folder: no marker, so it is not ours.
    const mine = path.join(sb.home, "Documents", "my-project");
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, "important.txt"), "x");
    fs.writeFileSync(path.join(mine, "state.json"), "{}");   // looks a little like ours, but is not a marker
    const r = run(sb, { CBB_HOME: mine });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/refusing.*none of our markers/s);
    expect(fs.existsSync(path.join(mine, "important.txt"))).toBe(true);
    // The default folder, present but unmarked (nothing we installed): refused as well.
    const dflt = path.join(sb.home, ".claude-bot-bridge");
    fs.mkdirSync(dflt, { recursive: true });
    fs.writeFileSync(path.join(dflt, "state.json"), "{}");
    const r2 = run(sb);
    expect(r2.status).not.toBe(0);
    expect(r2.stderr).toMatch(/refusing/i);
    expect(fs.existsSync(path.join(dflt, "state.json"))).toBe(true);
  });

  it("accepts any one of the markers: .cbb-home, .setup-done or bin/muse-ax", () => {
    for (const marker of [".cbb-home", ".setup-done", "bin/muse-ax"]) {
      const sb = sandbox();
      const dir = path.join(sb.home, "somewhere", "bridge");
      fs.mkdirSync(path.dirname(path.join(dir, marker)), { recursive: true });
      fs.writeFileSync(path.join(dir, marker), "x");
      fs.writeFileSync(path.join(dir, "state.json"), "{}");
      const r = run(sb, { CBB_HOME: dir });
      expect(r.status, `${marker}: ${r.stderr}`).toBe(0);
      expect(fs.existsSync(dir), marker).toBe(false);
    }
  });

  it("a marker that is a directory, not a file, does not count", () => {
    const sb = sandbox();
    const dir = path.join(sb.home, "tricky");
    fs.mkdirSync(path.join(dir, ".cbb-home"), { recursive: true });
    fs.mkdirSync(path.join(dir, "bin", "muse-ax"), { recursive: true });
    expect(run(sb, { CBB_HOME: dir }).status).not.toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("without CBB_HOME, only a folder called .claude-bot-bridge is removed (a marker alone is not enough)", () => {
    // Reached through a symlink named otherwise: the REAL folder name is what counts.
    const sb = sandbox();
    const real = path.join(sb.home, "elsewhere");
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, ".cbb-home"), "x");
    fs.symlinkSync(real, path.join(sb.home, ".claude-bot-bridge"));
    const r = run(sb);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not called \.claude-bot-bridge/);
    expect(fs.existsSync(path.join(real, ".cbb-home"))).toBe(true);
    // The same folder, named explicitly, is accepted.
    const r2 = run(sb, { CBB_HOME: real });
    expect(r2.status, r2.stderr).toBe(0);
    expect(fs.existsSync(real)).toBe(false);
  });

  it("refuses an empty HOME", () => {
    const sb = sandbox();
    const r = spawnSync("sh", [script, "--uninstall"], { encoding: "utf8", env: { PATH: `${sb.bin}:/usr/bin:/bin`, HOME: "" } });
    expect(r.status).not.toBe(0);
  });
});

describe("install.sh honours CBB_HOME", () => {
  // A fake swift that "builds" a muse-ax into the scratch path, fake xcode-select and uname are not needed on macOS.
  function installRig() {
    const sb = sandbox();
    fs.writeFileSync(path.join(sb.bin, "swift"), `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in --scratch-path) scratch="$2"; shift ;; esac; shift; done
mkdir -p "$scratch/release" && printf '#!/bin/sh\\necho muse-ax\\n' > "$scratch/release/muse-ax" && chmod 755 "$scratch/release/muse-ax"
`, { mode: 0o755 });
    fs.writeFileSync(path.join(sb.bin, "xcode-select"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return sb;
  }
  const install = (sb, env, args = []) => spawnSync("sh", [script, ...args], {
    encoding: "utf8",
    env: { PATH: `${sb.bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: sb.home, ...env },
  });

  it.runIf(process.platform === "darwin")("builds, installs, and writes its markers under CBB_HOME, not under ~/.claude-bot-bridge", () => {
    const sb = installRig();
    const dir = path.join(sb.home, "custom-bridge");
    const r = install(sb, { CBB_HOME: dir });
    expect(r.status, r.stderr).toBe(0);
    for (const f of ["bin/muse-ax", ".cbb-home", ".setup-done", "build/release/muse-ax"]) expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
    expect(fs.existsSync(path.join(sb.home, ".claude-bot-bridge"))).toBe(false);
    expect(r.stdout).toContain(path.join(dir, "bin", "muse-ax"));
    // ...and the marker it just wrote is what lets --uninstall remove it again.
    const u = run(sb, { CBB_HOME: dir });
    expect(u.status, u.stderr).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it.runIf(process.platform === "darwin")("the automatic build (CBB_NO_SETUP_MARKER) leaves .cbb-home but not the consent marker", () => {
    const sb = installRig();
    const dir = path.join(sb.home, ".claude-bot-bridge");
    const r = install(sb, { CBB_NO_SETUP_MARKER: "1" });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(dir, ".cbb-home"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".setup-done"))).toBe(false);
  });

  it("the canary template follows the bridge folder", () => {
    const plist = fs.readFileSync(new URL("../../../../scripts/com.qualixar.cbb.canary.plist", import.meta.url), "utf8");
    expect(plist).not.toContain("__HOME__");
    expect(plist.match(/__CBB_HOME__/g).length).toBeGreaterThanOrEqual(4);
    expect(plist).toMatch(/<key>CBB_HOME<\/key>/);
  });
});
