// Bundles the MCP server into one file so the installed plugin needs no node_modules.
import { build } from "esbuild";
import { options } from "./build-options.mjs";

await build(options);
