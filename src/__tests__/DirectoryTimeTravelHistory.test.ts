import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { WitnessingInMemoryContentAddressedStoreFactory } from "./_helpers/witnessingStore";
import {
  PrivateUserId,
  MindooTenant,
  MindooTenantDirectory,
  MindooDB,
  ChangeRevisionResult,
  PUBLIC_INFOS_KEY_ID,
} from "../core/types";
import { ACL_DEFAULT_POLICY_DOC_ID } from "../core/accesscontrol/types";
import type { DirectoryStateNode } from "../core/accesscontrol/DirectoryStateNode";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

/**
 * Regression coverage for the directory time-travel history (docs/accesscontrol.md
 * §8). These tests close the gap that previously hid a doc-grain bug: the chain
 * was built from the latest merged document, so intermediate revisions of an
 * in-place-edited policy/grant collapsed into a single node. The chain is now
 * built from the revision-grain changefeed, one node per change, stamped by
 * trusted time.
 */
describe("directory time-travel history (revision-grain)", () => {
  let factory: BaseMindooTenantFactory;
  let adminUser: PrivateUserId;
  let adminUserPassword: string;
  let tenant: MindooTenant;
  let directory: MindooTenantDirectory;

  type DirectoryWithState = MindooTenantDirectory & {
    getDirectoryStateHead(): Promise<DirectoryStateNode>;
    getDirectoryStateAt(T: number): Promise<DirectoryStateNode>;
    setDefaultAccessPolicy(
      policy: Record<string, unknown>,
      adminPrivateKey: unknown,
      adminPassword: string,
    ): Promise<void>;
    createAccessRule(
      rule: Record<string, unknown>,
      adminPrivateKey: unknown,
      adminPassword: string,
    ): Promise<void>;
    deleteRule(ruleId: string, adminPrivateKey: unknown, adminPassword: string): Promise<void>;
    findGrantAccessDocuments(username: string): Promise<Array<{ getId(): string }>>;
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function adminPrivateKey() {
    return adminUser.userSigningKeyPair.privateKey;
  }

  async function collectRevisions(
    db: MindooDB,
    docId?: string,
  ): Promise<ChangeRevisionResult[]> {
    const out: ChangeRevisionResult[] = [];
    const gen = docId
      ? db.iterateDocRevisionsSince(docId, null)
      : db.iterateChangeRevisionsSince(null);
    for await (const rev of gen) {
      out.push(rev);
    }
    return out;
  }

  beforeEach(async () => {
    const storeFactory = new WitnessingInMemoryContentAddressedStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());
    adminUserPassword = "adminpass123";
    adminUser = await factory.createUserId("CN=admin/O=tthist", adminUserPassword);
    const tenantId = "test-tenant-tthist";

    const adminKeyBag = new KeyBag(adminUser.userEncryptionKeyPair.privateKey, adminUserPassword, factory.getCryptoAdapter());
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);

    const currentUserPassword = "currentpass";
    const currentUser = await factory.createUserId("CN=current/O=tthist", currentUserPassword);
    const currentUserKeyBag = new KeyBag(currentUser.userEncryptionKeyPair.privateKey, currentUserPassword, factory.getCryptoAdapter());
    await currentUserKeyBag.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, (await adminKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!);
    await currentUserKeyBag.set("doc", tenantId, "default", (await adminKeyBag.get("doc", tenantId, "default"))!);

    tenant = await factory.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      currentUser,
      currentUserPassword,
      currentUserKeyBag,
    );
    directory = await tenant.openDirectory();
    await directory.registerUser(factory.toPublicUserId(adminUser), adminPrivateKey(), adminUserPassword);
  }, 30000);

  afterEach(async () => {
    await (tenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
  });

  it("regression: getStateAt returns the intermediate policy, head the latest", async () => {
    const dir = directory as DirectoryWithState;

    await dir.setDefaultAccessPolicy({ denyDocChange: false }, adminPrivateKey(), adminUserPassword);
    await sleep(5);
    await dir.setDefaultAccessPolicy({ denyDocChange: true }, adminPrivateKey(), adminUserPassword);

    // Recover the trusted time of each policy revision from the revision feed.
    const db = await tenant.openDB("directory");
    const policyRevisions = (await collectRevisions(db, ACL_DEFAULT_POLICY_DOC_ID)).filter(
      (r) => (r.doc.getData() as Record<string, unknown>).type === "defaultpolicy",
    );
    const falseRev = policyRevisions.find(
      (r) => (r.doc.getData() as Record<string, unknown>).denyDocChange === false,
    )!;
    const trueRev = policyRevisions.find(
      (r) => (r.doc.getData() as Record<string, unknown>).denyDocChange === true,
    )!;
    expect(falseRev).toBeTruthy();
    expect(trueRev).toBeTruthy();
    expect(trueRev.trustedTime).toBeGreaterThan(falseRev.trustedTime);

    // Head reflects the latest revision...
    expect((await dir.getDirectoryStateHead()).defaultPolicy?.denyDocChange).toBe(true);
    // ...but time-travel at the first revision's trusted time returns the first.
    expect((await dir.getDirectoryStateAt(falseRev.trustedTime)).defaultPolicy?.denyDocChange).toBe(false);
    // And at the second revision's trusted time, the second.
    expect((await dir.getDirectoryStateAt(trueRev.trustedTime)).defaultPolicy?.denyDocChange).toBe(true);
    // Just before the first policy revision, no policy existed.
    expect((await dir.getDirectoryStateAt(falseRev.trustedTime - 1)).defaultPolicy?.denyDocChange).toBeUndefined();
  }, 30000);

  it("revision feed yields every revision of an in-place-edited doc (doc-grain yields one)", async () => {
    const dir = directory as DirectoryWithState;
    await dir.setDefaultAccessPolicy({ denyDocChange: false }, adminPrivateKey(), adminUserPassword);
    await sleep(5);
    await dir.setDefaultAccessPolicy({ denyDocChange: true }, adminPrivateKey(), adminUserPassword);

    const db = await tenant.openDB("directory");

    // Revision feed: at least two revisions carry the policy fields.
    const policyRevs = (await collectRevisions(db, ACL_DEFAULT_POLICY_DOC_ID)).filter(
      (r) => (r.doc.getData() as Record<string, unknown>).type === "defaultpolicy",
    );
    expect(policyRevs.length).toBeGreaterThanOrEqual(2);

    // Doc-grain feed: the same document appears exactly once.
    let docGrainCount = 0;
    for await (const { doc } of db.iterateChangesSince(null)) {
      if (doc.getId() === ACL_DEFAULT_POLICY_DOC_ID) docGrainCount++;
    }
    expect(docGrainCount).toBe(1);
  }, 30000);

  it("single-doc revision feed matches the all-docs stream restricted to that doc", async () => {
    const dir = directory as DirectoryWithState;
    await dir.setDefaultAccessPolicy({ denyDocChange: false }, adminPrivateKey(), adminUserPassword);
    await sleep(5);
    await dir.setDefaultAccessPolicy({ denyDocCreate: true }, adminPrivateKey(), adminUserPassword);

    const db = await tenant.openDB("directory");
    const all = await collectRevisions(db);
    // The feed discovers per affected doc; identity is the (stable) entry id.
    const allForPolicy = all
      .filter((r) => r.docId === ACL_DEFAULT_POLICY_DOC_ID)
      .map((r) => r.entryId);
    const single = (await collectRevisions(db, ACL_DEFAULT_POLICY_DOC_ID)).map((r) => r.entryId);

    expect(single).toEqual(allForPolicy);
    // Within a single document, revisions are emitted in non-decreasing trusted-time order.
    const policyRevs = all.filter((r) => r.docId === ACL_DEFAULT_POLICY_DOC_ID);
    for (let i = 1; i < policyRevs.length; i++) {
      expect(policyRevs[i].trustedTime).toBeGreaterThanOrEqual(policyRevs[i - 1].trustedTime);
    }
  }, 30000);

  it("grant then full revoke: history shows active before, revoked at head", async () => {
    const dir = directory as DirectoryWithState;
    const aliceUsername = "CN=alice/O=tthist";
    const aliceUser = await factory.createUserId(aliceUsername, "alicepass");
    const aliceKey = aliceUser.userSigningKeyPair.publicKey;

    await directory.registerUser(factory.toPublicUserId(aliceUser), adminPrivateKey(), adminUserPassword);

    // Alice is active at head right after the grant.
    const headAfterGrant = await dir.getDirectoryStateHead();
    expect(headAfterGrant.bySigningKey.has(aliceKey)).toBe(true);

    const grantDocs = await dir.findGrantAccessDocuments(aliceUsername);
    expect(grantDocs.length).toBeGreaterThan(0);
    const grantDocId = grantDocs[0].getId();
    const grantRevs = await collectRevisions(await tenant.openDB("directory"), grantDocId);
    const tActive = Math.max(...grantRevs.map((r) => r.trustedTime));

    await sleep(5);
    await directory.revokeUser(aliceUsername, {}, adminPrivateKey(), adminUserPassword);

    // At head Alice's signing key is no longer trusted.
    const head = await dir.getDirectoryStateHead();
    expect(head.bySigningKey.has(aliceKey)).toBe(false);

    // But the historical state at the grant's trusted time still trusts her.
    const atActive = await dir.getDirectoryStateAt(tActive);
    expect(atActive.bySigningKey.has(aliceKey)).toBe(true);
  }, 30000);

  it("rule add then delete: present in history, absent at head", async () => {
    const dir = directory as DirectoryWithState;
    const ruleId = "histRule";

    await dir.createAccessRule(
      { ruleId, type: "doc_change", dbid: "*", action: "allow", users_hashes: ["$everyone"] },
      adminPrivateKey(),
      adminUserPassword,
    );

    const headWithRule = await dir.getDirectoryStateHead();
    const ruleNode = headWithRule.rulesByType.get("doc_change") ?? [];
    expect(ruleNode.map((r) => r.ruleId)).toContain(ruleId);

    // Trusted time at which the rule existed.
    const db = await tenant.openDB("directory");
    const ruleRevs = await collectRevisions(db);
    const tRule = Math.max(
      ...ruleRevs.filter((r) => (r.doc.getData() as Record<string, unknown>).ruleId === ruleId).map((r) => r.trustedTime),
    );

    await sleep(5);
    await dir.deleteRule(ruleId, adminPrivateKey(), adminUserPassword);

    const head = await dir.getDirectoryStateHead();
    expect((head.rulesByType.get("doc_change") ?? []).map((r) => r.ruleId)).not.toContain(ruleId);

    const atRule = await dir.getDirectoryStateAt(tRule);
    expect((atRule.rulesByType.get("doc_change") ?? []).map((r) => r.ruleId)).toContain(ruleId);
  }, 30000);
});
