import { z } from "zod";
import { taskId } from "../schemas";

export const DEFAULT_WAIT_S = 25;
export const MAX_WAIT_S = 50;

/** Input of the owner tool task_wait. Additive to API v1: a new tool with only optional fields. */
export const waitSchema = z.strictObject({
  id: taskId.optional(),
  since_rev: z.number().int().min(0).optional(),
  timeout_s: z.number().int().min(1).max(MAX_WAIT_S).default(DEFAULT_WAIT_S),
});
