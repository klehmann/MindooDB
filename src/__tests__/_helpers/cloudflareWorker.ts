/**
 * Runs the Cloudflare host (`src/cloudflare`) under `wrangler dev` for tests.
 *
 * The Worker is bundled straight from this checkout: a temporary project
 * re-exports `src/cloudflare/index.ts` and copies `cloudflare/wrangler.jsonc`.
 * Durable Object storage is local (Miniflare) and lives in the temporary
 * directory; nothing is deployed.
 *
 * Wrangler is found via `WRANGLER_BIN`, else `cloudflare/node_modules/.bin`.
 *
 * With `MINDOODB_CLOUDFLARE_PACKAGE_DIR` set to a directory whose
 * `node_modules` holds a built `mindoodb` package, the Worker imports
 * `mindoodb/cloudflare` from there instead — the path a deployment takes.
 */

import { spawn, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";

import type { PrivateUserId } from "../../core/types";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

export function findWrangler(): string | null {
  const candidates = [
    process.env.WRANGLER_BIN,
    path.join(REPO_ROOT, "cloudflare", "node_modules", ".bin", "wrangler"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port")),
      );
    });
  });
}

export interface RunningWorker {
  baseUrl: string;
  /** Fire the cron trigger once (as Cloudflare does every minute). */
  triggerCron(): Promise<void>;
  stop(): Promise<void>;
  /** Everything wrangler printed, for failure diagnostics. */
  log(): string;
}

export async function startCloudflareWorker(options: {
  serverIdentity: PrivateUserId;
  serverPassword: string;
  systemAdmin: PrivateUserId;
  /** Extra `config.json` fields besides the system admin capability (e.g. `cluster`). */
  serverConfig?: Record<string, unknown>;
  /** Extra `vars` for the Worker. */
  vars?: Record<string, string>;
}): Promise<RunningWorker> {
  const wrangler = findWrangler();
  if (!wrangler) {
    throw new Error("wrangler not found: set WRANGLER_BIN or install cloudflare/ dependencies");
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mindoodb-cloudflare-"));
  const packageDir = process.env.MINDOODB_CLOUDFLARE_PACKAGE_DIR;
  if (packageDir) {
    fs.symlinkSync(path.join(packageDir, "node_modules"), path.join(dir, "node_modules"));
  }
  fs.writeFileSync(
    path.join(dir, "entry.ts"),
    `export { default, MindooServerObject, MindooDatabaseObject } from ${JSON.stringify(
      packageDir ? "mindoodb/cloudflare" : path.join(REPO_ROOT, "src", "cloudflare", "index"),
    )};\n`,
  );
  const config = fs
    .readFileSync(path.join(REPO_ROOT, "cloudflare", "wrangler.jsonc"), "utf-8")
    .replace(/"main":\s*"[^"]+"/, '"main": "entry.ts"')
    .replace(/^\s*"\$schema".*$/m, "");
  fs.writeFileSync(path.join(dir, "wrangler.jsonc"), config);

  const vars: Record<string, string> = {
    MINDOODB_SERVER_IDENTITY: JSON.stringify(options.serverIdentity),
    MINDOODB_SERVER_PASSWORD: options.serverPassword,
    MINDOODB_JWT_SECRET: randomBytes(32).toString("base64"),
    MINDOODB_SERVER_CONFIG: JSON.stringify({
      ...options.serverConfig,
      capabilities: {
        ...(options.serverConfig?.capabilities as Record<string, unknown> | undefined),
        "ALL:/system/*": [
          {
            username: options.systemAdmin.username,
            publicsignkey: options.systemAdmin.userSigningKeyPair.publicKey,
          },
        ],
      },
    }),
    ...options.vars,
  };
  fs.writeFileSync(
    path.join(dir, ".dev.vars"),
    Object.entries(vars)
      .map(([name, value]) => `${name}='${value}'`)
      .join("\n") + "\n",
  );

  const port = await freePort();
  let output = "";
  const child: ChildProcess = spawn(
    wrangler,
    [
      "dev",
      "--local",
      "--test-scheduled",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--show-interactive-dev-session=false",
    ],
    { cwd: dir, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.on("data", (chunk) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk) => (output += chunk.toString()));

  const deadline = Date.now() + 90_000;
  while (!/Ready on/.test(output)) {
    if (child.exitCode !== null || Date.now() > deadline || /Uncaught|\[ERROR\]/.test(output)) {
      child.kill("SIGTERM");
      throw new Error(`wrangler dev did not start:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    triggerCron: async () => {
      const response = await fetch(`http://127.0.0.1:${port}/__scheduled?cron=*+*+*+*+*`);
      if (!response.ok) throw new Error(`Cron trigger failed: HTTP ${response.status}`);
    },
    log: () => output,
    stop: async () => {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
