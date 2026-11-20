import { describe, expect, it } from "vitest";
import { isHttpsUrl } from "../src/schemas";
import { createTask, owner, sampleTask, worker } from "./helpers";

const bad = (r: { isError: boolean; body: any }) => {
  expect(r.isError).toBe(true);
  expect(r.body.ok).toBe(false);
  expect(r.body.error.code).toBe("invalid_input");
  return r.body.error.message as string;
};

describe("validation", () => {
  it("enforces the 8 KB brief limit in bytes", async () => {
    expect((await owner("task_create", sampleTask({ brief: "a".repeat(8192) }))).body.ok).toBe(true);
    expect(bad(await owner("task_create", sampleTask({ brief: "a".repeat(8193) })))).toMatch(/brief/);
    expect(bad(await owner("task_create", sampleTask({ brief: "é".repeat(4097) })))).toMatch(/8192 bytes/);
  });

  it("enforces required fields, priority range and deadline format", async () => {
    bad(await owner("task_create", { title: "x" }));
    bad(await owner("task_create", sampleTask({ title: "  " })));
    bad(await owner("task_create", sampleTask({ priority: 0 })));
    bad(await owner("task_create", sampleTask({ priority: 4 })));
    bad(await owner("task_create", sampleTask({ priority: 1.5 })));
    bad(await owner("task_create", sampleTask({ deadline: "tomorrow" })));
    bad(await owner("task_create", sampleTask({ deadline: "2026-13-45T00:00:00Z" })));
    bad(await owner("task_create", sampleTask({ deadline: "2026-12-01T10:00:00" })));
  });

  it("rejects unknown fields so the origin cannot be spoofed", async () => {
    expect(bad(await owner("task_create", sampleTask({ origin: "someone else" })))).toMatch(/origin|Unrecognized/);
  });

  it("validates ids, statuses and limits", async () => {
    bad(await worker("claim_task", { id: "1" }));
    bad(await worker("claim_task", {}));
    bad(await owner("task_list", { status: "weird" }));
    bad(await owner("task_list", { limit: 0 }));
    bad(await worker("list_open_tasks", { limit: 51 }));
    bad(await worker("heartbeat", { extra: 1 }));
  });

  it("limits summary to 16 KB and links to https only", async () => {
    const id = await createTask();
    await worker("claim_task", { id });
    bad(await worker("submit_result", { id, summary: "s".repeat(16385) }));
    bad(await worker("submit_result", { id, summary: "" }));
    bad(await worker("submit_result", { id, summary: "ok", links: ["http://insecure.example"] }));
    bad(await worker("submit_result", { id, summary: "ok", links: ["javascript:alert(1)"] }));
    bad(await worker("submit_result", { id, summary: "ok", links: ["https://user:pw@example.com"] }));
    bad(await worker("submit_result", { id, summary: "ok", links: Array(21).fill("https://example.com") }));
    bad(await worker("submit_result", { id, summary: "ok", outcome: "maybe" }));
    expect((await worker("submit_result", { id, summary: "s".repeat(16384), links: ["https://example.com/ok"] })).body.ok).toBe(true);
  });

  it("limits notes and questions", async () => {
    const id = await createTask();
    await worker("claim_task", { id });
    bad(await worker("post_progress", { id, note: "n".repeat(2049) }));
    bad(await worker("ask_owner", { id, question: "" }));
    bad(await owner("task_answer", { id, reply: "r".repeat(4097) }));
  });

  it("does not echo submitted values in error messages", async () => {
    const msg = bad(await owner("task_create", sampleTask({ priority: "SECRET-VALUE-123" })));
    expect(msg).not.toMatch(/SECRET-VALUE-123/);
  });

  it("treats missing arguments as an empty object", async () => {
    expect((await worker("list_open_tasks")).body.ok).toBe(true);
  });

  it("isHttpsUrl handles malformed input", () => {
    expect(isHttpsUrl("not a url")).toBe(false);
    expect(isHttpsUrl("https://example.com/a?b=1")).toBe(true);
  });
});

describe("error shape", () => {
  it("uses the same envelope for every failure", async () => {
    const results = [
      await owner("task_get", { id: "T-0001" }),
      await worker("claim_task", { id: "bad" }),
      await worker("task_create", {}),
    ];
    for (const r of results) {
      expect(r.isError).toBe(true);
      expect(Object.keys(r.body).sort()).toEqual(["error", "ok"]);
      expect(typeof r.body.error.code).toBe("string");
      expect(typeof r.body.error.message).toBe("string");
      expect(JSON.stringify(r.body)).not.toMatch(/stack|\bat \w+ \(/);
    }
  });
});
