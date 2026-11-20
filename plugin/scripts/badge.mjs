#!/usr/bin/env node
// Writes docs/badges/muse-verified.json (a shields.io endpoint document) from rules/muse.json: the Muse versions the rules
// list, oldest first. CI runs `node plugin/scripts/badge.mjs --check` so the badge cannot go stale.
// Usage: badge.mjs [--check] [--rules <rules.json>] [--out <badge.json>]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LABEL = "verified on Muse";
export const COLOR = "F4A300";

const nums = (v) => String(v).split(".").map((n) => Number.parseInt(n, 10) || 0);
const compare = (a, b) => {
  const x = nums(a), y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};
const nextMinor = (v) => { const [a, b = 0] = nums(v); return `${a}.${b + 1}`; };
const same = (a, b) => compare(a, b) === 0;

/** Splits a version spec (a bare version, or comparators such as ">=13.1 <13.2") into { lower, upper, exact }. */
function parseSpec(spec) {
  const out = {};
  for (const tok of String(spec).trim().split(/\s+/)) {
    const m = /^(>=|<=|>|<|=)?(\d+(?:\.\d+)*)$/.exec(tok);
    if (!m) throw new Error(`unreadable version spec "${spec}"`);
    const [, op = "=", v] = m;
    if (op === ">=" || op === ">") out.lower = v;
    else if (op === "<" || op === "<=") out.upper = v;
    else out.exact = v;
  }
  return out;
}

/** "12.1" -> "12.1"; ">=13.1 <13.2" -> "13.1"; ">=13.1 <14" -> "13.1+" (13.1 and later 13.x); ">=13.1" -> "13.1+"; else "A–B". */
export function specLabel(spec) {
  const { lower, upper, exact } = parseSpec(spec);
  if (exact !== undefined) return exact;
  if (lower === undefined) return `<${upper}`;
  if (upper === undefined) return `${lower}+`;
  if (same(upper, nextMinor(lower))) return lower;
  if (!upper.includes(".") && same(upper, String(nums(lower)[0] + 1))) return `${lower}+`;
  return `${lower}–${upper}`;
}

const sortKey = (spec) => { const p = parseSpec(spec); return p.lower ?? p.exact ?? p.upper; };

export function verifiedMessage(rules) {
  const profiles = rules?.profiles;
  if (!Array.isArray(profiles) || profiles.length === 0) throw new Error("the rules have no profiles");
  const specs = [...new Set(profiles.flatMap((p) => p?.match?.versions ?? []))];
  if (specs.length === 0) throw new Error("the rules list no Muse versions");
  return specs.sort((a, b) => compare(sortKey(a), sortKey(b))).map(specLabel).filter((l, i, all) => all.indexOf(l) === i).join(" · ");
}

export const badgeFor = (rules) => ({ schemaVersion: 1, label: LABEL, message: verifiedMessage(rules), color: COLOR });

function main(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let rulesPath = path.join(here, "../../rules/muse.json"), outPath = path.join(here, "../../docs/badges/muse-verified.json"), check = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--check") check = true;
    else if (argv[i] === "--rules" && argv[i + 1]) rulesPath = argv[++i];
    else if (argv[i] === "--out" && argv[i + 1]) outPath = argv[++i];
    else { console.error("usage: badge.mjs [--check] [--rules <rules.json>] [--out <badge.json>]"); return 2; }
  }
  let text;
  try { text = `${JSON.stringify(badgeFor(JSON.parse(fs.readFileSync(rulesPath, "utf8"))), null, 2)}\n`; } catch (e) {
    console.error(`badge.mjs: cannot build the badge from ${rulesPath}: ${e.message}`);
    return 1;
  }
  if (check) {
    let have = null;
    try { have = fs.readFileSync(outPath, "utf8"); } catch { /* missing */ }
    if (have === text) { console.log(`${outPath} is current`); return 0; }
    console.error(`${outPath} is out of date with ${rulesPath}. Run: node plugin/scripts/badge.mjs`);
    return 1;
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, text);
  console.log(`wrote ${outPath}: ${JSON.parse(text).message}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
