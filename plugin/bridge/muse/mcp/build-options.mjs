export const options = {
  entryPoints: ["src/index.js"],
  outfile: "dist/index.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: 'import { createRequire as __cbbCreateRequire } from "node:module"; const require = __cbbCreateRequire(import.meta.url);' },
  logLevel: "warning",
};
