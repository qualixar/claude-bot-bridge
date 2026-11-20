// Static checks on the release workflow: supply-chain hygiene that is easy to regress silently.
import { describe, it, expect } from "vitest";
import fs from "node:fs";

const file = new URL("../../../../../.github/workflows/release.yml", import.meta.url);
const text = fs.readFileSync(file, "utf8");
const lines = text.split("\n");
const step = (name) => {
  const i = lines.findIndex((l) => l.includes(`- name: ${name}`));
  expect(i, `step ${name}`).toBeGreaterThan(-1);
  const rest = lines.slice(i + 1);
  const end = rest.findIndex((l) => /^ {6}- /.test(l));
  return rest.slice(0, end === -1 ? undefined : end).join("\n");
};

describe("release workflow", () => {
  it("pins every action by a full 40-hex commit SHA", () => {
    const uses = lines.filter((l) => /^\s*-?\s*uses:/.test(l));
    expect(uses.length).toBeGreaterThan(0);
    for (const l of uses) expect(l, l).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40}\s+# v\d/);
  });
  it("starts with no permissions and grants contents: write only to the signing job", () => {
    expect(text).toMatch(/^permissions: \{\}$/m);
    const build = text.slice(text.indexOf("  build:"), text.indexOf("  sign-and-publish:"));
    const publish = text.slice(text.indexOf("  sign-and-publish:"));
    expect(build).toMatch(/contents: read/);
    expect(build).not.toMatch(/contents: write/);
    expect(build).not.toMatch(/secrets\./);
    expect(publish).toMatch(/contents: write/);
  });
  it("runs the signing job in the `release` environment, after the build", () => {
    const publish = text.slice(text.indexOf("  sign-and-publish:"));
    expect(publish).toMatch(/needs: build/);
    expect(publish).toMatch(/environment: release/);
  });
  it("never lets checkout persist credentials", () => {
    expect((text.match(/uses: actions\/checkout/g) ?? []).length).toBe((text.match(/persist-credentials: false/g) ?? []).length);
  });
  it("installs OpenSSL and jq in a step BEFORE the signing step", () => {
    expect(text.indexOf("- name: Install the signing tools")).toBeGreaterThan(-1);
    expect(text.indexOf("- name: Install the signing tools")).toBeLessThan(text.indexOf("- name: Sign the manifest"));
    expect(step("Install the signing tools")).toMatch(/openssl@3/);
    expect(step("Install the signing tools")).toMatch(/jq/);
  });
  it("signs with a minimal PATH, with no installs, and reads the key only from the environment", () => {
    const s = step("Sign the manifest");
    expect(s).toMatch(/PATH="\$TOOLS_BIN:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin"/);
    expect(s).toMatch(/--key-env CBB_BINARY_SIGNING_KEY/);
    expect(s).not.toMatch(/brew /);
    expect(s).not.toMatch(/RUNNER_TEMP/);
    expect(s).not.toMatch(/(echo|printf)[^\n]*\$\{?CBB_BINARY_SIGNING_KEY/);
    expect(s).toMatch(/secrets\.CBB_BINARY_SIGNING_KEY/);
  });
  it("the manifest is signed with the BINARY key; the root key (and the old single key) appear nowhere in the workflow", () => {
    expect((text.match(/secrets\.CBB_BINARY_SIGNING_KEY/g) ?? []).length).toBe(1);
    expect(text).not.toMatch(/secrets\.CBB_SIGNING_KEY|secrets\.CBB_ROOT/i);
    expect(text).not.toMatch(/--key-env CBB_SIGNING_KEY/);
    expect(text).not.toMatch(/root[-_ ]?(private|signing)[-_ ]?key/i);
  });
  it("attests the build provenance with a SHA-pinned action, in the signing job only", () => {
    const publish = text.slice(text.indexOf("  sign-and-publish:"));
    const build = text.slice(text.indexOf("  build:"), text.indexOf("  sign-and-publish:"));
    expect(publish).toMatch(/uses: actions\/attest-build-provenance@[0-9a-f]{40} # v\d/);
    expect(step("Attest build provenance")).toMatch(/subject-path: dist\/muse-ax-macos-universal\.tar\.gz/);
    expect(publish).toMatch(/id-token: write/);
    expect(publish).toMatch(/attestations: write/);
    expect(build).not.toMatch(/id-token|attestations|attest-build-provenance/);
    expect(text.slice(0, text.indexOf("  build:"))).not.toMatch(/id-token|attestations/);   // not at workflow level
    expect((text.match(/id-token: write/g) ?? []).length).toBe(1);
    expect((text.match(/attestations: write/g) ?? []).length).toBe(1);
  });
  it("attests before publishing, after signing", () => {
    expect(text.indexOf("- name: Sign the manifest")).toBeLessThan(text.indexOf("- name: Attest build provenance"));
    expect(text.indexOf("- name: Attest build provenance")).toBeLessThan(text.indexOf("- name: Upload to the release"));
  });
  it("refuses to build a release while keys or rules are still UNSIGNED, before any test or build step", () => {
    const s = step("No unsigned trust material");
    expect(s).toMatch(/keys\/UNSIGNED rules\/UNSIGNED/);
    expect(s).toMatch(/keys\/keyset\.json\.sig/);
    expect(text.indexOf("- name: No unsigned trust material")).toBeLessThan(text.indexOf("- name: Swift tests"));
  });
  it("verifies the keyset and rules signatures in the build job (not only that the files exist), before any test or build step", () => {
    const build = text.slice(text.indexOf("  build:"), text.indexOf("  sign-and-publish:"));
    const s = step("Verify the keyset and rules signatures");
    expect(build).toContain("- name: Verify the keyset and rules signatures");
    expect(s).toMatch(/sh plugin\/scripts\/verify-keyset\.sh keys\/keyset\.json keys\/root-public\.pem/);
    expect(s).toMatch(/for f in rules\/index\.json rules\/muse\.json; do sh plugin\/scripts\/verify-rules\.sh "\$f"; done/);
    expect(s).toMatch(/cmp keys\/root-public\.pem plugin\/release-signing-public\.pem/);
    expect(s).toMatch(/OpenSSL 3/);
    expect(s).not.toMatch(/secrets\./);
    expect(text.indexOf("- name: No unsigned trust material")).toBeLessThan(text.indexOf("- name: Verify the keyset and rules signatures"));
    expect(text.indexOf("- name: Verify the keyset and rules signatures")).toBeLessThan(text.indexOf("- name: Swift tests"));
  });
  it("fails when the tag differs from the plugin version, in both jobs", () => {
    expect(step("Check the tag matches the plugin version")).toMatch(/tag \$TAG != plugin\.json version/);
    expect(step("Check the artifact is the one for this tag")).toMatch(/tag \$TAG != plugin\.json version/);
    expect(step("Check the tag matches the plugin version")).toMatch(/\^v\[0-9\]\+/);
  });
  it("publishes binary-manifest.json (the file the updater fetches)", () => {
    expect(text).toMatch(/dist\/binary-manifest\.json/);
    expect(text).toMatch(/releases\/download\/\$TAG\/muse-ax-macos-universal\.tar\.gz/);
  });
  it("has release docs naming the environment and its reviewers", () => {
    const doc = fs.readFileSync(new URL("../../../../../.github/RELEASING.md", import.meta.url), "utf8");
    expect(doc).toMatch(/Required reviewers/);
    expect(doc).toMatch(/`release`/);
    expect(doc).toMatch(/CBB_BINARY_SIGNING_KEY/);
  });
});
