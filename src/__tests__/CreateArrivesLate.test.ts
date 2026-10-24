/**
 * A document's change entries can reach a replica before its `doc_create`: sync runs
 * transfer batches in parallel, and a server keeps the change of a document whose
 * create it refused (docs/accesscontrol.md §10). Until the create arrives the
 * document must not exist for the replica's readers; once it arrives, the document
 * must appear, and the changefeeds must report it, so indexes and apps pick it up.
 */
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { KeyBag } from "../core/keys/KeyBag";
import { DEFAULT_TENANT_KEY_ID, PUBLIC_INFOS_KEY_ID, type MindooDB, type MindooTenant, type PrivateUserId } from "../core/types";

describe("a document whose create arrives after its changes", () => {
  const tenantId = "late-create";
  const password = "pass-123";
  let writer: MindooTenant;
  let reader: MindooTenant;

  beforeEach(async () => {
    const crypto = new NodeCryptoAdapter();
    const writerFactory = new BaseMindooTenantFactory(new InMemoryContentAddressedStoreFactory(), crypto);
    const readerFactory = new BaseMindooTenantFactory(new InMemoryContentAddressedStoreFactory(), crypto);
    const admin: PrivateUserId = await writerFactory.createUserId("CN=admin/O=late-create", password);
    const user: PrivateUserId = await writerFactory.createUserId("CN=user/O=late-create", password);
    const writerBag = new KeyBag(user.userEncryptionKeyPair.privateKey, password, crypto);
    await writerBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await writerBag.createTenantKey(tenantId);
    writer = await writerFactory.openTenant(tenantId, admin.userSigningKeyPair.publicKey, admin.userEncryptionKeyPair.publicKey, user, password, writerBag);
    const directory = await writer.openDirectory();
    await directory.registerUser(writerFactory.toPublicUserId(user), admin.userSigningKeyPair.privateKey, password);

    // The same person on a second device: same keys, its own stores.
    const readerBag = new KeyBag(user.userEncryptionKeyPair.privateKey, password, crypto);
    for (const keyId of [PUBLIC_INFOS_KEY_ID, DEFAULT_TENANT_KEY_ID]) {
      await readerBag.set("doc", tenantId, keyId, (await writerBag.get("doc", tenantId, keyId))!);
    }
    reader = await readerFactory.openTenant(tenantId, admin.userSigningKeyPair.publicKey, admin.userEncryptionKeyPair.publicKey, user, password, readerBag);
    const readerDirectory = await reader.openDB("directory");
    await readerDirectory.pullChangesFrom((await writer.openDB("directory")).getStore());
    await readerDirectory.syncStoreChanges();
  }, 60000);

  /** Copies the entries of `docId` of the given types from the writer's store to the reader's. */
  async function copy(from: MindooDB, to: MindooDB, docId: string, types: string[]) {
    const metas = (await from.getStore().findNewEntries([])).filter((m) => m.docId === docId && types.includes(m.entryType));
    expect(metas.length).toBeGreaterThan(0);
    await to.getStore().putEntries(await from.getStore().getEntries(metas.map((m) => m.id)));
    await to.syncStoreChanges();
  }

  async function feedIds(db: MindooDB, cursor: Parameters<MindooDB["iterateChangesSince"]>[0]) {
    const ids: string[] = [];
    let last = cursor;
    for await (const change of db.iterateChangesSince(cursor)) {
      ids.push(change.doc.getId());
      last = change.cursor;
    }
    return { ids, last };
  }

  async function metadataIds(db: MindooDB, cursor: Parameters<MindooDB["iterateChangeMetadataSince"]>[0]) {
    const ids: string[] = [];
    let last = cursor;
    for await (const change of db.iterateChangeMetadataSince(cursor)) {
      if (!change.isDeleted) ids.push(change.docId);
      last = change.cursor;
    }
    return { ids, last };
  }

  it("stays invisible without its create, then appears in the document list and both feeds", async () => {
    const source = await writer.openDB("main");
    const doc = await source.createDocument();
    await source.changeDoc(doc, (d) => {
      d.getData().title = "late";
    });
    const docId = doc.getId();

    const target = await reader.openDB("main");
    const before = await feedIds(target, null);
    const metaBefore = await metadataIds(target, null);

    // The change alone: no document yet.
    await copy(source, target, docId, ["doc_change"]);
    expect(await target.getAllDocumentIds()).not.toContain(docId);
    const afterChange = await feedIds(target, before.last);
    expect(afterChange.ids).not.toContain(docId);
    const metaAfterChange = await metadataIds(target, metaBefore.last);
    expect(metaAfterChange.ids).not.toContain(docId);

    // The create arrives: the document exists with both entries applied, and the
    // feeds report it to whoever resumes from where they stopped.
    await copy(source, target, docId, ["doc_create"]);
    expect(await target.getAllDocumentIds()).toContain(docId);
    expect((await target.getDocument(docId)).getData().title).toBe("late");
    expect((await feedIds(target, afterChange.last)).ids).toContain(docId);
    expect((await metadataIds(target, metaAfterChange.last)).ids).toContain(docId);
  }, 60000);
});
