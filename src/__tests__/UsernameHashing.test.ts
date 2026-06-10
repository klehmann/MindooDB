import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import {
  DEFAULT_TENANT_KEY_ID,
  PrivateUserId,
  MindooTenant,
  MindooDoc,
  MindooTenantDirectory,
  SigningKeyPair,
  PUBLIC_INFOS_KEY_ID,
} from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

/**
 * Tests for the salted (v2) username hashing scheme and its backward
 * compatibility with the legacy (v1) unsalted hashes (docs/accesscontrol.md §6.5).
 *
 * New grant/revoke documents must be written with the tenant-salted hash and a
 * `username_hash_v: 2` marker, while lookups must still match documents written
 * under the legacy unsalted scheme.
 */
describe("username hashing (salted v2 with legacy fallback)", () => {
  let factory: BaseMindooTenantFactory;
  let adminUser: PrivateUserId;
  let adminUserPassword: string;
  let tenant: MindooTenant;
  let tenantId: string;
  let directory: MindooTenantDirectory;
  let adminSigningKeyPair: SigningKeyPair;
  const subtle = new NodeCryptoAdapter().getSubtle();

  // `findGrantAccessDocuments` is implemented on the concrete directory class
  // but not declared on the public interface; expose it for assertions.
  type DirectoryWithFind = MindooTenantDirectory & {
    findGrantAccessDocuments(username: string): Promise<MindooDoc[]>;
  };

  async function sha256Hex(value: string): Promise<string> {
    const buf = await subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  beforeEach(async () => {
    const storeFactory = new InMemoryContentAddressedStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());
    adminUserPassword = "adminpass123";
    adminUser = await factory.createUserId("CN=admin/O=hashtest", adminUserPassword);
    tenantId = "test-tenant-hashing";

    const adminKeyBag = new KeyBag(
      adminUser.userEncryptionKeyPair.privateKey,
      adminUserPassword,
      factory.getCryptoAdapter(),
    );
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);

    // openTenant requires a non-admin current user; create one and share keys.
    const currentUserPassword = "currentpass123";
    const currentUser = await factory.createUserId("CN=current/O=hashtest", currentUserPassword);
    const currentUserKeyBag = new KeyBag(
      currentUser.userEncryptionKeyPair.privateKey,
      currentUserPassword,
      factory.getCryptoAdapter(),
    );
    await currentUserKeyBag.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, (await adminKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!);
    await currentUserKeyBag.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, (await adminKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!);

    tenant = await factory.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      currentUser,
      currentUserPassword,
      currentUserKeyBag,
    );
    directory = await tenant.openDirectory();
    // Register the admin identity so admin-signed directory writes are trusted.
    await directory.registerUser(
      factory.toPublicUserId(adminUser),
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword,
    );
    adminSigningKeyPair = adminUser.userSigningKeyPair;
  }, 30000);

  afterEach(async () => {
    await (tenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
  });

  it("writes new grants with the salted, NFKC-normalized v3 hash and a version marker", async () => {
    const user = await factory.createUserId("CN=alice/O=hashtest", "alicepass");
    await directory.registerUser(
      factory.toPublicUserId(user),
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword,
    );

    const docs = await (directory as DirectoryWithFind).findGrantAccessDocuments(user.username);
    expect(docs.length).toBe(1);
    const data = docs[0].getData();
    // Hardening (audit, Medium): the write form is now v3 — salted AND
    // NFKC-normalized before lowercasing to defeat homoglyph spoofing. For an
    // ASCII username NFKC is a no-op, so the digest equals the prior salted form.
    expect(data.username_hash_v).toBe(3);
    expect(data.username_hash).toBe(
      await sha256Hex(`${tenantId}/${user.username.normalize("NFKC").toLowerCase()}`),
    );
    // Must NOT be the legacy unsalted hash.
    expect(data.username_hash).not.toBe(await sha256Hex(user.username.toLowerCase()));
  }, 30000);

  it("still finds users stored under the legacy unsalted hash", async () => {
    // Simulate a directory document written by an older client: unsalted
    // username_hash and no version marker.
    const legacyUser = await factory.createUserId("CN=legacy/O=hashtest", "legacypass");
    const legacyHash = await sha256Hex(legacyUser.username.toLowerCase());

    const directoryDB = await tenant.openDB("directory");
    const doc = await directoryDB.createDocumentWithSigningKey(
      adminSigningKeyPair,
      adminUserPassword,
      PUBLIC_INFOS_KEY_ID,
    );
    await directoryDB.changeDoc(
      doc,
      (d: MindooDoc) => {
        const data = d.getData();
        data.form = "useroperation";
        data.type = "grantaccess";
        data.username_hash = legacyHash; // legacy v1, no username_hash_v
        data.userSigningPublicKey = legacyUser.userSigningKeyPair.publicKey;
        data.userEncryptionPublicKey = legacyUser.userEncryptionKeyPair.publicKey;
      },
      { signingKeyPair: adminSigningKeyPair, signingKeyPassword: adminUserPassword },
    );

    // Lookup by username must match the legacy doc despite the salted scheme.
    const found = await (directory as DirectoryWithFind).findGrantAccessDocuments(legacyUser.username);
    expect(found.length).toBe(1);
    expect(found[0].getData().username_hash).toBe(legacyHash);

    const keys = await directory.getUserPublicKeys(legacyUser.username);
    expect(keys?.signingPublicKey).toBe(legacyUser.userSigningKeyPair.publicKey);
  }, 30000);
});
