// The bots this MCP server can drive, keyed by bot id. The id is also the namespace of the bot's rules file
// (rules/<id>.json, listed in rules/index.json) and the id of its muse-ax driver. Adding a bot: a module here with the
// same shape ({ id, serverName, tools, handleCall }), a Swift BotDriver, and a rules file plus its index entry.
import muse from "./muse.js";

export const BOTS = Object.freeze({ [muse.id]: muse });

export const botIds = () => Object.keys(BOTS);

export function getBot(id) {
  const bot = Object.hasOwn(BOTS, id) ? BOTS[id] : undefined;
  if (!bot) throw new Error(`unknown bot "${id}". Known bots: ${botIds().join(", ")}.`);
  return bot;
}

/** The bot used when none is named: the first registered one. */
export const defaultBot = () => BOTS[botIds()[0]];
