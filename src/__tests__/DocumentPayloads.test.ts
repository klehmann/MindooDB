import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { KeyBag } from "../core/keys/KeyBag";
import {
  DEFAULT_TENANT_KEY_ID,
  PUBLIC_INFOS_KEY_ID,
  type MindooDB,
  type MindooTenant,
  type PrivateUserId,
} from "../core/types";
import { MindooValue } from "../core/values";
import { DocumentTooLargeError, setDocumentLoadBudget } from "../core/documentLoadGuard";
import { DocumentDeletedError } from "../core/errors";
import * as Automerge from "@automerge/automerge";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

describe("documents too large to load here", () => {
  const tenantId = "test-tenant-payloads";
  let factory: BaseMindooTenantFactory;
  let adminUser: PrivateUserId;
  const adminPassword = "admin-pass";
  let user: PrivateUserId;
  const userPassword = "user-pass";
  let keyBag: KeyBag;
  let tenant: MindooTenant;
  let db: MindooDB;

  beforeEach(async () => {
    factory = new BaseMindooTenantFactory(new InMemoryContentAddressedStoreFactory(), new NodeCryptoAdapter());
    adminUser = await factory.createUserId("CN=admin/O=payloads", adminPassword);
    user = await factory.createUserId("CN=user/O=payloads", userPassword);
    keyBag = new KeyBag(user.userEncryptionKeyPair.privateKey, userPassword, factory.getCryptoAdapter());
    await keyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await keyBag.createTenantKey(tenantId);
    tenant = await factory.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      user,
      userPassword,
      keyBag,
    );
    const directory = await tenant.openDirectory();
    await directory.registerUser(factory.toPublicUserId(user), adminUser.userSigningKeyPair.privateKey, adminPassword);
    db = await tenant.openDB("test-db");
  }, 30000);

  afterEach(async () => {
    await (tenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
  });

  afterEach(() => setDocumentLoadBudget(null));

  function forget() {
    (db as unknown as { docCache: Map<string, unknown> }).docCache.clear();
  }

  /** Load the payloads in "another" Automerge instance, as a worker would. */
  function loadElsewhere(changes: Uint8Array[]) {
    let doc = Automerge.init<Record<string, unknown>>();
    for (const change of changes) doc = Automerge.loadIncremental(doc, change);
    return doc;
  }

  function deleteChangeFor(doc: Automerge.Doc<Record<string, unknown>>, edit?: (d: Record<string, unknown>) => void) {
    const next = Automerge.change(Automerge.clone(doc), { time: Date.now() }, (d) => {
      d._lastModified = Date.now();
      edit?.(d);
    });
    return Automerge.getLastLocalChange(next)!;
  }

  it("reads the signed changes of a refused document and deletes it from a prepared change", async () => {
    const body = "y".repeat(200_000);
    const created = await db.createDocument({ initialValues: { title: "big", body: MindooValue.text(body) } });
    await db.changeDoc(await db.getDocument(created.getId()), (d) => {
      (d.getData() as any).title = "bigger";
    });
    const id = created.getId();
    forget();
    setDocumentLoadBudget(20 * 1024 * 1024);
    await expect(db.getDocument(id)).rejects.toBeInstanceOf(DocumentTooLargeError);

    const payloads = (await db.getDocumentPayloads!(id))!;
    expect(payloads.changes.length).toBe(2);
    expect(payloads.estimate!.ops).toBeGreaterThan(200_000);
    const elsewhere = loadElsewhere(payloads.changes);
    expect(Automerge.toJS(elsewhere)).toMatchObject({ title: "bigger", body });
    expect([...Automerge.getHeads(elsewhere)].sort()).toEqual([...payloads.heads].sort());

    // A change that edits the content, or one on stale heads, is refused.
    await expect(db.deleteDocumentWithChange!(id, deleteChangeFor(elsewhere, (d) => { d.title = "x"; }))).rejects.toThrow(/touches more/);
    const stale = loadElsewhere(payloads.changes.slice(0, 1));
    await expect(db.deleteDocumentWithChange!(id, deleteChangeFor(stale))).rejects.toThrow(/current heads/);

    await db.deleteDocumentWithChange!(id, deleteChangeFor(elsewhere));
    setDocumentLoadBudget(null);
    forget();
    await expect(db.getDocument(id)).rejects.toBeInstanceOf(DocumentDeletedError);
    expect(await db.getAllDocumentIds()).not.toContain(id);
    // Deleting twice is a no-op.
    await db.deleteDocumentWithChange!(id, deleteChangeFor(elsewhere));
  }, 60_000);

  it("returns null for an unknown document", async () => {
    expect(await db.getDocumentPayloads!("nope")).toBeNull();
  });
});
