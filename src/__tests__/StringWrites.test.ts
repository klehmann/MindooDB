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
import { LARGE_STRING_ATOMIC_THRESHOLD, MindooValue } from "../core/values";
import * as Automerge from "@automerge/automerge";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

describe("string writes: text stays text, large strings are atomic", () => {
  const tenantId = "test-tenant-strings";
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
    adminUser = await factory.createUserId("CN=admin/O=strings", adminPassword);
    user = await factory.createUserId("CN=user/O=strings", userPassword);
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

  /** Bytes of the last change Automerge recorded for the document. */
  function lastChangeBytes(docId: string): number {
    const internal = (db as unknown as { docCache: Map<string, { doc: unknown }> }).docCache.get(docId)!;
    return Automerge.getLastLocalChange(internal.doc as Automerge.Doc<unknown>)!.byteLength;
  }

  const big = (char: string) => char.repeat(LARGE_STRING_ATOMIC_THRESHOLD + 10);

  test("assigning a string to a text field stores only the change, and it stays text", async () => {
    const body = "Lorem ipsum dolor sit amet. ".repeat(1000); // 28 KB of text
    const doc = await db.createDocument({ initialValues: { body } });
    await db.changeDoc(await db.getDocument(doc.getId()), (d) => {
      (d.getData() as any).body = body + "Ende.";
    });
    expect(lastChangeBytes(doc.getId())).toBeLessThan(500);
    const after = await db.getDocument(doc.getId());
    expect(after.getData().body).toBe(body + "Ende.");
    expect(after.getFieldType("body")).toBe("text");
    // Still collaborative text: a splice applies.
    await db.applyJsonPatch(after, { textSplice: [{ path: ["body"], index: 0, deleteCount: 5, insert: "Hallo" }] });
    expect((await db.getDocument(doc.getId())).getData().body).toBe("Hallo" + (body + "Ende.").slice(5));
  });

  test("applyJsonPatch set and applyDocumentUpdate set edit existing long text the same way", async () => {
    const title = "Projektplan 2026 ".repeat(100); // 1.7 KB
    const note = "Notiz ".repeat(300);
    const doc = await db.createDocument({ initialValues: { title, note } });
    await db.applyJsonPatch(await db.getDocument(doc.getId()), { set: [{ path: ["title"], value: title + "2027" }] });
    expect(lastChangeBytes(doc.getId())).toBeLessThan(300);
    await db.applyDocumentUpdate(await db.getDocument(doc.getId()), { set: { note: note + "mehr" } });
    expect(lastChangeBytes(doc.getId())).toBeLessThan(300);
    const after = await db.getDocument(doc.getId());
    expect(after.getData()).toMatchObject({ title: title + "2027", note: note + "mehr" });
    expect(after.getFieldType("title")).toBe("text");
    expect(after.getFieldType("note")).toBe("text");
  });

  test("a short string assigned to a text field still replaces it as a whole", async () => {
    const doc = await db.createDocument({ initialValues: { state: "open" } });
    await db.changeDoc(await db.getDocument(doc.getId()), (d) => {
      (d.getData() as any).state = "in progress";
    });
    const change = Automerge.decodeChange(
      Automerge.getLastLocalChange(
        (db as unknown as { docCache: Map<string, { doc: unknown }> }).docCache.get(doc.getId())!.doc as Automerge.Doc<unknown>,
      )!,
    );
    expect(change.ops.some((op) => op.action === "makeText")).toBe(true);
    expect((await db.getDocument(doc.getId())).getData().state).toBe("in progress");
  });

  test("a large plain string is stored atomic, MindooValue.text keeps it collaborative", async () => {
    const doc = await db.createDocument({
      initialValues: { blob: big("a"), essay: MindooValue.text(big("b")), small: "klein" },
    });
    const loaded = await db.getDocument(doc.getId());
    expect(loaded.getFieldType("blob")).toBe("atomic");
    expect(loaded.getFieldType("essay")).toBe("text");
    expect(loaded.getFieldType("small")).toBe("text");
    expect(loaded.getData().blob).toBe(big("a"));

    // A large string written over existing text keeps it text (only the change is stored).
    await db.changeDoc(loaded, (d) => {
      (d.getData() as any).essay = big("b") + "!";
    });
    expect(lastChangeBytes(doc.getId())).toBeLessThan(500);
    expect((await db.getDocument(doc.getId())).getFieldType("essay")).toBe("text");

    // A new field or an atomic field gets the large string atomic.
    await db.changeDoc(await db.getDocument(doc.getId()), (d) => {
      (d.getData() as any).blob = big("c");
      (d.getData() as any).fresh = big("d");
      (d.getData() as any).nested = { inner: big("e") };
    });
    const after = await db.getDocument(doc.getId());
    expect(after.getFieldType("blob")).toBe("atomic");
    expect(after.getFieldType("fresh")).toBe("atomic");
    expect(after.getFieldType(["nested", "inner"])).toBe("atomic");
    expect(after.getData().fresh).toBe(big("d"));
  });

  test("MindooValue.text writes over an atomic field as new text", async () => {
    const doc = await db.createDocument({ initialValues: { status: MindooValue.atomic("open") } });
    await db.changeDoc(await db.getDocument(doc.getId()), (d) => {
      (d.getData() as any).status = MindooValue.text("now text");
    });
    expect((await db.getDocument(doc.getId())).getFieldType("status")).toBe("text");
    expect(() => MindooValue.text(1 as unknown as string)).toThrow();
  });
});
