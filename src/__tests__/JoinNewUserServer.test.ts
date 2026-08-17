/**
 * HTTP end-to-end: Device 1 founds a tenant, a DIFFERENT person joins from
 * Device 2 (not a second device of the founder). The admin publishes that
 * person's User-Key document from the join request and wraps `default` to it;
 * Device 2 must then see its own `userkey_*` document and seal it with its own
 * device wrap — otherwise it reports "waiting" forever while still opening
 * `default` through the local-User-Key fallback.
 *
 * The existing coverage only exercised the second-device case over HTTP, so a
 * new person's User-Key document was never checked for arrival on the joining
 * device.
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
const SERVER_PASSWORD = "server-join-new-user-pass";

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

async function userKeyDocIds(tenant: MindooTenant): Promise<string[]> {
  const db = await tenant.openDB(USER_DIRECTORY_DB_ID);
  const ids = await db.getAllDocumentIds();
  return ids.filter((id) => id.startsWith("userkey_")).sort();
}

describe("new user join over local HTTP server", () => {
  jest.setTimeout(240000);

  test("the admin-published User-Key document reaches the joining person", async () => {
    const cryptoAdapter = new NodeCryptoAdapter();
    const dataDir = `/tmp/mindoodb-join-new-user-${Date.now()}`;
    fs.mkdirSync(dataDir, { recursive: true });

    const bootstrapFactory = new BaseMindooTenantFactory(
      new IsolatedInMemoryStoreFactory(),
      cryptoAdapter,
    );
    const serverIdentity = await bootstrapFactory.createUserId(
      "CN=join-new-user-server",
      SERVER_PASSWORD,
    );
    fs.writeFileSync(
      `${dataDir}/server.identity.json`,
      JSON.stringify(serverIdentity, null, 2),
      "utf-8",
    );
    fs.writeFileSync(`${dataDir}/trusted-servers.json`, "[]", "utf-8");

    const systemAdmin = await bootstrapFactory.createUserId(
      "cn=sysadmin/o=join-new-user",
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
      const tenantId = `joinnew-${Date.now().toString(16)}`;
      const device1Name = `cn=karsten/o=${tenantId}`;
      const adminName = `cn=admin/o=${tenantId}`;
      const joinerName = `cn=jane/o=${tenantId}`;

      const device1Factory = new BaseMindooTenantFactory(
        new IsolatedInMemoryStoreFactory(),
        cryptoAdapter,
      );
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
      expect((await device1Tenant.reconcileUserKeys!({ allowSelfCreate: true })).state).toBe(
        "approved",
      );

      await device1Tenant.publishToServer(baseUrl, {
        systemAdminUser: systemAdmin,
        systemAdminPassword: SYSTEM_ADMIN_PASSWORD,
        adminUsername: adminUser.username,
      });

      const adminAuth = { user: adminUser, password: DEVICE1_PASSWORD };
      await pushDb(device1Tenant, baseUrl, "directory", adminAuth);
      await pushDb(device1Tenant, baseUrl, USER_DIRECTORY_DB_ID);

      const foundersUserKeyDocs = await userKeyDocIds(device1Tenant);
      expect(foundersUserKeyDocs).toHaveLength(1);

      // A brand-new person on a brand-new device: named identity with its own
      // User-Key, so the join request carries `userPublicKey`.
      const device2Factory = new BaseMindooTenantFactory(
        new IsolatedInMemoryStoreFactory(),
        cryptoAdapter,
      );
      const joiner = await device2Factory.createUserId(joinerName, DEVICE2_PASSWORD);
      await device2Factory.ensureUserKeyPair(joiner, DEVICE2_PASSWORD);
      const joinRequest = device2Factory.createJoinRequest(joiner, { label: "Jane Laptop" });
      expect(joinRequest.username).toBe(joinerName);
      expect(joinRequest.userPublicKey).toBeTruthy();

      // No `username` override: this is a new person, not another device.
      const joinResponse = await device1Tenant.approveJoinRequest(joinRequest, {
        adminSigningKey: adminUser.userSigningKeyPair.privateKey,
        adminPassword: DEVICE1_PASSWORD,
        adminUsername: adminUser.username,
        label: "Jane Laptop",
        serverUrl: baseUrl,
      });
      expect(joinResponse.username).toBe(joinerName);

      // The admin published a second User-Key document, carrying the public key
      // straight from the join request and no device wraps yet.
      const afterApprove = await userKeyDocIds(device1Tenant);
      expect(afterApprove).toHaveLength(2);
      const joinerDocId = afterApprove.find((id) => !foundersUserKeyDocs.includes(id))!;
      expect(joinerDocId).toBeTruthy();

      await pushDb(device1Tenant, baseUrl, "directory", adminAuth);
      await pushDb(device1Tenant, baseUrl, USER_DIRECTORY_DB_ID);

      const deliveries = await device2Factory.discoverTenantsOnServer(baseUrl, {
        user: joiner,
        password: DEVICE2_PASSWORD,
      });
      const delivery = deliveries.find((d) => d.tenantId === tenantId)!;
      expect(delivery).toBeTruthy();

      const joined = await device2Factory.bootstrapTenantFromDelivery(delivery, {
        user: joiner,
        password: DEVICE2_PASSWORD,
        serverUrl: baseUrl,
      });
      expect(joined.user.username).toBe(joinerName);
      // Discovery carries the admin's display name, which this device cannot
      // derive from the directory (the admin holds no grant of its own).
      expect(joined.adminUsername).toBe(adminUser.username);
      expect(await joined.keyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID)).toBeTruthy();

      await pullDb(joined.tenant, baseUrl, "directory");
      await pullDb(joined.tenant, baseUrl, USER_DIRECTORY_DB_ID);
      joined.tenant.noteUserDirectoryFetched!();

      // The core claim: the document the admin wrote must be visible here.
      expect(await userKeyDocIds(joined.tenant)).toContain(joinerDocId);

      // With the document in hand the joiner seals it with its own device wrap,
      // so it is enrolled rather than waiting for someone else's approval.
      const enrolled = await joined.tenant.reconcileUserKeys!();
      expect(enrolled.state).toBe("approved");
      expect(enrolled.pending).toBe(false);

      await joined.tenant.reconcileKeyDistributionsForCurrentUser!();
      expect(await joined.tenant.hasDecryptionKey!(DEFAULT_TENANT_KEY_ID)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
