/** `viewer` may only use the web board; `owner` and `worker` may also use /mcp. */
export type Role = "owner" | "worker" | "viewer";
/** Roles that may call the MCP endpoint. */
export type McpRole = "owner" | "worker";

export const STATUSES = [
  "open",
  "claimed",
  "in_progress",
  "needs_owner",
  "done",
  "failed",
  "cancelled",
] as const;
export type Status = (typeof STATUSES)[number];

export const ORIGIN = "Claude Code (owner's orchestrator)";
export const DEFAULT_WORKER_NAME = "Muse";
export const OWNER_ACTOR = "Claude Code";

export interface TaskRow {
  id: string;
  title: string;
  brief: string;
  deliverable: string;
  acceptance: string;
  priority: number;
  deadline: string | null;
  status: Status;
  claimed_by: string | null;
  origin: string;
  question: string | null;
  owner_reply: string | null;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  last_activity_at: string;
}

export interface EventRow {
  id: number;
  task_id: string | null;
  at: string;
  actor: string;
  kind: string;
  to_status: string | null;
  note: string | null;
}

export interface ResultView {
  task_id: string;
  outcome: "done" | "failed";
  summary: string;
  links: string[];
  notes: string;
  submitted_by: string;
  created_at: string;
}

export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
