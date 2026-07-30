/**
 * Shared setup for the document-copy test suites.
 *
 * Every copy scenario needs at least two databases, and half of them need two
 * tenants, so the boilerplate is factored out here rather than repeated four
 * times. Tenants get independent store factories so a cross-tenant copy really
 * crosses a storage boundary, exactly as it would in production.
 */

import { BaseMindooTenantFactory } from "../../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../../appendonlystores/InMemoryContentAddressedStoreFactory";
import { KeyBag } from "../../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../../node/crypto/NodeCryptoAdapter";
import {
  PUBLIC_INFOS_KEY_ID,
  type MindooDB,
  type MindooTenant,
  type PrivateUserId,
} from "../../core/types";

/** One fully provisioned tenant with a registered user. */
export interface CopyTestTenant {
  tenantId: string;
  tenant: MindooTenant;
  factory: BaseMindooTenantFactory;
  storeFactory: InMemoryContentAddressedStoreFactory;
  user: PrivateUserId;
  userPassword: string;
  keyBag: KeyBag;
  /** Ed25519 public key the tenant's user signs entries with. */
  signingPublicKey: string;
  openDB(dbId: string, options?: Record<string, unknown>): Promise<MindooDB>;
  dispose(): Promise<void>;
}

/**
 * Create a tenant with its own store factory, an admin, a registered user and
 * the tenant key.
 *
 * @param tenantId Unique tenant id for the test.
 * @param extraKeyIds Additional named symmetric keys to provision, for the
 *   scenarios that copy between different `decryptionKeyId`s.
 */
export async function createCopyTestTenant(
  tenantId: string,
  extraKeyIds: string[] = [],
): Promise<CopyTestTenant> {
  const storeFactory = new InMemoryContentAddressedStoreFactory();
  const factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());

  const adminPassword = "adminpass123";
  const admin = await factory.createUserId(`CN=admin/O=${tenantId}`, adminPassword);
  const userPassword = "userpassword123";
  const user = await factory.createUserId(`CN=user/O=${tenantId}`, userPassword);

  const keyBag = new KeyBag(
    user.userEncryptionKeyPair.privateKey,
    userPassword,
    factory.getCryptoAdapter(),
  );
  await keyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
  await keyBag.createTenantKey(tenantId);
  for (const keyId of extraKeyIds) {
    await keyBag.createDocKey(tenantId, keyId);
  }

  const tenant = await factory.openTenant(
    tenantId,
    admin.userSigningKeyPair.publicKey,
    admin.userEncryptionKeyPair.publicKey,
    user,
    userPassword,
    keyBag,
  );

  const directory = await tenant.openDirectory();
  await directory.registerUser(
    factory.toPublicUserId(user),
    admin.userSigningKeyPair.privateKey,
    adminPassword,
  );

  return {
    tenantId,
    tenant,
    factory,
    storeFactory,
    user,
    userPassword,
    keyBag,
    signingPublicKey: user.userSigningKeyPair.publicKey,
    openDB: (dbId, options) => tenant.openDB(dbId, options as never),
    dispose: async () => {
      await (tenant as unknown as { disposeCacheManager?: () => Promise<void> })
        .disposeCacheManager?.();
    },
  };
}

/** Create a document with the given fields and revise it `revisions` times. */
export async function seedDocument(
  db: MindooDB,
  fields: Record<string, unknown>,
  revisions = 0,
  options?: { idPrefix?: string; decryptionKeyId?: string },
): Promise<string> {
  const doc = await db.createDocument({
    idPrefix: options?.idPrefix,
    decryptionKeyId: options?.decryptionKeyId,
  });
  await db.changeDoc(doc, (draft) => {
    Object.assign(draft.getData(), fields);
  });
  for (let revision = 1; revision <= revisions; revision++) {
    await db.changeDoc(doc, (draft) => {
      draft.getData().revision = revision;
    });
  }
  return doc.getId();
}

/** All store entries a database holds for one document, oldest first. */
export async function docEntries(db: MindooDB, docId: string) {
  const entries = await db.getStore().findNewEntriesForDoc([], docId);
  return entries.sort((left, right) => left.createdAt - right.createdAt);
}
