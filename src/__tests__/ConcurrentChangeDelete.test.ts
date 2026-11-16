/**
 * One person edits a document while another person deletes it, each on their own
 * replica, and only then do the replicas sync. Expected outcome, whatever order the
 * entries arrive in:
 *
 * - the delete wins: the document is deleted on both replicas, with no conflict
 *   marker and nothing left in the live listings;
 * - the edit is not lost: it is merged into the document's content, so it shows up
 *   in the deleted snapshot, in the document history, and again after an undelete.
 */
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { KeyBag } from "../core/keys/KeyBag";
import {
  DEFAULT_TENANT_KEY_ID,
  PUBLIC_INFOS_KEY_ID,
  type MindooDB,
  type MindooTenant,
  type PrivateUserId,
} from "../core/types";

type SyncOrder = "editor first" | "deleter first";

describe("concurrent change and delete on two replicas", () => {
  const tenantId = "concurrent-change-delete";
  const adminPassword = "admin-pass-123";
  const editorPassword = "editor-pass-123";
  const deleterPassword = "deleter-pass-123";
  let editorTenant: MindooTenant;
  let deleterTenant: MindooTenant;
  let editorDb: MindooDB;
  let deleterDb: MindooDB;

  beforeEach(async () => {
    const crypto = new NodeCryptoAdapter();
    const editorFactory = new BaseMindooTenantFactory(new InMemoryContentAddressedStoreFactory(), crypto);
    const deleterFactory = new BaseMindooTenantFactory(new InMemoryContentAddressedStoreFactory(), crypto);
    const admin: PrivateUserId = await editorFactory.createUserId("CN=admin/O=change-delete", adminPassword);
    const editor: PrivateUserId = await editorFactory.createUserId("CN=editor/O=change-delete", editorPassword);
    const deleter: PrivateUserId = await deleterFactory.createUserId("CN=deleter/O=change-delete", deleterPassword);

    const editorBag = new KeyBag(editor.userEncryptionKeyPair.privateKey, editorPassword, crypto);
    await editorBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await editorBag.createTenantKey(tenantId);
    editorTenant = await editorFactory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      editor,
      editorPassword,
      editorBag,
    );
    const directory = await editorTenant.openDirectory();
    await directory.registerUser(editorFactory.toPublicUserId(editor), admin.userSigningKeyPair.privateKey, adminPassword);
    await directory.registerUser(deleterFactory.toPublicUserId(deleter), admin.userSigningKeyPair.privateKey, adminPassword);

    // A second person with their own stores and the shared tenant keys.
    const deleterBag = new KeyBag(deleter.userEncryptionKeyPair.privateKey, deleterPassword, crypto);
    for (const keyId of [PUBLIC_INFOS_KEY_ID, DEFAULT_TENANT_KEY_ID]) {
      await deleterBag.set("doc", tenantId, keyId, (await editorBag.get("doc", tenantId, keyId))!);
    }
    deleterTenant = await deleterFactory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      deleter,
      deleterPassword,
      deleterBag,
    );
    await (await deleterTenant.openDB("directory")).pullChangesFrom((await editorTenant.openDB("directory")).getStore());

    editorDb = await editorTenant.openDB("main");
    deleterDb = await deleterTenant.openDB("main");
  }, 60000);

  afterEach(async () => {
    for (const tenant of [editorTenant, deleterTenant]) {
      await (tenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
    }
  });

  /** Both replicas start from the same synced document. */
  async function sharedDocument(): Promise<string> {
    const doc = await editorDb.createDocument();
    await editorDb.changeDoc(doc, (d) => {
      d.getData().title = "Original";
      d.getData().status = "draft";
    });
    await deleterDb.pullChangesFrom(editorDb.getStore());
    expect((await deleterDb.getDocument(doc.getId())).getData().title).toBe("Original");
    return doc.getId();
  }

  async function sync(order: SyncOrder) {
    if (order === "editor first") {
      await deleterDb.pullChangesFrom(editorDb.getStore());
      await editorDb.pullChangesFrom(deleterDb.getStore());
    } else {
      await editorDb.pullChangesFrom(deleterDb.getStore());
      await deleterDb.pullChangesFrom(editorDb.getStore());
    }
  }

  async function expectDeletedWithEdit(db: MindooDB, docId: string, editCreatedAt: number) {
    // Deleted, and no trace of a conflict in the live view.
    expect(await db.getAllDocumentIds()).not.toContain(docId);
    expect(await db.getDeletedDocumentIds()).toContain(docId);
    await expect(db.getDocument(docId)).rejects.toThrow(/deleted/);

    // The edit is merged into the deleted snapshot.
    const snapshot = (await db.getDocumentAtTimestamp(docId, Date.now()))!;
    expect(snapshot.isDeleted()).toBe(true);
    expect(snapshot.getData()).toMatchObject({ title: "Edited", status: "draft", note: "added while deleting" });

    // Both the edit and the delete are in the history, and the timeline ends deleted.
    // (A history entry's isDeleted is the state at that point of the timeline, so the
    // edit entry reads as deleted when it was made after the delete.)
    const history = await db.getDocumentHistoryPage(docId, { limit: 100 });
    expect(history.entries.map((e) => e.entryType)).toEqual(expect.arrayContaining(["doc_change", "doc_delete"]));
    expect(history.entries.some((e) => e.entryType === "doc_change" && e.changeCreatedAt === editCreatedAt)).toBe(true);
    expect(history.entries.at(-1)!.isDeleted).toBe(true);
  }

  const cases: Array<{ order: SyncOrder; editAfterDelete: boolean }> = [
    { order: "editor first", editAfterDelete: false },
    { order: "deleter first", editAfterDelete: false },
    { order: "editor first", editAfterDelete: true },
    { order: "deleter first", editAfterDelete: true },
  ];

  it.each(cases)(
    "deletes on both replicas and keeps the edit (sync $order, edit after delete: $editAfterDelete)",
    async ({ order, editAfterDelete }) => {
      const docId = await sharedDocument();

      // Neither replica sees the other's entry yet. The timestamps of edit and
      // delete must not decide the outcome, so try both chronological orders.
      const edit = async () => {
        const doc = await editorDb.getDocument(docId);
        await editorDb.changeDoc(doc, (d) => {
          d.getData().title = "Edited";
          d.getData().note = "added while deleting";
        });
      };
      const remove = () => deleterDb.deleteDocument(docId);
      if (editAfterDelete) {
        await remove();
        await new Promise((resolve) => setTimeout(resolve, 5));
        await edit();
      } else {
        await edit();
        await new Promise((resolve) => setTimeout(resolve, 5));
        await remove();
      }
      const editorHistory = await editorDb.getDocumentHistoryPage(docId, { limit: 100 });
      const editCreatedAt = editorHistory.entries.filter((e) => e.entryType === "doc_change").at(-1)!.changeCreatedAt;

      await sync(order);

      await expectDeletedWithEdit(editorDb, docId, editCreatedAt);
      await expectDeletedWithEdit(deleterDb, docId, editCreatedAt);

      // Restoring on either side brings the document back with the edit in it,
      // and the restore reaches the other replica.
      await deleterDb.undeleteDocument(docId);
      const restored = await deleterDb.getDocument(docId);
      expect(restored.isDeleted()).toBe(false);
      expect(restored.getData()).toMatchObject({ title: "Edited", status: "draft", note: "added while deleting" });

      await editorDb.pullChangesFrom(deleterDb.getStore());
      const restoredOnEditor = await editorDb.getDocument(docId);
      expect(restoredOnEditor.isDeleted()).toBe(false);
      expect(restoredOnEditor.getData()).toMatchObject({ title: "Edited", note: "added while deleting" });
    },
    60000,
  );
});
