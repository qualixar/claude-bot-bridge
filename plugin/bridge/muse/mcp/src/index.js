#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { createManager } from "./lifecycle.js";
import { loadManifest, manifestPath } from "./binary-update.js";

// Updates run in the background; tools answer `updating` while the binary is being replaced.
const manager = createManager({ manifest: loadManifest(manifestPath()) });
manager.start();
await createServer({ manager }).connect(new StdioServerTransport());
