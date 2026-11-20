// MCP tool contract (api version 1). Tool names and input schemas are frozen: a newer board may only add
// new tools and optional input fields. The frozen copy lives in test/contract/tools.v1.json.
// Regenerate it ONLY for an additive change:  UPDATE_CONTRACT=1 npx vitest run --project node test/node/contract.test.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listing } from "../../src/tools";
import { API_VERSION } from "../../src/version";

const FILE = join(import.meta.dirname, "../contract/tools.v1.json");
type Schema = { type?: string; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown };
type Tool = { name: string; inputSchema: Schema };
type Snapshot = { api: number; roles: Record<string, Tool[]> };

const current = (): Snapshot => ({
  api: API_VERSION,
  roles: Object.fromEntries((["owner", "worker"] as const).map((r) => [r, listing(r).map((t) => ({ name: t.name, inputSchema: t.inputSchema as Schema }))])),
});

/** Every way a newer board could break an older client. Empty means compatible. */
export function breakingChanges(frozen: Snapshot, now: Snapshot): string[] {
  const problems: string[] = [];
  if (now.api !== frozen.api) problems.push(`api version changed ${frozen.api} -> ${now.api}`);
  for (const [role, tools] of Object.entries(frozen.roles)) {
    const live = new Map((now.roles[role] ?? []).map((t) => [t.name, t]));
    for (const old of tools) {
      const t = live.get(old.name);
      if (!t) {
        problems.push(`${role}: tool ${old.name} was removed or renamed`);
        continue;
      }
      const frozenProps = old.inputSchema.properties ?? {};
      const nowProps = t.inputSchema.properties ?? {};
      for (const [prop, schema] of Object.entries(frozenProps)) {
        if (!(prop in nowProps)) problems.push(`${role}.${old.name}: field ${prop} was removed`);
        else if (JSON.stringify(nowProps[prop]) !== JSON.stringify(schema)) problems.push(`${role}.${old.name}: field ${prop} changed`);
      }
      for (const req of t.inputSchema.required ?? []) {
        if (!(old.inputSchema.required ?? []).includes(req)) problems.push(`${role}.${old.name}: ${req} became required`);
      }
      for (const req of old.inputSchema.required ?? []) {
        if (!(t.inputSchema.required ?? []).includes(req)) problems.push(`${role}.${old.name}: ${req} is no longer required (frozen contract)`);
      }
      if (old.inputSchema.type !== t.inputSchema.type) problems.push(`${role}.${old.name}: input type changed`);
    }
  }
  return problems;
}

if (process.env.UPDATE_CONTRACT === "1") writeFileSync(FILE, JSON.stringify(current(), null, 2) + "\n");
const frozen = JSON.parse(readFileSync(FILE, "utf8")) as Snapshot;

describe("MCP tool contract v1", () => {
  it("the current tools are compatible with the frozen snapshot", () => {
    expect(breakingChanges(frozen, current())).toEqual([]);
  });

  it("the frozen snapshot covers the live worker tool names Muse's connector calls", () => {
    const names = frozen.roles.worker.map((t) => t.name).sort();
    for (const n of ["list_open_tasks", "claim_task", "get_task", "post_progress", "submit_result", "ask_owner", "heartbeat"]) expect(names).toContain(n);
    expect(frozen.api).toBe(1);
  });

  it("detects removed and renamed tools", () => {
    const now = structuredClone(current());
    now.roles.worker = now.roles.worker.filter((t) => t.name !== "claim_task");
    now.roles.worker.push({ name: "claim", inputSchema: { type: "object" } });
    expect(breakingChanges(frozen, now)).toEqual(["worker: tool claim_task was removed or renamed"]);
  });

  it("detects removed, changed and newly required fields, and an api bump", () => {
    const now = structuredClone(current());
    const claim = now.roles.worker.find((t) => t.name === "claim_task")!;
    (claim.inputSchema.properties as Record<string, unknown>).id = { type: "number" };
    const submit = now.roles.worker.find((t) => t.name === "submit_result")!;
    delete (submit.inputSchema.properties as Record<string, unknown>).notes;
    (submit.inputSchema.required as string[]).push("links");
    const post = now.roles.worker.find((t) => t.name === "post_progress")!;
    post.inputSchema.required = (post.inputSchema.required ?? []).filter((r) => r !== "note");
    now.api = 2;
    expect(breakingChanges(frozen, now)).toEqual([
      "api version changed 1 -> 2",
      "worker.claim_task: field id changed",
      "worker.post_progress: note is no longer required (frozen contract)",
      "worker.submit_result: field notes was removed",
      "worker.submit_result: links became required",
    ]);
  });

  it("allows additive changes: a new tool and a new optional field", () => {
    const now = structuredClone(current());
    now.roles.worker.push({ name: "brand_new_tool", inputSchema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] } });
    const progress = now.roles.worker.find((t) => t.name === "post_progress")!;
    (progress.inputSchema.properties as Record<string, unknown>).extra = { type: "string" };
    expect(breakingChanges(frozen, now)).toEqual([]);
  });
});
