#!/usr/bin/env node
/**
 * MindooDB Server Init - One-time setup that generates the server identity.
 *
 * Usage:
 *   npx ts-node src/init.ts --name <serverName> [options]
 *
 * Options:
 *   -n, --name <name>       Server name (e.g., "server1") -- required
 *   -d, --data-dir <path>   Data directory path (default: ./data)
 *   -f, --force             Overwrite existing server-identity.json
 *   -h, --help              Show this help message
 *
 * Environment variables:
 *   MINDOODB_SERVER_PASSWORD  Password to encrypt the server identity.
 *                             If not set, the user is prompted interactively.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";

import { NodeCryptoAdapter } from "mindoodb/node/crypto/NodeCryptoAdapter";
import { BaseMindooTenantFactory } from "mindoodb/core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "mindoodb/appendonlystores/InMemoryContentAddressedStoreFactory";

import { ENV_VARS } from "./types";

interface InitOptions {
  name: string;
  dataDir: string;
  force: boolean;
  help: boolean;
}

function parseArgs(args: string[]): InitOptions {
  const options: InitOptions = {
    name: "",
    dataDir: "./data",
    force: false,
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
MindooDB Server Init - Generate server identity

Usage:
  npx ts-node src/init.ts --name <serverName> [options]

Options:
  -n, --name <name>       Server name (e.g., "server1") -- required
  -d, --data-dir <path>   Data directory path (default: ./data)
  -f, --force             Overwrite existing server-identity.json
  -h, --help              Show this help message

Environment variables:
  MINDOODB_SERVER_PASSWORD  Password to encrypt the server identity.
                            If not set, the user is prompted interactively.

Examples:
  # Interactive (prompts for password):
  npx ts-node src/init.ts --name server1

  # Non-interactive (password from env var):
  MINDOODB_SERVER_PASSWORD=secret npx ts-node src/init.ts --name server1 --data-dir ./data
`);
}

async function promptPassword(): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise((resolve) => {
    rl.question("Enter password to encrypt server identity: ", (answer) => {
      rl.close();
      resolve(answer);
    });
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
  const tenantApiKeysPath = join(options.dataDir, "tenant-api-keys.json");

  if (existsSync(identityPath) && !options.force) {
    console.error(`Error: ${identityPath} already exists. Use --force to overwrite.`);
    process.exit(1);
  }

  // Get password from env var or prompt
  let password = process.env[ENV_VARS.SERVER_PASSWORD];
  if (!password) {
    password = await promptPassword();
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

  // Create tenant-api-keys.json if it doesn't exist
  if (!existsSync(tenantApiKeysPath)) {
    writeFileSync(tenantApiKeysPath, "[]", "utf-8");
    console.log(`Created empty tenant-api-keys.json: ${tenantApiKeysPath}`);
  }

  // Print public keys for sharing with other servers
  console.log("\n" + "=".repeat(60));
  console.log("SERVER PUBLIC KEYS (share these with other servers):");
  console.log("=".repeat(60));
  console.log(`\nServer name: ${serverUsername}`);
  console.log(`\nSigning public key (Ed25519):\n${identity.userSigningKeyPair.publicKey}`);
  console.log(`\nEncryption public key (RSA-OAEP):\n${identity.userEncryptionKeyPair.publicKey}`);
  console.log("\n" + "=".repeat(60));
  console.log("\nTo trust this server on another server, POST to /admin/trusted-servers:");
  console.log(JSON.stringify({
    name: serverUsername,
    signingPublicKey: identity.userSigningKeyPair.publicKey,
    encryptionPublicKey: identity.userEncryptionKeyPair.publicKey,
  }, null, 2));
  console.log("=".repeat(60));
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
