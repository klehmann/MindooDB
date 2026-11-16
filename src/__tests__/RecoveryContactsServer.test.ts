/**
 * Recovery contacts end to end over a local HTTP server (docs/userkeys.md
 * §12): Alice names Bob, Carol and Dave. She loses her device. Bob and Carol
 * each hand her a package; with the two packages a brand-new device becomes
 * one of Alice's devices — it reads her sealed documents, also those sealed
 * after a User-Key rotation — and names the same contacts again, which
 * withdraws the used rescue device. One package alone opens nothing.
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
  RecoveryContactsError,
  RecoveryError,
  RecoveryPackageError,
  certifyDeviceWithRescueDevice,
  combineRecoveryHelperPackages,
  decryptRecoveryHelperPackage,
  encryptRecoveryHelperPackage,
  generateRecoveryPackagePassword,
  type RecoveryHelperPackage,
} from "../core/recovery";

const PASSWORD = "device-pass";
const SYSTEM_ADMIN_PASSWORD = "sysadmin-pass";
const SERVER_PASSWORD = "server-rescue-pass";

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

describe("recovery contacts over a local HTTP server", () => {
  jest.setTimeout(600000);

  test("two of three contacts bring Alice onto a new device; one alone cannot", async () => {
    const crypto = new NodeCryptoAdapter();
    const dataDir = `/tmp/mindoodb-rescue-server-${Date.now()}`;
    fs.mkdirSync(dataDir, { recursive: true });

    const bootstrap = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    const serverIdentity = await bootstrap.createUserId("CN=rescue-server", SERVER_PASSWORD);
    fs.writeFileSync(`${dataDir}/server.identity.json`, JSON.stringify(serverIdentity), "utf-8");
    fs.writeFileSync(`${dataDir}/trusted-servers.json`, "[]", "utf-8");
    const systemAdmin = await bootstrap.createUserId("cn=sysadmin/o=rescue-server", SYSTEM_ADMIN_PASSWORD);
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
      const tenantId = `rescue-${Date.now().toString(16)}`;
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
      expect((await alice.reconcileUserKeys!({ allowSelfCreate: true })).state).toBe("approved");
      await alice.publishToServer(baseUrl, {
        systemAdminUser: systemAdmin,
        systemAdminPassword: SYSTEM_ADMIN_PASSWORD,
        adminUsername: adminUser.username,
      });
      const adminAuth = { user: adminUser, password: PASSWORD };

      // Bob, Carol, Dave (contacts) and Eve (not a contact), each on their own device.
      const directory = (await alice.openDirectory()) as BaseMindooTenantDirectory;
      async function person(name: string): Promise<Person> {
        const factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
        const user = await factory.createUserId(`cn=${name}/o=${tenantId}`, PASSWORD);
        await factory.ensureUserKeyPair(user, PASSWORD);
        await directory.registerUser(
          factory.toPublicUserId(user),
          adminUser.userSigningKeyPair.privateKey,
          PASSWORD,
          undefined,
          `${name}-laptop`,
        );
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
      const dave = await person("dave");
      const eve = await person("eve");
      await push(alice, baseUrl, "directory", adminAuth);
      await push(alice, baseUrl, USER_DIRECTORY_DB_ID);
      for (const p of [bob, carol, dave, eve]) {
        await pull(p.tenant, baseUrl, "directory");
        await pull(p.tenant, baseUrl, USER_DIRECTORY_DB_ID);
        p.tenant.noteUserDirectoryFetched!();
        expect((await p.tenant.reconcileUserKeys!({ allowSelfCreate: true })).state).toBe("approved");
        await push(p.tenant, baseUrl, USER_DIRECTORY_DB_ID);
      }
      await pull(alice, baseUrl, USER_DIRECTORY_DB_ID);

      // A document only Alice can read.
      const notes = await alice.openDB("notes");
      const sealedBefore = await notes.createDocument({ recipients: [], initialValues: { text: "before" } });

      // Validation of the contact list.
      await expect(alice.setupRecoveryContacts!([bob.user.username])).rejects.toMatchObject({
        code: "too-few-contacts",
      });
      await expect(
        alice.setupRecoveryContacts!([bob.user.username, aliceUser.username]),
      ).rejects.toMatchObject({ code: "contact-is-self" });
      await expect(
        alice.setupRecoveryContacts!([bob.user.username, `cn=nobody/o=${tenantId}`]),
      ).rejects.toMatchObject({ code: "contact-without-key", usernames: [`cn=nobody/o=${tenantId}`] });

      const setup = await alice.setupRecoveryContacts!(
        [bob.user.username, carol.user.username, dave.user.username],
        { rescueDeviceLabel: "Rettungsgerät" },
      );
      expect(setup.payload.threshold).toBe(2);
      expect(setup.payload.contacts.map((c) => c.username)).toEqual([
        bob.user.username,
        carol.user.username,
        dave.user.username,
      ]);
      expect((await alice.getRecoveryContactsSetup!())?.docId).toBe(setup.docId);
      const certs = await alice.listOwnDeviceCertificates!();
      expect(certs.map((c) => c.fingerprint)).toContain(setup.payload.rescueDevice.signingKeyFingerprint);

      // The rescue device keeps up with rotation: rotate, then seal again.
      await alice.rotateUserKey!();
      const sealedAfter = await notes.createDocument({ recipients: [], initialValues: { text: "after" } });
      await push(alice, baseUrl, USER_DIRECTORY_DB_ID);
      await push(alice, baseUrl, "notes");

      // The contacts see the request; Eve does not.
      for (const p of [bob, carol, eve]) await pull(p.tenant, baseUrl, USER_DIRECTORY_DB_ID);
      const requests = await bob.tenant.listRecoveryContactRequests!();
      expect(requests).toEqual([
        expect.objectContaining({ docId: setup.docId, username: aliceUser.username, threshold: 2 }),
      ]);
      expect(await eve.tenant.listRecoveryContactRequests!()).toEqual([]);
      await expect(
        eve.tenant.createRecoveryHelperPackage!(aliceUser.username, { serverUrl: baseUrl }),
      ).rejects.toMatchObject({ code: "not-a-contact" });

      async function helperText(helper: Person): Promise<{ text: string; password: string }> {
        const pkg = await helper.tenant.createRecoveryHelperPackage!(aliceUser.username, { serverUrl: baseUrl });
        expect(pkg.username).toBe(aliceUser.username);
        expect(pkg.tenantId).toBe(tenantId);
        const password = generateRecoveryPackagePassword(crypto);
        return { text: await encryptRecoveryHelperPackage(crypto, pkg, password), password };
      }
      const fromBob = await helperText(bob);
      const fromCarol = await helperText(carol);

      // ---- Alice's device is gone. A new device, fresh keys, nothing on any grant.
      const newFactory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
      const newUser = await newFactory.createUserId(aliceUser.username, "new-device-pass");
      const device = {
        signingPublicKey: newUser.userSigningKeyPair.publicKey,
        encryptionPublicKey: newUser.userEncryptionKeyPair.publicKey,
      };
      const bobPkg = await decryptRecoveryHelperPackage(crypto, fromBob.text, fromBob.password);
      const carolPkg = await decryptRecoveryHelperPackage(crypto, fromCarol.text, fromCarol.password);

      // One package alone opens nothing.
      await expect(combineRecoveryHelperPackages(crypto, [bobPkg])).rejects.toBeInstanceOf(RecoveryPackageError);
      // Bob's share used twice does not count as two.
      const bobTwice: RecoveryHelperPackage = { ...bobPkg, helper: "someone else" };
      await expect(combineRecoveryHelperPackages(crypto, [bobPkg, bobTwice])).rejects.toMatchObject({
        code: "duplicate",
      });
      // Before recovering, the new device has no access at all.
      expect(
        (await newFactory.discoverTenantsOnServer(baseUrl, { user: newUser, password: "new-device-pass" })).map(
          (d) => d.tenantId,
        ),
      ).not.toContain(tenantId);

      const combined = await combineRecoveryHelperPackages(crypto, [bobPkg, carolPkg]);
      expect(combined.serverUrl).toBe(baseUrl);
      const certified = await certifyDeviceWithRescueDevice({
        cryptoAdapter: crypto,
        recovery: combined,
        device,
        label: "New phone",
      });
      expect(certified.tenantId).toBe(tenantId);
      expect(certified.username).toBe(aliceUser.username);

      // The new device joins like any certified device.
      const deliveries = await newFactory.discoverTenantsOnServer(baseUrl, {
        user: newUser,
        password: "new-device-pass",
      });
      const delivery = deliveries.find((d) => d.tenantId === tenantId)!;
      expect(delivery).toBeTruthy();
      const joined = await newFactory.bootstrapTenantFromDelivery(delivery, {
        user: newUser,
        password: "new-device-pass",
        serverUrl: baseUrl,
      });
      const recovered = joined.tenant;
      expect(await recovered.hasDecryptionKey!(DEFAULT_TENANT_KEY_ID)).toBe(true);
      await pull(recovered, baseUrl, "notes");
      const recoveredNotes = await recovered.openDB("notes");
      expect((await recoveredNotes.getDocument(sealedBefore.getId())).getData().text).toBe("before");
      expect((await recoveredNotes.getDocument(sealedAfter.getId())).getData().text).toBe("after");
      expect(await recovered.canIssueDeviceCertificates!()).toBe(true);

      // Same contacts again: a new rescue device; the used one is withdrawn.
      const previous = await recovered.getRecoveryContactsSetup!();
      expect(previous?.docId).toBe(setup.docId);
      const renewed = await recovered.setupRecoveryContacts!(previous!.payload.contacts.map((c) => c.username), {
        withdrawRescueDevices: [certified.rescueSigningKeyFingerprint],
      });
      expect(renewed.docId).not.toBe(setup.docId);
      expect(renewed.payload.rescueDevice.signingKeyFingerprint).not.toBe(
        setup.payload.rescueDevice.signingKeyFingerprint,
      );
      await push(recovered, baseUrl, USER_DIRECTORY_DB_ID);
      expect((await recovered.listOwnDeviceCertificates!()).map((c) => c.fingerprint)).not.toContain(
        setup.payload.rescueDevice.signingKeyFingerprint,
      );

      // The old packages are worthless now.
      const otherDevice = await newFactory.createUserId(aliceUser.username, "x-pass");
      await expect(
        certifyDeviceWithRescueDevice({
          cryptoAdapter: crypto,
          recovery: combined,
          device: {
            signingPublicKey: otherDevice.userSigningKeyPair.publicKey,
            encryptionPublicKey: otherDevice.userEncryptionKeyPair.publicKey,
          },
        }),
      ).rejects.toEqual(expect.objectContaining({ name: "RecoveryError", code: "not-certified" }));
      expect(new RecoveryError("no-server", "x")).toBeInstanceOf(Error);

      // Bob sees the renewed setup and can help again with it.
      await pull(bob.tenant, baseUrl, USER_DIRECTORY_DB_ID);
      expect((await bob.tenant.listRecoveryContactRequests!())[0]?.docId).toBe(renewed.docId);

      // Removing recovery contacts withdraws the rescue device.
      expect(await recovered.removeRecoveryContacts!()).toBe(1);
      expect(await recovered.getRecoveryContactsSetup!()).toBeNull();
      await expect(bob.tenant.createRecoveryHelperPackage!(aliceUser.username)).resolves.toBeTruthy(); // bob's replica is stale
      await push(recovered, baseUrl, USER_DIRECTORY_DB_ID);
      await pull(bob.tenant, baseUrl, USER_DIRECTORY_DB_ID);
      await expect(bob.tenant.createRecoveryHelperPackage!(aliceUser.username)).rejects.toBeInstanceOf(
        RecoveryContactsError,
      );
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
