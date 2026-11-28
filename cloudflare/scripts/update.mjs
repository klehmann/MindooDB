#!/usr/bin/env node
/**
 * Update the server to a mindoodb release and deploy it.
 *
 *   npm run update            # newest release
 *   npm run update -- 0.2.1   # a specific release
 *   npm run update -- --no-deploy
 *
 * Installs the release (pinned exactly in package.json), prints the version
 * change and deploys with the tag mindoodb-<version>. Stored data and secrets
 * are not touched; `npx wrangler rollback <version-id>` serves the previous
 * code again. If the release notes ask for changes to wrangler.jsonc (a new
 * Durable Object class, binding or limit), make them before deploying.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const deploy = !args.includes("--no-deploy");
const target = args.find((a) => !a.startsWith("--")) ?? "latest";
const shell = process.platform === "win32";

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit", shell });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function installed() {
  try {
    return JSON.parse(readFileSync(new URL("../node_modules/mindoodb/package.json", import.meta.url), "utf-8")).version;
  } catch {
    return null;
  }
}

const before = installed();
run("npm", ["install", "--save-exact", "--no-audit", "--no-fund", `mindoodb@${target}`]);
const after = installed();

if (before === after) {
  console.log(`mindoodb ${after} is already installed.`);
  if (!args.includes("--force")) {
    console.log("Nothing to deploy (pass --force to deploy anyway).");
    process.exit(0);
  }
} else {
  console.log(`mindoodb ${before ?? "(none)"} -> ${after}`);
}

if (deploy) {
  run("node", [fileURLToPath(new URL("./deploy.mjs", import.meta.url))]);
  console.log("Deployed. Check the server, e.g. its /.well-known/mindoodb-server-info.");
} else {
  console.log("Installed only. Deploy with `npm run deploy`.");
}
