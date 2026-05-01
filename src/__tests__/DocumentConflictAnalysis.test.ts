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
});
