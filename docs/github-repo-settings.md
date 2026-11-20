# GitHub repository settings

Set these by hand on github.com/qualixar/claude-bot-bridge, under Settings and the About panel.

## Description

Claude Code plugin and MCP server that hands tasks to the Meta Muse AI agent. Direct chat through the macOS Accessibility API for quick questions, plus a self-hosted task board (Cloudflare Workers, Docker or your Mac) for jobs while you are away. macOS bridge, signed updates, AGPL-3.0 or commercial.

(300 characters; limit 350.)

## Website

`https://qualixar.com`

Swap it for a dedicated page once one exists.

## Topics

GitHub allows 20 topics, lowercase letters, numbers and hyphens only. These are exactly 20:

```
claude-code
claude-code-plugin
mcp
mcp-server
meta-muse
muse
ai-agents
multi-agent
agent-orchestration
macos
accessibility
cloudflare-workers
self-hosted
task-board
kanban
automation
typescript
swift
ai-reliability
qualixar
```

`claude-code`, `mcp`, `mcp-server`, `ai-agents`, `macos`, `cloudflare-workers`, `self-hosted`, `kanban`, `automation`, `typescript` and `swift` are established topic names with many repositories. `claude-code-plugin`, `meta-muse`, `muse`, `task-board`, `ai-reliability` and `qualixar` are small or new: they cost nothing and make the repository findable for those exact searches. When GitHub shows the topic with a count of zero or one, keep it anyway.

## Social preview

Upload `assets/social-preview.png` (1280 x 640) under Settings, General, Social preview.

## Branch protection for `main`

The plugin code, including the pinned release public key in `plugin/bridge/muse/mcp/dist/index.mjs`, reaches users from the default branch through Claude Code's marketplace, so `main` is part of the trust boundary. Settings, Rules, New branch ruleset, target `main`, enforcement Active:

- Require a pull request before merging (at least one approval once there is a second maintainer; for a one-person project keep the pull request itself, so CI runs before anything lands).
- Require status checks to pass, using the exact job names of `.github/workflows/ci.yml`: `board`, `mcp`, `swift`, `trust-material` (the keyset and rules signatures and the root public key) and `badge` (the verified-version badge). All five are needed: a check that is not listed here can fail without blocking the merge. When a job is added or renamed in `ci.yml`, change this list in the same pull request. Also require branches to be up to date.
- Block force pushes and block deletions.
- Do not add bypass actors, or limit them to the repository admin.

## Private vulnerability reporting

Settings, Code security, "Private vulnerability reporting": Enable. `SECURITY.md` tells reporters to use it, so it must be on.

## The `release` environment

Settings, Environments, New environment: `release`.

- Required reviewers: at least one maintainer. The signing job pauses until a reviewer approves it.
- Deployment branches and tags: "Selected branches and tags", add the tag rule `v*`.
- Environment secrets: `CBB_BINARY_SIGNING_KEY` = the Ed25519 private key (PEM) whose public half is `keys/binary-public.pem`. Keep it an environment secret, not a repository secret, so only the signing job can read it. The root key and the rules key are never stored in GitHub (see `.github/RELEASING.md`).

Full release steps, including the tag ruleset: `.github/RELEASING.md`.
