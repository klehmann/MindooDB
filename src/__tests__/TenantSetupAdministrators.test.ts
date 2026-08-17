/**
 * `tenantsetup` records the tenant's administrators. The admin holds no
 * grantaccess document, so this list is what lets a member name the
 * administration key. Names are field-encrypted under `default`, so the sync
 * server (which only holds `$publicinfos`) cannot read them.
 */
import { describe, expect, test } from "@jest/globals";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { DEFAULT_TENANT_KEY_ID, TENANT_SETUP_DOC_ID } from "../core/types";
import {
  readTenantSetupAdministrators,
  writeTenantSetupAdministrator,
} from "../core/tenantSetup";

describe("tenantsetup administrators", () => {
  jest.setTimeout(120000);
  const adminPassword = "admin-pass-123";
  const userPassword = "alice-pass-123";

  test("tenant creation records the admin with an encrypted name and its keys", async () => {
    const factory = new BaseMindooTenantFactory(
      new InMemoryContentAddressedStoreFactory(),
      new NodeCryptoAdapter(),
    );
    const adminName = "cn=admin/o=admins-test";
    const { tenant, adminUser } = await factory.createTenant({
      tenantId: "admins-create-test",
      adminName,
      adminPassword,
      userName: "cn=alice/o=admins-test",
      userPassword,
    });

    const directoryDb = await tenant.openDB("directory", { adminOnlyDb: true });
    const administrators = await readTenantSetupAdministrators(directoryDb, tenant);
    expect(administrators).toHaveLength(1);
    expect(administrators[0]!.username).toBe(adminName);
    expect(administrators[0]!.keyPairs).toHaveLength(1);
    expect(administrators[0]!.keyPairs[0]!.signingPublicKey).toBe(
      adminUser.userSigningKeyPair.publicKey,
    );
    expect(administrators[0]!.keyPairs[0]!.encryptionPublicKey).toBe(
      adminUser.userEncryptionKeyPair.publicKey,
    );

    // The stored form mirrors a grant's userKeyPairs, and the name is ciphertext.
    const raw = (await directoryDb.getDocument(TENANT_SETUP_DOC_ID)).getData() as Record<
      string,
      unknown
    >;
    const entries = raw.administrators as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.username_encrypted_key).toBe(DEFAULT_TENANT_KEY_ID);
    expect(typeof entries[0]!.username_encrypted).toBe("string");
    expect(JSON.stringify(entries[0])).not.toContain(adminName);
    expect(Array.isArray(entries[0]!.userKeyPairs)).toBe(true);

    // Without `default` the entry survives, but the name stays unreadable —
    // the sync server's view.
    await tenant.removeNamedDecryptionKey(DEFAULT_TENANT_KEY_ID);
    const serverView = await readTenantSetupAdministrators(directoryDb, tenant);
    expect(serverView).toHaveLength(1);
    expect(serverView[0]!.username).toBeUndefined();
    expect(serverView[0]!.keyPairs[0]!.signingPublicKey).toBe(
      adminUser.userSigningKeyPair.publicKey,
    );
  }, 120000);

  test("another device of the same admin is merged; a second admin is appended", async () => {
    const factory = new BaseMindooTenantFactory(
      new InMemoryContentAddressedStoreFactory(),
      new NodeCryptoAdapter(),
    );
    const adminName = "cn=admin/o=admins-merge";
    const { tenant, adminUser } = await factory.createTenant({
      tenantId: "admins-merge-test",
      adminName,
      adminPassword,
      userName: "cn=alice/o=admins-merge",
      userPassword,
    });
    const directoryDb = await tenant.openDB("directory", { adminOnlyDb: true });

    const secondDevice = await factory.createUserId(adminName, "second-device-pass");
    await writeTenantSetupAdministrator(
      directoryDb,
      {
        username: adminName,
        keyPairs: [
          {
            signingPublicKey: secondDevice.userSigningKeyPair.publicKey,
            encryptionPublicKey: secondDevice.userEncryptionKeyPair.publicKey,
            label: "Admin Laptop",
          },
        ],
      },
      adminUser.userSigningKeyPair,
      adminPassword,
      tenant,
    );

    const afterDevice = await readTenantSetupAdministrators(directoryDb, tenant);
    expect(afterDevice).toHaveLength(1);
    expect(afterDevice[0]!.keyPairs.map((pair) => pair.signingPublicKey)).toEqual([
      adminUser.userSigningKeyPair.publicKey,
      secondDevice.userSigningKeyPair.publicKey,
    ]);
    expect(afterDevice[0]!.keyPairs[1]!.label).toBe("Admin Laptop");

    const coAdminName = "cn=second-admin/o=admins-merge";
    const coAdmin = await factory.createUserId(coAdminName, "co-admin-pass");
    await writeTenantSetupAdministrator(
      directoryDb,
      {
        username: coAdminName,
        keyPairs: [
          {
            signingPublicKey: coAdmin.userSigningKeyPair.publicKey,
            encryptionPublicKey: coAdmin.userEncryptionKeyPair.publicKey,
          },
        ],
      },
      adminUser.userSigningKeyPair,
      adminPassword,
      tenant,
    );

    const afterCoAdmin = await readTenantSetupAdministrators(directoryDb, tenant);
    expect(afterCoAdmin.map((entry) => entry.username)).toEqual([adminName, coAdminName]);
    expect(afterCoAdmin[0]!.keyPairs).toHaveLength(2);
    expect(afterCoAdmin[1]!.keyPairs).toHaveLength(1);

    // Re-writing the founding admin unchanged must not duplicate the entry.
    await writeTenantSetupAdministrator(
      directoryDb,
      {
        username: adminName,
        keyPairs: [
          {
            signingPublicKey: adminUser.userSigningKeyPair.publicKey,
            encryptionPublicKey: adminUser.userEncryptionKeyPair.publicKey,
          },
        ],
      },
      adminUser.userSigningKeyPair,
      adminPassword,
      tenant,
    );
    const afterRewrite = await readTenantSetupAdministrators(directoryDb, tenant);
    expect(afterRewrite).toHaveLength(2);
    expect(afterRewrite[0]!.keyPairs).toHaveLength(2);
  }, 120000);

  test("approving a join request heals a tenant that has no administrators yet", async () => {
    const factory = new BaseMindooTenantFactory(
      new InMemoryContentAddressedStoreFactory(),
      new NodeCryptoAdapter(),
    );
    const adminName = "cn=admin/o=admins-heal";
    const { tenant, adminUser } = await factory.createTenant({
      tenantId: "admins-heal-test",
      adminName,
      adminPassword,
      userName: "cn=alice/o=admins-heal",
      userPassword,
    });
    const directoryDb = await tenant.openDB("directory", { adminOnlyDb: true });

    // Simulate a tenant created before `tenantsetup` recorded administrators.
    const doc = await directoryDb.getDocument(TENANT_SETUP_DOC_ID);
    await directoryDb.changeDoc(
      doc,
      (d) => {
        delete (d.getData() as { administrators?: unknown[] }).administrators;
      },
      {
        signingKeyPair: adminUser.userSigningKeyPair,
        signingKeyPassword: adminPassword,
      },
    );
    expect(await readTenantSetupAdministrators(directoryDb, tenant)).toEqual([]);

    const joiner = await factory.createUserId("cn=bob/o=admins-heal", "bob-pass-123");
    await factory.ensureUserKeyPair(joiner, "bob-pass-123");
    await tenant.approveJoinRequest(factory.createJoinRequest(joiner, { label: "Bob Laptop" }), {
      adminSigningKey: adminUser.userSigningKeyPair.privateKey,
      adminPassword,
      adminUsername: adminName,
    });

    const healed = await readTenantSetupAdministrators(directoryDb, tenant);
    expect(healed).toHaveLength(1);
    expect(healed[0]!.username).toBe(adminName);
    expect(healed[0]!.keyPairs[0]!.signingPublicKey).toBe(adminUser.userSigningKeyPair.publicKey);
  }, 120000);

  test("tenants created before the field simply have no administrators", async () => {
    const factory = new BaseMindooTenantFactory(
      new InMemoryContentAddressedStoreFactory(),
      new NodeCryptoAdapter(),
    );
    const { tenant, adminUser } = await factory.createTenant({
      tenantId: "admins-legacy-test",
      adminName: "cn=admin/o=admins-legacy",
      adminPassword,
      userName: "cn=alice/o=admins-legacy",
      userPassword,
    });
    const directoryDb = await tenant.openDB("directory", { adminOnlyDb: true });
    const doc = await directoryDb.getDocument(TENANT_SETUP_DOC_ID);
    await directoryDb.changeDoc(
      doc,
      (d) => {
        delete (d.getData() as { administrators?: unknown[] }).administrators;
      },
      {
        signingKeyPair: adminUser.userSigningKeyPair,
        signingKeyPassword: adminPassword,
      },
    );
    expect(await readTenantSetupAdministrators(directoryDb, tenant)).toEqual([]);
  }, 120000);
});
