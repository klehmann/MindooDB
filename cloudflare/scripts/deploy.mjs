#!/usr/bin/env node
/**
 * `wrangler deploy`, tagged with the installed mindoodb version so that
 * `npx wrangler versions list` shows which release each Worker version runs.
 * Extra arguments are passed on to wrangler.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const version = JSON.parse(readFileSync(new URL("../node_modules/mindoodb/package.json", import.meta.url), "utf-8")).version;
const result = spawnSync(
  "npx",
  ["wrangler", "deploy", "--tag", `mindoodb-${version}`, "--message", `mindoodb ${version}`, ...process.argv.slice(2)],
  { stdio: "inherit", shell: process.platform === "win32" },
);
process.exit(result.status ?? 1);
