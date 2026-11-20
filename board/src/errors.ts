import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ErrorCode =
  | "invalid_input"
  | "not_found"
  | "invalid_state"
  | "forbidden"
  | "paused"
  | "internal";

/** An expected failure that is safe to show to the caller. */
export class ToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...data }) }] };
}

export function fail(code: ErrorCode, message: string, extra: Record<string, unknown> = {}): CallToolResult {
  const body = { ok: false, error: { code, message, ...extra } };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }] };
}
