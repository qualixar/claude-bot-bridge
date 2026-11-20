import { runtime } from "#harness";
import { describe, expect, it } from "vitest";
import { OWNER } from "./helpers";
import { app } from "#harness";

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

const waitRequest = (signal: AbortSignal, args: Record<string, unknown>) =>
  new Request("https://board.test/mcp", {
    method: "POST",
    signal,
    headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "task_wait", arguments: args } }),
  });

describe(`task_wait abort wiring (${runtime})`, () => {
  it("passes the request's signal to the tool: aborting the request ends a long wait within 2 s", async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const pending = app.fetch(waitRequest(ac.signal, { timeout_s: 30 })).then((r) => r.text()).catch((e) => `rejected:${String(e)}`);
    await sleepMs(300);
    ac.abort();
    await pending;
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it("an already aborted request does not wait out the timeout", async () => {
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    await app.fetch(waitRequest(ac.signal, { timeout_s: 30 })).then((r) => r.text()).catch(() => undefined);
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it("a request that is not aborted still waits for its change or timeout", async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const r = await app.fetch(waitRequest(ac.signal, { timeout_s: 2 }));
    const body = JSON.parse(((await r.json()) as any).result.content[0].text);
    expect(body).toMatchObject({ ok: true, changed: false });
    expect(body.aborted).toBeUndefined();
    expect(Date.now() - t0).toBeGreaterThan(1500);
  });
});
