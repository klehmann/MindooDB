import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import {
  PrivateUserId,
  MindooTenant,
  MindooDB,
  MindooDoc,
  PUBLIC_INFOS_KEY_ID,
} from "../core/types";
import { DocumentDeletedError, DocumentNotFoundError } from "../core/errors";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

/**
 * Edge cases of the combined `changeDoc(doc, changeFunc, options?: ChangeOptions)`
 * API (which replaced `changeDocWithSigningKey`):
 * - which key signs the change entry (default, options, deprecated wrapper)
 * - validation of partial / wrong signing-key options
 * - refusal for deleted, unknown and read-only cases
 * - a throwing callback writes nothing and cleans up its attachment uploads
 * - draft semantics of the collecting document inside the callback
 *
 * Access control (`bypassAccessControlPrecheck`, Tier 1/2 denials) is covered
 * by WriteAccessPrecheck.test.ts and Tier2Quarantine.test.ts; the
 * after-callback guard by Attachments.test.ts.
 */
describe("changeDoc with ChangeOptions", () => {
  let factory: BaseMindooTenantFactory;
  let adminUser: PrivateUserId;
  let adminUserPassword: string;
  let currentUser: PrivateUserId;
  let currentUserPassword: string;
  let tenant: MindooTenant;
  let db: MindooDB;

  beforeEach(async () => {
    factory = new BaseMindooTenantFactory(
      new InMemoryContentAddressedStoreFactory(),
      new NodeCryptoAdapter(),
    );
    adminUserPassword = "adminpass123";
    adminUser = await factory.createUserId("CN=admin/O=changedoctest", adminUserPassword);
    currentUserPassword = "userpassword123";
    currentUser = await factory.createUserId("CN=testuser/O=changedoctest", currentUserPassword);
    const keyBag = new KeyBag(
      currentUser.userEncryptionKeyPair.privateKey,
      currentUserPassword,
      factory.getCryptoAdapter(),
    );

    const tenantId = "test-tenant-changedoc";
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
    await directory.registerUser(
      factory.toPublicUserId(currentUser),
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword,
    );

    db = await tenant.openDB("test-db");
  }, 30000);

  afterEach(async () => {
    await (tenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
  });

  /** Ids of all store entries that belong to the document. */
  async function docEntryIds(docId: string): Promise<string[]> {
    const metas = await db.getStore().findNewEntriesForDoc([], docId);
    return metas.map((m) => m.id).sort();
  }

  /** Signer of the newest `doc_change` entry of the document. */
  async function lastChangeSigner(docId: string): Promise<string> {
    const metas = (await db.getStore().findNewEntriesForDoc([], docId))
      .filter((m) => m.entryType === "doc_change")
      .sort((a, b) => a.createdAt - b.createdAt);
    expect(metas.length).toBeGreaterThan(0);
    return metas[metas.length - 1].createdByPublicKey;
  }

  async function newDoc(values: Record<string, unknown> = { title: "start" }): Promise<MindooDoc> {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), values);
    });
    return db.getDocument(doc.getId());
  }

  describe("signing key", () => {
    it("signs with the current user's key when options are omitted or empty", async () => {
      const doc = await newDoc();
      expect(await lastChangeSigner(doc.getId())).toBe(currentUser.userSigningKeyPair.publicKey);

      await db.changeDoc(doc, (d) => {
        d.getData().title = "empty options";
      }, {});
      expect(await lastChangeSigner(doc.getId())).toBe(currentUser.userSigningKeyPair.publicKey);
    }, 30000);

    it("signs with signingKeyPair from the options", async () => {
      const doc = await newDoc();
      await db.changeDoc(doc, (d) => {
        d.getData().title = "by admin";
      }, {
        signingKeyPair: adminUser.userSigningKeyPair,
        signingKeyPassword: adminUserPassword,
      });

      expect(await lastChangeSigner(doc.getId())).toBe(adminUser.userSigningKeyPair.publicKey);
      expect((await db.getDocument(doc.getId())).getData().title).toBe("by admin");
    }, 30000);

    it("deprecated changeDocWithSigningKey signs like changeDoc with options", async () => {
      const doc = await newDoc();
      await db.changeDocWithSigningKey(doc, (d) => {
        d.getData().title = "by admin (legacy)";
      }, adminUser.userSigningKeyPair, adminUserPassword);

      expect(await lastChangeSigner(doc.getId())).toBe(adminUser.userSigningKeyPair.publicKey);
      expect((await db.getDocument(doc.getId())).getData().title).toBe("by admin (legacy)");
    }, 30000);

    it.each([
      ["only signingKeyPair", "pair"],
      ["only signingKeyPassword", "password"],
    ])("rejects %s without running the callback or writing", async (_label, which) => {
      const doc = await newDoc();
      const before = await docEntryIds(doc.getId());
      const changeFunc = jest.fn((d: MindooDoc) => {
        d.getData().title = "must not be written";
      });
      const options = which === "pair"
        ? { signingKeyPair: adminUser.userSigningKeyPair }
        : { signingKeyPassword: adminUserPassword };

      await expect(db.changeDoc(doc, changeFunc, options)).rejects.toThrow(
        /signingKeyPair and signingKeyPassword must be provided together/,
      );
      expect(changeFunc).not.toHaveBeenCalled();
      expect(await docEntryIds(doc.getId())).toEqual(before);
      expect((await db.getDocument(doc.getId())).getData().title).toBe("start");
    }, 30000);

    it("rejects a wrong signingKeyPassword without writing a change", async () => {
      const doc = await newDoc();
      const before = await docEntryIds(doc.getId());

      await expect(db.changeDoc(doc, (d) => {
        d.getData().title = "must not be written";
      }, {
        signingKeyPair: adminUser.userSigningKeyPair,
        signingKeyPassword: "wrong-password",
      })).rejects.toThrow();

      expect(await docEntryIds(doc.getId())).toEqual(before);
      // The failed write must not leave the draft in the document cache either.
      expect((await db.getDocument(doc.getId())).getData().title).toBe("start");
    }, 30000);

    it("does not build the next change on a change that failed to persist", async () => {
      const doc = await newDoc();
      await expect(db.changeDoc(doc, (d) => {
        d.getData().title = "never persisted";
      }, {
        signingKeyPair: adminUser.userSigningKeyPair,
        signingKeyPassword: "wrong-password",
      })).rejects.toThrow();

      await db.changeDoc(doc, (d) => {
        d.getData().other = "persisted";
      });

      // Every dependency of every stored entry must itself be stored, otherwise
      // other replicas can never apply the follow-up change.
      const store = db.getStore();
      const metas = await store.findNewEntriesForDoc([], doc.getId());
      const dependencyIds = [...new Set(metas.flatMap((m) => m.dependencyIds))];
      expect((await store.hasEntries(dependencyIds)).sort()).toEqual(dependencyIds.sort());

      const data = (await db.getDocument(doc.getId())).getData();
      expect(data.title).toBe("start");
      expect(data.other).toBe("persisted");
    }, 30000);
  });

  describe("refused documents", () => {
    it("throws DocumentDeletedError for a deleted document without running the callback", async () => {
      const doc = await newDoc();
      await db.deleteDocument(doc.getId());
      const changeFunc = jest.fn();

      await expect(db.changeDoc(doc, changeFunc)).rejects.toBeInstanceOf(DocumentDeletedError);
      expect(changeFunc).not.toHaveBeenCalled();
    }, 30000);

    it("throws DocumentNotFoundError for a document the database does not hold", async () => {
      const otherDb = await tenant.openDB("other-db");
      const foreignDoc = await otherDb.createDocument();
      const changeFunc = jest.fn();

      await expect(db.changeDoc(foreignDoc, changeFunc)).rejects.toBeInstanceOf(DocumentNotFoundError);
      expect(changeFunc).not.toHaveBeenCalled();
      expect(await db.getAllDocumentIds()).not.toContain(foreignDoc.getId());
    }, 30000);

    it("rejects changes in a read-only time travel snapshot", async () => {
      const doc = await newDoc();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const snapshot = await tenant.openDB("test-db", { timeTravelDate: Date.now() });
      const snapshotDoc = await snapshot.getDocument(doc.getId());
      const changeFunc = jest.fn();

      await expect(snapshot.changeDoc(snapshotDoc, changeFunc)).rejects.toThrow(/read-only mode/);
      expect(changeFunc).not.toHaveBeenCalled();
    }, 30000);
  });

  describe("throwing callback", () => {
    it.each([
      ["synchronously", (d: MindooDoc) => {
        d.getData().title = "draft";
        throw new Error("boom");
      }],
      ["asynchronously", async (d: MindooDoc) => {
        d.getData().title = "draft";
        await Promise.resolve();
        throw new Error("boom");
      }],
    ])("propagates an error thrown %s and writes nothing", async (_label, changeFunc) => {
      const doc = await newDoc();
      const before = await docEntryIds(doc.getId());

      await expect(db.changeDoc(doc, changeFunc)).rejects.toThrow("boom");

      expect(await docEntryIds(doc.getId())).toEqual(before);
      expect((await db.getDocument(doc.getId())).getData().title).toBe("start");

      // The document stays changeable afterwards.
      await db.changeDoc(doc, (d) => {
        d.getData().title = "after";
      });
      expect((await db.getDocument(doc.getId())).getData().title).toBe("after");
    }, 30000);

    it("does not attach an attachment uploaded before the callback threw", async () => {
      const doc = await newDoc();
      const storeIdsBefore = await db.getStore().getAllIds();

      await expect(db.changeDoc(doc, async (d) => {
        await d.addAttachment(new Uint8Array([1, 2, 3, 4]), "a.bin", "application/octet-stream");
        throw new Error("boom after upload");
      })).rejects.toThrow("boom after upload");

      expect((await db.getDocument(doc.getId())).getAttachments()).toEqual([]);
      // No change entry and no pending upload ledger entry are left behind.
      // (The uploaded chunks themselves are only removed by stores that
      // implement deleteEntriesForAttachment, which the in-memory store
      // does not.)
      expect((await db.getStore().getAllIds()).sort()).toEqual(storeIdsBefore.sort());
    }, 30000);
  });

  describe("draft semantics inside the callback", () => {
    it("reads its own pending writes and deletions", async () => {
      const doc = await newDoc({ title: "start", keep: 1 });
      const seen: Record<string, unknown> = {};

      await db.changeDoc(doc, (d) => {
        const data = d.getData();
        data.title = "pending";
        seen.title = data.title;
        delete data.keep;
        seen.keep = data.keep;
        seen.hasKeep = "keep" in data;
      });

      expect(seen).toEqual({ title: "pending", keep: undefined, hasKeep: false });
    }, 30000);

    it("lets the last of set and delete on the same field win", async () => {
      const doc = await newDoc({ a: 1, b: 2 });

      await db.changeDoc(doc, (d) => {
        const data = d.getData();
        data.a = 10;
        delete data.a; // set then delete -> deleted
        delete data.b;
        data.b = 20; // delete then set -> set
      });

      const data = (await db.getDocument(doc.getId())).getData();
      expect("a" in data).toBe(false);
      expect(data.b).toBe(20);
    }, 30000);

    it("writes an entry and bumps lastModified for an empty callback", async () => {
      const doc = await newDoc();
      const before = await docEntryIds(doc.getId());
      const lastModifiedBefore = doc.getLastModified();
      await new Promise((resolve) => setTimeout(resolve, 5));

      await db.changeDoc(doc, () => {});

      expect((await docEntryIds(doc.getId())).length).toBe(before.length + 1);
      const after = await db.getDocument(doc.getId());
      expect(after.getLastModified()).toBeGreaterThan(lastModifiedBefore);
      expect(after.getData().title).toBe("start");
    }, 30000);
  });
});
