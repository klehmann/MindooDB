#!/usr/bin/env node
/**
 * MindooDB Add-to-Network CLI
 *
 * Exchanges trusted-server public keys between a new server and existing servers
 * using `/system/trusted-servers` with JWT auth (same system admin identity on each server).
 *
 * Password: MINDOODB_SYSTEM_ADMIN_PASSWORD, --password-file, or TTY prompt (hidden).
 */

import { readFileSync } from "fs";
import { MindooDBServerAdmin } from "../../core/MindooDBServerAdmin";
import type { PrivateUserId } from "../../core/userid";
import { NodeCryptoAdapter } from "../crypto/NodeCryptoAdapter";

const ENV_PASSWORD = "MINDOODB_SYSTEM_ADMIN_PASSWORD";

interface CliOptions {
  newServer: string;
  servers: string[];
  identityPath: string;
  passwordFile: string;
  help: boolean;
}

interface ServerInfo {
  name: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
}

/** Exported for tests. */
export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    newServer: "",
    servers: [],
    identityPath: "",
    passwordFile: "",
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case "--new-server":
        if (nextArg) {
          options.newServer = nextArg.replace(/\/+$/, "");
          i++;
        }
        break;
      case "--servers":
        if (nextArg) {
          options.servers = nextArg.split(",").map((s) => s.trim().replace(/\/+$/, ""));
          i++;
        }
        break;
      case "--identity":
        if (nextArg) {
          options.identityPath = nextArg;
          i++;
        }
        break;
      case "--password-file":
        if (nextArg) {
          options.passwordFile = nextArg;
          i++;
        }
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        if (arg.startsWith("-")) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
    }
  }

  return options;
}

function showHelp(): void {
  console.log(`
MindooDB Add-to-Network

Adds a new server to an existing network by exchanging trust between all servers.
Uses /system/trusted-servers with JWT (same system admin identity must be authorized on every server).

Usage:
  npm run server:add-to-network -- [options]

Options:
  --new-server <url>         URL of the server being added (required)
  --servers <url,url,...>    Comma-separated URLs of existing servers (required)
  --identity <path>          System admin *.identity.json (PrivateUserId) (required)
  --password-file <path>     Read password from file (optional if env or TTY)
  -h, --help                 Show this help message

Password (first match wins):
  ${ENV_PASSWORD}   environment variable
  --password-file     file containing one line (trimmed)
  TTY               hidden prompt on interactive terminal

Example:
  npm run server:add-to-network -- \\
    --new-server https://server4.example.com \\
    --servers https://s1.example.com,https://s2.example.com \\
    --identity ./system-admin.identity.json
`);
}

function loadIdentity(path: string): PrivateUserId {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as PrivateUserId;
  if (!parsed?.username || !parsed?.userSigningKeyPair?.publicKey) {
    throw new Error(`Invalid identity file: ${path}`);
  }
  return parsed;
}

async function resolvePassword(passwordFile: string): Promise<string> {
  const fromEnv = process.env[ENV_PASSWORD];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  if (passwordFile) {
    return readFileSync(passwordFile, "utf8").replace(/\r?\n$/, "");
  }
  if (process.stdin.isTTY) {
    return readPasswordHidden("System admin password: ");
  }
  console.error(
    `Error: Set ${ENV_PASSWORD}, use --password-file, or run from an interactive terminal.`,
  );
  process.exit(1);
}

/** Hidden password on TTY (no echo). */
function readPasswordHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    if (!stdin.isTTY) {
      reject(new Error("Internal: readPasswordHidden without TTY"));
      return;
    }
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let pass = "";
    const onData = (key: string) => {
      if (key === "\n" || key === "\r" || key === "\u0004") {
        stdin.setRawMode(false);
        stdin.removeListener("data", onData);
        stdin.pause();
        stdout.write("\n");
        resolve(pass);
        return;
      }
      if (key === "\u0003") {
        stdin.setRawMode(false);
        process.exit(130);
      }
      if (key === "\u007f" || key === "\b") {
        pass = pass.slice(0, -1);
        return;
      }
      if (key.length === 1) pass += key;
    };
    stdin.on("data", onData);
  });
}

async function fetchServerInfo(serverUrl: string): Promise<ServerInfo> {
  const url = `${serverUrl}/.well-known/mindoodb-server-info`;
  console.log(`  Fetching server info from ${url}`);
  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `Failed to fetch server info from ${serverUrl}: HTTP ${response.status} — ${JSON.stringify(body)}`,
    );
  }

  const info = body as ServerInfo;
  if (!info.name || !info.signingPublicKey || !info.encryptionPublicKey) {
    throw new Error(`Invalid server info response from ${serverUrl}`);
  }

  return info;
}

function createAdmin(
  baseUrl: string,
  identity: PrivateUserId,
  password: string,
): MindooDBServerAdmin {
  return new MindooDBServerAdmin({
    serverUrl: baseUrl,
    systemAdminUser: identity,
    systemAdminPassword: password,
    cryptoAdapter: new NodeCryptoAdapter(),
  });
}

async function addTrustedServer(
  targetUrl: string,
  serverInfo: ServerInfo,
  identity: PrivateUserId,
  password: string,
): Promise<void> {
  const admin = createAdmin(targetUrl, identity, password);
  try {
    await admin.addTrustedServer({
      name: serverInfo.name,
      signingPublicKey: serverInfo.signingPublicKey,
      encryptionPublicKey: serverInfo.encryptionPublicKey,
    });
    console.log(`  Added "${serverInfo.name}" to ${targetUrl}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("409") || /already exists/i.test(msg)) {
      console.log(`  "${serverInfo.name}" already trusted on ${targetUrl} (skipped)`);
      return;
    }
    throw e;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  if (!options.newServer) {
    console.error("Error: --new-server is required. Use --help for usage.");
    process.exit(1);
  }
  if (options.servers.length === 0) {
    console.error("Error: --servers is required. Use --help for usage.");
    process.exit(1);
  }
  if (!options.identityPath) {
    console.error("Error: --identity is required. Use --help for usage.");
    process.exit(1);
  }

  const identity = loadIdentity(options.identityPath);
  const password = await resolvePassword(options.passwordFile);
  if (!password) {
    console.error("Error: system admin password is empty.");
    process.exit(1);
  }

  console.log("=".repeat(60));
  console.log("MindooDB Add-to-Network");
  console.log("=".repeat(60));
  console.log(`New server:       ${options.newServer}`);
  console.log(`Existing servers: ${options.servers.join(", ")}`);
  console.log(`Identity:         ${options.identityPath}`);
  console.log("=".repeat(60));

  console.log("\n[1/3] Fetching new server identity...");
  const newServerInfo = await fetchServerInfo(options.newServer);
  console.log(`  Server name: ${newServerInfo.name}\n`);

  console.log("[2/3] Exchanging trust with existing servers...");
  let successCount = 0;
  const errors: string[] = [];

  for (const existingUrl of options.servers) {
    try {
      console.log(`\n  --- ${existingUrl} ---`);

      const existingInfo = await fetchServerInfo(existingUrl);
      console.log(`  Server name: ${existingInfo.name}`);

      await addTrustedServer(existingUrl, newServerInfo, identity, password);
      await addTrustedServer(options.newServer, existingInfo, identity, password);

      successCount++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`  ERROR: ${msg}`);
      errors.push(`${existingUrl}: ${msg}`);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("[3/3] Summary");
  console.log("=".repeat(60));
  console.log(`Trust established with ${successCount}/${options.servers.length} servers.`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const err of errors) {
      console.log(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log(`\n${newServerInfo.name} is now part of the network.`);
  console.log(
    "Next step: configure per-tenant sync via POST /system/tenants/:tenantId/sync-servers (see README-server.md).",
  );
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return /[/\\]add-to-network\.(ts|js|mjs|cjs)$/.test(entry);
}

if (isDirectExecution()) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
