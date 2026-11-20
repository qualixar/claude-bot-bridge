// <CBB_HOME>/keys/current: the newest verified keyset this machine has seen, in the layout the Swift helper uses
// (PairCache.swift): one fresh directory v-<id>/ holding keyset.json and keyset.json.sig, and a symlink `current` that
// is swapped to it with one rename. Both programs read and write the same folder, serialised by keys/.lock.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { acquireLockFile } from "./lock.js";

const FILE = "keyset.json";
const MAX_BYTES = 64 * 1024;
const LOCK_STALE_MS = 120_000;   // FileLock.swift's default
const LOCK_TRIES = 50;
const LOCK_WAIT_MS = 100;

const keysDir = (dir) => path.join(dir, "keys");
const sleepReal = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** The cached pair, or null. `current` is resolved once, so both files come from the same version directory. */
export function readStoredKeyset(dir) {
  try {
    const root = keysDir(dir);
    const target = path.resolve(root, fs.readlinkSync(path.join(root, "current")));
    const jsonPath = path.join(target, FILE), sigPath = path.join(target, `${FILE}.sig`);
    if (fs.statSync(jsonPath).size > MAX_BYTES || fs.statSync(sigPath).size > 1024) return null;
    return { json: fs.readFileSync(jsonPath, "utf8"), signature: fs.readFileSync(sigPath, "utf8").trim() };
  } catch { return null; }
}

async function takeLock(file, { sleep, isAlive }) {
  for (let i = 0; i < LOCK_TRIES; i++) {
    const lock = acquireLockFile(file, { staleMs: LOCK_STALE_MS, isAlive });
    if (lock) return lock;
    await sleep(LOCK_WAIT_MS);
  }
  return null;
}

/** Keeps the new directory and the one before it (a reader may still be opening it); removes older v-* directories. */
function prune(root, keep) {
  for (const n of fs.readdirSync(root)) {
    if (n.startsWith("v-") && !keep.includes(n)) fs.rmSync(path.join(root, n), { recursive: true, force: true });
  }
}

/**
 * Atomically replaces the cached keyset: write a fresh directory, then repoint `current` at it with one rename. Returns
 * true on success; a failure (read-only home, a lock that never frees) returns false and leaves what was there. Never throws.
 * The caller has already verified the pair with the root key.
 */
export async function writeStoredKeyset(dir, { json, signature }, { sleep = sleepReal, isAlive } = {}) {
  const root = keysDir(dir);
  let lock = null, made = null;
  try {
    fs.mkdirSync(root, { recursive: true });
    lock = await takeLock(path.join(root, ".lock"), { sleep, isAlive });
    if (!lock) return false;
    const name = `v-${crypto.randomUUID().toUpperCase()}`;
    made = path.join(root, name);
    fs.mkdirSync(made);
    fs.writeFileSync(path.join(made, FILE), json);
    fs.writeFileSync(path.join(made, `${FILE}.sig`), `${signature.trim()}\n`);
    let previous = null;
    try { previous = fs.readlinkSync(path.join(root, "current")); } catch { /* first write */ }
    const tmp = path.join(root, `.current.${crypto.randomUUID()}`);
    fs.symlinkSync(name, tmp);
    try { fs.renameSync(tmp, path.join(root, "current")); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
    made = null;
    prune(root, [name, previous].filter(Boolean));
    return true;
  } catch {
    if (made) fs.rmSync(made, { recursive: true, force: true });
    return false;
  } finally { lock?.release(); }
}
