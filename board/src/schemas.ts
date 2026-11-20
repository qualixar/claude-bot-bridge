import { z } from "zod";

const encoder = new TextEncoder();
const byteLength = (s: string): number => encoder.encode(s).length;

/** Non-empty trimmed string limited by UTF-8 bytes (the limits are byte limits). */
const bytesText = (maxBytes: number) =>
  z
    .string()
    .trim()
    .min(1)
    .refine((s) => byteLength(s) <= maxBytes, { message: `must be at most ${maxBytes} bytes` });

const optionalBytesText = (maxBytes: number) =>
  z
    .string()
    .trim()
    .refine((s) => byteLength(s) <= maxBytes, { message: `must be at most ${maxBytes} bytes` });

export const taskId = z.string().regex(/^T-\d{4,6}$/, "must look like T-0001");

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
export const isoDeadline = z
  .string()
  .regex(ISO_RE, "must be an ISO 8601 date-time with a timezone, e.g. 2026-12-01T18:00:00Z")
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "is not a real date" });

export function isHttpsUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}
const httpsLink = z
  .string()
  .max(2048)
  .refine(isHttpsUrl, { message: "must be an https URL without credentials" });

export const MAX_BRIEF_BYTES = 8 * 1024;
export const MAX_SUMMARY_BYTES = 16 * 1024;

export const schemas = {
  none: z.strictObject({}),
  taskId: z.strictObject({ id: taskId }),
  taskCreate: z.strictObject({
    title: z.string().trim().min(1).max(200),
    brief: bytesText(MAX_BRIEF_BYTES),
    deliverable: bytesText(2048),
    acceptance: optionalBytesText(2048).default(""),
    priority: z.number().int().min(1).max(3).default(2),
    deadline: isoDeadline.optional(),
  }),
  taskList: z.strictObject({
    status: z
      .enum(["open", "claimed", "in_progress", "needs_owner", "done", "failed", "cancelled"])
      .optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  listOpen: z.strictObject({ limit: z.number().int().min(1).max(50).default(20) }),
  taskResults: z.strictObject({
    id: taskId.optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  rotate: z.strictObject({
    cursor: z.string().max(64).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    verify: z.boolean().optional(),
  }),
  taskAnswer: z.strictObject({ id: taskId, reply: bytesText(4096) }),
  taskCancel: z.strictObject({ id: taskId, reason: optionalBytesText(1024).default("") }),
  postProgress: z.strictObject({ id: taskId, note: bytesText(2048) }),
  askOwner: z.strictObject({ id: taskId, question: bytesText(2048) }),
  submitResult: z.strictObject({
    id: taskId,
    summary: bytesText(MAX_SUMMARY_BYTES),
    links: z.array(httpsLink).max(20).default([]),
    notes: optionalBytesText(4096).default(""),
    outcome: z.enum(["done", "failed"]).default("done"),
  }),
};

export type Schemas = typeof schemas;
