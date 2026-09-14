/**
 * Bundle and run the TypeScript live Iroh server. ts-node cannot resolve the
 * nodenext `.js` imports in this repo; esbuild can.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(root, "..");
const outdir = join(pkgRoot, ".tmp");
const outfile = join(outdir, "iroh-live-server.cjs");
mkdirSync(outdir, { recursive: true });

await build({
  absWorkingDir: pkgRoot,
  entryPoints: [join(root, "iroh-live-test-server.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile,
  packages: "external",
  sourcemap: "inline",
  logLevel: "silent",
});

createRequire(import.meta.url)(outfile);
