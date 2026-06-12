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
} from "../core/types";
import type { AccessDecision, RuleType } from "../core/accesscontrol/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

/**
 * Server-side Tier 1 access evaluation must work with ONLY the `$publicinfos`
 * key — the exact key situation of a real sync server (TenantManager loads only
 * `$publicinfos`, never the tenant default key). The server therefore cannot
 * decrypt `user_details_encrypted`, so `getUserBySigningPublicKey` returns the
 * bare `username_hash`. Username- and group-targeted Tier 1 rules must still
 * match, resolved purely in hash space from the precomputed `identity_hashes`
 * bundle and the `$publicinfos`-readable group docs (docs/accesscontrol.md
 * §6.5, §7).
 */
class SharedInMemoryStoreFactory implements ContentAddressedStoreFactory {
  private stores = new Map<string, CreateStoreResult>();
  createStore(dbId: string, options?: OpenStoreOptions): CreateStoreResult {
    if (!this.stores.has(dbId)) {
      this.stores.set(dbId, {
        docStore: new InMemoryContentAddressedStore(dbId, StoreKind.docs, undefined, options),
        attachmentStore: new InMemoryContentAddressedStore(dbId, StoreKind.attachments, undefined, options),
      });
    }
    return this.stores.get(dbId)!;
  }
}

/** Server directory surface: hash-space lookups + the Tier 1 evaluator. */
type ServerDir = {
  getUserBySigningPublicKey(
    key: string,
  ): Promise<{ username: string; details: unknown; identityHashes?: string[] } | null>;
  evaluateAccessForSigningKey(input: {
    op: RuleType;
    dbid: string;
    signingKey: string;
    trustedTime: number;
    isAuthor?: boolean;
  }): Promise<AccessDecision>;
};

describe("server-side Tier 1 access evaluation with only the $publicinfos key (§6.5/§7)", () => {
  let factory: BaseMindooTenantFactory;
  let storeFactory: SharedInMemoryStoreFactory;
  const tenantId = "tenant-server-publicinfos";
  const dbid = "crm";

  let admin: PrivateUserId;
  const adminPassword = "adminpass123";
  let adminKeyBag: KeyBag;

  let alice: PrivateUserId;
  let bob: PrivateUserId;
  let hrUser: PrivateUserId;

  let writerTenant: MindooTenant;
  let aliceUsername: string;
  let hrUsername: string;

  type AclDirectory = Required<
    Pick<
      Awaited<ReturnType<MindooTenant["openDirectory"]>>,
      "setDatabaseAccessPolicy" | "setDefaultAccessPolicy" | "createAccessRule" | "addUsersToGroup"
    >
  > & { getUserBySigningPublicKey(key: string): Promise<{ username: string } | null> };
  let aclDir: AclDirectory;

  async function fullKeyBagFor(user: PrivateUserId, password: string): Promise<KeyBag> {
    const kb = new KeyBag(user.userEncryptionKeyPair.privateKey, password, new NodeCryptoAdapter());
    await kb.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, (await adminKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!);
    await kb.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, (await adminKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!);
    return kb;
  }

  beforeEach(async () => {
    storeFactory = new SharedInMemoryStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());

    admin = await factory.createUserId("CN=admin/O=srv", adminPassword);
    adminKeyBag = new KeyBag(admin.userEncryptionKeyPair.privateKey, adminPassword, new NodeCryptoAdapter());
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);

    alice = await factory.createUserId("CN=alice/O=srv", "alicepass123");
    bob = await factory.createUserId("CN=bob/O=srv", "bobpass123");
    hrUser = await factory.createUserId("CN=hruser/O=srv", "hrpass123");

    const writerUser = await factory.createUserId("CN=writer/O=srv", "writerpass123");
    writerTenant = await factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      writerUser,
      "writerpass123",
      await fullKeyBagFor(writerUser, "writerpass123"),
    );

    const directory = await writerTenant.openDirectory();
    for (const u of [admin, alice, bob, hrUser, writerUser]) {
      await directory.registerUser(factory.toPublicUserId(u), admin.userSigningKeyPair.privateKey, adminPassword);
    }
    aclDir = directory as unknown as AclDirectory;

    aliceUsername = (await aclDir.getUserBySigningPublicKey(alice.userSigningKeyPair.publicKey))!.username;
    hrUsername = (await aclDir.getUserBySigningPublicKey(hrUser.userSigningKeyPair.publicKey))!.username;

    // HR group with hrUser as a member.
    await aclDir.addUsersToGroup("hr", [hrUsername], admin.userSigningKeyPair.privateKey, adminPassword);

    // Baseline: deny doc_change in crm, then allow specific identities.
    await aclDir.setDefaultAccessPolicy({}, admin.userSigningKeyPair.privateKey, adminPassword);
    await aclDir.setDatabaseAccessPolicy(
      dbid,
      { denyDocChange: true },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );

    // Rule U: a username-targeted Tier 1 allow (no withfields).
    await aclDir.createAccessRule(
      { ruleId: "crm_change_alice", type: "doc_change", dbid, action: "allow", usernames: [aliceUsername] },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    // Rule G: a group-targeted Tier 1 allow (no withfields).
    await aclDir.createAccessRule(
      { ruleId: "crm_change_hr", type: "doc_change", dbid, action: "allow", groups: ["hr"] },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
  }, 90000);

  /** A sync-server tenant whose KeyBag holds ONLY $publicinfos (no default key). */
  async function openServerDirectory(): Promise<ServerDir> {
    const serverPassword = "server-pass-123";
    const serverUser = await factory.createUserId("CN=syncserver/O=srv", serverPassword);
    const serverKeyBag = new KeyBag(serverUser.userEncryptionKeyPair.privateKey, serverPassword, new NodeCryptoAdapter());
    await serverKeyBag.set(
      "doc",
      tenantId,
      PUBLIC_INFOS_KEY_ID,
      (await adminKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!,
    );
    const serverTenant = await factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      serverUser,
      serverPassword,
      serverKeyBag,
    );
    return (await serverTenant.openDirectory()) as unknown as ServerDir;
  }

  const TRUSTED_TIME = () => Date.now() + 60_000; // safely after all policy revisions

  it("cannot read the cleartext name (no default key) yet exposes the identity_hashes bundle", async () => {
    const serverDir = await openServerDirectory();
    const lookup = await serverDir.getUserBySigningPublicKey(alice.userSigningKeyPair.publicKey);
    expect(lookup).not.toBeNull();
    expect(lookup!.details).toBeNull();
    expect(lookup!.username).not.toBe(aliceUsername);
    expect(lookup!.identityHashes!.length).toBeGreaterThan(0);
  }, 90000);

  it("matches a username-targeted Tier 1 rule by signing key, in hash space", async () => {
    const serverDir = await openServerDirectory();
    const decision = await serverDir.evaluateAccessForSigningKey({
      op: "doc_change",
      dbid,
      signingKey: alice.userSigningKeyPair.publicKey,
      trustedTime: TRUSTED_TIME(),
    });
    expect(decision.allowed).toBe(true);
    expect(decision.tier).toBe("tier1");
    expect(decision.matchedRuleId).toBe("crm_change_alice");
  }, 90000);

  it("matches a group-targeted Tier 1 rule by signing key, in hash space", async () => {
    const serverDir = await openServerDirectory();
    const decision = await serverDir.evaluateAccessForSigningKey({
      op: "doc_change",
      dbid,
      signingKey: hrUser.userSigningKeyPair.publicKey,
      trustedTime: TRUSTED_TIME(),
    });
    expect(decision.allowed).toBe(true);
    expect(decision.tier).toBe("tier1");
    expect(decision.matchedRuleId).toBe("crm_change_hr");
  }, 90000);

  it("still denies an identity that no rule targets (baseline deny)", async () => {
    const serverDir = await openServerDirectory();
    const decision = await serverDir.evaluateAccessForSigningKey({
      op: "doc_change",
      dbid,
      signingKey: bob.userSigningKeyPair.publicKey,
      trustedTime: TRUSTED_TIME(),
    });
    expect(decision.allowed).toBe(false);
  }, 90000);
});
