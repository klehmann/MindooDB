/**
 * HTTP end-to-end: Device 1 founds a tenant, Device 2 joins as a second
 * device of the same person, Device 1 approves the User-Key wrap and pushes
 * `userdirectory` to a local MindooDBServer, Device 2 discovers the tenant
 * and imports `default` from the ACL key-distribution document.
 *
 * Regression: the server wraps the real directory in CompositeMindooDirectory
 * and used to skip `resolveUsernameHashForSigningKey`, so the wrap push was
 * denied as "signer is not a granted device".
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
import type { ServerConfig } from "../node/server/types";

const DEVICE1_PASSWORD = "device1-pass";
const DEVICE2_PASSWORD = "device2-pass";
const SYSTEM_ADMIN_PASSWORD = "sysadmin-pass";
const SERVER_PASSWORD = "server-join-pass";

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

describe("second device join over local HTTP server", () => {
  jest.setTimeout(240000);

  test("Device 2 joins as Device 1's second device, then discovers and unwraps default", async () => {
    const cryptoAdapter = new NodeCryptoAdapter();
    const dataDir = `/tmp/mindoodb-join-second-device-${Date.now()}`;
    fs.mkdirSync(dataDir, { recursive: true });

    const bootstrapFactory = new BaseMindooTenantFactory(
      new IsolatedInMemoryStoreFactory(),
      cryptoAdapter,
    );
    const serverIdentity = await bootstrapFactory.createUserId(
      "CN=join-second-server",
      SERVER_PASSWORD,
    );
    fs.writeFileSync(
      `${dataDir}/server.identity.json`,
      JSON.stringify(serverIdentity, null, 2),
      "utf-8",
    );
    fs.writeFileSync(`${dataDir}/trusted-servers.json`, "[]", "utf-8");

    const systemAdmin = await bootstrapFactory.createUserId(
      "cn=sysadmin/o=join-second",
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
      const tenantId = `join2-${Date.now().toString(16)}`;
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

      const directory = await device1Tenant.openDirectory();
      await directory.autoDistributeKeysToUser!(
        device1User.username,
        [DEFAULT_TENANT_KEY_ID],
        adminUser.userSigningKeyPair.privateKey,
        DEVICE1_PASSWORD,
      );

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

      const device2Factory = new BaseMindooTenantFactory(
        new IsolatedInMemoryStoreFactory(),
        cryptoAdapter,
      );
      const device2User = await device2Factory.createUserId("", DEVICE2_PASSWORD);
      await device2Factory.ensureUserKeyPair(device2User, DEVICE2_PASSWORD);
      const joinRequest = device2Factory.createJoinRequest(device2User, { label: "Edge2" });
      expect(joinRequest.v).toBe(2);
      expect(joinRequest.username).toBeUndefined();

      const joinResponse = await device1Tenant.approveJoinRequest(joinRequest, {
        adminSigningKey: adminUser.userSigningKeyPair.privateKey,
        adminPassword: DEVICE1_PASSWORD,
        username: device1User.username,
        label: "Edge2",
        serverUrl: baseUrl,
      });
      expect(joinResponse.username).toBe(device1User.username);
      expect(joinResponse.encryptedDocKeys.some((entry) => entry.keyId === PUBLIC_INFOS_KEY_ID)).toBe(
        true,
      );

      await pushDb(device1Tenant, baseUrl, "directory", adminAuth);

      device1Tenant.noteUserDirectoryFetched!();
      await device1Tenant.reconcileUserKeys!();
      const pending = await device1Tenant.listPendingUserKeyDevices!();
      expect(pending).toHaveLength(1);
      expect(pending[0].label).toBe("Edge2");

      const deliveries = await device2Factory.discoverTenantsOnServer(baseUrl, {
        user: device2User,
        password: DEVICE2_PASSWORD,
      });
      expect(deliveries.map((d) => d.tenantId)).toContain(tenantId);
      const delivery = deliveries.find((d) => d.tenantId === tenantId)!;
      expect(delivery.wrappedPublicInfosKey).toBeTruthy();
      expect(delivery.wrappedJoinResponse).toBeTruthy();

      const joined = await device2Factory.bootstrapTenantFromDelivery(delivery, {
        user: device2User,
        password: DEVICE2_PASSWORD,
        serverUrl: baseUrl,
      });
      expect(joined.user.username).toBe(device1User.username);
      expect(await joined.keyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID)).toBeTruthy();
      expect(await joined.tenant.hasDecryptionKey!(DEFAULT_TENANT_KEY_ID)).toBe(false);

      await device1Tenant.approveUserKeyDevice!(pending[0].fingerprint);
      await pushDb(device1Tenant, baseUrl, USER_DIRECTORY_DB_ID);

      await pullDb(joined.tenant, baseUrl, USER_DIRECTORY_DB_ID);

      joined.tenant.noteUserDirectoryFetched!();
      const enrollment = await joined.tenant.reconcileUserKeys!();
      expect(enrollment.state).toBe("approved");

      const imported = await joined.tenant.reconcileKeyDistributionsForCurrentUser!();
      expect(imported.imported).toContain(DEFAULT_TENANT_KEY_ID);
      expect(await joined.tenant.hasDecryptionKey!(DEFAULT_TENANT_KEY_ID)).toBe(true);

      await pullDb(joined.tenant, baseUrl, "main");
      const device2Main = await joined.tenant.openDB("main");
      const remoteDoc = await device2Main.getDocument(seedDocId);
      expect(remoteDoc.getData().title).toBe("from-device-1");
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
