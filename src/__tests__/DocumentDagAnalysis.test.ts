import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { DEFAULT_TENANT_KEY_ID, PUBLIC_INFOS_KEY_ID, StoreKind } from "../core/types";
import type { MindooDB, OpenDBOptions } from "../core/types";

describe("Document DAG analysis", () => {
  class SharedInMemoryContentAddressedStoreFactory extends InMemoryContentAddressedStoreFactory {
    private stores = new Map<string, InMemoryContentAddressedStore>();
    private attachmentStores = new Map<string, InMemoryContentAddressedStore>();

    override createStore(dbId: string) {
      let docStore = this.stores.get(dbId);
      if (!docStore) {
        docStore = new InMemoryContentAddressedStore(dbId, StoreKind.docs);
        this.stores.set(dbId, docStore);
      }
      let attachmentStore = this.attachmentStores.get(dbId);
      if (!attachmentStore) {
        attachmentStore = new InMemoryContentAddressedStore(dbId, StoreKind.attachments);
        this.attachmentStores.set(dbId, attachmentStore);
      }
      return { docStore, attachmentStore };
    }
  }

  let storeFactory: SharedInMemoryContentAddressedStoreFactory;
  let factory: BaseMindooTenantFactory;
  let cryptoAdapter: NodeCryptoAdapter;
  let tenantId: string;
  let user: any;
  let userTwo: any;
  let adminUser: any;
  let userPassword: string;
  let userTwoPassword: string;
  let adminUserPassword: string;
  let userKeyBag: KeyBag;
  let userTwoKeyBag: KeyBag;
  let adminKeyBag: KeyBag;

  beforeEach(async () => {
    storeFactory = new SharedInMemoryContentAddressedStoreFactory();
    cryptoAdapter = new NodeCryptoAdapter();
    factory = new BaseMindooTenantFactory(storeFactory, cryptoAdapter);
    tenantId = "dag-analysis-tenant";

    userPassword = "userpass123";
    user = await factory.createUserId("CN=user/O=dag-analysis", userPassword);
    userKeyBag = new KeyBag(
      user.userEncryptionKeyPair.privateKey,
      userPassword,
      cryptoAdapter,
    );

    userTwoPassword = "usertwopass123";
    userTwo = await factory.createUserId("CN=user-two/O=dag-analysis", userTwoPassword);
    userTwoKeyBag = new KeyBag(
      userTwo.userEncryptionKeyPair.privateKey,
      userTwoPassword,
      cryptoAdapter,
    );

    adminUserPassword = "adminpass123";
    adminUser = await factory.createUserId("CN=admin/O=dag-analysis", adminUserPassword);
    adminKeyBag = new KeyBag(
      adminUser.userEncryptionKeyPair.privateKey,
      adminUserPassword,
      cryptoAdapter,
    );

    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);
    await userKeyBag.set(
      "doc",
      tenantId,
      PUBLIC_INFOS_KEY_ID,
      (await adminKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!,
    );
    await userKeyBag.set(
      "doc",
      tenantId,
      DEFAULT_TENANT_KEY_ID,
      (await adminKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!,
    );
    await userTwoKeyBag.set(
      "doc",
      tenantId,
      PUBLIC_INFOS_KEY_ID,
      (await adminKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!,
    );
    await userTwoKeyBag.set(
      "doc",
      tenantId,
      DEFAULT_TENANT_KEY_ID,
      (await adminKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!,
    );

    const bootstrapTenant = await factory.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      user,
      userPassword,
      userKeyBag,
    );
    const directory = await bootstrapTenant.openDirectory();
    await directory.registerUser(
      factory.toPublicUserId(adminUser),
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword,
    );
    await directory.registerUser(
      factory.toPublicUserId(user),
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword,
    );
    await directory.registerUser(
      factory.toPublicUserId(userTwo),
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword,
    );
  }, 30000);

  async function openUserTenant() {
    return factory.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      user,
      userPassword,
      userKeyBag,
    );
  }

  async function openUserTwoTenant() {
    return factory.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      userTwo,
      userTwoPassword,
      userTwoKeyBag,
    );
  }

  async function openUserDb(dbId: string, options?: OpenDBOptions): Promise<MindooDB> {
    const tenant = await openUserTenant();
    return tenant.openDB(dbId, options);
  }

  async function openUserTwoDb(dbId: string, options?: OpenDBOptions): Promise<MindooDB> {
    const tenant = await openUserTwoTenant();
    return tenant.openDB(dbId, options);
  }

  async function createSharedDbPair(
    dbId: string,
    options?: OpenDBOptions,
  ): Promise<{ userDb: MindooDB; userTwoDb: MindooDB }> {
    const userDb = await openUserDb(dbId, options);
    const userTwoDb = await openUserTwoDb(dbId, options);
    return { userDb, userTwoDb };
  }

  async function scanDocMetadata(db: MindooDB, docId: string): Promise<any[]> {
    const store = db.getStore() as any;
    let cursor: any = null;
    const entries: any[] = [];
    while (true) {
      const page: any = await store.scanEntriesSince(cursor, 1000, { docId });
      entries.push(...page.entries);
      cursor = page.nextCursor;
      if (!page.hasMore) {
        break;
      }
    }
    return entries;
  }

  it("analyzes concurrent heads and reconstructs signer-local branches", async () => {
    const dbId = "dag-concurrent";
    const { userDb, userTwoDb } = await createSharedDbPair(dbId);

    const doc = await userDb.createDocument();
    const docId = doc.getId();
    const userTwoView = await userTwoDb.getDocument(docId);

    await userDb.changeDoc(doc, (draft) => {
      draft.getData().userOnly = "from-user";
    });
    await userTwoDb.changeDoc(userTwoView, (draft) => {
      draft.getData().userTwoOnly = "from-user-two";
    });

    const analysis = await userDb.analyzeDocumentDagAtTimestamp(docId, "now");
    expect(analysis.activeHeadEntryIds).toHaveLength(2);
    expect(analysis.branches).toHaveLength(2);
    expect(analysis.graphLaneIds).toHaveLength(2);
    expect(
      analysis.branches.map((branch) => branch.headCreatedByPublicKey).sort(),
    ).toEqual([
      userTwo.userSigningKeyPair.publicKey,
      user.userSigningKeyPair.publicKey,
    ].sort());

    const userBranch = analysis.branches.find(
      (branch) => branch.headCreatedByPublicKey === user.userSigningKeyPair.publicKey,
    );
    const userTwoBranch = analysis.branches.find(
      (branch) => branch.headCreatedByPublicKey === userTwo.userSigningKeyPair.publicKey,
    );
    expect(userBranch).toBeTruthy();
    expect(userTwoBranch).toBeTruthy();
    const userEntry = analysis.entries.find((entry) => entry.entryId === userBranch!.headEntryId);
    const userTwoEntry = analysis.entries.find((entry) => entry.entryId === userTwoBranch!.headEntryId);
    expect(userEntry?.primaryGraphLaneId).toBeTruthy();
    expect(userTwoEntry?.primaryGraphLaneId).toBeTruthy();
    expect(userEntry?.primaryGraphLaneId).not.toBe(userTwoEntry?.primaryGraphLaneId);
    expect(userEntry?.automergeActorId).toBeTruthy();
    expect(userTwoEntry?.automergeActorId).toBeTruthy();
    expect(userEntry?.automergeActorId).not.toBe(userTwoEntry?.automergeActorId);

    const userBranchDoc = await userDb.materializeDocumentBranchAtEntry(docId, userBranch!.headEntryId);
    const userTwoBranchDoc = await userDb.materializeDocumentBranchAtEntry(docId, userTwoBranch!.headEntryId);

    expect(userBranchDoc).not.toBeNull();
    expect(userTwoBranchDoc).not.toBeNull();
    expect(userBranchDoc!.doc.getData().userOnly).toBe("from-user");
    expect((userBranchDoc!.doc.getData() as Record<string, unknown>).userTwoOnly).toBeUndefined();
    expect(userTwoBranchDoc!.doc.getData().userTwoOnly).toBe("from-user-two");
    expect((userTwoBranchDoc!.doc.getData() as Record<string, unknown>).userOnly).toBeUndefined();
  });

  it("reuses branch-compatible snapshots when materializing a concurrent head", async () => {
    const dbId = "dag-snapshots";
    const options: OpenDBOptions = {
      snapshotConfig: {
        minChanges: 1,
        cooldownMs: 0,
      },
    };
    const { userDb, userTwoDb } = await createSharedDbPair(dbId, options);

    const doc = await userDb.createDocument();
    const docId = doc.getId();
    const userTwoView = await userTwoDb.getDocument(docId);

    await userDb.changeDoc(doc, (draft) => {
      draft.getData().userOnly = "snap-user";
    });
    await userTwoDb.changeDoc(userTwoView, (draft) => {
      draft.getData().userTwoOnly = "snap-user-two";
    });

    const analysis = await userDb.analyzeDocumentDagAtTimestamp(docId, "now");
    expect(analysis.activeHeadEntryIds).toHaveLength(2);

    let snapshotBackedBranches = 0;
    for (const branch of analysis.branches) {
      const branchDoc = await userDb.materializeDocumentBranchAtEntry(docId, branch.headEntryId);
      expect(branchDoc).not.toBeNull();
      expect(branchDoc!.branchEntryIds.length).toBeGreaterThanOrEqual(2);
      if (branchDoc!.snapshotEntryId) {
        snapshotBackedBranches++;
      }
    }
    expect(snapshotBackedBranches).toBeGreaterThan(0);
  });

  it("keeps merge timelines bounded by timestamp slices", async () => {
    const dbId = "dag-merge";
    const { userDb, userTwoDb } = await createSharedDbPair(dbId);

    const doc = await userDb.createDocument();
    const docId = doc.getId();
    const userTwoView = await userTwoDb.getDocument(docId);

    await userDb.changeDoc(doc, (draft) => {
      draft.getData().userOnly = "before-merge-user";
    });
    await userTwoDb.changeDoc(userTwoView, (draft) => {
      draft.getData().userTwoOnly = "before-merge-user-two";
    });
    const beforeMergeTimestamp = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const mergeDb = await openUserDb(dbId);
    const mergedDoc = await mergeDb.getDocument(docId);
    await mergeDb.changeDoc(mergedDoc, (draft) => {
      draft.getData().merged = true;
    });

    const beforeMergeAnalysis = await mergeDb.analyzeDocumentDagAtTimestamp(docId, beforeMergeTimestamp);
    const afterMergeAnalysis = await mergeDb.analyzeDocumentDagAtTimestamp(docId, "now");
    expect(beforeMergeAnalysis.activeHeadEntryIds).toHaveLength(2);
    expect(afterMergeAnalysis.activeHeadEntryIds).toHaveLength(1);
    expect(afterMergeAnalysis.graphLaneIds.length).toBeGreaterThanOrEqual(2);

    const beforeMergeHeadEntries = beforeMergeAnalysis.activeHeadEntryIds
      .map((entryId) => afterMergeAnalysis.entries.find((entry) => entry.entryId === entryId))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    expect(beforeMergeHeadEntries).toHaveLength(2);
    expect(beforeMergeHeadEntries[0]!.primaryGraphLaneId).toBeTruthy();
    expect(beforeMergeHeadEntries[1]!.primaryGraphLaneId).toBeTruthy();
    expect(beforeMergeHeadEntries[0]!.primaryGraphLaneId).not.toBe(beforeMergeHeadEntries[1]!.primaryGraphLaneId);

    const mergedHeadEntry = afterMergeAnalysis.entries.find(
      (entry) => entry.entryId === afterMergeAnalysis.activeHeadEntryIds[0],
    );
    expect(mergedHeadEntry?.isMergePoint).toBe(true);
    expect(mergedHeadEntry?.dependencyIds.length).toBe(2);

    for (const branch of beforeMergeAnalysis.branches) {
      const branchDoc = await mergeDb.materializeDocumentBranchAtTimestamp(
        docId,
        beforeMergeTimestamp,
        branch.headEntryId,
      );
      expect(branchDoc).not.toBeNull();
      expect((branchDoc!.doc.getData() as Record<string, unknown>).merged).toBeUndefined();
    }
  });

  it("describes and materializes delete heads", async () => {
    const dbId = "dag-delete";
    const { userDb } = await createSharedDbPair(dbId);

    const doc = await userDb.createDocument();
    const docId = doc.getId();
    await userDb.changeDoc(doc, async (draft) => {
      draft.getData().status = "active";
      draft.getData().counter = 1;
      await draft.addAttachment(new Uint8Array([1, 2, 3]), "status.txt", "text/plain");
    });

    const beforeDeleteAnalysis = await userDb.analyzeDocumentDagAtTimestamp(docId, "now");
    const activeHead = beforeDeleteAnalysis.activeHeadEntryIds[0];
    const headDetails = await userDb.describeDocumentDagEntry(docId, activeHead);
    expect(headDetails).not.toBeNull();
    expect(headDetails!.decodedChange?.touchedKeys).toContain("status");
    expect(headDetails!.decodedChange?.touchedPaths).toContain("status");
    expect(headDetails!.decodedChange?.touchedPaths).toContain("_attachments[].fileName");
    expect(headDetails!.decodedChange?.touchedPaths).toContain("_attachments[].mimeType");

    await userDb.deleteDocument(docId);
    const afterDeleteAnalysis = await userDb.analyzeDocumentDagAtTimestamp(docId, "now");
    expect(afterDeleteAnalysis.activeHeadEntryIds).toHaveLength(1);

    const deletedBranch = await userDb.materializeDocumentBranchAtEntry(
      docId,
      afterDeleteAnalysis.activeHeadEntryIds[0]!,
    );
    expect(deletedBranch).not.toBeNull();
    expect(deletedBranch!.doc.isDeleted()).toBe(true);
  });

  it("recovers missing dependency entry ids from store metadata before writing", async () => {
    const dbId = "dag-recover-missing-deps";
    const { userDb } = await createSharedDbPair(dbId);

    const doc = await userDb.createDocument();
    const docId = doc.getId();
    await userDb.changeDoc(doc, (draft) => {
      draft.getData().step = 1;
    });

    const beforeEntries = await scanDocMetadata(userDb, docId);
    const firstChange = beforeEntries
      .filter((entry) => entry.entryType === "doc_change")
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))[0];
    expect(firstChange).toBeTruthy();

    const hashMap = (userDb as any).automergeHashToEntryId as Map<string, Map<string, string>>;
    hashMap.delete(docId);

    await userDb.changeDoc(doc, (draft) => {
      draft.getData().step = 2;
    });

    const afterEntries = await scanDocMetadata(userDb, docId);
    const changeEntries = afterEntries
      .filter((entry) => entry.entryType === "doc_change")
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    expect(changeEntries).toHaveLength(2);
    expect(changeEntries[1]!.dependencyIds).toEqual([firstChange.id]);
  });

  it("fails writes instead of persisting broken dependency metadata when recovery cannot find parents", async () => {
    const dbId = "dag-missing-deps-hard-fail";
    const { userDb } = await createSharedDbPair(dbId);

    const doc = await userDb.createDocument();
    const docId = doc.getId();
    await userDb.changeDoc(doc, (draft) => {
      draft.getData().step = 1;
    });

    const entries = await scanDocMetadata(userDb, docId);
    const firstChange = entries.find((entry) => entry.entryType === "doc_change");
    expect(firstChange).toBeTruthy();

    const hashMap = (userDb as any).automergeHashToEntryId as Map<string, Map<string, string>>;
    hashMap.delete(docId);

    const store = userDb.getStore() as any;
    store.entries.delete(firstChange.id);
    store.sortedEntriesCache = null;

    await expect(userDb.changeDoc(doc, (draft) => {
      draft.getData().step = 2;
    })).rejects.toThrow(`Could not resolve automerge dependency hashes`);

    const finalEntries = await scanDocMetadata(userDb, docId);
    const finalChangeEntries = finalEntries.filter((entry) => entry.entryType === "doc_change");
    expect(finalChangeEntries).toHaveLength(0);
  });
});
