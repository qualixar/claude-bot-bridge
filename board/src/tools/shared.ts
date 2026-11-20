import type { z } from "zod";
import { ToolError } from "../errors";
import type { TransitionResult } from "../store/transition";
import type { Store } from "../store/context";
import type { McpRole, TaskRow } from "../types";
import { OWNER_ACTOR } from "../types";

export interface ToolCtx {
  store: Store;
  role: McpRole;
  nowMs: number;
  workerName: string;
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  roles: readonly McpRole[];
  description: string;
  schema: S;
  handler: (ctx: ToolCtx, args: z.output<S>) => Promise<Record<string, unknown>>;
}

/** Keeps the generic argument inferred at the definition site while storing tools in one list. */
export const defineTool = <S extends z.ZodType>(def: ToolDef<S>): ToolDef => def as unknown as ToolDef;

export const nowIso = (ctx: ToolCtx): string => new Date(ctx.nowMs).toISOString();
export const actorOf = (ctx: ToolCtx): string => (ctx.role === "worker" ? ctx.workerName : OWNER_ACTOR);

export function expectOk(result: TransitionResult, id: string, hint: string): void {
  if (result.ok) return;
  if (result.reason === "not_found") throw new ToolError("not_found", `No task ${id}.`);
  const stop = result.current === "cancelled" ? " The owner cancelled it; stop work on it." : "";
  throw new ToolError("invalid_state", `Task ${id} is ${result.current}. ${hint}${stop}`, { current_status: result.current });
}

export const summaryView = (t: TaskRow) => ({
  id: t.id,
  title: t.title,
  status: t.status,
  priority: t.priority,
  deadline: t.deadline,
  claimed_by: t.claimed_by,
  created_at: t.created_at,
  updated_at: t.updated_at,
});

export const fullView = (t: TaskRow) => ({
  id: t.id,
  title: t.title,
  brief: t.brief,
  deliverable: t.deliverable,
  acceptance: t.acceptance,
  priority: t.priority,
  deadline: t.deadline,
  status: t.status,
  claimed_by: t.claimed_by,
  origin: t.origin,
  question: t.question,
  owner_reply: t.owner_reply,
  created_at: t.created_at,
  updated_at: t.updated_at,
  claimed_at: t.claimed_at,
  last_activity_at: t.last_activity_at,
});
