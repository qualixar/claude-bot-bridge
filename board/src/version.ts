import pkg from "../package.json";

/** Single source of truth for the board version: package.json. */
export const BOARD_VERSION: string = pkg.version;

/** Latest migration number (migrations/0001_init.sql is 1). A test checks this against the migrations folder. */
export const SCHEMA_VERSION = 2;

/**
 * MCP tool contract version. Tool names and input schemas are frozen: later versions may only add
 * optional input fields or new tools, so an older board keeps working with a newer plugin.
 * test/node/contract.test.ts enforces this against test/contract/tools.v1.json.
 */
export const API_VERSION = 1;
