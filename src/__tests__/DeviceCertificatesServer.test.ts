/**
 * HTTP end-to-end for device certificates (docs/userkeys.md §9.6): Device 1
 * certifies Device 2 with the person's self-grant key instead of a join
 * request. Device 2 discovers the tenant, syncs, reads and writes through the
 * server, which knows Device 2 only from the certificate.
 */
import fs from "fs";
import { Server } from "http";

import { IsolatedInMemoryStoreFactory } from "./_helpers/multiDevice";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { MindooDBServer } from "../node/server/MindooDBServer";
import {
  DEFAULT_TENANT_KEY_ID,
  PUBLIC_INFOS_KEY_ID,
  USER_DIRECTORY_DB_ID,
  type MindooTenant,
  type PrivateUserId,
} from "../core/types";
import type { ServerConfig } from "../server/types";
import type { BaseMindooTenantDirectory } from "../core/BaseMindooTenantDirectory";

const DEVICE1_PASSWORD = "device1-pass";
const DEVICE2_PASSWORD = "device2-pass";
const SYSTEM_ADMIN_PASSWORD = "sysadmin-pass";
const SERVER_PASSWORD = "server-dcert-pass";

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

async function pushDb(
  tenant: MindooTenant,
  baseUrl: string,
  dbId: string,
  auth?: { user: PrivateUserId; password: string },
): Promise<void> {
  const local = await tenant.openDB(
    dbId,
    dbId === "directory" ? { adminOnlyDb: true } : undefined,
  );
  const remote = await tenant.connectToServer(baseUrl, dbId);
  const result = await local.pushChangesTo(
    remote,
    auth ? { networkAuthOverride: auth } : undefined,
  );
  expect(result.cancelled).toBe(false);
}

async function pullDb(tenant: MindooTenant, baseUrl: string, dbId: string): Promise<void> {
  const local = await tenant.openDB(
    dbId,
    dbId === "directory" ? { adminOnlyDb: true } : undefined,
  );
  const remote = await tenant.connectToServer(baseUrl, dbId);
  await local.pullChangesFrom(remote);
  await local.syncStoreChanges();
}

describe("certified device over local HTTP server", () => {
  jest.setTimeout(240000);

  test("Device 2, certified by Device 1, discovers the tenant, reads and writes", async () => {
    const cryptoAdapter = new NodeCryptoAdapter();
    const dataDir = `/tmp/mindoodb-dcert-server-${Date.now()}`;
    fs.mkdirSync(dataDir, { recursive: true });

    const bootstrapFactory = new BaseMindooTenantFactory(
      new IsolatedInMemoryStoreFactory(),
      cryptoAdapter,
    );
    const serverIdentity = await bootstrapFactory.createUserId(
      "CN=dcert-server",
      SERVER_PASSWORD,
    );
    fs.writeFileSync(
      `${dataDir}/server.identity.json`,
      JSON.stringify(serverIdentity, null, 2),
      "utf-8",
    );
    fs.writeFileSync(`${dataDir}/trusted-servers.json`, "[]", "utf-8");

    const systemAdmin = await bootstrapFactory.createUserId(
      "cn=sysadmin/o=dcert-server",
      SYSTEM_ADMIN_PASSWORD,
    );
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

    const server = new MindooDBServer(dataDir, SERVER_PASSWORD, undefined, config);
    const { httpServer, baseUrl } = await startServer(server);

    try {
      const tenantId = `dcert-${Date.now().toString(16)}`;
      const device1Name = `cn=karsten/o=${tenantId}`;
      const adminName = `cn=admin/o=${tenantId}`;

      const device1Factory = new BaseMindooTenantFactory(
        new IsolatedInMemoryStoreFactory(),
        cryptoAdapter,
      );
      // Same as Haven: the founding device holds a distinct admin identity
      // plus the first app user. `openTenant` refuses to use the admin as
      // currentUser, so Device 1 operates as karsten and only uses the admin
      // key for privileged directory writes / join approval.
      const adminUser = await device1Factory.createUserId(adminName, DEVICE1_PASSWORD);
      const device1User = await device1Factory.createUserId(device1Name, DEVICE1_PASSWORD);
      await device1Factory.ensureUserKeyPair(device1User, DEVICE1_PASSWORD);

      const created = await device1Factory.createTenant({
        tenantId,
        adminUser,
        adminPassword: DEVICE1_PASSWORD,
        appUser: device1User,
        userPassword: DEVICE1_PASSWORD,
      });
      const device1Tenant = created.tenant;

      device1Tenant.noteUserDirectoryFetched!();
      const minted = await device1Tenant.reconcileUserKeys!({ allowSelfCreate: true });
      expect(minted.state).toBe("approved");

      const mainDb = await device1Tenant.openDB("main");
      const seedDoc = await mainDb.createDocument();
      const seedDocId = seedDoc.getId();
      await mainDb.changeDoc(seedDoc, (d) => {
        d.getData().title = "from-device-1";
      });

      await device1Tenant.publishToServer(baseUrl, {
        systemAdminUser: systemAdmin,
        systemAdminPassword: SYSTEM_ADMIN_PASSWORD,
        adminUsername: adminUser.username,
      });

      const adminAuth = { user: adminUser, password: DEVICE1_PASSWORD };
      await pushDb(device1Tenant, baseUrl, "directory", adminAuth);
      await pushDb(device1Tenant, baseUrl, USER_DIRECTORY_DB_ID);
      await pushDb(device1Tenant, baseUrl, "main");

      // The admin lets this person vouch for their own devices.
      const directory = (await device1Tenant.openDirectory()) as BaseMindooTenantDirectory;
      await directory.setDeviceSelfGrant(
        device1User.username,
        await device1Tenant.getDeviceSelfGrantPublicKey!(),
        adminUser.userSigningKeyPair.privateKey,
        DEVICE1_PASSWORD,
      );

      // Device 2: its own keys, no join request, nothing on the grant.
      const device2Factory = new BaseMindooTenantFactory(
        new IsolatedInMemoryStoreFactory(),
        cryptoAdapter,
      );
      const device2User = await device2Factory.createUserId(device1User.username, DEVICE2_PASSWORD);
      await device1Tenant.issueDeviceCertificate!(
        {
          signingPublicKey: device2User.userSigningKeyPair.publicKey,
          encryptionPublicKey: device2User.userEncryptionKeyPair.publicKey,
        },
        "Tablet",
      );
      await pushDb(device1Tenant, baseUrl, "directory", adminAuth);
      await pushDb(device1Tenant, baseUrl, USER_DIRECTORY_DB_ID);

      const deliveries = await device2Factory.discoverTenantsOnServer(baseUrl, {
        user: device2User,
        password: DEVICE2_PASSWORD,
      });
      expect(deliveries.map((d) => d.tenantId)).toContain(tenantId);
      const delivery = deliveries.find((d) => d.tenantId === tenantId)!;
      expect(delivery.wrappedPublicInfosKey).toBeTruthy();

      const joined = await device2Factory.bootstrapTenantFromDelivery(delivery, {
        user: device2User,
        password: DEVICE2_PASSWORD,
        serverUrl: baseUrl,
      });
      expect(await joined.keyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID)).toBeTruthy();
      await pullDb(joined.tenant, baseUrl, "directory");
      await pullDb(joined.tenant, baseUrl, USER_DIRECTORY_DB_ID);
      joined.tenant.noteUserDirectoryFetched!();
      await joined.tenant.reconcileUserKeys!();
      await joined.tenant.reconcileKeyDistributionsForCurrentUser!();
      expect(await joined.tenant.hasDecryptionKey!(DEFAULT_TENANT_KEY_ID)).toBe(true);

      await pullDb(joined.tenant, baseUrl, "main");
      const device2Main = await joined.tenant.openDB("main");
      expect((await device2Main.getDocument(seedDocId)).getData().title).toBe("from-device-1");

      // Device 2 writes; the server accepts the push and Device 1 reads it.
      const written = await device2Main.createDocument({ initialValues: { title: "from-device-2" } });
      await pushDb(joined.tenant, baseUrl, "main");
      await pullDb(device1Tenant, baseUrl, "main");
      const device1Main = await device1Tenant.openDB("main");
      expect((await device1Main.getDocument(written.getId())).getData().title).toBe("from-device-2");
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
