#!/usr/bin/env node
/**
 * One-time setup of a MindooDB server on Cloudflare.
 *
 * Creates the server identity and a system administrator, then stores what
 * the Worker needs as secrets:
 *
 *   MINDOODB_SERVER_IDENTITY  server.identity.json (password-encrypted keys)
 *   MINDOODB_SERVER_PASSWORD  random password of that identity
 *   MINDOODB_JWT_SECRET       random key from which sync-token keys derive
 *   MINDOODB_SERVER_CONFIG    initial config.json (system admin capabilities)
 *
 * Usage:
 *   npm run setup                    # store secrets with `wrangler secret put`
 *   npm run setup -- --local         # write .dev.vars for `wrangler dev` instead
 *
 * Options:
 *   --name <name>              server name (default: CN=<worker name>)
 *   --admin <username>         system admin to create (default: cn=sysadmin)
 *   --admin-public <file>      use an existing identity (public part) as admin instead
 *   --out <dir>                where to write the admin identity (default: .)
 *
 * The admin password is read from MINDOODB_ADMIN_PASSWORD or prompted for.
 *
 * Workers' WebCrypto allows at most 100 000 PBKDF2 iterations, so the server
 * identity is encrypted with that count (the Node server uses 310 000). The
 * admin identity never reaches the server and keeps the default.
 */

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

const { BaseMindooTenantFactory, InMemoryContentAddressedStoreFactory, NodeCryptoAdapter } = await import("mindoodb");

function parseArgs(argv) {
  const options = { local: false, admin: "cn=sysadmin", out: "." };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--local") options.local = true;
    else if (arg === "--name") options.name = next();
    else if (arg === "--admin") options.admin = next();
    else if (arg === "--admin-public") options.adminPublic = next();
    else if (arg === "--out") options.out = next();
    else throw new Error(`Unknown option ${arg}`);
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

function workerName() {
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf-8");
  return /"name"\s*:\s*"([^"]+)"/.exec(config)?.[1] ?? "mindoodb-server";
}

function putSecret(name, value) {
  const result = spawnSync("npx", ["wrangler", "secret", "put", name], {
    input: value,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) {
    throw new Error(`wrangler secret put ${name} failed`);
  }
}

const options = parseArgs(process.argv.slice(2));
const factory = new BaseMindooTenantFactory(
  new InMemoryContentAddressedStoreFactory(),
  new NodeCryptoAdapter(),
);

const serverName = options.name ?? `CN=${workerName()}`;
const serverPassword = randomBytes(32).toString("base64url");
console.log(`Creating server identity "${serverName}" ...`);
// Only the server identity is decrypted inside the Worker; the admin keeps
// the client default.
process.env.MINDOODB_PBKDF2_ITERATIONS = "100000";
const serverIdentity = await factory.createUserId(serverName, serverPassword);
delete process.env.MINDOODB_PBKDF2_ITERATIONS;

let admin;
if (options.adminPublic) {
  const identity = JSON.parse(readFileSync(options.adminPublic, "utf-8"));
  admin = { username: identity.username, publicsignkey: identity.userSigningKeyPair.publicKey };
} else {
  const password =
    process.env.MINDOODB_ADMIN_PASSWORD ?? (await promptHidden(`Password for system admin "${options.admin}": `));
  if (!password) throw new Error("A system admin password is required");
  console.log(`Creating system admin "${options.admin}" ...`);
  const identity = await factory.createUserId(options.admin, password);
  const file = join(
    options.out,
    `system-admin-${options.admin.replace(/[^a-zA-Z0-9_=-]/g, "-").replace(/-+/g, "-").toLowerCase()}.identity.json`,
  );
  if (existsSync(file)) throw new Error(`${file} exists; choose another --admin or --out`);
  writeFileSync(file, JSON.stringify(identity, null, 2), "utf-8");
  console.log(`System admin identity written to ${file} (keep it; the server never sees the private key)`);
  admin = { username: options.admin, publicsignkey: identity.userSigningKeyPair.publicKey };
}

const secrets = {
  MINDOODB_SERVER_IDENTITY: JSON.stringify(serverIdentity),
  MINDOODB_SERVER_PASSWORD: serverPassword,
  MINDOODB_JWT_SECRET: randomBytes(32).toString("base64"),
  MINDOODB_SERVER_CONFIG: JSON.stringify({ capabilities: { "ALL:/system/*": [admin] } }),
};

if (options.local) {
  // Single-quoted dotenv values are taken literally (the JSON keeps its quotes).
  const lines = Object.entries(secrets).map(([name, value]) => `${name}='${value}'`);
  writeFileSync(new URL("../.dev.vars", import.meta.url), `${lines.join("\n")}\n`, "utf-8");
  console.log("Wrote .dev.vars for `wrangler dev`.");
} else {
  for (const [name, value] of Object.entries(secrets)) putSecret(name, value);
  console.log("Secrets stored. Deploy with `npm run deploy`.");
}
