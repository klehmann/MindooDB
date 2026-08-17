import { BaseMindooTenantFactory } from "../../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStore } from "../../core/appendonlystores/InMemoryContentAddressedStore";
import {
  ContentAddressedStoreFactory,
  CreateStoreResult,
  DEFAULT_TENANT_KEY_ID,
  MindooTenant,
  OpenStoreOptions,
  PrivateUserId,
  PUBLIC_INFOS_KEY_ID,
  StoreKind,
} from "../../core/types";
import { KeyBag } from "../../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../../node/crypto/NodeCryptoAdapter";

/**
 * Isolated in-memory store namespace. Each replica (device) gets its own
 * factory so they only converge through explicit {@link syncAll} pushes,
 * matching two real devices that share keys but not storage.
 */
export class IsolatedInMemoryStoreFactory implements ContentAddressedStoreFactory {
  private docStores = new Map<string, InMemoryContentAddressedStore>();
  private attachmentStores = new Map<string, InMemoryContentAddressedStore>();

  createStore(dbId: string, options?: OpenStoreOptions): CreateStoreResult {
    let docStore = this.docStores.get(dbId);
    if (!docStore) {
      docStore = new InMemoryContentAddressedStore(dbId, StoreKind.docs, undefined, options);
      this.docStores.set(dbId, docStore);
    }
    let attachmentStore = this.attachmentStores.get(dbId);
    if (!attachmentStore) {
      attachmentStore = new InMemoryContentAddressedStore(
        dbId,
        StoreKind.attachments,
        undefined,
        options,
      );
      this.attachmentStores.set(dbId, attachmentStore);
    }
    return { docStore, attachmentStore };
  }
}

export interface DeviceHandle {
  label: string;
  username: string;
  user: PrivateUserId;
  password: string;
  tenant: MindooTenant;
  factory: BaseMindooTenantFactory;
  storeFactory: IsolatedInMemoryStoreFactory;
  keyBag: KeyBag;
}

export interface MultiDeviceFixture {
  tenantId: string;
  crypto: NodeCryptoAdapter;
  adminUser: PrivateUserId;
  adminPassword: string;
  /** Host replica opened as a non-admin operator (admin identity cannot be currentUser). */
  host: DeviceHandle;
  devices: DeviceHandle[];
}

async function seedKeyBag(
  user: PrivateUserId,
  password: string,
  crypto: NodeCryptoAdapter,
  tenantId: string,
  source: KeyBag,
): Promise<KeyBag> {
  const keyBag = new KeyBag(user.userEncryptionKeyPair.privateKey, password, crypto);
  await keyBag.set(
    "doc",
    tenantId,
    PUBLIC_INFOS_KEY_ID,
    (await source.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!,
  );
  await keyBag.set(
    "doc",
    tenantId,
    DEFAULT_TENANT_KEY_ID,
    (await source.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!,
  );
  return keyBag;
}

/**
 * Host replica with `$publicinfos` + `default` and the admin registered in
 * the directory. The host is opened as a bootstrap operator, not the admin
 * identity.
 */
export async function makeTenant(opts?: { tenantId?: string }): Promise<MultiDeviceFixture> {
  const tenantId = opts?.tenantId ?? "tenant-multidevice";
  const crypto = new NodeCryptoAdapter();
  const storeFactory = new IsolatedInMemoryStoreFactory();
  const factory = new BaseMindooTenantFactory(storeFactory, crypto);
  const adminPassword = "admin-pass-123";
  const adminUser = await factory.createUserId(`CN=admin/O=${tenantId}`, adminPassword);
  const adminKeyBag = new KeyBag(adminUser.userEncryptionKeyPair.privateKey, adminPassword, crypto);
  await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
  await adminKeyBag.createTenantKey(tenantId);

  const operatorPassword = "operator-pass-123";
  const operator = await factory.createUserId(`CN=operator/O=${tenantId}`, operatorPassword);
  const operatorKeyBag = await seedKeyBag(
    operator,
    operatorPassword,
    crypto,
    tenantId,
    adminKeyBag,
  );

  const tenant = await factory.openTenant(
    tenantId,
    adminUser.userSigningKeyPair.publicKey,
    adminUser.userEncryptionKeyPair.publicKey,
    operator,
    operatorPassword,
    operatorKeyBag,
  );
  const directory = await tenant.openDirectory();
  await directory.registerUser(
    factory.toPublicUserId(adminUser),
    adminUser.userSigningKeyPair.privateKey,
    adminPassword,
  );
  await directory.registerUser(
    factory.toPublicUserId(operator),
    adminUser.userSigningKeyPair.privateKey,
    adminPassword,
    undefined,
    "host",
  );

  const host: DeviceHandle = {
    label: "host",
    username: operator.username,
    user: operator,
    password: operatorPassword,
    tenant,
    factory,
    storeFactory,
    keyBag: operatorKeyBag,
  };
  return { tenantId, crypto, adminUser, adminPassword, host, devices: [] };
}

/**
 * First device of a new person: isolated store, KeyBag seeded from the host,
 * grant created via `registerUser`.
 */
export async function addPerson(
  fixture: MultiDeviceFixture,
  commonName: string,
  label = "device-1",
): Promise<DeviceHandle> {
  const storeFactory = new IsolatedInMemoryStoreFactory();
  const factory = new BaseMindooTenantFactory(storeFactory, fixture.crypto);
  const password = `${commonName}-pass-123`;
  const user = await factory.createUserId(`CN=${commonName}/O=${fixture.tenantId}`, password);
  const keyBag = await seedKeyBag(user, password, fixture.crypto, fixture.tenantId, fixture.host.keyBag);
  const tenant = await factory.openTenant(
    fixture.tenantId,
    fixture.adminUser.userSigningKeyPair.publicKey,
    fixture.adminUser.userEncryptionKeyPair.publicKey,
    user,
    password,
    keyBag,
  );
  const directory = await fixture.host.tenant.openDirectory();
  await directory.registerUser(
    factory.toPublicUserId(user),
    fixture.adminUser.userSigningKeyPair.privateKey,
    fixture.adminPassword,
    undefined,
    label,
  );
  const handle: DeviceHandle = {
    label,
    username: user.username,
    user,
    password,
    tenant,
    factory,
    storeFactory,
    keyBag,
  };
  fixture.devices.push(handle);
  return handle;
}

/**
 * Additional device of an existing person: `factory.createUserId` with the
 * same DN, then `directory.addUserKeys`.
 */
export async function addDevice(
  fixture: MultiDeviceFixture,
  existing: DeviceHandle,
  label: string,
): Promise<DeviceHandle> {
  const storeFactory = new IsolatedInMemoryStoreFactory();
  const factory = new BaseMindooTenantFactory(storeFactory, fixture.crypto);
  const password = `${label}-pass-123`;
  const user = await factory.createUserId(existing.user.username, password);
  const keyBag = await seedKeyBag(user, password, fixture.crypto, fixture.tenantId, fixture.host.keyBag);
  const tenant = await factory.openTenant(
    fixture.tenantId,
    fixture.adminUser.userSigningKeyPair.publicKey,
    fixture.adminUser.userEncryptionKeyPair.publicKey,
    user,
    password,
    keyBag,
  );
  const directory = await fixture.host.tenant.openDirectory();
  await directory.addUserKeys!(
    existing.username,
    [
      {
        signingPublicKey: user.userSigningKeyPair.publicKey,
        encryptionPublicKey: user.userEncryptionKeyPair.publicKey,
        label,
      },
    ],
    fixture.adminUser.userSigningKeyPair.privateKey,
    fixture.adminPassword,
  );
  const handle: DeviceHandle = {
    label,
    username: existing.username,
    user,
    password,
    tenant,
    factory,
    storeFactory,
    keyBag,
  };
  fixture.devices.push(handle);
  return handle;
}

/** n-way push of `dbId` across the given replicas (host + devices by default). */
export async function syncAll(
  fixture: MultiDeviceFixture,
  dbId: string,
  replicas?: DeviceHandle[],
): Promise<void> {
  const devices = replicas ?? [fixture.host, ...fixture.devices];
  for (const source of devices) {
    for (const target of devices) {
      if (source === target) continue;
      const sourceDb = await source.tenant.openDB(dbId);
      const targetDb = await target.tenant.openDB(dbId);
      await sourceDb.pushChangesTo(targetDb.getStore());
      await targetDb.syncStoreChanges();
    }
  }
}

export async function revokeDevice(
  fixture: MultiDeviceFixture,
  username: string,
  signingPublicKey: string,
): Promise<void> {
  const directory = await fixture.host.tenant.openDirectory();
  await directory.updateUserGrant!(
    username,
    { revokeSigningKeys: [signingPublicKey] },
    fixture.adminUser.userSigningKeyPair.privateKey,
    fixture.adminPassword,
  );
}

export async function restoreDevice(
  fixture: MultiDeviceFixture,
  username: string,
  signingPublicKey: string,
): Promise<void> {
  const directory = await fixture.host.tenant.openDirectory();
  await directory.updateUserGrant!(
    username,
    { restoreSigningKeys: [signingPublicKey] },
    fixture.adminUser.userSigningKeyPair.privateKey,
    fixture.adminPassword,
  );
}
