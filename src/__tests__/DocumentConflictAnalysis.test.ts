import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import {
  DEFAULT_TENANT_KEY_ID,
  DocumentConflictAnalysisEvent,
  MindooDB,
  OpenDBOptions,
  PUBLIC_INFOS_KEY_ID,
  StoreKind,
} from "../core/types";

describe("Document conflict analysis", () => {
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
  let passwordCounter = 0;

  function makeTestPassword(label: string): string {
    passwordCounter += 1;
    return `generated-${label}-${passwordCounter}-${Date.now()}`;
  }

  beforeEach(async () => {
    storeFactory = new SharedInMemoryContentAddressedStoreFactory();
    cryptoAdapter = new NodeCryptoAdapter();
    factory = new BaseMindooTenantFactory(storeFactory, cryptoAdapter);
    tenantId = "conflict-analysis-tenant";

    userPassword = makeTestPassword("user");
    user = await factory.createUserId("CN=user/O=conflict-analysis", userPassword);
    userKeyBag = new KeyBag(
      user.userEncryptionKeyPair.privateKey,
      userPassword,
      cryptoAdapter,
    );

    userTwoPassword = makeTestPassword("user-two");
    userTwo = await factory.createUserId("CN=user-two/O=conflict-analysis", userTwoPassword);
    userTwoKeyBag = new KeyBag(
      userTwo.userEncryptionKeyPair.privateKey,
      userTwoPassword,
      cryptoAdapter,
    );

    adminUserPassword = makeTestPassword("admin");
    adminUser = await factory.createUserId("CN=admin/O=conflict-analysis", adminUserPassword);
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

  async function createSharedDbPair(dbId: string): Promise<{ userDb: MindooDB; userTwoDb: MindooDB }> {
    const userDb = await openUserDb(dbId);
    const userTwoDb = await openUserTwoDb(dbId);
    return { userDb, userTwoDb };
  }

  async function collectConflictEvents(
    db: MindooDB,
    docId: string,
    options: Parameters<MindooDB["analyzeDocumentConflicts"]>[1] = {},
  ): Promise<DocumentConflictAnalysisEvent[]> {
    const events: DocumentConflictAnalysisEvent[] = [];
    for await (const event of db.analyzeDocumentConflicts([docId], options)) {
      events.push(event);
    }
    return events;
  }

  it("does not report conflicts for concurrent edits to different keys", async () => {
    const { userDb, userTwoDb } = await createSharedDbPair("conflict-different-keys");
    const doc = await userDb.createDocument();
    const docId = doc.getId();
    const userTwoView = await userTwoDb.getDocument(docId);

    await userDb.changeDoc(doc, (draft) => {
      draft.getData().title = "from-user";
    });
    await userTwoDb.changeDoc(userTwoView, (draft) => {
      draft.getData().status = "from-user-two";
    });

    const events = await collectConflictEvents(userDb, docId, { mode: "full" });
    expect(events.some((event) => event.type === "conflictDetected")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "docDone",
      docId,
      hadConflicts: false,
    }));
  });

  it("reports conflict paths and value summaries for concurrent edits to the same key", async () => {
    const { userDb, userTwoDb } = await createSharedDbPair("conflict-same-key");
    const doc = await userDb.createDocument();
    const docId = doc.getId();
    const userTwoView = await userTwoDb.getDocument(docId);

    await userDb.changeDoc(doc, (draft) => {
      draft.getData().title = "from-user";
    });
    await userTwoDb.changeDoc(userTwoView, (draft) => {
      draft.getData().title = "from-user-two";
    });

    const events = await collectConflictEvents(userDb, docId, {
      mode: "full",
      detail: "values",
    });
    const conflict = events.find((event) => event.type === "conflictDetected");

    expect(conflict).toBeDefined();
    expect(conflict?.type).toBe("conflictDetected");
    if (conflict?.type !== "conflictDetected") {
      return;
    }
    expect(conflict.conflict.docId).toBe(docId);
    expect(conflict.conflict.paths.map((path) => path.pathString)).toContain("title");
    const titlePath = conflict.conflict.paths.find((path) => path.pathString === "title");
    expect(titlePath?.values?.map((value) => value.preview).sort()).toEqual([
      "from-user",
      "from-user-two",
    ].sort());
    expect(JSON.stringify(conflict)).not.toContain("Automerge");
  });

  it("reports later writes as conflict resolutions in full reports", async () => {
    const { userDb, userTwoDb } = await createSharedDbPair("conflict-resolution");
    const doc = await userDb.createDocument();
    const docId = doc.getId();
    const userTwoView = await userTwoDb.getDocument(docId);

    await userDb.changeDoc(doc, (draft) => {
      draft.getData().title = "from-user";
    });
    await userTwoDb.changeDoc(userTwoView, (draft) => {
      draft.getData().title = "from-user-two";
    });

    const mergeDb = await openUserDb("conflict-resolution");
    const mergedDoc = await mergeDb.getDocument(docId);
    await mergeDb.changeDoc(mergedDoc, (draft) => {
      draft.getData().title = "resolved";
    });

    const report = await mergeDb.getDocumentConflictReport(docId, { detail: "paths-only" });

    expect(report.hadConflicts).toBe(true);
    expect(report.conflicts.some((conflict) =>
      conflict.paths.some((path) => path.pathString === "title"),
    )).toBe(true);
    expect(report.resolutions.some((resolution) => resolution.path.pathString === "title")).toBe(true);
  });

  it("supports early generator termination and AbortSignal cancellation", async () => {
    const { userDb, userTwoDb } = await createSharedDbPair("conflict-cancel");
    const doc = await userDb.createDocument();
    const docId = doc.getId();
    const userTwoView = await userTwoDb.getDocument(docId);

    await userDb.changeDoc(doc, (draft) => {
      draft.getData().title = "from-user";
    });
    await userTwoDb.changeDoc(userTwoView, (draft) => {
      draft.getData().title = "from-user-two";
    });

    let conflictEvents = 0;
    for await (const event of userDb.analyzeDocumentConflicts([docId], { mode: "quick" })) {
      if (event.type === "conflictDetected") {
        conflictEvents++;
        break;
      }
    }
    expect(conflictEvents).toBe(1);

    const controller = new AbortController();
    controller.abort();
    await expect(async () => {
      for await (const _event of userDb.analyzeDocumentConflicts([docId], { signal: controller.signal })) {
        // The aborted signal should make the generator throw before yielding.
      }
    }).rejects.toThrow("Conflict analysis aborted");
  });

  it("filters out already-seen conflicts when a checkpoint is provided", async () => {
    const { userDb, userTwoDb } = await createSharedDbPair("conflict-since-filter");
    const doc = await userDb.createDocument();
    const docId = doc.getId();
    const userTwoView = await userTwoDb.getDocument(docId);

    await userDb.changeDoc(doc, (draft) => {
      draft.getData().title = "from-user";
    });
    await userTwoDb.changeDoc(userTwoView, (draft) => {
      draft.getData().title = "from-user-two";
    });

    const checkpoint = await userDb.getConflictScanCheckpoint();
    const events = await collectConflictEvents(userDb, docId, {
      mode: "full",
      since: checkpoint,
    });

    expect(events.some((event) => event.type === "conflictDetected")).toBe(false);
    expect(events.some((event) => event.type === "scanCheckpoint")).toBe(true);
  });

  it("uses receipt order for since filtering instead of only wall-clock time", async () => {
    const { userDb, userTwoDb } = await createSharedDbPair("conflict-since-receipt-order");
    const doc = await userDb.createDocument();
    const docId = doc.getId();
    const userTwoView = await userTwoDb.getDocument(docId);
    const checkpoint = {
      ...(await userDb.getConflictScanCheckpoint()),
      takenAt: Date.now() + 60_000,
    };

    await userDb.changeDoc(doc, (draft) => {
      draft.getData().title = "from-user";
    });
    await userTwoDb.changeDoc(userTwoView, (draft) => {
      draft.getData().title = "from-user-two";
    });

    const events = await collectConflictEvents(userDb, docId, {
      mode: "full",
      since: checkpoint,
    });

    expect(events.some((event) => event.type === "conflictDetected")).toBe(true);
  });

  it("reports resolutions that happen after the checkpoint", async () => {
    const { userDb, userTwoDb } = await createSharedDbPair("conflict-since-resolution");
    const doc = await userDb.createDocument();
    const docId = doc.getId();
    const userTwoView = await userTwoDb.getDocument(docId);

    await userDb.changeDoc(doc, (draft) => {
      draft.getData().title = "from-user";
    });
    await userTwoDb.changeDoc(userTwoView, (draft) => {
      draft.getData().title = "from-user-two";
    });

    const checkpoint = await userDb.getConflictScanCheckpoint();
    const mergeDb = await openUserDb("conflict-since-resolution");
    const mergedDoc = await mergeDb.getDocument(docId);
    await mergeDb.changeDoc(mergedDoc, (draft) => {
      draft.getData().title = "resolved";
    });

    const events = await collectConflictEvents(mergeDb, docId, {
      mode: "full",
      since: checkpoint,
    });

    expect(events.some((event) => event.type === "conflictResolved")).toBe(true);
  });

  it("can include unresolved conflicts that predate the checkpoint", async () => {
    const { userDb, userTwoDb } = await createSharedDbPair("conflict-since-unresolved");
    const doc = await userDb.createDocument();
    const docId = doc.getId();
    const userTwoView = await userTwoDb.getDocument(docId);

    await userDb.changeDoc(doc, (draft) => {
      draft.getData().title = "from-user";
    });
    await userTwoDb.changeDoc(userTwoView, (draft) => {
      draft.getData().title = "from-user-two";
    });

    const checkpoint = await userDb.getConflictScanCheckpoint();
    const events = await collectConflictEvents(userDb, docId, {
      mode: "full",
      since: checkpoint,
      includeUnresolvedFromBefore: true,
    });

    expect(events.some((event) => event.type === "conflictDetected")).toBe(true);
  });

  it("resolves the prior value at the merge base for a conflicted path", async () => {
    const { userDb, userTwoDb } = await createSharedDbPair("conflict-base-value");
    const doc = await userDb.createDocument();
    const docId = doc.getId();
    await userDb.changeDoc(doc, (draft) => {
      draft.getData().title = "base";
    });

    const userTwoView = await userTwoDb.getDocument(docId);
    await userDb.changeDoc(doc, (draft) => {
      draft.getData().title = "from-user";
    });
    await userTwoDb.changeDoc(userTwoView, (draft) => {
      draft.getData().title = "from-user-two";
    });

    const report = await userDb.getDocumentConflictReport(docId, { detail: "values" });
    const conflict = report.conflicts.find((candidate) =>
      candidate.paths.some((path) => path.pathString === "title"),
    );
    expect(conflict).toBeDefined();
    if (!conflict) {
      return;
    }
    const titlePath = conflict.paths.find((path) => path.pathString === "title");
    expect(titlePath).toBeDefined();
    if (!titlePath) {
      return;
    }
    const baseValues = await userDb.getDocumentConflictBaseValues(docId, [
      { location: conflict.location, path: titlePath.path, pathString: titlePath.pathString },
    ]);
    expect(baseValues).toHaveLength(1);
    expect(baseValues[0]?.status).toBe("available");
    expect(baseValues[0]?.preview).toBe("base");
    expect(baseValues[0]?.baseEntryId).toBeTruthy();
  });

  it("returns no-prior-value when the conflicted field did not exist before the conflict", async () => {
    const { userDb, userTwoDb } = await createSharedDbPair("conflict-base-no-prior");
    const doc = await userDb.createDocument();
    const docId = doc.getId();
    const userTwoView = await userTwoDb.getDocument(docId);

    await userDb.changeDoc(doc, (draft) => {
      draft.getData().title = "from-user";
    });
    await userTwoDb.changeDoc(userTwoView, (draft) => {
      draft.getData().title = "from-user-two";
    });

    const report = await userDb.getDocumentConflictReport(docId, { detail: "values" });
    const conflict = report.conflicts.find((candidate) =>
      candidate.paths.some((path) => path.pathString === "title"),
    );
    expect(conflict).toBeDefined();
    if (!conflict) {
      return;
    }
    const titlePath = conflict.paths.find((path) => path.pathString === "title");
    expect(titlePath).toBeDefined();
    if (!titlePath) {
      return;
    }
    const [baseValue] = await userDb.getDocumentConflictBaseValues(docId, [
      { location: conflict.location, path: titlePath.path, pathString: titlePath.pathString },
    ]);
    expect(baseValue?.status).toBe("no-prior-value");
    expect(baseValue?.preview).toBeNull();
    expect(baseValue?.baseEntryId).toBeTruthy();
  });

  it("coalesces multiple queries that share a merge base into a single materialization", async () => {
    const { userDb, userTwoDb } = await createSharedDbPair("conflict-base-coalesce");
    const doc = await userDb.createDocument();
    const docId = doc.getId();
    await userDb.changeDoc(doc, (draft) => {
      draft.getData().title = "base-title";
      draft.getData().status = "base-status";
    });

    const userTwoView = await userTwoDb.getDocument(docId);
    await userDb.changeDoc(doc, (draft) => {
      draft.getData().title = "user-title";
      draft.getData().status = "user-status";
    });
    await userTwoDb.changeDoc(userTwoView, (draft) => {
      draft.getData().title = "two-title";
      draft.getData().status = "two-status";
    });

    const report = await userDb.getDocumentConflictReport(docId, { detail: "values" });
    const queries = report.conflicts.flatMap((conflict) =>
      conflict.paths
        .filter((path) => path.pathString === "title" || path.pathString === "status")
        .map((path) => ({
          location: conflict.location,
          path: path.path,
          pathString: path.pathString,
        })),
    );
    expect(queries.length).toBeGreaterThanOrEqual(2);

    const baseValues = await userDb.getDocumentConflictBaseValues(docId, queries);
    expect(baseValues).toHaveLength(queries.length);
    const baseEntryIds = new Set(baseValues.map((value) => value.baseEntryId));
    expect(baseEntryIds.size).toBe(1);
    const titleValue = baseValues.find((value) => value.pathString === "title");
    const statusValue = baseValues.find((value) => value.pathString === "status");
    expect(titleValue?.preview).toBe("base-title");
    expect(statusValue?.preview).toBe("base-status");
  });

  it("returns missing-entry when the conflict location's entry is not in the local store", async () => {
    const { userDb } = await createSharedDbPair("conflict-base-missing-entry");
    const doc = await userDb.createDocument();
    const docId = doc.getId();
    await userDb.changeDoc(doc, (draft) => {
      draft.getData().title = "base";
    });

    const [baseValue] = await userDb.getDocumentConflictBaseValues(docId, [
      {
        location: {
          kind: "entry-after",
          entryId: "non-existent-entry-id",
          headEntryIds: [],
          automergeHeads: [],
        },
        path: ["title"],
        pathString: "title",
      },
    ]);
    expect(baseValue?.status).toBe("missing-entry");
    expect(baseValue?.preview).toBeNull();
    expect(baseValue?.baseEntryId).toBeNull();
  });

  it("returns an empty array when no queries are supplied", async () => {
    const { userDb } = await createSharedDbPair("conflict-base-empty");
    const doc = await userDb.createDocument();
    expect(await userDb.getDocumentConflictBaseValues(doc.getId(), [])).toEqual([]);
  });

  it("emits a final conflict scan checkpoint", async () => {
    const { userDb } = await createSharedDbPair("conflict-since-checkpoint-event");
    const doc = await userDb.createDocument();
    const docId = doc.getId();
    const inputCheckpoint = await userDb.getConflictScanCheckpoint();

    await userDb.changeDoc(doc, (draft) => {
      draft.getData().title = "after-checkpoint";
    });

    const events = await collectConflictEvents(userDb, docId, {
      since: inputCheckpoint,
    });
    const checkpointEvents = events.filter((event) => event.type === "scanCheckpoint");

    expect(checkpointEvents).toHaveLength(1);
    const [checkpointEvent] = checkpointEvents;
    expect(checkpointEvent?.type).toBe("scanCheckpoint");
    if (checkpointEvent?.type !== "scanCheckpoint") {
      return;
    }
    expect(checkpointEvent.checkpoint.changeSeqAsOf).toBeGreaterThanOrEqual(inputCheckpoint.changeSeqAsOf);
    expect(checkpointEvent.checkpoint.takenAt).toBeGreaterThanOrEqual(inputCheckpoint.takenAt);
  });
});
