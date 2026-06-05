import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import {
  PrivateUserId,
  MindooTenant,
  MindooDoc,
  MindooTenantDirectory,
  SigningKeyPair,
  PUBLIC_INFOS_KEY_ID,
} from "../core/types";
import {
  ACL_DEFAULT_POLICY_DOC_ID,
  aclRuleDocId,
} from "../core/accesscontrol/types";
import type { DirectoryStateNode } from "../core/accesscontrol/DirectoryStateNode";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

/**
 * Integration test: access-control documents written into the `directory`
 * database are projected into the time-travel chain (docs/accesscontrol.md §6,
 * §8). Verifies the directory's single-pass builder parses policy, rule, and
 * grant documents into the head node.
 */
describe("directory-state chain integration", () => {
  let factory: BaseMindooTenantFactory;
  let adminUser: PrivateUserId;
  let adminUserPassword: string;
  let tenant: MindooTenant;
  let directory: MindooTenantDirectory;
  let adminSigningKeyPair: SigningKeyPair;

  type DirectoryWithState = MindooTenantDirectory & {
    getDirectoryStateHead(): Promise<DirectoryStateNode>;
  };

  beforeEach(async () => {
    const storeFactory = new InMemoryContentAddressedStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());
    adminUserPassword = "adminpass123";
    adminUser = await factory.createUserId("CN=admin/O=dirstate", adminUserPassword);
    const tenantId = "test-tenant-dirstate";

    const adminKeyBag = new KeyBag(adminUser.userEncryptionKeyPair.privateKey, adminUserPassword, factory.getCryptoAdapter());
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);

    const currentUserPassword = "currentpass";
    const currentUser = await factory.createUserId("CN=current/O=dirstate", currentUserPassword);
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
    await directory.registerUser(factory.toPublicUserId(adminUser), adminUser.userSigningKeyPair.privateKey, adminUserPassword);
    adminSigningKeyPair = adminUser.userSigningKeyPair;
  }, 30000);

  afterEach(async () => {
    await (tenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
  });

  async function writeAclDoc(docId: string, fields: Record<string, unknown>): Promise<void> {
    const db = await tenant.openDB("directory");
    const doc = await db.createDocument({
      id: docId,
      decryptionKeyId: PUBLIC_INFOS_KEY_ID,
      signingKeyPair: adminSigningKeyPair,
      signingKeyPassword: adminUserPassword,
    });
    await db.changeDoc(
      doc,
      (d: MindooDoc) => {
        const data = d.getData();
        for (const [k, v] of Object.entries(fields)) {
          data[k] = v;
        }
      },
      { signingKeyPair: adminSigningKeyPair, signingKeyPassword: adminUserPassword },
    );
  }

  it("projects the default policy document into the chain head", async () => {
    await writeAclDoc(ACL_DEFAULT_POLICY_DOC_ID, {
      form: "accesscontrol",
      type: "defaultpolicy",
      denyDocChange: true,
    });
    const head = await (directory as DirectoryWithState).getDirectoryStateHead();
    expect(head.defaultPolicy?.denyDocChange).toBe(true);
  }, 30000);

  it("projects an access-control rule document into the chain head", async () => {
    const ruleId = "ruleOne";
    await writeAclDoc(aclRuleDocId(ruleId), {
      form: "accesscontrol",
      type: "doc_change",
      ruleId,
      dbid: "*",
      action: "allow",
      users_hashes: ["$everyone"],
      users_encrypted: "",
    });
    const head = await (directory as DirectoryWithState).getDirectoryStateHead();
    const rules = head.rulesByType.get("doc_change") ?? [];
    expect(rules.map((r) => r.ruleId)).toContain(ruleId);
    expect(rules[0].action).toBe("allow");
  }, 30000);

  it("projects user grants into usersByHash and the reverse signing-key index", async () => {
    const user = await factory.createUserId("CN=alice/O=dirstate", "alicepass");
    await directory.registerUser(factory.toPublicUserId(user), adminUser.userSigningKeyPair.privateKey, adminUserPassword);

    const head = await (directory as DirectoryWithState).getDirectoryStateHead();
    const grant = head.bySigningKey.get(user.userSigningKeyPair.publicKey);
    expect(grant).toBeTruthy();
    expect(grant!.active).toBe(true);
    expect(grant!.signingKeys).toContain(user.userSigningKeyPair.publicKey);
  }, 30000);
});
