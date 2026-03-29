#!/usr/bin/env node
/**
 * MindooDB Server Init - One-time setup that generates the server identity
 * and optionally creates a first system admin keypair.
 *
 * Usage:
 *   npx ts-node src/serverinit.ts --name <serverName> [options]
 *
 * Options:
 *   -n, --name <name>       Server name (e.g., "server1") -- required
 *   -d, --data-dir <path>   Data directory path (default: ./data)
 *   -f, --force             Overwrite existing server-identity.json
 *   --skip-admin            Skip system admin keypair generation
 *   -h, --help              Show this help message
 *
 * Environment variables:
 *   MINDOODB_SERVER_PASSWORD / MINDOODB_SERVER_PASSWORD_FILE — encrypt server identity.
 *   If neither is set, the user is prompted interactively.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";

import { NodeCryptoAdapter } from "../crypto/NodeCryptoAdapter";
import { BaseMindooTenantFactory } from "../../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../../appendonlystores/InMemoryContentAddressedStoreFactory";

import { resolveServerPassword } from "./resolveServerPassword";
import { ENV_VARS } from "./types";
import type { ServerConfig } from "./types";

interface InitOptions {
  name: string;
  dataDir: string;
  force: boolean;
  skipAdmin: boolean;
  help: boolean;
}

function parseArgs(args: string[]): InitOptions {
  const options: InitOptions = {
    name: "",
    dataDir: "./data",
    force: false,
    skipAdmin: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case "-n":
      case "--name":
        if (nextArg) {
          options.name = nextArg;
          i++;
        }
        break;

      case "-d":
      case "--data-dir":
        if (nextArg) {
          options.dataDir = nextArg;
          i++;
        }
        break;

      case "-f":
      case "--force":
        options.force = true;
        break;

      case "--skip-admin":
        options.skipAdmin = true;
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
MindooDB Server Init - Generate server identity and (optionally) a system admin

Usage:
  npx ts-node src/serverinit.ts --name <serverName> [options]

Options:
  -n, --name <name>       Server name (e.g., "server1") -- required
  -d, --data-dir <path>   Data directory path (default: ./data)
  -f, --force             Overwrite existing server-identity.json
  --skip-admin            Skip interactive system admin keypair generation
  -h, --help              Show this help message

Environment variables:
  MINDOODB_SERVER_PASSWORD or MINDOODB_SERVER_PASSWORD_FILE — encrypt server identity.
  If neither is set, the user is prompted interactively.

Examples:
  # Interactive (prompts for password and system admin setup):
  npx ts-node src/serverinit.ts --name server1

  # Non-interactive (password from file, skip admin):
  MINDOODB_SERVER_PASSWORD_FILE=./.server-password npx ts-node src/serverinit.ts --name server1 --skip-admin
`);
}

function createReadline(): ReturnType<typeof createInterface> {
  return createInterface({
    input: process.stdin,
    output: process.stderr,
  });
}

async function promptLine(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer));
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  if (!options.name) {
    console.error("Error: --name is required. Use --help for usage.");
    process.exit(1);
  }

  const identityPath = join(options.dataDir, "server-identity.json");
  const trustedServersPath = join(options.dataDir, "trusted-servers.json");
  const configPath = join(options.dataDir, "config.json");

  if (existsSync(identityPath) && !options.force) {
    console.error(`Error: ${identityPath} already exists. Use --force to overwrite.`);
    process.exit(1);
  }

  // Get password from env / file or prompt
  let password = resolveServerPassword();
  if (!password) {
    const rl = createReadline();
    password = await promptLine(rl, "Enter password to encrypt server identity: ");
    rl.close();
  }
  if (!password) {
    console.error("Error: password is required.");
    process.exit(1);
  }

  // Ensure data directory exists
  if (!existsSync(options.dataDir)) {
    mkdirSync(options.dataDir, { recursive: true });
  }

  console.log("=".repeat(60));
  console.log("MindooDB Server Init");
  console.log("=".repeat(60));
  console.log(`Server name: ${options.name}`);
  console.log(`Data directory: ${options.dataDir}`);
  console.log("=".repeat(60));

  const cryptoAdapter = new NodeCryptoAdapter();
  const factory = new BaseMindooTenantFactory(
    new InMemoryContentAddressedStoreFactory(),
    cryptoAdapter,
  );

  const serverUsername = `CN=${options.name}`;
  console.log(`\nGenerating server identity for "${serverUsername}"...`);
  console.log("(This may take a few seconds for RSA key generation)\n");

  const identity = await factory.createUserId(serverUsername, password);

  // Write server-identity.json
  writeFileSync(identityPath, JSON.stringify(identity, null, 2), "utf-8");
  console.log(`\nServer identity written to: ${identityPath}`);

  // Create trusted-servers.json if it doesn't exist
  if (!existsSync(trustedServersPath)) {
    writeFileSync(trustedServersPath, "[]", "utf-8");
    console.log(`Created empty trusted-servers.json: ${trustedServersPath}`);
  }

  // Print public keys for sharing with other servers
  console.log("\n" + "=".repeat(60));
  console.log("SERVER PUBLIC KEYS (share these with other servers):");
  console.log("=".repeat(60));
  console.log(`\nServer name: ${serverUsername}`);
  console.log(`\nSigning public key (Ed25519):\n${identity.userSigningKeyPair.publicKey}`);
  console.log(`\nEncryption public key (RSA-OAEP):\n${identity.userEncryptionKeyPair.publicKey}`);
  console.log("=".repeat(60));

  // System admin keypair generation
  if (!options.skipAdmin) {
    await generateSystemAdmin(factory, options.dataDir, configPath);
  } else {
    writeDefaultConfig(configPath);
    console.log(`\nSkipped system admin generation (--skip-admin).`);
  }

  if (!process.env.MINDOODB_SKIP_NEXT_STEPS) {
    console.log("\n" + "=".repeat(60));
    console.log("NEXT STEPS:");
    console.log("=".repeat(60));
    console.log("1. Start the server:");
    console.log(
      `   ${ENV_VARS.SERVER_PASSWORD_FILE}=<path> or ${ENV_VARS.SERVER_PASSWORD}=<password> ` +
        `node dist/node/server/server.js -d ${options.dataDir}`,
    );
    console.log("2. Edit config.json to configure system admin capabilities");
    console.log("3. Use MindooDBServerAdmin or publishToServer to manage tenants");
    console.log("=".repeat(60));
  }
}

async function generateSystemAdmin(
  factory: BaseMindooTenantFactory,
  dataDir: string,
  configPath: string,
): Promise<void> {
  const rl = createReadline();

  const answer = await promptLine(rl, "\nCreate a system admin now? (y/N) ");
  if (answer.toLowerCase() !== "y") {
    rl.close();
    writeDefaultConfig(configPath);
    console.log("Skipped system admin generation.");
    return;
  }

  const adminUsername = await promptLine(rl, "System admin username (e.g. cn=sysadmin/o=myorg): ");
  if (!adminUsername.trim()) {
    rl.close();
    console.error("Error: username cannot be empty.");
    writeDefaultConfig(configPath);
    return;
  }

  const adminPassword = await promptLine(rl, "Password to protect the system admin private key: ");
  if (!adminPassword) {
    rl.close();
    console.error("Error: password cannot be empty.");
    writeDefaultConfig(configPath);
    return;
  }

  const adminPasswordConfirm = await promptLine(rl, "Confirm password: ");
  rl.close();

  if (adminPassword !== adminPasswordConfirm) {
    console.error("Error: passwords do not match.");
    writeDefaultConfig(configPath);
    return;
  }

  console.log(`\nGenerating system admin keypair for "${adminUsername}"...`);
  console.log("(This may take a few seconds for RSA key generation)\n");

  const adminIdentity = await factory.createUserId(adminUsername, adminPassword);

  // Save the password-encrypted private key to a separate identity file
  const safeFilename = adminUsername
    .replace(/[^a-zA-Z0-9_=-]/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
  const identityFilePath = join(dataDir, `system-admin-${safeFilename}.identity.json`);
  writeFileSync(identityFilePath, JSON.stringify(adminIdentity, null, 2), "utf-8");
  console.log(`System admin identity (password-encrypted) written to: ${identityFilePath}`);

  // Write config.json with the admin's public key
  const config: ServerConfig = {
    capabilities: {
      "ALL:/system/*": [
        {
          username: adminUsername,
          publicsignkey: adminIdentity.userSigningKeyPair.publicKey as string,
        },
      ],
    },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  console.log(`Config written to: ${configPath}`);

  console.log("\n" + "=".repeat(60));
  console.log("SYSTEM ADMIN CREATED:");
  console.log("=".repeat(60));
  console.log(`Username: ${adminUsername}`);
  console.log(`Identity file: ${identityFilePath}`);
  console.log(`Config: ${configPath}`);
  console.log("\nThe identity file contains the password-encrypted private key.");
  console.log("The raw private key is never stored on disk.");
  console.log("You will need the password when using MindooDBServerAdmin or publishToServer.");
  console.log("=".repeat(60));
}

function writeDefaultConfig(configPath: string): void {
  if (existsSync(configPath)) return;

  const config: ServerConfig = {
    capabilities: {
      "ALL:/system/*": [
        {
          username: "<INSERT_USERNAME>",
          publicsignkey: "<INSERT_SIGNING_PUBLIC_KEY>",
        },
      ],
    },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  console.log(`Default config.json (with placeholder) written to: ${configPath}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
