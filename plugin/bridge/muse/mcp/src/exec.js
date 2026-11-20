import { execFile } from "node:child_process";

/** Promise wrapper over execFile that never rejects: resolves { code, stdout, stderr } (code -1 = could not run / killed). */
export function run(file, args = [], { timeoutMs = 60_000, env } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      });
    } catch (e) {
      // e.g. ENOEXEC (a file that is not a program) is thrown synchronously by spawn.
      resolve({ code: -1, stdout: "", stderr: String(e?.message ?? e) });
    }
  });
}
