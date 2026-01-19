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
 *   -h, --help              Show this help message
 * 
 * Environment variables:
 *   MINDOODB_SERVER_KEY_PASSWORD   Password to decrypt server private keys
 *   MINDOODB_ADMIN_API_KEY         API key to protect admin endpoints (optional)
 */

import { MindooDBServer } from "./MindooDBServer";
import { ServerSync, startPeriodicSync } from "./ServerSync";
import { ENV_VARS } from "./types";

interface CliOptions {
  dataDir: string;
  port: number;
  autoSync: boolean;
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
  -h, --help              Show this help message

Environment variables:
  MINDOODB_SERVER_KEY_PASSWORD   Password to decrypt server private keys
                                 (required if server-keys.json exists)
  MINDOODB_ADMIN_API_KEY         API key to protect admin endpoints (optional)
                                 If not set, admin endpoints are open

Examples:
  # Start server with default settings
  npx ts-node src/index.ts

  # Start server with custom data directory and port
  npx ts-node src/index.ts -d /var/lib/mindoodb -p 8080

  # Start server with auto-sync enabled
  MINDOODB_SERVER_KEY_PASSWORD=secret npx ts-node src/index.ts -s

  # Start server with API key protection
  MINDOODB_ADMIN_API_KEY=my-secret-key npx ts-node src/index.ts
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
  
  // Check environment variables
  const serverKeyPassword = process.env[ENV_VARS.SERVER_KEY_PASSWORD];
  const adminApiKey = process.env[ENV_VARS.ADMIN_API_KEY];
  
  console.log(`Admin API key: ${adminApiKey ? "configured" : "not set (endpoints open)"}`);
  console.log(`Server key password: ${serverKeyPassword ? "configured" : "not set"}`);
  console.log("=".repeat(60));

  // Create and start the server
  const server = new MindooDBServer(options.dataDir);
  
  // If auto-sync is enabled and we have server keys, start periodic sync
  if (options.autoSync) {
    if (!serverKeyPassword) {
      console.warn(
        "[Main] Auto-sync enabled but MINDOODB_SERVER_KEY_PASSWORD not set. " +
        "Server-to-server sync will not work."
      );
    } else {
      // Start auto-sync for each tenant that has remote servers configured
      const tenantManager = server.getTenantManager();
      const tenants = tenantManager.listTenants();
      
      for (const tenantId of tenants) {
        try {
          const tenant = tenantManager.getTenant(tenantId);
          const config = tenant.context.config;
          const serverKeys = tenant.context.serverKeys;
          
          if (config.remoteServers && config.remoteServers.length > 0 && serverKeys) {
            const serverSync = new ServerSync(
              tenantManager.getCryptoAdapter(),
              tenantId,
              serverKeys,
              serverKeyPassword,
              (dbId) => tenantManager.getStore(tenantId, dbId)
            );
            
            const stopSync = startPeriodicSync(serverSync, config.remoteServers);
            
            // Handle graceful shutdown
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
  server.listen(options.port);
}

// Run main
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
