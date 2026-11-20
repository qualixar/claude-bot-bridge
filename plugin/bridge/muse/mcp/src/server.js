import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BOTS } from "./bots/index.js";
import { PLUGIN_VERSION } from "./version.js";

export { BOTS };

/** Serves the tools of every registered bot (see bots/index.js). */
export function createServer(deps = {}, bots = Object.values(BOTS)) {
  const server = new McpServer({ name: "claude-bot-bridge", version: PLUGIN_VERSION });
  for (const bot of bots) {
    for (const [name, cmd, description, shape] of bot.tools) {
      server.registerTool(name, { description, inputSchema: shape }, async (input) => {
        const result = await bot.handleCall(cmd, input, deps);
        return { content: [{ type: "text", text: JSON.stringify(result) }], isError: result.ok === false };
      });
    }
  }
  return server;
}
