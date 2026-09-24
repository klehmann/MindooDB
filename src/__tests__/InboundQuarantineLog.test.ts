/**
 * The materialization quarantine log is written on every pass over a document,
 * and a document is materialized again and again. That combination is where the
 * loops live, so these tests are about what the log does on the *second* pass,
 * not the first:
 *
 * - it must not gain a copy of a record it already holds,
 * - it must not mark the checkpoint dirty when the verdict has not changed,
 *   since that would turn reading a quarantined document into a disk write,
 * - and it must let go of a record once the entry it describes is acceptable.
 */

import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import {
  ContentAddressedStoreFactory,
  CreateStoreResult,
  OpenStoreOptions,
  StoreKind,
  DEFAULT_TENANT_KEY_ID,
  PUBLIC_INFOS_KEY_ID,
  PrivateUserId,
  MindooTenant,
  MindooDB,
  SigningKeyPair,
} from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

/** Two tenant instances over one store, so a fresh replica materializes writes it never made. */
class SharedInMemoryStoreFactory implements ContentAddressedStoreFactory {
  private stores = new Map<string, CreateStoreResult>();
  createStore(dbId: string, options?: OpenStoreOptions): CreateStoreResult {
    if (!this.stores.has(dbId)) {
      this.stores.set(dbId, {
        docStore: new InMemoryContentAddressedStore(dbId, StoreKind.docs, undefined, options),
        attachmentStore: new InMemoryContentAddressedStore(
          dbId,
          StoreKind.attachments,
          undefined,
          options,
        ),
      });
    }
    return this.stores.get(dbId)!;
  }
}

interface QuarantineEntry {
  entryId: string;
  docId: string;
  reason: string;
  entryType: string;
}

/**
 * The log's whole purpose is to survive re-materialization, so the tests have to
 * force one. Dropping the in-memory document cache is the shortest honest way to
 * make the next read take the full materialization path again.
 */
interface DbInternals {
  getQuarantineLog: () => readonly QuarantineEntry[];
  docCache: Map<string, unknown>;
  cacheMetaDirty: boolean;
}

function internalsOf(db: MindooDB): DbInternals {
  return db as unknown as DbInternals;
}

async function rematerialize(db: MindooDB, docId: string): Promise<void> {
  internalsOf(db).docCache.delete(docId);
  await db.getDocument(docId).catch(() => null);
}

describe("materialization quarantine log", () => {
  let factory: BaseMindooTenantFactory;
  let storeFactory: SharedInMemoryStoreFactory;
  const tenantId = "tenant-quarantine-log";

  let admin: PrivateUserId;
  const adminPassword = "adminpass123";
  let adminKeyBag: KeyBag;

  let alice: PrivateUserId;
  const alicePassword = "alicepass123";

  let writerTenant: MindooTenant;
  let aliceSigning: SigningKeyPair;

  async function keyBagFor(user: PrivateUserId, password: string): Promise<KeyBag> {
    const adapter = new NodeCryptoAdapter();
    const kb = new KeyBag(user.userEncryptionKeyPair.privateKey, password, adapter);
    await kb.set(
      "doc",
      tenantId,
      PUBLIC_INFOS_KEY_ID,
      (await adminKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!,
    );
    await kb.set(
      "doc",
      tenantId,
      DEFAULT_TENANT_KEY_ID,
      (await adminKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!,
    );
    return kb;
  }

  async function openReaderTenant(label: string): Promise<MindooTenant> {
    const reader = await factory.createUserId(`CN=${label}/O=qtnlog`, "readerpass123");
    const directory = await writerTenant.openDirectory();
    await directory.registerUser(
      factory.toPublicUserId(reader),
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    return factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      reader,
      "readerpass123",
      await keyBagFor(reader, "readerpass123"),
    );
  }

  beforeEach(async () => {
    storeFactory = new SharedInMemoryStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());

    admin = await factory.createUserId("CN=admin/O=qtnlog", adminPassword);
    adminKeyBag = new KeyBag(
      admin.userEncryptionKeyPair.privateKey,
      adminPassword,
      new NodeCryptoAdapter(),
    );
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);

    alice = await factory.createUserId("CN=alice/O=qtnlog", alicePassword);
    aliceSigning = {
      publicKey: alice.userSigningKeyPair.publicKey,
      privateKey: alice.userSigningKeyPair.privateKey,
    };

    const writer = await factory.createUserId("CN=writer/O=qtnlog", "writerpass123");
    writerTenant = await factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      writer,
      "writerpass123",
      await keyBagFor(writer, "writerpass123"),
    );

    const directory = await writerTenant.openDirectory();
    for (const user of [admin, alice, writer]) {
      await directory.registerUser(
        factory.toPublicUserId(user),
        admin.userSigningKeyPair.privateKey,
        adminPassword,
      );
    }
  }, 60000);

  /**
   * Alice archives a contact and then edits it. A Tier 2 deny rule forbids
   * editing an archived contact, so exactly one entry is quarantined — a stable
   * one-record verdict to watch across repeated passes.
   */
  async function seedOneQuarantinedEntry(): Promise<string> {
    const crm = await writerTenant.openDB("crm");
    const doc = await crm.createDocument({
      signingKeyPair: aliceSigning,
      signingKeyPassword: alicePassword,
      initialValues: { title: "Beta", status: "open", v: 1 },
    });
    const docId = doc.getId();

    const directory = (await writerTenant.openDirectory()) as Required<
      Pick<
        Awaited<ReturnType<typeof writerTenant.openDirectory>>,
        "setDefaultAccessPolicy" | "createAccessRule"
      >
    >;
    await directory.setDefaultAccessPolicy(
      {},
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    await directory.createAccessRule(
      {
        ruleId: "crm-no-edit-archived",
        type: "doc_change",
        dbid: "crm",
        action: "deny",
        users_hashes: ["$everyone"],
        withfields: [{ key: "status", op: "equals", value: "archived", when: "before" }],
      },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    await crm.changeDoc(
      doc,
      async (d) => {
        d.getData().status = "archived";
      },
      { signingKeyPair: aliceSigning, signingKeyPassword: alicePassword },
    );
    const archived = await crm.getDocument(docId);
    await crm.changeDoc(
      archived!,
      async (d) => {
        d.getData().v = 2;
      },
      { signingKeyPair: aliceSigning, signingKeyPassword: alicePassword },
    );
    return docId;
  }

  it("does not grow when the same document is materialized again", async () => {
    const docId = await seedOneQuarantinedEntry();
    const readerCrm = await (await openReaderTenant("reader1")).openDB("crm");
    const internals = internalsOf(readerCrm);

    await readerCrm.getDocument(docId);
    const first = internals.getQuarantineLog().filter((r) => r.docId === docId);
    expect(first.length).toBe(1);

    for (let pass = 0; pass < 5; pass++) {
      await rematerialize(readerCrm, docId);
    }

    // Appending would have left six copies of the same record here.
    const after = internals.getQuarantineLog().filter((r) => r.docId === docId);
    expect(after.length).toBe(1);
    expect(after[0].entryId).toBe(first[0].entryId);
  }, 60000);

  it("leaves the stored record untouched when the verdict is unchanged", async () => {
    const docId = await seedOneQuarantinedEntry();
    const readerCrm = await (await openReaderTenant("reader2")).openDB("crm");
    const internals = internalsOf(readerCrm);

    await readerCrm.getDocument(docId);
    const stored = internals.getQuarantineLog().find((r) => r.docId === docId);
    expect(stored).toBeDefined();

    // `recordedAt` is stamped per pass, so a record replaced on every pass has a
    // different one — which is what makes this a test and not a tautology. The
    // sleep guarantees the stamps could differ.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await rematerialize(readerCrm, docId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await rematerialize(readerCrm, docId);

    // The same object, not an equal one: the checkpoint is rewritten whenever
    // this changes, and a document with a stable verdict is read far more often
    // than its verdict changes.
    expect(internals.getQuarantineLog().find((r) => r.docId === docId)).toBe(stored);
  }, 60000);

  it("survives a restart through the metadata checkpoint", async () => {
    const docId = await seedOneQuarantinedEntry();
    const readerTenant = await openReaderTenant("reader3");
    const readerCrm = await readerTenant.openDB("crm");
    await readerCrm.getDocument(docId);

    const exported = (
      readerCrm as unknown as { exportMetadataCheckpoint: () => Uint8Array }
    ).exportMetadataCheckpoint();
    const checkpoint = JSON.parse(new TextDecoder().decode(exported));

    expect(checkpoint.quarantineLog[docId]).toHaveLength(1);
    expect(checkpoint.quarantineLog[docId][0].docId).toBe(docId);
    // Additive field: the checkpoint version must NOT move, or every existing
    // installation rebuilds its metadata from scratch to gain an audit trail.
    expect(checkpoint.version).toBe(2);
  }, 60000);

  it("retires a record once the entry becomes acceptable", async () => {
    const crm = await writerTenant.openDB("crm");
    const doc = await crm.createDocument({
      signingKeyPair: aliceSigning,
      signingKeyPassword: alicePassword,
      initialValues: { title: "Gamma", v: 1 },
    });
    const docId = doc.getId();

    const writerDirectory = (await writerTenant.openDirectory()) as Required<
      Pick<
        Awaited<ReturnType<typeof writerTenant.openDirectory>>,
        "setDefaultAccessPolicy"
      >
    >;
    await writerDirectory.setDefaultAccessPolicy(
      {},
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    const readerTenant = await openReaderTenant("reader4");
    const readerDirectory = await readerTenant.openDirectory();
    const readerCrm = await readerTenant.openDB("crm");
    const internals = internalsOf(readerCrm);

    // A directory that cannot answer must not let entries through, so the pass
    // quarantines them and refuses to cache the result — the transient case the
    // log has to be able to take back.
    const realEvaluate = readerDirectory.evaluateClientAccess!.bind(readerDirectory);
    readerDirectory.evaluateClientAccess = async () => {
      throw new Error("directory unreachable");
    };

    await readerCrm.getDocument(docId).catch(() => null);
    const held = internals.getQuarantineLog().filter((r) => r.docId === docId);
    expect(held.length).toBeGreaterThanOrEqual(1);
    expect(held.every((r) => r.reason === "directory_unavailable")).toBe(true);

    readerDirectory.evaluateClientAccess = realEvaluate;
    await rematerialize(readerCrm, docId);

    // The entries are acceptable now, so nothing about this document is
    // quarantined — a log that only ever appended would still be accusing it.
    expect(internals.getQuarantineLog().filter((r) => r.docId === docId)).toEqual([]);
    expect((await readerCrm.getDocument(docId))!.getData().v).toBe(1);
  }, 60000);
});
