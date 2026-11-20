import { defineConfig } from "vitest/config";

// Two projects run the same behaviour tests: `workers` (workerd + D1) and `node` (node:sqlite).
export default defineConfig({
  test: {
    projects: ["./vitest.workers.config.ts", "./vitest.node.config.ts"],
    coverage: {
      provider: "istanbul" as const,
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
    },
  },
});
