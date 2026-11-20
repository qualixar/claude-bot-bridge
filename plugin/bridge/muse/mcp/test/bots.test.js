// The bot adapter boundary on the Node side: a registry keyed by bot id, and rules files that name their bot.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { BOTS, botIds, getBot, defaultBot } from "../src/bots/index.js";
import { createServer } from "../src/server.js";
import muse from "../src/bots/muse.js";

const repo = (rel) => new URL(`../../../../../${rel}`, import.meta.url);
const json = (rel) => JSON.parse(fs.readFileSync(repo(rel), "utf8"));

describe("bot registry", () => {
  it("is keyed by bot id and holds the Muse module", () => {
    expect(Object.keys(BOTS)).toEqual(["muse"]);
    expect(getBot("muse")).toBe(muse);
    expect(botIds()).toEqual(["muse"]);
    expect(defaultBot()).toBe(muse);
  });
  it("refuses an unknown bot id with the list of known ones", () => {
    expect(() => getBot("nope")).toThrow(/unknown bot "nope".*muse/);
  });
  it("every module has the shape the server needs and an id that is a valid rules namespace", () => {
    for (const [id, bot] of Object.entries(BOTS)) {
      expect(bot.id).toBe(id);
      expect(id).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
      expect(typeof bot.serverName).toBe("string");
      expect(Array.isArray(bot.tools) && typeof bot.handleCall === "function").toBe(true);
    }
  });
  it("the server registers the tools of every registered bot", () => {
    const server = createServer({});
    const names = Object.keys(server._registeredTools ?? {});
    for (const [name] of muse.tools) expect(names).toContain(name);
  });
});

describe("rules files name their bot", () => {
  const index = json("rules/index.json");
  it("rules/index.json lists exactly the registered bots, each with a rules file next to it", () => {
    expect(index.schema).toBe(1);
    expect(index.bots.map((b) => b.id).sort()).toEqual(botIds().sort());
    for (const b of index.bots) {
      expect(b.rules).toMatch(/^[A-Za-z0-9._-]+\.json$/);
      expect(fs.existsSync(repo(`rules/${b.rules}`))).toBe(true);
    }
  });
  it("each rules document carries the bot id of its index entry, a key_id and a revision", () => {
    for (const b of index.bots) {
      const doc = json(`rules/${b.rules}`);
      expect(doc.bot).toBe(b.id);
      expect(b.rules).toBe(`${b.id}.json`);
      expect(doc.key_id).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(Number.isInteger(doc.revision) && doc.revision >= 1).toBe(true);
    }
    expect(index.key_id).toBe(json("rules/muse.json").key_id);
  });
  it("the rules key id used by the rules and the index exists in the keyset with the purpose `rules`", () => {
    const keyset = json("keys/keyset.json");
    const k = keyset.keys.find((x) => x.id === index.key_id);
    expect(k?.use).toBe("rules");
  });
});
