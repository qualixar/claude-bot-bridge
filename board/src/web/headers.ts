export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export type BodyKind = "html" | "api" | "asset";

/** Headers for every response the web board sends. HSTS is only sent over https. */
export function securityHeaders(https: boolean, kind: BodyKind, extra: Record<string, string> = {}): Headers {
  const h = new Headers({
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "cache-control": kind === "asset" ? "no-cache" : "no-store",
    ...extra,
  });
  if (https) h.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  return h;
}
