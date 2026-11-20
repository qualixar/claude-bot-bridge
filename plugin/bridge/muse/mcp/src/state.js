import fs from "node:fs";
import path from "node:path";

/** ~/.claude-bot-bridge/state.json. muse-ax (canary) writes it too, so writes keep unknown keys and rename atomically. */
const file = (dir) => path.join(dir, "state.json");

export function readState(dir) {
  try {
    const v = JSON.parse(fs.readFileSync(file(dir), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

/** Shallow merge. State is bookkeeping only, so a write failure is swallowed (returns false). */
export function mergeState(dir, patch) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.state.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ ...readState(dir), ...patch }, null, 2) + "\n");
    fs.renameSync(tmp, file(dir));
    return true;
  } catch { return false; }
}
