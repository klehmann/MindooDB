import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import {
  PrivateUserId,
  MindooTenant,
  MindooDB,
  PUBLIC_INFOS_KEY_ID,
} from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { matchesDocIdPrefix } from "../core/utils/idGeneration";

/**
 * Tests for the `idPrefix` filter on the read/iterate surface:
 * - `getAllDocumentIds` / `getDeletedDocumentIds` narrowed by prefix
 * - `iterateChangeMetadataSince` / `iterateChangesSince` narrowed by prefix
 * - `countChangesSince` narrowed by prefix
 * - boundary-aware matching (`cls` must not match `classroom_…`)
 */
describe("matchesDocIdPrefix", () => {
  it("matches on the `<prefix>_` boundary, not a raw startsWith", () => {
    expect(matchesDocIdPrefix("cls_0BqXa9yTFn2M4kVzR1sWpq", "cls")).toBe(true);
    // Exact equality (no suffix) also matches.
    expect(matchesDocIdPrefix("cls", "cls")).toBe(true);
    // Different prefix that merely shares a leading substring must NOT match.
    expect(matchesDocIdPrefix("classroom_0BqXa9yTFn2M4kVzR1sWpq", "cls")).toBe(false);
    expect(matchesDocIdPrefix("clsx_0BqXa9yTFn2M4kVzR1sWpq", "cls")).toBe(false);
    // Empty prefix means "no filter".
    expect(matchesDocIdPrefix("anything", "")).toBe(true);
  });
});

describe("idPrefix-filtered reads and iteration", () => {
  let factory: BaseMindooTenantFactory;
  let adminUser: PrivateUserId;
  let adminUserPassword: string;
  let currentUser: PrivateUserId;
  let currentUserPassword: string;
  let keyBag: KeyBag;
  let tenant: MindooTenant;
  let db: MindooDB;

  beforeEach(async () => {
    const storeFactory = new InMemoryContentAddressedStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());
    adminUserPassword = "adminpass123";
    adminUser = await factory.createUserId("CN=admin/O=idprefixfilter", adminUserPassword);
    currentUserPassword = "userpassword123";
    currentUser = await factory.createUserId("CN=testuser/O=idprefixfilter", currentUserPassword);
    keyBag = new KeyBag(currentUser.userEncryptionKeyPair.privateKey, currentUserPassword, factory.getCryptoAdapter());

    const tenantId = "test-tenant-idprefixfilter";
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

  async function seedMixedDocuments(): Promise<{
    clsIds: string[];
    stuIds: string[];
    classroomId: string;
  }> {
    // Two `cls` docs, one `stu` doc, and one `classroom` doc whose id shares the
    // "cls" leading substring but a different prefix (boundary test).
    const cls1 = await db.createDocument({ idPrefix: "cls", initialValues: { name: "5a" } });
    const stu1 = await db.createDocument({ idPrefix: "stu", initialValues: { name: "Ada" } });
    const cls2 = await db.createDocument({ idPrefix: "cls", initialValues: { name: "5b" } });
    const classroom = await db.createDocument({ idPrefix: "classroom", initialValues: { name: "R1" } });
    return {
      clsIds: [cls1.getId(), cls2.getId()].sort(),
      stuIds: [stu1.getId()],
      classroomId: classroom.getId(),
    };
  }

  it("getAllDocumentIds({ idPrefix }) returns only boundary-matching ids", async () => {
    const { clsIds, classroomId } = await seedMixedDocuments();

    const all = await db.getAllDocumentIds();
    expect(all.length).toBe(4);

    const clsOnly = (await db.getAllDocumentIds({ idPrefix: "cls" })).sort();
    expect(clsOnly).toEqual(clsIds);
    expect(clsOnly).not.toContain(classroomId);

    const stuOnly = await db.getAllDocumentIds({ idPrefix: "stu" });
    expect(stuOnly.every((id) => id.startsWith("stu_"))).toBe(true);
    expect(stuOnly.length).toBe(1);

    // Empty prefix is a no-op filter.
    expect((await db.getAllDocumentIds({ idPrefix: "" })).length).toBe(4);
    // Unknown prefix yields nothing.
    expect(await db.getAllDocumentIds({ idPrefix: "nope" })).toEqual([]);
  }, 30000);

  it("getDeletedDocumentIds({ idPrefix }) filters deleted ids by prefix", async () => {
    const { clsIds, stuIds } = await seedMixedDocuments();

    await db.deleteDocument(clsIds[0]);
    await db.deleteDocument(stuIds[0]);

    const deletedCls = await db.getDeletedDocumentIds({ idPrefix: "cls" });
    expect(deletedCls).toEqual([clsIds[0]]);

    const deletedStu = await db.getDeletedDocumentIds({ idPrefix: "stu" });
    expect(deletedStu).toEqual([stuIds[0]]);

    // The still-existing cls doc must not appear on the deleted feed.
    expect(await db.getAllDocumentIds({ idPrefix: "cls" })).toEqual([clsIds[1]]);
  }, 30000);

  it("iterateChangeMetadataSince(null, { idPrefix }) yields only matching docIds", async () => {
    const { clsIds } = await seedMixedDocuments();

    const seen: string[] = [];
    for await (const summary of db.iterateChangeMetadataSince(null, { idPrefix: "cls" })) {
      seen.push(summary.docId);
    }
    expect(seen.sort()).toEqual(clsIds);
  }, 30000);

  it("iterateChangesSince(null, { idPrefix }) yields only matching documents", async () => {
    const { clsIds, stuIds, classroomId } = await seedMixedDocuments();

    const seen: string[] = [];
    for await (const { doc } of db.iterateChangesSince(null, { idPrefix: "cls" })) {
      seen.push(doc.getId());
    }
    expect(seen.sort()).toEqual(clsIds);
    expect(seen).not.toContain(classroomId);
    expect(seen).not.toContain(stuIds[0]);
  }, 30000);

  it("tolerates a trailing `_` in idPrefix across reads and iteration", async () => {
    const { clsIds } = await seedMixedDocuments();

    // A developer may append the boundary `_` by mistake; `"cls_"` must behave
    // exactly like `"cls"` (the separator is re-added by matchesDocIdPrefix).
    expect((await db.getAllDocumentIds({ idPrefix: "cls_" })).sort()).toEqual(clsIds);
    // Multiple trailing underscores collapse to the same prefix.
    expect((await db.getAllDocumentIds({ idPrefix: "cls__" })).sort()).toEqual(clsIds);

    const seenMeta: string[] = [];
    for await (const summary of db.iterateChangeMetadataSince(null, { idPrefix: "cls_" })) {
      seenMeta.push(summary.docId);
    }
    expect(seenMeta.sort()).toEqual(clsIds);

    const seenDocs: string[] = [];
    for await (const { doc } of db.iterateChangesSince(null, { idPrefix: "cls_" })) {
      seenDocs.push(doc.getId());
    }
    expect(seenDocs.sort()).toEqual(clsIds);

    expect(db.countChangesSince?.(null, { idPrefix: "cls_" })).toBe(2);

    // A prefix that is only underscores is an empty filter → matches everything.
    expect((await db.getAllDocumentIds({ idPrefix: "_" })).length).toBe(4);
  }, 30000);

  it("countChangesSince(null, { idPrefix }) counts only matching changes", async () => {
    const { classroomId } = await seedMixedDocuments();

    expect(db.countChangesSince?.(null)).toBe(4);
    expect(db.countChangesSince?.(null, { idPrefix: "cls" })).toBe(2);
    expect(db.countChangesSince?.(null, { idPrefix: "stu" })).toBe(1);
    expect(db.countChangesSince?.(null, { idPrefix: "classroom" })).toBe(1);
    // Boundary: `cls` must not count the classroom doc.
    expect(db.countChangesSince?.(null, { idPrefix: "cls" })).not.toBe(3);
    expect(classroomId.startsWith("classroom_")).toBe(true);
  }, 30000);
});
