// An owner-recording lock file ("pid\nnonce\n"), the same format FileLock.swift uses, so the helper and the MCP server can
// share a lock on one folder (the keyset cache, the binary directory).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

/** The owner recorded in the lock file ("pid\nnonce\n"), or null (unreadable, a legacy directory lock, garbage). */
function readOwner(lock) {
  try {
    const [pid, nonce, ...rest] = fs.readFileSync(lock, "utf8").split("\n");
    return /^\d+$/.test(pid) && nonce && rest.join("") === "" ? { pid: Number(pid), nonce } : null;
  } catch { return null; }
}

/** Takeover needs BOTH: the file is older than the threshold AND its owner process is gone (or never recorded). */
function lockIsStale(lock, nowMs, isAlive, staleMs) {
  if (nowMs - fs.statSync(lock).mtimeMs <= staleMs) return false;
  const owner = readOwner(lock);
  return owner ? !isAlive(owner.pid) : true;
}

/**
 * Exclusive lock file at `lock` holding this process's pid and a random nonce. Returns { release } or null when someone
 * else holds it. release() removes the file only while it still carries this nonce. A stale lock is moved aside with one
 * rename, so two processes cannot both take it over.
 */
export function acquireLockFile(lock, { nowMs = Date.now(), isAlive = pidAlive, staleMs }) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const nonce = crypto.randomUUID();
  const create = () => fs.writeFileSync(lock, `${process.pid}\n${nonce}\n`, { flag: "wx", mode: 0o600 });
  try { create(); } catch (e) {
    if (e.code !== "EEXIST") throw e;
    if (!lockIsStale(lock, nowMs, isAlive, staleMs)) return null;
    const aside = `${lock}.stale-${nonce}`;
    try { fs.renameSync(lock, aside); } catch { return null; }
    fs.rmSync(aside, { recursive: true, force: true });
    try { create(); } catch { return null; }
  }
  return { release: () => { if (readOwner(lock)?.nonce === nonce) fs.rmSync(lock, { force: true }); } };
}
