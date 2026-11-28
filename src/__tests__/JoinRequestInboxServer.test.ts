/**
 * HTTP end-to-end for the invitation / join-request inbox on the Node server
 * (scenario in `_helpers/joinRequestInboxScenario.ts`; the Cloudflare host
 * runs the same scenario in `CloudflareJoinRequests.test.ts`).
 */
import fs from "fs";
import { Server } from "http";

import { IsolatedInMemoryStoreFactory } from "./_helpers/multiDevice";
import { runJoinRequestInboxScenario } from "./_helpers/joinRequestInboxScenario";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { MindooDBServer } from "../node/server/MindooDBServer";
import type { ServerConfig } from "../server/types";

const SYSTEM_ADMIN_PASSWORD = "sysadmin-pass";
const SERVER_PASSWORD = "server-inbox-pass";

async function startServer(server: MindooDBServer): Promise<{ httpServer: Server; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const httpServer = server.getApp().listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to determine test server port"));
        return;
      }
      resolve({ httpServer, baseUrl: `http://127.0.0.1:${address.port}` });
    });
    httpServer.on("error", reject);
  });
}

describe("join-request inbox over local HTTP server", () => {
  jest.setTimeout(300000);

  test("personal link: request, match, admit, discover, purge", async () => {
    const cryptoAdapter = new NodeCryptoAdapter();
    const dataDir = `/tmp/mindoodb-join-inbox-${Date.now()}`;
    fs.mkdirSync(dataDir, { recursive: true });

    const bootstrapFactory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), cryptoAdapter);
    const serverIdentity = await bootstrapFactory.createUserId("CN=join-inbox-server", SERVER_PASSWORD);
    fs.writeFileSync(`${dataDir}/server.identity.json`, JSON.stringify(serverIdentity, null, 2), "utf-8");
    fs.writeFileSync(`${dataDir}/trusted-servers.json`, "[]", "utf-8");
    const systemAdmin = await bootstrapFactory.createUserId("cn=sysadmin/o=join-inbox", SYSTEM_ADMIN_PASSWORD);
    const config: ServerConfig = {
      joinRequests: { maxRequestsPerIpPerHour: 6 },
      capabilities: {
        "ALL:/system/*": [
          { username: systemAdmin.username, publicsignkey: systemAdmin.userSigningKeyPair.publicKey as string },
        ],
      },
    };
    const server = new MindooDBServer(dataDir, SERVER_PASSWORD, undefined, config);
    const { httpServer, baseUrl } = await startServer(server);

    try {
      await runJoinRequestInboxScenario({ baseUrl, systemAdmin, systemAdminPassword: SYSTEM_ADMIN_PASSWORD });
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
