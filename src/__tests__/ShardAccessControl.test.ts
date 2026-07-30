/**
 * Write-policy behavior when sharding a database.
 *
 * Access-control rules are keyed by database id, so entries that were legal in
 * the source are not automatically legal in a freshly created shard. A graft
 * makes this sharp: it carries the ORIGINAL authors' signatures, and the server
 * witness evaluates Tier 1 against the target `dbid` when the shard is pushed.
 *
 * This suite pins the two things an operator needs to be able to rely on:
 * the default (no-rule) semantics, and that the copy refuses up front instead
 * of writing entries the witness would later reject.
 */

import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import {
  ContentAddressedStoreFactory,
  CreateStoreResult,
  DEFAULT_TENANT_KEY_ID,
  MindooDB,
  MindooTenant,
  OpenStoreOptions,
  PUBLIC_INFOS_KEY_ID,
  PrivateUserId,
  StoreKind,
} from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

/** One store per database id, shared across every tenant handle in the test. */
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

describe("sharding under an access policy", () => {
  const tenantId = "tenant-shard-acl";
  const adminPassword = "adminpass123";
  const alicePassword = "alicepass123";
  const operatorPassword = "operatorpass123";

  let factory: BaseMindooTenantFactory;
  let admin: PrivateUserId;
  let adminKeyBag: KeyBag;
  let alice: PrivateUserId;

  /** Alice authors the documents; the operator performs the shard. */
  let aliceTenant: MindooTenant;
  let operatorTenant: MindooTenant;
  let aclDir: {
    setDefaultAccessPolicy(
      policy: Record<string, unknown>,
      key: PrivateUserId["userSigningKeyPair"]["privateKey"],
      password: string,
    ): Promise<unknown>;
    setDatabaseAccessPolicy(
      dbid: string,
      policy: Record<string, unknown>,
      key: PrivateUserId["userSigningKeyPair"]["privateKey"],
      password: string,
    ): Promise<unknown>;
    createAccessRule(
      rule: Record<string, unknown>,
      key: PrivateUserId["userSigningKeyPair"]["privateKey"],
      password: string,
    ): Promise<unknown>;
  };

  let monolith: MindooDB;
  let docId: string;

  /**
   * @param withDocumentKey When false, the bag gets only the public-infos key
   *   needed to read the directory — not the tenant key the documents are
   *   encrypted with. That models an infrastructure operator who administers
   *   the databases without being able to read what is in them.
   */
  async function keyBagFor(
    user: PrivateUserId,
    password: string,
    withDocumentKey = true,
  ): Promise<KeyBag> {
    const bag = new KeyBag(user.userEncryptionKeyPair.privateKey, password, new NodeCryptoAdapter());
    await bag.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, (await adminKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!);
    if (withDocumentKey) {
      await bag.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, (await adminKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!);
    }
    return bag;
  }

  beforeEach(async () => {
    factory = new BaseMindooTenantFactory(new SharedInMemoryStoreFactory(), new NodeCryptoAdapter());

    admin = await factory.createUserId("CN=admin/O=shardacl", adminPassword);
    adminKeyBag = new KeyBag(admin.userEncryptionKeyPair.privateKey, adminPassword, new NodeCryptoAdapter());
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);

    alice = await factory.createUserId("CN=alice/O=shardacl", alicePassword);
    const operator = await factory.createUserId("CN=operator/O=shardacl", operatorPassword);

    aliceTenant = await factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      alice,
      alicePassword,
      await keyBagFor(alice, alicePassword),
    );
    operatorTenant = await factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      operator,
      operatorPassword,
      await keyBagFor(operator, operatorPassword),
    );

    const directory = await aliceTenant.openDirectory();
    for (const user of [admin, alice, operator]) {
      await directory.registerUser(
        factory.toPublicUserId(user),
        admin.userSigningKeyPair.privateKey,
        adminPassword,
      );
    }
    aclDir = directory as unknown as typeof aclDir;

    // Access control is enabled tenant-wide, but permissive by default.
    await aclDir.setDefaultAccessPolicy({}, admin.userSigningKeyPair.privateKey, adminPassword);

    monolith = await aliceTenant.openDB("monolith");
    const doc = await monolith.createDocument({ idPrefix: "inv2025" });
    await monolith.changeDoc(doc, (draft) => {
      draft.getData().year = 2025;
    });
    docId = doc.getId();
  }, 120000);

  it("admits a shard into a database with no rules of its own", async () => {
    // The pinned default: access control is enabled, the target database has no
    // policy and no matching rule, so the baseline deny flags are all false and
    // everything is allowed. A shard into a brand-new database just works.
    const shard = await operatorTenant.openDB("shard-open");

    const result = await monolith.copyDocumentsTo({ idPrefix: "inv2025" }, shard, {
      mode: "history",
      targetDocId: "same",
      authorship: "preserve",
    });

    expect(result.failed).toEqual([]);
    expect(result.copiedDocIds).toEqual([docId]);
    for (const entry of await shard.getStore().findNewEntriesForDoc([], docId)) {
      expect(entry.createdByPublicKey).toBe(alice.userSigningKeyPair.publicKey);
    }
  }, 120000);

  it("refuses the graft when the target denies the original authors", async () => {
    await aclDir.setDatabaseAccessPolicy(
      "shard-locked",
      { denyDocCreate: true, denyDocChange: true },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    const shard = await operatorTenant.openDB("shard-locked");

    const result = await monolith.copyDocumentsTo({ idPrefix: "inv2025" }, shard, {
      mode: "history",
      targetDocId: "same",
      authorship: "preserve",
    });

    expect(result.copiedDocIds).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toMatch(/does not admit/);
    expect(result.failed[0].error).toMatch(/reauthor|bypassAccessControlPrecheck/);
    // Nothing was written: the refusal happens before any entry is transferred.
    expect(await shard.getStore().findNewEntriesForDoc([], docId)).toHaveLength(0);
  }, 120000);

  it("admits the graft once the target grants the original authors", async () => {
    await aclDir.setDatabaseAccessPolicy(
      "shard-granted",
      { denyDocCreate: true, denyDocChange: true },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    for (const type of ["doc_create", "doc_change"]) {
      await aclDir.createAccessRule(
        {
          ruleId: `shard_granted_${type}`,
          type,
          dbid: "shard-granted",
          action: "allow",
          users_hashes: ["$everyone"],
        },
        admin.userSigningKeyPair.privateKey,
        adminPassword,
      );
    }
    const shard = await operatorTenant.openDB("shard-granted");

    const result = await monolith.copyDocumentsTo({ idPrefix: "inv2025" }, shard, {
      mode: "history",
      targetDocId: "same",
      authorship: "preserve",
    });

    expect(result.failed).toEqual([]);
    expect(result.copiedDocIds).toEqual([docId]);
  }, 120000);

  it("writes anyway when the caller bypasses the precheck", async () => {
    await aclDir.setDatabaseAccessPolicy(
      "shard-bypass",
      { denyDocCreate: true, denyDocChange: true },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    const shard = await operatorTenant.openDB("shard-bypass");

    const result = await monolith.copyDocumentsTo({ idPrefix: "inv2025" }, shard, {
      mode: "history",
      targetDocId: "same",
      authorship: "preserve",
      bypassAccessControlPrecheck: true,
    });

    expect(result.failed).toEqual([]);
    expect((await shard.getStore().findNewEntriesForDoc([], docId)).length).toBeGreaterThan(0);
  }, 120000);

  it("lets an operator who cannot read the documents shard them anyway", async () => {
    // The point of the graft fast path: it moves ciphertext, so administering
    // a database and being able to read it are separate privileges.
    const custodian = await factory.createUserId("CN=custodian/O=shardacl", "custodianpass123");
    await (await aliceTenant.openDirectory()).registerUser(
      factory.toPublicUserId(custodian),
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    const custodianTenant = await factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      custodian,
      "custodianpass123",
      await keyBagFor(custodian, "custodianpass123", false),
    );

    const custodianMonolith = await custodianTenant.openDB("monolith");
    const shard = await custodianTenant.openDB("shard-custodian");

    // The custodian genuinely cannot read the content.
    await expect(custodianMonolith.getDocument(docId)).rejects.toThrow();

    const result = await custodianMonolith.copyDocumentsTo({ idPrefix: "inv2025" }, shard, {
      mode: "history",
      targetDocId: "same",
      authorship: "preserve",
    });

    expect(result.failed).toEqual([]);
    expect(result.copiedDocIds).toEqual([docId]);

    // Alice, who holds the key, finds her document intact in the shard —
    // still carrying her signature, not the custodian's.
    const aliceShard = await aliceTenant.openDB("shard-custodian");
    expect((await aliceShard.getDocument(docId)).getData().year).toBe(2025);
    for (const entry of await aliceShard.getStore().findNewEntriesForDoc([], docId)) {
      expect(entry.createdByPublicKey).toBe(alice.userSigningKeyPair.publicKey);
    }
  }, 120000);

  it("checks the copying user, not the original authors, on a replay", async () => {
    // Only the operator is granted on this target. A graft would be refused
    // (Alice has no rights here) but a replay re-signs as the operator, so the
    // same documents go through.
    await aclDir.setDatabaseAccessPolicy(
      "shard-replay",
      { denyDocCreate: true, denyDocChange: true },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    const directoryInternals = aclDir as unknown as {
      getUserBySigningPublicKey(key: string): Promise<{ username: string } | null>;
      hashUsername(username: string): Promise<string>;
    };
    const operatorUsername = (
      await directoryInternals.getUserBySigningPublicKey(
        (await operatorTenant.getCurrentUserId()).userSigningPublicKey,
      )
    )!.username;
    const operatorHash = await directoryInternals.hashUsername(operatorUsername);
    for (const type of ["doc_create", "doc_change"]) {
      await aclDir.createAccessRule(
        {
          ruleId: `shard_replay_${type}`,
          type,
          dbid: "shard-replay",
          action: "allow",
          users_hashes: [operatorHash],
        },
        admin.userSigningKeyPair.privateKey,
        adminPassword,
      );
    }
    const shard = await operatorTenant.openDB("shard-replay");
    const operatorMonolith = await operatorTenant.openDB("monolith");

    const grafted = await operatorMonolith.copyDocumentsTo({ idPrefix: "inv2025" }, shard, {
      mode: "history",
      targetDocId: "same",
      authorship: "preserve",
    });
    expect(grafted.failed).toHaveLength(1);
    expect(grafted.failed[0].error).toMatch(/does not admit/);

    const replayed = await operatorMonolith.copyDocumentsTo({ idPrefix: "inv2025" }, shard, {
      mode: "history",
      targetDocId: "same",
    });
    expect(replayed.failed).toEqual([]);
    expect(replayed.copiedDocIds).toEqual([docId]);
  }, 120000);
});
