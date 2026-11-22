#!/usr/bin/env node
/**
 * Read or replace the running server's config.json as system admin.
 *
 * Usage:
 *   npm run config -- --url <server url> get               # print the current config
 *   npm run config -- --url <server url> put <file>        # replace it (backup is kept)
 *   npm run config -- --url <server url> backups           # list earlier versions
 *
 * Options:
 *   --url <url>                server url (or MINDOODB_URL), e.g. https://mindoodb-server.<account>.workers.dev
 *   --identity <file>          system admin identity (default: the one system-admin-*.identity.json here)
 *
 * The admin password is read from MINDOODB_ADMIN_PASSWORD or prompted for.
 *
 * The server keeps config.json in its Durable Object storage. The
 * MINDOODB_SERVER_CONFIG secret written by `npm run setup` only seeds it until
 * the first `put`; after that this command is the way to change it. Changes
 * apply immediately, no redeploy needed. The server refuses a config that
 * would remove your own access to `PUT /system/config`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

// Keep stdout for the config itself (`get > config.json`); mindoodb's own
// log lines go to stderr.
const print = (text) => process.stdout.write(`${text}\n`);
console.log = console.info = console.debug = (...args) => console.error(...args);

const { MindooDBServerAdmin, NodeCryptoAdapter } = await import("mindoodb");

function parseArgs(argv) {
  const options = { url: process.env.MINDOODB_URL, args: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--url") options.url = next();
    else if (arg === "--identity") options.identity = next();
    else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
    else options.args.push(arg);
  }
  return options;
}

async function promptHidden(question) {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

function findIdentity() {
  const files = readdirSync(".").filter((f) => /^system-admin-.*\.identity\.json$/.test(f));
  if (files.length !== 1) {
    throw new Error(
      files.length === 0
        ? "No system-admin-*.identity.json here; pass --identity <file>"
        : `Several admin identities here (${files.join(", ")}); pass --identity <file>`,
    );
  }
  return files[0];
}

const options = parseArgs(process.argv.slice(2));
const [command, file] = options.args;
if (!options.url) throw new Error("Pass --url <server url> (or set MINDOODB_URL)");
if (!["get", "put", "backups"].includes(command)) throw new Error("Command must be get, put <file> or backups");
if (command === "put" && !file) throw new Error("put needs a config file");

const identity = JSON.parse(readFileSync(options.identity ?? findIdentity(), "utf-8"));
const password =
  process.env.MINDOODB_ADMIN_PASSWORD ?? (await promptHidden(`Password for system admin "${identity.username}": `));
const admin = new MindooDBServerAdmin({
  serverUrl: options.url.replace(/\/+$/, ""),
  systemAdminUser: identity,
  systemAdminPassword: password,
  cryptoAdapter: new NodeCryptoAdapter(),
});

try {
  if (command === "get") {
    print(JSON.stringify(await admin.getConfig(), null, 2));
  } else if (command === "backups") {
    print(JSON.stringify(await admin.listConfigBackups(), null, 2));
  } else {
    const config = JSON.parse(readFileSync(file, "utf-8"));
    const result = await admin.updateConfig(config);
    print(result.success ? "Config replaced." : `Not replaced: ${result.message ?? "unknown reason"}`);
    if (result.backupFile) print(`Previous config kept as ${result.backupFile}`);
    if (!result.success) process.exitCode = 1;
  }
} catch (error) {
  // A wrong password surfaces as a failed decryption of the identity.
  if (error?.name === "OperationError") {
    console.error("Could not decrypt the admin identity: wrong password?");
  } else {
    console.error(error?.message ?? error);
  }
  process.exitCode = 1;
}
