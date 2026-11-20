import type { IncomingMessage, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";

/** Largest request body the Node server will buffer (MCP bodies are capped at 128 KB; forms at 4 KB). */
export const MAX_REQUEST_BYTES = 160 * 1024;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const last = (value: string | string[] | undefined): string | undefined => {
  const raw = Array.isArray(value) ? value.join(",") : value;
  return raw?.split(",").at(-1)?.trim() || undefined;
};

/**
 * Client address for the failed-auth limiter: the socket address, or, with TRUST_PROXY=1, the last
 * X-Forwarded-For entry (what the single trusted proxy appended; earlier entries are client-controlled).
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  return (trustProxy ? last(req.headers["x-forwarded-for"]) : undefined) ?? req.socket.remoteAddress ?? "unknown";
}

function protocol(req: IncomingMessage, trustProxy: boolean): "http" | "https" {
  const forwarded = trustProxy ? last(req.headers["x-forwarded-proto"]) : undefined;
  if (forwarded === "https" || forwarded === "http") return forwarded;
  return (req.socket as TLSSocket).encrypted ? "https" : "http";
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  if (Number(req.headers["content-length"] ?? 0) > MAX_REQUEST_BYTES) throw new HttpError(413, "Request too large");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_REQUEST_BYTES) throw new HttpError(413, "Request too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * A signal that aborts when the client closes the connection before the response is complete
 * (`res` 'close' with the response not finished), so long-polling tools such as task_wait stop at once.
 */
export function abortOnClientClose(res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  res.once("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}

export async function toWebRequest(req: IncomingMessage, trustProxy: boolean, signal?: AbortSignal): Promise<Request> {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", `${protocol(req, trustProxy)}://${req.headers.host ?? "localhost"}`);
  } catch {
    throw new HttpError(400, "Bad request");
  }
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    try {
      headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
    } catch {
      throw new HttpError(400, "Bad header");
    }
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await readBody(req) : undefined;
  return new Request(url, { method, headers, body, signal });
}

const waitForDrainOrClose = (res: ServerResponse) =>
  new Promise<void>((resolve) => {
    res.once("drain", resolve);
    res.once("close", resolve);
  });

/** Copies a Web Response to the Node response, streaming the body (Server-Sent Events included). */
export async function sendWebResponse(res: ServerResponse, response: Response, headOnly = false): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") res.setHeader(key, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  if (!response.body || headOnly) {
    await response.body?.cancel();
    res.end();
    return;
  }
  res.flushHeaders();
  const reader = response.body.getReader();
  res.on("close", () => void reader.cancel().catch(() => undefined));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || res.destroyed) break;
      if (!res.write(value)) await waitForDrainOrClose(res);
    }
  } finally {
    res.end();
  }
}
