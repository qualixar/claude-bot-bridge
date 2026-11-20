import { resolve } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(resolve(import.meta.dirname, "./migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Fake keys, for tests only.
          bindings: {
            OWNER_TOKEN: "test-owner-token-0123456789abcdef",
            WORKER_TOKEN: "test-worker-token-0123456789abcdef",
            SESSION_SECRET: "test-session-secret-0123456789abcdef0123456789",
            ALLOW_PLAINTEXT_STORAGE: "1",
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    resolve: { alias: { "#harness": resolve(import.meta.dirname, "./test/harness.workers.ts") } },
    test: {
      name: "workers",
      include: ["test/*.test.ts", "test/workers/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
