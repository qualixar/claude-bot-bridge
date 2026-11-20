import { execFile } from "node:child_process";

/** Runs a JSON-printing CLI. Always resolves to the parsed JSON object (the CLI prints JSON even on failure). */
export function runCli(args, { bin, timeoutMs = 60_000, exec = execFile } = {}) {
  return new Promise((resolve) => {
    exec(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(parseOutput(stdout, err));
    });
  });
}

export function parseOutput(stdout, err) {
  const text = String(stdout ?? "").trim();
  if (text) {
    try { return JSON.parse(text.split("\n").pop()); } catch { /* fall through */ }
  }
  const msg = err ? (err.killed ? "muse-ax timed out" : `muse-ax failed: ${err.code ?? err.message}`) : "muse-ax produced no JSON output";
  return { ok: false, error: { code: "cli_error", message: msg } };
}
