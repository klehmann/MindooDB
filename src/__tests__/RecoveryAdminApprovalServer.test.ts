/**
 * Rescue devices without device self-grant (docs/userkeys.md §12.9), end to
 * end over a local HTTP server. Alice may not certify her own devices. Her
 * rescue device is admitted by the administrator like an additional device and
 * gets her User-Key from her own device without a dialog, because its setup
 * is attested with her User-Key. A device the administrator plants with a
 * forged setup gets nothing. Recovery: the new device joins with a normal
 * join request, the administrator approves it, the rescue device wraps the
 * User-Key to it, and the administrator removes the used rescue device.
 */
import fs from "fs";
import { Server } from "http";

import { IsolatedInMemoryStoreFactory } from "./_helpers/multiDevice";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { KeyBag } from "../core/keys/KeyBag";
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
import {
  approveDeviceWithRescueDevice,
  certifyDeviceWithRescueDevice,
  combineRecoveryHelperPackages,
  generateRescueDevice,
  openPaperRescueSecret,
  rescueDeviceJoinRequestUri,
} from "../core/recovery";
import { USERKEY_FORM } from "../core/userkeys/types";

const PASSWORD = "device-pass";
const SYSTEM_ADMIN_PASSWORD = "sysadmin-pass";
const SERVER_PASSWORD = "server-admin-rescue-pass";

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

interface Person {
  user: PrivateUserId;
  tenant: MindooTenant;
}

describe("admin-approved rescue devices over a local HTTP server", () => {
  jest.setTimeout(600000);

  test("contacts and paper without self-grant: admin admits, rescue device wraps the new device", async () => {
    const crypto = new NodeCryptoAdapter();
    const dataDir = `/tmp/mindoodb-admin-rescue-${Date.now()}`;
    fs.mkdirSync(dataDir, { recursive: true });
    const bootstrap = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    const serverIdentity = await bootstrap.createUserId("CN=admin-rescue-server", SERVER_PASSWORD);
    fs.writeFileSync(`${dataDir}/server.identity.json`, JSON.stringify(serverIdentity), "utf-8");
    fs.writeFileSync(`${dataDir}/trusted-servers.json`, "[]", "utf-8");
    const systemAdmin = await bootstrap.createUserId("cn=sysadmin/o=admin-rescue-server", SYSTEM_ADMIN_PASSWORD);
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
      const tenantId = `arescue-${Date.now().toString(16)}`;
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
        allowDeviceSelfGrantForAppUser: false,
      });
      const alice = created.tenant;
      alice.noteUserDirectoryFetched!();
      await alice.reconcileUserKeys!({ allowSelfCreate: true });
      expect(await alice.canIssueDeviceCertificates!()).toBe(false);
      await alice.publishToServer(baseUrl, {
        systemAdminUser: systemAdmin,
        systemAdminPassword: SYSTEM_ADMIN_PASSWORD,
        adminUsername: adminUser.username,
      });
      const adminAuth = { user: adminUser, password: PASSWORD };
      const admin = { adminSigningKey: adminUser.userSigningKeyPair.privateKey, adminPassword: PASSWORD };

      const directory = (await alice.openDirectory()) as BaseMindooTenantDirectory;
      async function person(name: string): Promise<Person> {
        const factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
        const user = await factory.createUserId(`cn=${name}/o=${tenantId}`, PASSWORD);
        await factory.ensureUserKeyPair(user, PASSWORD);
        await directory.registerUser(factory.toPublicUserId(user), admin.adminSigningKey, PASSWORD, undefined, `${name}-laptop`);
        const keyBag = new KeyBag(user.userEncryptionKeyPair.privateKey, PASSWORD, crypto);
        for (const keyId of [PUBLIC_INFOS_KEY_ID, DEFAULT_TENANT_KEY_ID]) {
          await keyBag.set("doc", tenantId, keyId, (await created.keyBag.get("doc", tenantId, keyId))!);
        }
        const tenant = await factory.openTenant(
          tenantId,
          adminUser.userSigningKeyPair.publicKey,
          adminUser.userEncryptionKeyPair.publicKey,
          user,
          PASSWORD,
          keyBag,
        );
        return { user, tenant };
      }
      const bob = await person("bob");
      const carol = await person("carol");
      await push(alice, baseUrl, "directory", adminAuth);
      await push(alice, baseUrl, USER_DIRECTORY_DB_ID);
      for (const p of [bob, carol]) {
        await pull(p.tenant, baseUrl, "directory");
        await pull(p.tenant, baseUrl, USER_DIRECTORY_DB_ID);
        p.tenant.noteUserDirectoryFetched!();
        await p.tenant.reconcileUserKeys!({ allowSelfCreate: true });
        await push(p.tenant, baseUrl, USER_DIRECTORY_DB_ID);
      }
      await pull(alice, baseUrl, USER_DIRECTORY_DB_ID);

      const notes = await alice.openDB("notes");
      const sealed = await notes.createDocument({ recipients: [], initialValues: { text: "only alice" } });
      await push(alice, baseUrl, "notes");

      // --- Setup without self-grant: the rescue device waits for the admin.
      await expect(
        alice.setupRecoveryContacts!([bob.user.username, carol.user.username], { allowAdminApproval: false }),
      ).rejects.toMatchObject({ code: "self-grant-required" });
      const setup = await alice.setupRecoveryContacts!([bob.user.username, carol.user.username], {
        rescueDeviceLabel: "Rescue device (recovery contacts)",
      });
      expect(setup.payload.rescueDevice.approval).toBe("admin");
      expect(setup.payload.rescueDevice.certificateDocId).toBeUndefined();
      expect(setup.joinRequestUri).toMatch(/^mdb:\/\/join-request\//);
      expect(await alice.getRecoveryContactsStatus!()).toBe("waiting-for-admin");

      // The admin grants it under Alice's name, like an additional device. The
      // admin works on another device (Bob's here): an approval on Alice's own
      // device would wrap her key right away (§4.3).
      const asAdmin = async (joinRequestUri: string) => {
        await pull(bob.tenant, baseUrl, "directory");
        await bob.tenant.approveJoinRequest(joinRequestUri, { ...admin, username: aliceUser.username });
        await push(bob.tenant, baseUrl, "directory", adminAuth);
        await pull(alice, baseUrl, "directory");
      };
      await asAdmin(setup.joinRequestUri!);
      expect(await alice.getRecoveryContactsStatus!()).toBe("waiting-for-key");

      // A device the admin plants on Alice's grant, with a forged setup of its own.
      const plantedFactory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
      const plantedRescue = await generateRescueDevice(crypto);
      await asAdmin(rescueDeviceJoinRequestUri({ ...plantedRescue, label: "Rescue device (recovery contacts)" }));
      const plantedUser = await plantedFactory.createUserId(aliceUser.username, "planted-pass");
      expect(plantedUser).toBeTruthy();
      const forged = await alice.openDB(USER_DIRECTORY_DB_ID);
      await forged.createDocument({
        decryptionKeyId: DEFAULT_TENANT_KEY_ID,
        idPrefix: "rcv",
        initialValues: {
          ...JSON.parse(JSON.stringify(setup.payload)),
          createdAt: Date.now() - 1000,
          rescueDevice: {
            signingPublicKey: plantedRescue.signingPublicKey,
            encryptionPublicKey: plantedRescue.encryptionPublicKey,
            signingKeyFingerprint: plantedRescue.signingKeyFingerprint,
            approval: "admin",
            attestation: { epoch: "1", signature: setup.payload.rescueDevice.attestation!.signature },
          },
          form: USERKEY_FORM,
        },
      });

      // Alice's next reconcile wraps her key to her own rescue device only, and
      // the forged setup is not taken for hers.
      await alice.reconcileUserKeys!();
      expect(await alice.getRecoveryContactsStatus!()).toBe("active");
      const pendingAfter = (await alice.listPendingUserKeyDevices!()).map((d) => d.encryptionPublicKey.replace(/\s+/g, ""));
      expect(pendingAfter).toContain(plantedRescue.encryptionPublicKey.replace(/\s+/g, ""));
      expect((await alice.getRecoveryContactsSetup!())?.docId).toBe(setup.docId);
      await push(alice, baseUrl, USER_DIRECTORY_DB_ID);

      // Paper without self-grant behaves the same.
      const sheet = await alice.createPaperRescueDevice!({ label: "Recovery printout" });
      expect(sheet.approval).toBe("admin");
      expect(sheet.joinRequestUri).toBeTruthy();
      expect(await alice.getPaperRescueStatus!()).toBe("waiting-for-admin");

      // --- Recovery: two helper packages carry the admin mode along.
      for (const p of [bob, carol]) await pull(p.tenant, baseUrl, USER_DIRECTORY_DB_ID);
      const packages = [
        await bob.tenant.createRecoveryHelperPackage!(aliceUser.username, { serverUrl: baseUrl }),
        await carol.tenant.createRecoveryHelperPackage!(aliceUser.username, { serverUrl: baseUrl }),
      ];
      expect(packages[0]!.rescueApproval).toBe("admin");
      const recovery = await combineRecoveryHelperPackages(crypto, packages);
      expect(recovery.rescueApproval).toBe("admin");

      const newFactory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
      const newUser = await newFactory.createUserId(aliceUser.username, "new-pass");
      // Without self-grant, certifying is impossible…
      await expect(
        certifyDeviceWithRescueDevice({
          cryptoAdapter: crypto,
          recovery,
          device: { signingPublicKey: newUser.userSigningKeyPair.publicKey, encryptionPublicKey: newUser.userEncryptionKeyPair.publicKey },
        }),
      ).rejects.toThrow();
      // …and wrapping waits for the admin to add the new device.
      await expect(
        approveDeviceWithRescueDevice({ cryptoAdapter: crypto, recovery, deviceEncryptionPublicKey: newUser.userEncryptionKeyPair.publicKey }),
      ).rejects.toMatchObject({ code: "device-not-on-grant" });

      const joinRequest = newFactory.createJoinRequest(newUser, { format: "uri", label: "New phone" });
      await asAdmin(joinRequest);
      const approved = await approveDeviceWithRescueDevice({
        cryptoAdapter: crypto,
        recovery,
        deviceEncryptionPublicKey: newUser.userEncryptionKeyPair.publicKey,
      });
      expect(approved.username).toBe(aliceUser.username);

      const delivery = (await newFactory.discoverTenantsOnServer(baseUrl, { user: newUser, password: "new-pass" }))
        .find((d) => d.tenantId === tenantId)!;
      const joined = await newFactory.bootstrapTenantFromDelivery(delivery, { user: newUser, password: "new-pass", serverUrl: baseUrl });
      expect((await joined.tenant.reconcileUserKeys!()).state).toBe("approved");
      await pull(joined.tenant, baseUrl, "notes");
      expect((await (await joined.tenant.openDB("notes")).getDocument(sealed.getId())).getData().text).toBe("only alice");

      // The admin removes the used rescue device; its packages stop working.
      await pull(alice, baseUrl, "directory");
      await directory.updateUserGrant!(
        aliceUser.username,
        { revokeSigningKeys: [setup.payload.rescueDevice.signingPublicKey] },
        admin.adminSigningKey,
        PASSWORD,
      );
      await push(alice, baseUrl, "directory", adminAuth);
      const another = await newFactory.createUserId(aliceUser.username, "another-pass");
      await expect(
        approveDeviceWithRescueDevice({ cryptoAdapter: crypto, recovery, deviceEncryptionPublicKey: another.userEncryptionKeyPair.publicKey }),
      ).rejects.toMatchObject({ code: "not-certified" });

      // The paper sheet carries its mode too.
      expect((await openPaperRescueSecret(crypto, sheet, baseUrl)).rescueApproval).toBe("admin");
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
