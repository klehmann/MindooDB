#!/usr/bin/env node

import { writeFileSync } from "fs";

import { InMemoryContentAddressedStoreFactory } from "../../appendonlystores/InMemoryContentAddressedStoreFactory";
import { BaseMindooTenantFactory } from "../../core/BaseMindooTenantFactory";
import { NodeCryptoAdapter } from "../crypto/NodeCryptoAdapter";
import {
  CliUsageError,
  getOptionalArg,
  loadPrivateIdentity,
  parseArgs,
  requireIdentityArg,
} from "./cli-utils";

export const HELP_TEXT = `mindoodb identity:export-public - export public keys from an identity file

Usage:
  npm run identity:export-public -- --identity <path> [--output <path>]
  ./mindoodb-cli.sh identity:export-public <file> [--output <path>]

Options:
  --identity <path>   Path to an *.identity.json file (required)
  --output <path>     Write JSON to file instead of stdout
  --help              Show this help
`;

export async function run(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const identityPath = requireIdentityArg(args, HELP_TEXT);
  const outputPath = getOptionalArg(args, "output");
  const identity = loadPrivateIdentity(identityPath);

  const factory = new BaseMindooTenantFactory(
    new InMemoryContentAddressedStoreFactory(),
    new NodeCryptoAdapter(),
  );
  const publicIdentity = factory.toPublicUserId(identity);
  const json = JSON.stringify(publicIdentity, null, 2);

  if (outputPath) {
    writeFileSync(outputPath, `${json}\n`, "utf8");
    console.log(`Public identity written to: ${outputPath}`);
  } else {
    console.log(json);
  }

  return 0;
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return /[/\\]identity-export-public\.(ts|js|mjs|cjs)$/.test(entry);
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
