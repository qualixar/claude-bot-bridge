import { describe, expect, it } from "vitest";
import { appWith } from "#harness";
import { authenticate, bearerToken, safeEqual } from "../src/auth";
import { OWNER, WORKER, call, owner, post, send, worker } from "./helpers";

const listBody = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const names = (r: { json: any }) => r.json.result.tools.map((t: { name: string }) => t.name).sort();

describe("authentication", () => {
  it("returns 401 with an empty body for missing, wrong and malformed tokens", async () => {
    for (const token of [null, "nope", `${OWNER}x`, ""]) {
      const r = await post(token, listBody);
      expect(r.status).toBe(401);
      expect(r.json).toBeNull();
    }
    const basic = await send(new Request("https://board.test/mcp", { method: "POST", headers: { authorization: `Basic ${OWNER}` }, body: "{}" }));
    expect(basic.status).toBe(401);
    expect(await basic.text()).toBe("");
  });

  it("checks the token before the path and method", async () => {
    expect((await send(new Request("https://board.test/other"))).status).toBe(401);
    expect((await send(new Request("https://board.test/mcp", { method: "GET" }))).status).toBe(401);
  });

  it("returns 404 and 405 only for authenticated callers", async () => {
    const auth = { authorization: `Bearer ${OWNER}` };
    expect((await send(new Request("https://board.test/other", { headers: auth }))).status).toBe(404);
    const get = await send(new Request("https://board.test/mcp", { method: "GET", headers: auth }));
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
  });

  it("accepts the bearer scheme case-insensitively", async () => {
    const res = await send(
      new Request("https://board.test/mcp", {
        method: "POST",
        headers: { authorization: `bearer ${WORKER}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(listBody),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("fails closed when secrets are unset, short or identical", async () => {
    const req = new Request("https://x/mcp", { headers: { authorization: `Bearer ${OWNER}` } });
    expect(await authenticate(req, {})).toBeNull();
    expect(await authenticate(req, { OWNER_TOKEN: OWNER, WORKER_TOKEN: OWNER })).toBeNull();
    expect(await authenticate(req, { OWNER_TOKEN: "short", WORKER_TOKEN: "short2" })).toBeNull();
    expect(await authenticate(req, { OWNER_TOKEN: OWNER, WORKER_TOKEN: WORKER })).toBe("owner");
    expect(await appWith({ WORKER_TOKEN: "" }).fetch(new Request("https://x/mcp", { method: "POST" }))).toHaveProperty("status", 401);
  });

  it("compares in constant-time helpers correctly", async () => {
    expect(await safeEqual("abc", "abc")).toBe(true);
    expect(await safeEqual("abc", "abd")).toBe(false);
    expect(await safeEqual("abc", "abcd")).toBe(false);
    expect(bearerToken(new Request("https://x", { headers: { authorization: "Bearer a b" } }))).toBeNull();
  });
});

describe("roles", () => {
  it("lists only the worker tools for the worker token", async () => {
    expect(names(await post(WORKER, listBody))).toEqual(
      ["ask_owner", "claim_task", "get_task", "heartbeat", "list_open_tasks", "post_progress", "submit_result"],
    );
  });

  it("lists owner tools plus the read tools for the owner token", async () => {
    expect(names(await post(OWNER, listBody))).toEqual(
      ["admin_rotate_encryption", "board_pause", "board_resume", "get_task", "heartbeat", "list_open_tasks", "task_answer", "task_cancel", "task_create", "task_get", "task_list", "task_results", "task_wait"],
    );
  });

  it("publishes JSON Schemas and AI-worker descriptions", async () => {
    const r = await post(WORKER, listBody);
    const claim = r.json.result.tools.find((t: any) => t.name === "claim_task");
    expect(claim.inputSchema.type).toBe("object");
    expect(claim.inputSchema.required).toContain("id");
    expect(claim.description).toMatch(/owner's orchestrator/);
    const submit = r.json.result.tools.find((t: any) => t.name === "submit_result");
    expect(submit.description).toMatch(/must go through this tool/);
  });

  it("blocks the worker from owner tools and the owner from worker-only tools", async () => {
    for (const name of ["task_create", "task_list", "task_get", "task_results", "task_answer", "task_cancel", "board_pause", "board_resume"]) {
      const r = await worker(name, {});
      expect(r.isError).toBe(true);
      expect(r.body.error.code).toBe("forbidden");
    }
    for (const name of ["claim_task", "post_progress", "submit_result", "ask_owner"]) {
      expect((await owner(name, {})).body.error.code).toBe("forbidden");
    }
    expect((await call(WORKER, "nonexistent")).body.error.code).toBe("forbidden");
  });

  it("never lets a worker create tasks or pause the board", async () => {
    await worker("board_pause");
    expect((await worker("list_open_tasks")).body.ok).toBe(true);
  });
});
