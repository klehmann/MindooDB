/**
 * Paper rescue device end to end over a local HTTP server (docs/userkeys.md
 * §12.8): Alice prints a sheet, rotates her User-Key, prints a second sheet
 * (which withdraws the first), loses her device, and a brand-new device
 * becomes hers with the second sheet. The first sheet is refused, and the
 * recovery contacts' rescue device is untouched by any of it.
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
import { certifyDeviceWithRescueDevice, openPaperRescueSecret } from "../core/recovery";

const PASSWORD = "device-pass";
const SYSTEM_ADMIN_PASSWORD = "sysadmin-pass";
const SERVER_PASSWORD = "server-paper-pass";

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

async function push(
  tenant: MindooTenant,
  baseUrl: string,
  dbId: string,
  auth?: { user: PrivateUserId; password: string },
): Promise<void> {
  const local = await tenant.openDB(dbId, dbId === "directory" ? { adminOnlyDb: true } : undefined);
  const remote = await tenant.connectToServer(baseUrl, dbId);
  const result = await local.pushChangesTo(remote, auth ? { networkAuthOverride: auth } : undefined);
  expect(result.cancelled).toBe(false);
}

async function pull(tenant: MindooTenant, baseUrl: string, dbId: string): Promise<void> {
  const local = await tenant.openDB(dbId, dbId === "directory" ? { adminOnlyDb: true } : undefined);
  const remote = await tenant.connectToServer(baseUrl, dbId);
  await local.pullChangesFrom(remote);
  await local.syncStoreChanges();
}

describe("paper rescue device over a local HTTP server", () => {
  jest.setTimeout(600000);

  test("a printed sheet brings Alice onto a new device; an older sheet is withdrawn", async () => {
    const crypto = new NodeCryptoAdapter();
    const dataDir = `/tmp/mindoodb-paper-rescue-${Date.now()}`;
    fs.mkdirSync(dataDir, { recursive: true });
    const bootstrap = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    const serverIdentity = await bootstrap.createUserId("CN=paper-server", SERVER_PASSWORD);
    fs.writeFileSync(`${dataDir}/server.identity.json`, JSON.stringify(serverIdentity), "utf-8");
    fs.writeFileSync(`${dataDir}/trusted-servers.json`, "[]", "utf-8");
    const systemAdmin = await bootstrap.createUserId("cn=sysadmin/o=paper-server", SYSTEM_ADMIN_PASSWORD);
    const config: ServerConfig = {
      capabilities: {
        "ALL:/system/*": [
          { username: systemAdmin.username, publicsignkey: systemAdmin.userSigningKeyPair.publicKey as string },
        ],
      },
    };
    const server = new MindooDBServer(dataDir, SERVER_PASSWORD, undefined, config);
    const { httpServer, baseUrl } = await startServer(server);
    try {
      const tenantId = `paper-${Date.now().toString(16)}`;
      const aliceFactory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
      const adminUser = await aliceFactory.createUserId(`cn=admin/o=${tenantId}`, PASSWORD);
      const aliceUser = await aliceFactory.createUserId(`cn=alice/o=${tenantId}`, PASSWORD);
      await aliceFactory.ensureUserKeyPair(aliceUser, PASSWORD);
      const created = await aliceFactory.createTenant({
        tenantId,
        adminUser,
        adminPassword: PASSWORD,
        appUser: aliceUser,
        userPassword: PASSWORD,
      });
      const alice = created.tenant;
      alice.noteUserDirectoryFetched!();
      await alice.reconcileUserKeys!({ allowSelfCreate: true });
      await alice.publishToServer(baseUrl, {
        systemAdminUser: systemAdmin,
        systemAdminPassword: SYSTEM_ADMIN_PASSWORD,
        adminUsername: adminUser.username,
      });
      const adminAuth = { user: adminUser, password: PASSWORD };
      await push(alice, baseUrl, "directory", adminAuth);

      const notes = await alice.openDB("notes");
      const before = await notes.createDocument({ recipients: [], initialValues: { text: "before" } });

      const sheet1 = await alice.createPaperRescueDevice!({ label: "Notfallausdruck" });
      expect(sheet1.tenantId).toBe(tenantId);
      expect(sheet1.username).toBe(aliceUser.username);
      expect((await alice.listPaperRescueDevices!()).map((r) => r.docId)).toEqual([sheet1.docId]);
      await alice.rotateUserKey!();
      const after = await notes.createDocument({ recipients: [], initialValues: { text: "after" } });
      const sheet2 = await alice.createPaperRescueDevice!({ label: "Notfallausdruck" });
      expect((await alice.listPaperRescueDevices!()).map((r) => r.docId)).toEqual([sheet2.docId]);
      const certs = (await alice.listOwnDeviceCertificates!()).map((c) => c.fingerprint);
      expect(certs).toContain(sheet2.rescueSigningKeyFingerprint);
      expect(certs).not.toContain(sheet1.rescueSigningKeyFingerprint);
      expect((await alice.listRescueDeviceSigningKeys!()).length).toBe(1);
      await push(alice, baseUrl, USER_DIRECTORY_DB_ID);
      await push(alice, baseUrl, "notes");

      // The sheet round-trips as JSON (the application encrypts it for print).
      const printed = JSON.parse(JSON.stringify(sheet2)) as typeof sheet2;
      await expect(
        openPaperRescueSecret(crypto, { ...printed, secret: sheet1.secret }),
      ).rejects.toThrow();

      const newFactory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
      const newUser = await newFactory.createUserId(aliceUser.username, "new-pass");
      const device = {
        signingPublicKey: newUser.userSigningKeyPair.publicKey,
        encryptionPublicKey: newUser.userEncryptionKeyPair.publicKey,
      };

      // The withdrawn first sheet no longer works.
      await expect(
        certifyDeviceWithRescueDevice({
          cryptoAdapter: crypto,
          recovery: await openPaperRescueSecret(crypto, sheet1, baseUrl),
          device,
        }),
      ).rejects.toMatchObject({ code: "not-certified" });

      const certified = await certifyDeviceWithRescueDevice({
        cryptoAdapter: crypto,
        recovery: await openPaperRescueSecret(crypto, printed, baseUrl),
        device,
        label: "Restored from paper",
      });
      expect(certified.username).toBe(aliceUser.username);
      const delivery = (await newFactory.discoverTenantsOnServer(baseUrl, { user: newUser, password: "new-pass" }))
        .find((d) => d.tenantId === tenantId)!;
      const joined = await newFactory.bootstrapTenantFromDelivery(delivery, {
        user: newUser,
        password: "new-pass",
        serverUrl: baseUrl,
      });
      expect(await joined.tenant.hasDecryptionKey!(DEFAULT_TENANT_KEY_ID)).toBe(true);
      await pull(joined.tenant, baseUrl, "notes");
      const restoredNotes = await joined.tenant.openDB("notes");
      expect((await restoredNotes.getDocument(before.getId())).getData().text).toBe("before");
      expect((await restoredNotes.getDocument(after.getId())).getData().text).toBe("after");
      // The sheet stays valid after use, like a printout in a drawer.
      expect((await joined.tenant.listPaperRescueDevices!()).map((r) => r.docId)).toEqual([sheet2.docId]);
      expect(await joined.tenant.removePaperRescueDevices!()).toBe(1);
      expect(await joined.tenant.listPaperRescueDevices!()).toEqual([]);
      expect(PUBLIC_INFOS_KEY_ID).toBeTruthy();
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
