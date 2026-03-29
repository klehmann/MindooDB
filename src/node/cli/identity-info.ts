#!/usr/bin/env node

import { NodeCryptoAdapter } from "../crypto/NodeCryptoAdapter";
import { CliUsageError, loadPrivateIdentity, parseArgs, requireIdentityArg } from "./cli-utils";

export const HELP_TEXT = `mindoodb identity:info - display public information from an identity file

Usage:
  npm run identity:info -- --identity <path>
  ./mindoodb-cli.sh identity:info <file>

Options:
  --identity <path>   Path to an *.identity.json file (required)
  --help              Show this help
`;

async function hashUsernameHex(username: string): Promise<string> {
  const cryptoAdapter = new NodeCryptoAdapter();
  const subtle = cryptoAdapter.getSubtle();
  const bytes = new TextEncoder().encode(username.toLowerCase());
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const identityPath = requireIdentityArg(args, HELP_TEXT);
  const identity = loadPrivateIdentity(identityPath);
  const usernameHash = await hashUsernameHex(identity.username);

  console.log(`Identity file: ${identityPath}`);
  console.log(`Username: ${identity.username}`);
  console.log(`Public user ID (hex): ${usernameHash}`);
  console.log(`Signing public key:\n${identity.userSigningKeyPair.publicKey}`);
  console.log(`Encryption public key:\n${identity.userEncryptionKeyPair.publicKey}`);
  console.log(`Salt strings: signing, encryption`);
  console.log(`Encrypted private keys present: yes`);

  return 0;
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return /[/\\]identity-info\.(ts|js|mjs|cjs)$/.test(entry);
}

if (isDirectExecution()) {
  run().then(
    (exitCode) => process.exit(exitCode),
    (error) => {
      if (error instanceof CliUsageError) {
        console.log(error.message);
        process.exit(error.exitCode);
      }
      console.error("Fatal error:", error);
      process.exit(1);
    },
  );
}
