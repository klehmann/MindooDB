import * as Automerge from "@automerge/automerge";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { KeyBag } from "../core/keys/KeyBag";
import {
  type MindooDB,
  type MindooTenant,
  type PrivateUserId,
  PUBLIC_INFOS_KEY_ID,
} from "../core/types";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

describe("Automerge binary export and apply", () => {
  let factory: BaseMindooTenantFactory;
  let adminUser: PrivateUserId;
  let adminUserPassword: string;
  let currentUser: PrivateUserId;
  let currentUserPassword: string;
  let keyBag: KeyBag;
  let tenant: MindooTenant;
  let db: MindooDB;

  beforeEach(async () => {
    factory = new BaseMindooTenantFactory(new InMemoryContentAddressedStoreFactory(), new NodeCryptoAdapter());
    adminUserPassword = createTestSecret("admin");
    adminUser = await factory.createUserId("CN=admin/O=automergebinary", adminUserPassword);
    currentUserPassword = createTestSecret("user");
    currentUser = await factory.createUserId("CN=testuser/O=automergebinary", currentUserPassword);
    keyBag = new KeyBag(currentUser.userEncryptionKeyPair.privateKey, currentUserPassword, factory.getCryptoAdapter());

    const tenantId = "test-tenant-automergebinary";
    await keyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await keyBag.createTenantKey(tenantId);
    tenant = await factory.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      currentUser,
      currentUserPassword,
      keyBag,
    );

    const directory = await tenant.openDirectory();
    const publicUser = factory.toPublicUserId(currentUser);
    await directory.registerUser(publicUser, adminUser.userSigningKeyPair.privateKey, adminUserPassword);
    db = await tenant.openDB("test-db");
  }, 30000);

  afterEach(async () => {
    await (tenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
  });

  it("exports a binary snapshot and merges concurrent local changes", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (draft) => {
      draft.getData().body = "Hello";
    });

    const snapshot = await db.exportAutomergeSnapshot(doc);
    expect(snapshot.binary.byteLength).toBeGreaterThan(0);
    expect(snapshot.heads.length).toBeGreaterThan(0);

    let replica = Automerge.load<{ body: string; subject?: string }>(snapshot.binary, { actor: "replica-a" });
    const baseHeads = [...snapshot.heads];

    replica = Automerge.change(replica, (draft) => {
      Automerge.updateSpans(draft, ["body"], [{ type: "text", value: "Hello world" }]);
    });

    await db.changeDoc(doc, (draft) => {
      draft.getData().subject = "Concurrent metadata";
    });

    const changes = Automerge.getChangesSince(replica, baseHeads as Automerge.Heads);
    expect(changes.length).toBeGreaterThan(0);

    const result = await db.applyAutomergeChanges(doc, {
      baseHeads,
      changes,
    });

    expect(result.data.body).toBe("Hello world");
    expect(result.data.subject).toBe("Concurrent metadata");
  }, 30000);
});

function createTestSecret(label: string) {
  return `${label}-password-${Math.random().toString(36).slice(2)}`;
}
