import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "#harness": resolve(import.meta.dirname, "./test/harness.node.ts") } },
  test: {
    name: "node",
    environment: "node",
    include: ["test/*.test.ts", "test/node/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
