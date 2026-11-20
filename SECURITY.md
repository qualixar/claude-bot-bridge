# Security policy

Claude Bot Bridge types into a desktop app that may be linked to your social and messaging accounts, and its board holds task text that you may consider private. We treat security reports as the highest-priority work on the project.

## Reporting a vulnerability

Please report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue, pull request or discussion for a security problem.

Include what you can of the following: the affected component (bridge, plugin, board, release workflow, rules files), the version or commit, steps to reproduce, and the impact you expect. A proof of concept helps, but never test against accounts, boards or Muse sessions that are not yours.

We aim to acknowledge a report within 3 working days and to share a first assessment within 7. When a fix ships we credit the reporter in the release notes unless you ask us not to.

## Supported versions

Only the latest release receives security fixes. The bridge checks for new releases once a day and tells Claude when an update is available; please keep plugin auto-update switched on.

## Scope

In scope: the `bot-bridge` and `bot-bridge-board` plugins, the `muse-ax` helper, the signed rules files and binary manifests, the board server on every runtime (Cloudflare Workers, Node, Docker), and `.github/workflows`.

Out of scope: vulnerabilities in Meta's Muse app or service, in Claude Code, in Cloudflare, Tailscale or Docker themselves (report those to their owners), and findings that need an attacker who already controls your Mac user account.

## Signing keys

Everything the bridge downloads is signed with Ed25519, through a hierarchy of keys:

- **The root key** is held offline by the maintainer. It is not in this repository and not in GitHub (no secret, no environment secret). It signs one file only, `keys/keyset.json`, and signs no rules and no binaries. Its public half ships in `plugin/release-signing-public.pem` (the same bytes as `keys/root-public.pem`) and is compiled into the helper and the MCP server: it is the only key built in.
- **`keys/keyset.json`** lists the short-lived keys that may sign, each with an id, a purpose and an expiry, and a `revoked` list. The signature is `keys/keyset.json.sig`.
- **The rules key** (purpose `rules`) signs `rules/index.json` and `rules/*.json`. Signing is a manual step on the maintainer's machine.
- **The binary key** (purpose `binary`) signs the release manifest. It is an environment secret of the `release` environment, which needs a reviewer's approval, and it is the only key GitHub holds.

The rules key and the binary key are separate: neither can sign what the other signs. Every rules file and manifest names its key (`key_id`, inside the signed bytes); a document without one is refused. Each machine remembers the newest keyset it has verified and refuses older ones, so a revocation cannot be undone by serving an old copy. If the newest keyset has expired, nothing is trusted until a newer one is published.

**Revocation.** A key that may be exposed is revoked by publishing a newer keyset that lists it under `revoked` (and, if needed, a replacement key). Machines pick it up at their next update check (daily); rules signed by the revoked key stop being used at the next load and a manifest signed by it is refused.

**Reporting a key compromise.** If you believe the rules key, the binary key or the root key has been exposed, or you see a rules file or a release signed by a key you do not expect, report it through the private route above and mark it urgent. Do not post the key, the file or the suspected leak anywhere public. For the root key the report matters most: nothing signs above it, so a compromise needs a new root key and a new plugin release. The recovery steps are in `.github/RELEASING.md` ("Revoking a key").
