/**
 * HTTP end-to-end: a long-running client keeps syncing after its token expired.
 *
 * Haven opens many network stores for the same user and server (every database,
 * docs and attachments), and they share one sign-in: the first store
 * authenticates, the others join that in-flight authentication. A store that
 * joined kept the settled promise, so once the token expired (an hour later, or
 * after the computer slept) it was handed the expired token again, also on the
 * retry after the server's 401 — the sync failed with "Invalid or expired token".
 */
import fs from "fs";
import { Server } from "http";

import { IsolatedInMemoryStoreFactory } from "./_helpers/multiDevice";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { MindooDBServer } from "../node/server/MindooDBServer";
import { USER_DIRECTORY_DB_ID, type MindooTenant } from "../core/types";
import type { ServerConfig } from "../server/types";

const PASSWORD = "pw";
const SERVER_PASSWORD = "server-pw";
const DEMO_CONFIG: ServerConfig = {
  capabilities: { "POST:/system/tenants/*": [{ username: "*", publicsignkey: "*" }] },
};

async function startServer(dataDir: string): Promise<{ httpServer: Server; baseUrl: string }> {
  fs.mkdirSync(dataDir, { recursive: true });
  const factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), new NodeCryptoAdapter());
  const serverIdentity = await factory.createUserId("CN=token-expiry-server", SERVER_PASSWORD);
  fs.writeFileSync(`${dataDir}/server.identity.json`, JSON.stringify(serverIdentity), "utf-8");
  fs.writeFileSync(`${dataDir}/trusted-servers.json`, "[]", "utf-8");
  const server = new MindooDBServer(dataDir, SERVER_PASSWORD, undefined, DEMO_CONFIG);
  return new Promise((resolve, reject) => {
    const httpServer = server.getApp().listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve({ httpServer, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

describe("token expiry over HTTP", () => {
  jest.setTimeout(120000);

  test("stores that shared one sign-in sign in again after the token expired", async () => {
    const dataDir = `/tmp/mindoodb-token-expiry-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const { httpServer, baseUrl } = await startServer(dataDir);
    try {
      const tenantId = `exp-${Date.now().toString(16)}`;
      const factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), new NodeCryptoAdapter());
      const admin = await factory.createUserId(`cn=admin/o=${tenantId}`, PASSWORD);
      const user = await factory.createUserId(`cn=karsten/o=${tenantId}`, PASSWORD);
      await factory.ensureUserKeyPair(user, PASSWORD);
      const { tenant } = await factory.createTenant({
        tenantId,
        adminUser: admin,
        adminPassword: PASSWORD,
        appUser: user,
        userPassword: PASSWORD,
      });
      tenant.noteUserDirectoryFetched!();
      await tenant.reconcileUserKeys!({ allowSelfCreate: true });
      await tenant.publishToServer(baseUrl, {
        systemAdminUser: admin,
        systemAdminPassword: PASSWORD,
        adminUsername: admin.username,
      });
      const directory = await tenant.openDB("directory", { adminOnlyDb: true });
      await directory.pushChangesTo(await tenant.connectToServer(baseUrl, "directory"), {
        networkAuthOverride: { user: admin, password: PASSWORD },
      });

      const notes = await tenant.openDB("notes");
      const doc = await notes.createDocument();
      await notes.changeDoc(doc, (d) => {
        d.getData().title = "before";
      });
      const userDirectory = await tenant.openDB(USER_DIRECTORY_DB_ID);

      const sync = async (t: MindooTenant) => {
        // Both databases at once: one store authenticates, the other joins it.
        await Promise.all([
          userDirectory.pushChangesTo(await t.connectToServer(baseUrl, USER_DIRECTORY_DB_ID)),
          notes.pushChangesTo(await t.connectToServer(baseUrl, "notes")),
        ]);
      };
      await sync(tenant);

      // Two hours later (the app stayed open, or the computer slept): the token
      // has expired for client and server alike.
      const realNow = Date.now.bind(Date);
      const offset = 2 * 60 * 60 * 1000;
      const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
      try {
        await notes.changeDoc(doc, (d) => {
          d.getData().title = "after";
        });
        await sync(tenant);
        await notes.pullChangesFrom(await tenant.connectToServer(baseUrl, "notes"));
      } finally {
        nowSpy.mockRestore();
      }
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
