import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import {
  PrivateUserId,
  MindooTenant,
  DEFAULT_TENANT_KEY_ID,
  PUBLIC_INFOS_KEY_ID,
  StoreKind,
} from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { BasicOnDiskContentAddressedStore } from "../node/appendonlystores/BasicOnDiskContentAddressedStore";

/**
 * Reproduces the "user 1 stops receiving user 2's changes until browser
 * reload" bug observed with two Haven clients auto-pushing/SSE-pulling
 * against the same server tenant.
 *
 * Root cause: in `BasicOnDiskContentAddressedStore.putEntries` the
 * `receiptOrder` is assigned synchronously (`this.nextReceiptOrder++`), but
 * the entry only becomes visible to `scanEntriesSince` after an awaited
 * metadata file write. Two concurrent `putEntries` calls (e.g. both users
 * auto-pushing at the same time, or the up-to-3 parallel transfer batches of
 * a single push) can therefore make an entry with receiptOrder N+1 visible
 * BEFORE the entry with receiptOrder N. A pull scan running in exactly that
 * window persists its sync cursor beyond N — and since cursor scans only ever
 * move forward, entry N is never delivered to that client again:
 *
 * - the entry is permanently missing from the client's local store,
 * - later changes depending on it stay "pending" in Automerge (stale doc),
 * - the DAG explorer prunes the ungrounded branch (flat, single-line DAG),
 * - a reload "fixes" it because the in-memory sync scan cursor is discarded
 *   and the full re-scan finds the hole.
 *
 * The test deterministically forces the interleaving by gating the metadata
 * file write of user 2's change entry inside the shared on-disk "server"
 * store while user 1's change lands and user 1 pulls.
 */
describe("receipt-order visibility race during concurrent push + pull scan", () => {
  jest.setTimeout(30000);

  let tempDir: string;
  let storeFactory1: InMemoryContentAddressedStoreFactory;
  let storeFactory2: InMemoryContentAddressedStoreFactory;
  let factory1: BaseMindooTenantFactory;
  let factory2: BaseMindooTenantFactory;

  let user1: PrivateUserId;
  let user1Password: string;
  let user1KeyBag: KeyBag;

  let user2: PrivateUserId;
  let user2Password: string;
  let user2KeyBag: KeyBag;

  let adminUser: PrivateUserId;
  let adminUserPassword: string;

  let tenantId: string;
  let tenantEncryptionKey: Uint8Array;
  let publicInfosKey: Uint8Array;

  let tenant1: MindooTenant;
  let tenant2: MindooTenant;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "mindoodb-race-test-"));

    storeFactory1 = new InMemoryContentAddressedStoreFactory();
    storeFactory2 = new InMemoryContentAddressedStoreFactory();

    const cryptoAdapter = new NodeCryptoAdapter();
    factory1 = new BaseMindooTenantFactory(storeFactory1, cryptoAdapter);
    factory2 = new BaseMindooTenantFactory(storeFactory2, cryptoAdapter);

    user1Password = "user1pass123";
    user1 = await factory1.createUserId("CN=user1/O=testtenant", user1Password);
    user1KeyBag = new KeyBag(
      user1.userEncryptionKeyPair.privateKey,
      user1Password,
      cryptoAdapter
    );

    user2Password = "user2pass123";
    user2 = await factory2.createUserId("CN=user2/O=testtenant", user2Password);
    user2KeyBag = new KeyBag(
      user2.userEncryptionKeyPair.privateKey,
      user2Password,
      cryptoAdapter
    );

    adminUserPassword = "adminpass123";
    adminUser = await factory1.createUserId("CN=admin/O=testtenant", adminUserPassword);

    tenantId = "race-test-tenant";
    await user1KeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    publicInfosKey = (await user1KeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!;

    await user1KeyBag.createTenantKey(tenantId);
    tenantEncryptionKey = (await user1KeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!;
    tenant1 = await factory1.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      user1,
      user1Password,
      user1KeyBag
    );

    const directory1 = await tenant1.openDirectory();
    await directory1.registerUser(
      factory1.toPublicUserId(user1),
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword
    );
    await directory1.registerUser(
      factory2.toPublicUserId(user2),
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword
    );

    await user2KeyBag.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, publicInfosKey);
    await user2KeyBag.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, tenantEncryptionKey);
    tenant2 = await factory2.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      user2,
      user2Password,
      user2KeyBag
    );

    const directory2 = await tenant2.openDB("directory");
    await directory2.pullChangesFrom((await tenant1.openDB("directory")).getStore());
  }, 30000);

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("a pull scan running while an earlier-receiptOrder entry is still being written must not permanently skip that entry", async () => {
    // Shared "server" store, same implementation the example MindooDB server
    // uses for file-backed tenants.
    const serverStore = new BasicOnDiskContentAddressedStore(
      "contacts",
      StoreKind.docs,
      undefined,
      { basePath: tempDir }
    );

    // --- Base state: user 1 creates the shared document and pushes it ---
    const contactsDB1 = await tenant1.openDB("contacts");
    const doc1 = await contactsDB1.createDocument();
    const docId = doc1.getId();
    await contactsDB1.changeDoc(doc1, async (d) => {
      d.getData().title = "shared doc";
    });
    await contactsDB1.pushChangesTo(serverStore);

    // User 2 pulls the base state from the server.
    const contactsDB2 = await tenant2.openDB("contacts");
    await contactsDB2.pullChangesFrom(serverStore);
    const doc2 = await contactsDB2.getDocument(docId);
    expect(doc2.getData().title).toBe("shared doc");

    // User 1 pulls once so a scan cursor for (server -> local1) is persisted.
    await contactsDB1.pullChangesFrom(serverStore);

    // --- Parallel edits (each user works without seeing the other's edit) ---
    const store1 = contactsDB1.getStore();
    const store2 = contactsDB2.getStore();

    const store2IdsBefore = new Set(await store2.getAllIds());
    await contactsDB2.changeDoc(doc2, async (d) => {
      d.getData().user2Edit = "hello from user2";
    });
    const user2EntryIds = (await store2.getAllIds()).filter(
      (id) => !store2IdsBefore.has(id)
    );
    expect(user2EntryIds.length).toBe(1);
    const user2EntryId = user2EntryIds[0];
    const user2Entries = await store2.getEntries([user2EntryId]);

    const store1IdsBefore = new Set(await store1.getAllIds());
    await contactsDB1.changeDoc(await contactsDB1.getDocument(docId), async (d) => {
      d.getData().user1Edit = "hello from user1";
    });
    const user1EntryIds = (await store1.getAllIds()).filter(
      (id) => !store1IdsBefore.has(id)
    );
    expect(user1EntryIds.length).toBe(1);
    const user1Entries = await store1.getEntries(user1EntryIds);

    // --- Force the race window on the server store ---
    // Gate the metadata file write of user 2's entry: its receiptOrder is
    // assigned synchronously inside putEntries, but the entry stays invisible
    // to scanEntriesSince until the gated write completes.
    type WriteFileAtomic = (filePath: string, data: Uint8Array | string) => Promise<void>;
    const storeInternals = serverStore as unknown as { writeFileAtomic: WriteFileAtomic };
    const originalWriteFileAtomic = storeInternals.writeFileAtomic.bind(serverStore);

    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => (releaseGate = resolve));
    let signalGateReached!: () => void;
    const gateReached = new Promise<void>((resolve) => (signalGateReached = resolve));
    const gatedFileNamePart = encodeURIComponent(user2EntryId);

    storeInternals.writeFileAtomic = async (filePath, data) => {
      if (filePath.includes(gatedFileNamePart)) {
        signalGateReached();
        await gate;
      }
      return originalWriteFileAtomic(filePath, data);
    };

    try {
      // User 2's auto-push arrives at the server first: receiptOrder is
      // assigned, but the write hangs (e.g. slow disk / large batch).
      const user2PushPromise = serverStore.putEntries(user2Entries);
      await gateReached;

      // User 1's auto-push arrives while user 2's write is still in flight.
      // Without write serialization it completes immediately and becomes
      // visible with a HIGHER receiptOrder than user 2's invisible entry.
      const user1PushPromise = serverStore.putEntries(user1Entries);
      await Promise.race([
        user1PushPromise,
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);

      // User 1's SSE-triggered pull runs in exactly this window. The scan
      // must not persist a cursor beyond user 2's still-invisible entry.
      await contactsDB1.pullChangesFrom(serverStore);

      // User 2's write completes.
      releaseGate();
      await user2PushPromise;
      await user1PushPromise;
    } finally {
      releaseGate();
      storeInternals.writeFileAtomic = originalWriteFileAtomic;
    }

    // Sanity: the server has BOTH edits.
    expect(await serverStore.hasEntries([user2EntryId])).toEqual([user2EntryId]);
    expect(await serverStore.hasEntries(user1EntryIds)).toEqual(user1EntryIds);

    // --- User 1 does a manual sync (same sequence Haven runs) ---
    await contactsDB1.pullChangesFrom(serverStore);
    await contactsDB1.syncStoreChanges();

    // User 2's entry must have arrived in user 1's local store...
    expect(await store1.hasEntries([user2EntryId])).toEqual([user2EntryId]);

    // ...and the materialized document must contain the merged state.
    const mergedDoc1 = await contactsDB1.getDocument(docId);
    expect(mergedDoc1.getData().user1Edit).toBe("hello from user1");
    expect(mergedDoc1.getData().user2Edit).toBe("hello from user2");

    // The other direction keeps working either way: user 2 pulls and merges
    // user 1's edit (this is the asymmetry observed in Haven).
    await contactsDB2.pullChangesFrom(serverStore);
    const mergedDoc2 = await contactsDB2.getDocument(docId);
    expect(mergedDoc2.getData().user1Edit).toBe("hello from user1");
    expect(mergedDoc2.getData().user2Edit).toBe("hello from user2");
  });

  it("follow-up changes depending on a skipped entry stay pending and the document remains stale (Haven symptom)", async () => {
    const serverStore = new BasicOnDiskContentAddressedStore(
      "contacts",
      StoreKind.docs,
      undefined,
      { basePath: path.join(tempDir, "stale-doc") }
    );

    const contactsDB1 = await tenant1.openDB("contacts");
    const doc1 = await contactsDB1.createDocument();
    const docId = doc1.getId();
    await contactsDB1.changeDoc(doc1, async (d) => {
      d.getData().title = "shared doc";
    });
    await contactsDB1.pushChangesTo(serverStore);

    const contactsDB2 = await tenant2.openDB("contacts");
    await contactsDB2.pullChangesFrom(serverStore);
    const doc2 = await contactsDB2.getDocument(docId);

    await contactsDB1.pullChangesFrom(serverStore);

    const store1 = contactsDB1.getStore();
    const store2 = contactsDB2.getStore();

    // User 2's first parallel edit — this is the entry that gets skipped.
    const idsBeforeEdit1 = new Set(await store2.getAllIds());
    await contactsDB2.changeDoc(doc2, async (d) => {
      d.getData().step = "user2 edit 1";
    });
    const skippedEntryId = (await store2.getAllIds()).filter(
      (id) => !idsBeforeEdit1.has(id)
    )[0];
    const skippedEntries = await store2.getEntries([skippedEntryId]);

    // User 1 edits in parallel.
    const store1IdsBefore = new Set(await store1.getAllIds());
    await contactsDB1.changeDoc(await contactsDB1.getDocument(docId), async (d) => {
      d.getData().user1Edit = "hello from user1";
    });
    const user1Entries = await store1.getEntries(
      (await store1.getAllIds()).filter((id) => !store1IdsBefore.has(id))
    );

    type WriteFileAtomic = (filePath: string, data: Uint8Array | string) => Promise<void>;
    const storeInternals = serverStore as unknown as { writeFileAtomic: WriteFileAtomic };
    const originalWriteFileAtomic = storeInternals.writeFileAtomic.bind(serverStore);

    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => (releaseGate = resolve));
    let signalGateReached!: () => void;
    const gateReached = new Promise<void>((resolve) => (signalGateReached = resolve));
    const gatedFileNamePart = encodeURIComponent(skippedEntryId);

    storeInternals.writeFileAtomic = async (filePath, data) => {
      if (filePath.includes(gatedFileNamePart)) {
        signalGateReached();
        await gate;
      }
      return originalWriteFileAtomic(filePath, data);
    };

    try {
      const user2PushPromise = serverStore.putEntries(skippedEntries);
      await gateReached;

      const user1PushPromise = serverStore.putEntries(user1Entries);
      await Promise.race([
        user1PushPromise,
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);

      // The fatal pull: user 1's scan cursor jumps past the invisible entry.
      await contactsDB1.pullChangesFrom(serverStore);

      releaseGate();
      await user2PushPromise;
      await user1PushPromise;
    } finally {
      releaseGate();
      storeInternals.writeFileAtomic = originalWriteFileAtomic;
    }

    // User 2 keeps working: pulls user 1's edit, makes a follow-up change
    // (which now DEPENDS on the skipped entry) and pushes it normally.
    await contactsDB2.pullChangesFrom(serverStore);
    await contactsDB2.changeDoc(await contactsDB2.getDocument(docId), async (d) => {
      d.getData().step = "user2 edit 2";
    });
    await contactsDB2.pushChangesTo(serverStore);

    // User 1 syncs manually — repeatedly, like the user did in Haven.
    await contactsDB1.pullChangesFrom(serverStore);
    await contactsDB1.syncStoreChanges();
    await contactsDB1.pullChangesFrom(serverStore);
    await contactsDB1.syncStoreChanges();

    // Expected behavior: user 1 sees user 2's latest state.
    const doc1Synced = await contactsDB1.getDocument(docId);
    expect(await store1.hasEntries([skippedEntryId])).toEqual([skippedEntryId]);
    expect(doc1Synced.getData().step).toBe("user2 edit 2");

    // User 2 still merges user 1's edit fine (asymmetry as observed).
    const doc2Synced = await contactsDB2.getDocument(docId);
    expect(doc2Synced.getData().user1Edit).toBe("hello from user1");
  });
});
