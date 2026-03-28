#!/usr/bin/env node
/**
 * MindooDB Add-to-Network CLI
 *
 * Automates adding a new server to an existing network of MindooDB servers
 * by exchanging trust (public keys) between all parties.
 *
 * Usage:
 *   npx ts-node src/add-to-network.ts [options]
 *
 * Options:
 *   --new-server <url>        URL of the server being added (required)
 *   --servers <url,url,...>    Comma-separated URLs of existing servers (required)
 *   --api-key <key>           Admin API key shared by all servers (required)
 *   -h, --help                Show this help message
 */

import http from "http";
import https from "https";
import { URL } from "url";

interface CliOptions {
  newServer: string;
  servers: string[];
  apiKey: string;
  help: boolean;
}

interface ServerInfo {
  name: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    newServer: "",
    servers: [],
    apiKey: "",
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case "--new-server":
        if (nextArg) { options.newServer = nextArg.replace(/\/+$/, ""); i++; }
        break;
      case "--servers":
        if (nextArg) {
          options.servers = nextArg.split(",").map((s) => s.trim().replace(/\/+$/, ""));
          i++;
        }
        break;
      case "--api-key":
        if (nextArg) { options.apiKey = nextArg; i++; }
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

Usage:
  npx ts-node src/add-to-network.ts [options]

Options:
  --new-server <url>        URL of the server being added (required)
  --servers <url,url,...>    Comma-separated URLs of existing servers (required)
  --api-key <key>           Admin API key shared by all servers (required)
  -h, --help                Show this help message

Example:
  npx ts-node src/add-to-network.ts \\
    --new-server https://server4.example.com \\
    --servers https://s1.example.com,https://s2.example.com,https://s3.example.com \\
    --api-key my-admin-key
`);
}

function httpRequest(
  url: string,
  method: "GET" | "POST",
  body?: object,
  apiKey?: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;

    const headers: Record<string, string> = {};
    if (apiKey) headers["X-API-Key"] = apiKey;
    if (body) headers["Content-Type"] = "application/json";

    const payload = body ? JSON.stringify(body) : undefined;
    if (payload) headers["Content-Length"] = Buffer.byteLength(payload).toString();

    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers,
        rejectUnauthorized: true,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode || 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode || 0, body: data });
          }
        });
      },
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function fetchServerInfo(serverUrl: string): Promise<ServerInfo> {
  const url = `${serverUrl}/.well-known/mindoodb-server-info`;
  console.log(`  Fetching server info from ${url}`);
  const response = await httpRequest(url, "GET");

  if (response.status !== 200) {
    throw new Error(
      `Failed to fetch server info from ${serverUrl}: HTTP ${response.status} — ${JSON.stringify(response.body)}`,
    );
  }

  const info = response.body as ServerInfo;
  if (!info.name || !info.signingPublicKey || !info.encryptionPublicKey) {
    throw new Error(`Invalid server info response from ${serverUrl}`);
  }

  return info;
}

async function addTrustedServer(
  targetUrl: string,
  serverInfo: ServerInfo,
  apiKey: string,
): Promise<void> {
  const url = `${targetUrl}/admin/trusted-servers`;
  const response = await httpRequest(url, "POST", serverInfo, apiKey);

  if (response.status === 201) {
    console.log(`  Added "${serverInfo.name}" to ${targetUrl}`);
  } else if (response.status === 409) {
    console.log(`  "${serverInfo.name}" already trusted on ${targetUrl} (skipped)`);
  } else {
    throw new Error(
      `Failed to add "${serverInfo.name}" to ${targetUrl}: HTTP ${response.status} — ${JSON.stringify(response.body)}`,
    );
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
  if (!options.apiKey) {
    console.error("Error: --api-key is required. Use --help for usage.");
    process.exit(1);
  }

  console.log("=".repeat(60));
  console.log("MindooDB Add-to-Network");
  console.log("=".repeat(60));
  console.log(`New server:      ${options.newServer}`);
  console.log(`Existing servers: ${options.servers.join(", ")}`);
  console.log("=".repeat(60));

  // Step 1: Fetch the new server's public info
  console.log("\n[1/3] Fetching new server identity...");
  const newServerInfo = await fetchServerInfo(options.newServer);
  console.log(`  Server name: ${newServerInfo.name}\n`);

  // Step 2: For each existing server, exchange trust
  console.log("[2/3] Exchanging trust with existing servers...");
  let successCount = 0;
  const errors: string[] = [];

  for (const existingUrl of options.servers) {
    try {
      console.log(`\n  --- ${existingUrl} ---`);

      // Fetch existing server's info
      const existingInfo = await fetchServerInfo(existingUrl);
      console.log(`  Server name: ${existingInfo.name}`);

      // Add new server to existing server
      await addTrustedServer(existingUrl, newServerInfo, options.apiKey);

      // Add existing server to new server
      await addTrustedServer(options.newServer, existingInfo, options.apiKey);

      successCount++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`  ERROR: ${msg}`);
      errors.push(`${existingUrl}: ${msg}`);
    }
  }

  // Step 3: Summary
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
  console.log("Next step: configure per-tenant sync via POST /admin/tenants/:tenantId/sync-servers");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
