import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { fail, ok, ToolError } from "../errors";
import { isPaused, reclaimStale } from "../store/board";
import type { McpRole } from "../types";
import { ownerTools } from "./owner";
import type { ToolCtx, ToolDef } from "./shared";
import { workerTools } from "./worker";

const REGISTRY = new Map<string, ToolDef>([...workerTools, ...ownerTools].map((t) => [t.name, t]));

export function toolsFor(role: McpRole): ToolDef[] {
  return [...REGISTRY.values()].filter((t) => t.roles.includes(role));
}

export function listing(role: McpRole) {
  return toolsFor(role).map((t) => {
    const { $schema: _omit, ...inputSchema } = z.toJSONSchema(t.schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
    return { name: t.name, description: t.description, inputSchema: inputSchema as { type: "object" } };
  });
}

/** Names and messages of failed fields only; submitted values are never echoed back. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
    .join("; ");
}

/**
 * `ctx.signal` (optional) is the request's abort signal: long-polling tools such as task_wait stop early when it fires.
 * Extra context fields travel through unchanged; only the tools that know about them read them.
 */
export async function callTool(ctx: ToolCtx & { signal?: AbortSignal }, name: string, rawArgs: unknown): Promise<CallToolResult> {
  const tool = REGISTRY.get(name);
  if (!tool || !tool.roles.includes(ctx.role)) return fail("forbidden", "Unknown tool or not allowed for this token.");
  try {
    if (ctx.role === "worker" && (await isPaused(ctx.store.db))) {
      return fail("paused", "paused: the owner has paused the board. Do nothing and stop this run.");
    }
    const parsed = tool.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) return fail("invalid_input", describeIssues(parsed.error));
    await reclaimStale(ctx.store, ctx.nowMs);
    return ok(await tool.handler(ctx, parsed.data));
  } catch (err) {
    if (err instanceof ToolError) return fail(err.code, err.message, err.extra);
    console.error("tool failure", name, err instanceof Error ? err.message : "unknown");
    return fail("internal", "Internal error. Try again later.");
  }
}
