import { OWNER, WORKER, app } from "#harness";

export { OWNER, WORKER };

let rpcId = 0;

export const send = (req: Request): Promise<Response> => app.fetch(req);

export interface Reply {
  status: number;
  json: any;
}

export async function post(token: string | null, body: unknown, extra: Record<string, string> = {}): Promise<Reply> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extra,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await send(new Request("https://board.test/mcp", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }));
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

export interface ToolReply {
  isError: boolean;
  body: any;
  raw: any;
}

export async function call(token: string | null, name: string, args: Record<string, unknown> = {}): Promise<ToolReply> {
  const r = await post(token, { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } });
  const result = r.json?.result;
  if (!result) throw new Error(`no result: ${r.status} ${JSON.stringify(r.json)}`);
  return { isError: Boolean(result.isError), body: JSON.parse(result.content[0].text), raw: result };
}

export const owner = (name: string, args: Record<string, unknown> = {}) => call(OWNER, name, args);
export const worker = (name: string, args: Record<string, unknown> = {}) => call(WORKER, name, args);

export const sampleTask = (over: Record<string, unknown> = {}) => ({
  title: "Research X",
  brief: "Find three sources about X.",
  deliverable: "A short summary with links",
  acceptance: "Three https links",
  priority: 2,
  ...over,
});

export async function createTask(over: Record<string, unknown> = {}): Promise<string> {
  const r = await owner("task_create", sampleTask(over));
  return r.body.task.id as string;
}
