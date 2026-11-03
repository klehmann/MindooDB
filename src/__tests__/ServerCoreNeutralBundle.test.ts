/**
 * The server core (`src/server`) and the Cloudflare host (`src/cloudflare`)
 * must run on runtimes without Node built-ins, such as Cloudflare Workers.
 * Bundling them for esbuild's neutral platform
 * fails on any `fs`, `path`, `node:*`, … import that creeps in, directly or
 * through a dependency.
 */

import path from "path";
import { build } from "esbuild";

describe("server core platform neutrality", () => {
  test.each([
    ["src/server", path.join(__dirname, "..", "server", "index.ts")],
    ["src/cloudflare", path.join(__dirname, "..", "cloudflare", "index.ts")],
  ])("%s bundles for a neutral platform without Node built-ins", async (_name, entryPoint) => {
    const result = await build({
      entryPoints: [entryPoint],
      bundle: true,
      platform: "neutral",
      format: "esm",
      mainFields: ["module", "main"],
      conditions: ["workerd", "worker", "browser"],
      // Automerge ships its own per-runtime builds (WASM); hosts bundle it
      // with their own toolchain.
      external: ["@automerge/automerge", "@automerge/automerge/*"],
      write: false,
      metafile: true,
      logLevel: "silent",
    });

    const externalImports = Object.values(result.metafile.outputs)
      .flatMap((output) => output.imports)
      .filter((imported) => imported.external)
      .map((imported) => imported.path);
    expect(externalImports.filter((p) => !p.startsWith("@automerge/automerge"))).toEqual([]);

    // Free references to Node globals would compile but fail at runtime.
    const bundled = result.outputFiles[0].text;
    expect(bundled).not.toMatch(/\bBuffer\.(from|alloc|isBuffer|concat)\(/);
    expect(bundled).not.toMatch(/\brequire\(/);
  }, 60_000);
});
