import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import handler from "../../src/index";

const mcp = (token: string) =>
  new Request("https://board.test/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

describe("Workers entry", () => {
  it("serves the app from env bindings", async () => {
    expect((await handler.fetch(mcp(env.OWNER_TOKEN!), env)).status).toBe(200);
    expect((await handler.fetch(mcp("wrong-token-0123456789"), env)).status).toBe(401);
    expect(await (await handler.fetch(new Request("https://board.test/healthz"), env)).json()).toEqual({ ok: true });
  });

  it("uses CF-Connecting-IP for the failed-auth limit", async () => {
    const bad = (i: number) => {
      const r = mcp(`bad-${i}-0123456789abcdef`);
      r.headers.set("cf-connecting-ip", "203.0.113.200");
      return handler.fetch(r, env);
    };
    for (let i = 0; i < 20; i++) expect((await bad(i)).status).toBe(401);
    expect((await bad(99)).status).toBe(429);
    expect((await handler.fetch(mcp(env.OWNER_TOKEN!), env)).status).toBe(200);
  });

  it("counts failed auth in the rate-limiting binding, not in D1", async () => {
    expect(env.AUTH_FAIL_LIMITER).toBeDefined();
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE scope LIKE 'authfail:%'").first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });

  it("streams for at most 60 seconds", async () => {
    const { WORKERS_STREAM } = await import("../../src/web/routes");
    expect(WORKERS_STREAM.maxMs).toBe(60_000);
  });

  it("runs housekeeping from the cron trigger", async () => {
    await expect(handler.scheduled({} as ScheduledController, env)).resolves.toBeUndefined();
  });

  it("reuses one app per env object", async () => {
    const other = { ...env, WORKER_NAME: "Other" } as Env;
    expect((await handler.fetch(mcp(env.OWNER_TOKEN!), other)).status).toBe(200);
  });
});
