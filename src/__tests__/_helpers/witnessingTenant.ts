import { BaseMindooTenantFactory } from "../../core/BaseMindooTenantFactory";
import {
  DEFAULT_TENANT_KEY_ID,
  MindooTenant,
  MindooTenantDirectory,
  PrivateUserId,
  PUBLIC_INFOS_KEY_ID,
} from "../../core/types";
import { KeyBag } from "../../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../../node/crypto/NodeCryptoAdapter";
import { WitnessingInMemoryContentAddressedStoreFactory } from "./witnessingStore";

export interface WitnessingTenantContext {
  tenant: MindooTenant;
  factory: BaseMindooTenantFactory;
  storeFactory: WitnessingInMemoryContentAddressedStoreFactory;
  directory: MindooTenantDirectory;
  adminUser: PrivateUserId;
  adminUserPassword: string;
  currentUser: PrivateUserId;
  currentUserPassword: string;
}

/**
 * Build a fully-initialized tenant backed by the {@link
 * WitnessingInMemoryContentAddressedStoreFactory}, so every persisted entry is
 * stamped with a monotonic `receivedAt` (the access-control trusted time). This
 * gives deterministic, distinct, increasing trusted times for time-travel tests
 * without a real witness/server.
 */
export async function createWitnessingTenant(
  tenantId = "test-tenant-witnessing",
): Promise<WitnessingTenantContext> {
  const storeFactory = new WitnessingInMemoryContentAddressedStoreFactory();
  const factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());

  const adminUserPassword = "adminpass123";
  const adminUser = await factory.createUserId("CN=admin/O=witnessing", adminUserPassword);
  const currentUserPassword = "currentpass123";
  const currentUser = await factory.createUserId("CN=current/O=witnessing", currentUserPassword);

  const cryptoAdapter = new NodeCryptoAdapter();
  const adminKeyBag = new KeyBag(adminUser.userEncryptionKeyPair.privateKey, adminUserPassword, cryptoAdapter);
  const currentUserKeyBag = new KeyBag(
    currentUser.userEncryptionKeyPair.privateKey,
    currentUserPassword,
    cryptoAdapter,
  );

  await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
  await adminKeyBag.createTenantKey(tenantId);
  await currentUserKeyBag.set(
    "doc",
    tenantId,
    PUBLIC_INFOS_KEY_ID,
    (await adminKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!,
  );
  await currentUserKeyBag.set(
    "doc",
    tenantId,
    DEFAULT_TENANT_KEY_ID,
    (await adminKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!,
  );

  const tenant = await factory.openTenant(
    tenantId,
    adminUser.userSigningKeyPair.publicKey,
    adminUser.userEncryptionKeyPair.publicKey,
    currentUser,
    currentUserPassword,
    currentUserKeyBag,
  );

  const directory = await tenant.openDirectory();
  await directory.registerUser(factory.toPublicUserId(adminUser), adminUser.userSigningKeyPair.privateKey, adminUserPassword);
  await directory.registerUser(factory.toPublicUserId(currentUser), adminUser.userSigningKeyPair.privateKey, adminUserPassword);

  return {
    tenant,
    factory,
    storeFactory,
    directory,
    adminUser,
    adminUserPassword,
    currentUser,
    currentUserPassword,
  };
}
