#!/usr/bin/env node

import { renameSync, writeFileSync } from "fs";

import { InMemoryContentAddressedStoreFactory } from "../../appendonlystores/InMemoryContentAddressedStoreFactory";
import { BaseMindooTenantFactory } from "../../core/BaseMindooTenantFactory";
import { NodeCryptoAdapter } from "../crypto/NodeCryptoAdapter";
import {
  CliUsageError,
  loadPrivateIdentity,
  parseArgs,
  promptHiddenLine,
  requireIdentityArg,
} from "./cli-utils";

export const HELP_TEXT = `mindoodb identity:change-password - change the password of an identity file

Usage:
  npm run identity:change-password -- --identity <path>
  ./mindoodb-cli.sh identity:change-password <file>

Options:
  --identity <path>   Path to an *.identity.json file (required)
  --help              Show this help

You will be prompted for the current password, new password, and confirmation.
`;

export interface ChangeIdentityPasswordDeps {
  prompt?: (question: string) => Promise<string>;
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tempPath, path);
}

export async function run(
  argv: string[] = process.argv.slice(2),
  deps: ChangeIdentityPasswordDeps = {},
): Promise<number> {
  const args = parseArgs(argv);
  const identityPath = requireIdentityArg(args, HELP_TEXT);
  const prompt = deps.prompt ?? promptHiddenLine;

  const identity = loadPrivateIdentity(identityPath);
  const oldPassword = await prompt("Current password: ");
  if (!oldPassword) {
    throw new Error("Current password cannot be empty.");
  }

  const newPassword = await prompt("New password: ");
  if (!newPassword) {
    throw new Error("New password cannot be empty.");
  }

  const confirmPassword = await prompt("Confirm new password: ");
  if (newPassword !== confirmPassword) {
    throw new Error("Passwords do not match.");
  }

  const factory = new BaseMindooTenantFactory(
    new InMemoryContentAddressedStoreFactory(),
    new NodeCryptoAdapter(),
  );
  const updatedIdentity = await factory.changeIdentityPassword(identity, oldPassword, newPassword);

  writeJsonAtomic(identityPath, updatedIdentity);
  console.log(`Updated password for identity: ${identityPath}`);

  return 0;
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return /[/\\]change-identity-password\.(ts|js|mjs|cjs)$/.test(entry);
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
