// Bundles the Node entry points into dist/node/ so the runtime image needs no node_modules.
import { rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist/node", { recursive: true, force: true });
await build({
  entryPoints: { server: "src/node/server.ts", rotate: "src/node/rotate.ts" },
  outdir: "dist/node",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  logLevel: "info",
  // Some bundled dependencies use CommonJS require() internally.
  banner: { js: "import { createRequire as __cbbCreateRequire } from 'node:module'; const require = __cbbCreateRequire(import.meta.url);" },
});
