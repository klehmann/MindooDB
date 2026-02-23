#!/usr/bin/env node
/**
 * MindooDB Example Server - Entry Point
 *
 * Usage:
 *   npx ts-node src/index.ts [options]
 *   node dist/index.js [options]
 *
 * Options:
 *   -d, --data-dir <path>   Data directory path (default: ./data)
 *   -p, --port <port>       Server port (default: 3000)
 *   -s, --auto-sync         Enable automatic sync with remote servers
 *   -w, --static-dir <path> Serve static files from this directory at /statics/
 *   --tls-cert <path>       Path to TLS certificate file (PEM)
 *   --tls-key <path>        Path to TLS private key file (PEM)
 *   -h, --help              Show this help message
 *
 * Environment variables:
 *   MINDOODB_SERVER_PASSWORD   Password to decrypt server identity private keys
 *   MINDOODB_ADMIN_API_KEY     API key to protect admin endpoints (optional)
 */

import { MindooDBServer } from "./MindooDBServer";
import { ServerSync, startPeriodicSync } from "./ServerSync";
import { ENV_VARS } from "./types";

interface CliOptions {
  dataDir: string;
  port: number;
  autoSync: boolean;
  tlsCert?: string;
  tlsKey?: string;
  staticDir?: string;
  help: boolean;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    dataDir: "./data",
    port: 3000,
    autoSync: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case "-d":
      case "--data-dir":
        if (nextArg) {
          options.dataDir = nextArg;
          i++;
        }
        break;

      case "-p":
      case "--port":
        if (nextArg) {
          const port = parseInt(nextArg, 10);
          if (!isNaN(port) && port > 0 && port < 65536) {
            options.port = port;
          } else {
            console.error(`Invalid port: ${nextArg}`);
            process.exit(1);
          }
          i++;
        }
        break;

      case "-s":
      case "--auto-sync":
        options.autoSync = true;
        break;

      case "--tls-cert":
        if (nextArg) {
          options.tlsCert = nextArg;
          i++;
        }
        break;

      case "--tls-key":
        if (nextArg) {
          options.tlsKey = nextArg;
          i++;
        }
        break;

      case "-w":
      case "--static-dir":
        if (nextArg) {
          options.staticDir = nextArg;
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
MindooDB Example Server

Usage:
  npx ts-node src/index.ts [options]
  node dist/index.js [options]

Options:
  -d, --data-dir <path>   Data directory path (default: ./data)
  -p, --port <port>       Server port (default: 3000)
  -s, --auto-sync         Enable automatic sync with remote servers
  -w, --static-dir <path> Serve static files at /statics/ (e.g. bootstrap UI)
  --tls-cert <path>       Path to TLS certificate file (PEM format)
  --tls-key <path>        Path to TLS private key file (PEM format)
  -h, --help              Show this help message

Environment variables:
  MINDOODB_SERVER_PASSWORD     Password to decrypt server identity private keys
                               (required if server-identity.json exists)
  MINDOODB_ADMIN_API_KEY       API key to protect admin endpoints (optional)
                               If not set, admin endpoints are open
  MINDOODB_ADMIN_ALLOWED_IPS   Comma-separated IPs/CIDRs allowed to access admin
                               endpoints (default: localhost only). Set to "*" to
                               allow all IPs. Example: "10.0.0.0/8,192.168.1.5"

Examples:
  # Start server with default settings
  npx ts-node src/index.ts

  # Start server with custom data directory and port
  npx ts-node src/index.ts -d /var/lib/mindoodb -p 8080

  # Start server with auto-sync enabled
  MINDOODB_SERVER_PASSWORD=secret npx ts-node src/index.ts -s

  # Start server with API key protection
  MINDOODB_ADMIN_API_KEY=my-secret-key npx ts-node src/index.ts

  # Start server with static files (e.g. bootstrap UI for distributed web apps)
  npx ts-node src/index.ts -w ./webapp-bootstrap

  # Start server with TLS (HTTPS)
  npx ts-node src/index.ts --tls-cert /path/to/fullchain.pem --tls-key /path/to/privkey.pem -p 443
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  console.log("=".repeat(60));
  console.log("MindooDB Example Server");
  console.log("=".repeat(60));
  console.log(`Data directory: ${options.dataDir}`);
  console.log(`Port: ${options.port}`);
  console.log(`Auto-sync: ${options.autoSync ? "enabled" : "disabled"}`);
  console.log(`Static dir: ${options.staticDir || "not set"}`);
  console.log(`TLS: ${options.tlsCert ? "enabled" : "disabled"}`);

  if ((options.tlsCert && !options.tlsKey) || (!options.tlsCert && options.tlsKey)) {
    console.error("Error: --tls-cert and --tls-key must both be provided");
    process.exit(1);
  }

  const serverPassword = process.env[ENV_VARS.SERVER_PASSWORD];
  const adminApiKey = process.env[ENV_VARS.ADMIN_API_KEY];

  console.log(`Admin API key: ${adminApiKey ? "configured" : "not set (endpoints open)"}`);
  console.log(`Admin IP allowlist: ${process.env.MINDOODB_ADMIN_ALLOWED_IPS || "localhost only (default)"}`);
  console.log(`Server password: ${serverPassword ? "configured" : "not set"}`);
  console.log("=".repeat(60));

  // Create and start the server
  const server = new MindooDBServer(options.dataDir, serverPassword, options.staticDir);

  // If auto-sync is enabled and we have server identity, start periodic sync
  if (options.autoSync) {
    const tenantManager = server.getTenantManager();
    const serverIdentity = tenantManager.getServerIdentity();

    if (!serverIdentity) {
      console.warn(
        "[Main] Auto-sync enabled but no server-identity.json found. " +
        "Run 'npm run init' to create a server identity.",
      );
    } else if (!serverPassword) {
      console.warn(
        "[Main] Auto-sync enabled but MINDOODB_SERVER_PASSWORD not set. " +
        "Server-to-server sync will not work.",
      );
    } else {
      const tenants = tenantManager.listTenants();

      for (const tenantId of tenants) {
        try {
          const tenant = await tenantManager.getTenant(tenantId);
          const config = tenant.context.config;

          if (config.remoteServers && config.remoteServers.length > 0) {
            const serverSync = new ServerSync(
              tenantManager.getCryptoAdapter(),
              tenantId,
              serverIdentity,
              serverPassword,
              async (dbId) => tenantManager.getStore(tenantId, dbId),
            );

            const stopSync = startPeriodicSync(serverSync, config.remoteServers);

            process.on("SIGINT", () => {
              console.log("\n[Main] Shutting down...");
              stopSync();
              process.exit(0);
            });

            process.on("SIGTERM", () => {
              console.log("\n[Main] Shutting down...");
              stopSync();
              process.exit(0);
            });

            console.log(`[Main] Started auto-sync for tenant ${tenantId}`);
          }
        } catch (error) {
          console.error(`[Main] Error setting up auto-sync for tenant ${tenantId}:`, error);
        }
      }
    }
  }

  // Start listening
  if (options.tlsCert && options.tlsKey) {
    server.listenTls(options.port, options.tlsCert, options.tlsKey);
  } else {
    server.listen(options.port);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
