/**
 * Full HTTP integration test for server-side document-history purge execution
 * (docs/accesscontrol.md §13).
 *
 * Exercises the real client <-> server path end-to-end over HTTP:
 *  1. A tenant is created locally and published to an isolated server (which
 *     therefore holds the tenant's real `$publicinfos` key and an unlocked
 *     server identity — the precondition for server-side purge execution).
 *  2. A document is created in `main` and pushed to the server.
 *  3. The admin publishes an admin-signed purge request into the directory and
 *     pushes the directory; the server's `handlePutEntries` fires
 *     `executePendingPurges`, which physically removes the document history.
 *  4. The purged document's entries disappear from the server's `main` store.
 *  5. A re-push of the same document is rejected (the purged-doc registry guards
 *     against a stale client resurrecting the data).
 */
import fs from "fs";
import { Server } from "http";

import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { MindooDBServer } from "../node/server/MindooDBServer";
import type { ContentAddressedStore, StoreEntryMetadata } from "../core/types";
import type { ServerConfig } from "../node/server/types";

async function startServer(
  server: MindooDBServer,
): Promise<{ httpServer: Server; baseUrl: string }> {
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

/** Poll until `predicate` is true or the deadline passes. */
async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs = 15000, intervalMs = 250 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function entriesForDoc(store: ContentAddressedStore, docId: string): Promise<StoreEntryMetadata[]> {
  const all = await store.findNewEntries([]);
  return all.filter((entry) => entry.docId === docId);
}

describe("server-side document-history purge (HTTP)", () => {
  let httpServer: Server;
  let baseUrl: string;
  let dataDir: string;
  let server: MindooDBServer;
  let systemAdmin: Awaited<ReturnType<BaseMindooTenantFactory["createUserId"]>>;
  const serverPassword = "server-pass";

  beforeAll(async () => {
    const cryptoAdapter = new NodeCryptoAdapter();
    const factory = new BaseMindooTenantFactory(
      new InMemoryContentAddressedStoreFactory(),
      cryptoAdapter,
    );

    dataDir = `/tmp/mindoodb-purge-server-${Date.now()}`;
    fs.mkdirSync(dataDir, { recursive: true });

    const serverIdentity = await factory.createUserId("CN=purge-test-server", serverPassword);
    fs.writeFileSync(`${dataDir}/server.identity.json`, JSON.stringify(serverIdentity, null, 2), "utf-8");
    fs.writeFileSync(`${dataDir}/trusted-servers.json`, "[]", "utf-8");

    // The system admin authorizes tenant registration via /system/*.
    systemAdmin = await factory.createUserId("cn=purge-sysadmin/o=test", "sysadmin-pass");
    const config: ServerConfig = {
      capabilities: {
        "ALL:/system/*": [
          {
            username: systemAdmin.username,
            publicsignkey: systemAdmin.userSigningKeyPair.publicKey as string,
          },
        ],
      },
    };

    server = new MindooDBServer(dataDir, serverPassword, undefined, config);
    ({ httpServer, baseUrl } = await startServer(server));
  }, 60000);

  afterAll(async () => {
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    if (dataDir && fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("purges document history server-side and rejects re-pushes", async () => {
    const cryptoAdapter = new NodeCryptoAdapter();
    const localFactory = new BaseMindooTenantFactory(
      new InMemoryContentAddressedStoreFactory(),
      cryptoAdapter,
    );

    const tenantId = `purge-${Date.now()}`;
    const adminPassword = "admin-pass";
    const result = await localFactory.createTenant({
      tenantId,
      adminName: `cn=admin/o=${tenantId}`,
      adminPassword,
      userName: `cn=user1/o=${tenantId}`,
      userPassword: "user-pass",
    });

    // Publish the tenant: the server receives the real $publicinfos key, which
    // (with the unlocked server identity) lets it build a real directory and run
    // purge execution.
    await result.tenant.publishToServer(baseUrl, {
      systemAdminUser: systemAdmin,
      systemAdminPassword: "sysadmin-pass",
      adminUsername: result.adminUser.username,
    });

    // Bootstrap the directory grants with a one-shot admin override.
    const directoryDb = await result.tenant.openDB("directory");
    const remoteDirectory = await result.tenant.connectToServer(baseUrl, "directory");
    await expect(
      directoryDb.pushChangesTo(remoteDirectory, {
        networkAuthOverride: { user: result.adminUser, password: adminPassword },
      }),
    ).resolves.toMatchObject({ cancelled: false });

    // Create a document in `main` and push it to the server.
    const mainDb = await result.tenant.openDB("main");
    const remoteMain = await result.tenant.connectToServer(baseUrl, "main");
    const doc = await mainDb.createDocument();
    await mainDb.changeDoc(doc, (d) => {
      d.getData().title = "to-be-purged";
    });
    await expect(mainDb.pushChangesTo(remoteMain)).resolves.toMatchObject({ cancelled: false });

    // Identify the docId from the local store (single doc in `main`).
    const localMeta = await mainDb.getStore().findNewEntries([]);
    expect(localMeta.length).toBeGreaterThan(0);
    const docId = localMeta[0].docId;
    expect(typeof docId).toBe("string");

    // The server's main store now holds the document's entries.
    expect((await entriesForDoc(remoteMain, docId!)).length).toBeGreaterThan(0);

    // Admin publishes an admin-signed purge request and pushes the directory.
    const directory = await result.tenant.openDirectory();
    expect(typeof directory.publishDocHistoryPurge).toBe("function");
    await directory.publishDocHistoryPurge!(
      {
        v: 1,
        tenantId,
        requestId: `req-${Date.now()}`,
        dbId: "main",
        docIds: [docId!],
        reason: "GDPR erasure",
        preparedByPublicKey: "",
      },
      result.adminUser.userSigningKeyPair.privateKey,
      adminPassword,
    );
    await expect(
      directoryDb.pushChangesTo(remoteDirectory, {
        networkAuthOverride: { user: result.adminUser, password: adminPassword },
      }),
    ).resolves.toMatchObject({ cancelled: false });

    // Server-side purge runs fire-and-forget after the directory push; poll
    // until the document's entries are gone from the server's main store.
    const purged = await waitFor(async () => (await entriesForDoc(remoteMain, docId!)).length === 0);
    expect(purged).toBe(true);

    // A re-push of the now-purged document is rejected by the purged-doc
    // registry (the local client still holds the entries).
    await expect(mainDb.pushChangesTo(remoteMain)).rejects.toThrow(
      /purged document|access[_ ]denied/i,
    );
  }, 120000);
});
