/**
 * Tenant setup label is field-encrypted under `default` so the sync server
 * (which only holds `$publicinfos`) cannot read the display name.
 */
import { describe, expect, test } from "@jest/globals";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { DEFAULT_TENANT_KEY_ID, PUBLIC_INFOS_KEY_ID, TENANT_SETUP_DOC_ID } from "../core/types";
import { readTenantSetupLabel, writeTenantSetupLabel } from "../core/tenantSetup";
import { isValidTenantId } from "../core/tenantIdValidation";

describe("tenantsetup label encryption", () => {
  jest.setTimeout(120000);
  const adminName = "cn=admin/o=label-test";
  const adminPassword = "admin-pass-123";
  const userName = "cn=alice/o=label-test";
  const userPassword = "alice-pass-123";

  test("stores label_encrypted under default; plaintext label is cleared", async () => {
    const factory = new BaseMindooTenantFactory(
      new InMemoryContentAddressedStoreFactory(),
      new NodeCryptoAdapter(),
    );
    const { tenant, adminUser } = await factory.createTenant({
      tenantId: "label-enc-test",
      adminName,
      adminPassword,
      userName,
      userPassword,
      tenantLabel: "Secret Org Name",
    });

    const directoryDb = await tenant.openDB("directory", { adminOnlyDb: true });
    const label = await readTenantSetupLabel(directoryDb, tenant);
    expect(label).toBe("Secret Org Name");

    const doc = await directoryDb.getDocument(TENANT_SETUP_DOC_ID);
    const data = doc.getData() as Record<string, unknown>;
    expect(typeof data.label_encrypted).toBe("string");
    expect(data.label_encrypted_key).toBe("default");
    expect(data.label).toBeUndefined();

    await writeTenantSetupLabel(
      directoryDb,
      "Renamed Org",
      adminUser.userSigningKeyPair,
      adminPassword,
      tenant,
    );
    expect(await readTenantSetupLabel(directoryDb, tenant)).toBe("Renamed Org");
    const updated = (await directoryDb.getDocument(TENANT_SETUP_DOC_ID)).getData() as Record<
      string,
      unknown
    >;
    expect(updated.label).toBeUndefined();

    // Without `default`, the encrypted label is unreadable (server/$publicinfos-only bag).
    await tenant.removeNamedDecryptionKey(DEFAULT_TENANT_KEY_ID);
    expect(await readTenantSetupLabel(directoryDb, tenant)).toBeUndefined();
  }, 120000);

  test("legacy plaintext label is still readable", async () => {
    const factory = new BaseMindooTenantFactory(
      new InMemoryContentAddressedStoreFactory(),
      new NodeCryptoAdapter(),
    );
    const { tenant, adminUser } = await factory.createTenant({
      tenantId: "label-legacy-test",
      adminName: "cn=admin/o=label-legacy",
      adminPassword,
      userName: "cn=alice/o=label-legacy",
      userPassword,
    });
    const directoryDb = await tenant.openDB("directory", { adminOnlyDb: true });
    const doc = await directoryDb.createDocument({
      id: TENANT_SETUP_DOC_ID,
      signingKeyPair: adminUser.userSigningKeyPair,
      signingKeyPassword: adminPassword,
      decryptionKeyId: PUBLIC_INFOS_KEY_ID,
    });
    await directoryDb.changeDoc(
      doc,
      (d) => {
        (d.getData() as { label?: string }).label = "Legacy Plain";
      },
      {
        signingKeyPair: adminUser.userSigningKeyPair,
        signingKeyPassword: adminPassword,
      },
    );
    expect(await readTenantSetupLabel(directoryDb, tenant)).toBe("Legacy Plain");
  }, 120000);

  test("device is a reserved tenant id", () => {
    expect(isValidTenantId("device")).toBe(false);
    expect(isValidTenantId("my-device")).toBe(true);
  });
});
