import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { DEFAULT_TENANT_KEY_ID, PrivateUserId, MindooTenant, MindooDoc, ProcessChangesCursor, PUBLIC_INFOS_KEY_ID } from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

describe("granting tenant access", () => {
  let factory: BaseMindooTenantFactory;
  let storeFactory: InMemoryContentAddressedStoreFactory;
  let adminUser: PrivateUserId;
  let adminUserPassword: string;
  let adminKeyBag: KeyBag;
  let tenant: MindooTenant;
  let tenantId: string;
  let regularUser: PrivateUserId;
  let regularUserPassword: string;

  beforeEach(async () => {
    storeFactory = new InMemoryContentAddressedStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());
    
    // Create admin user (signing + encryption keys used for tenant administration)
    adminUserPassword = "adminpass123";
    adminUser = await factory.createUserId("CN=admin/O=testtenant", adminUserPassword);
    
    // Create tenant encryption key
    tenantId = "test-tenant-process-changes";
    
    // Create KeyBag for admin user
    const cryptoAdapter = new NodeCryptoAdapter();
    adminKeyBag = new KeyBag(
      adminUser.userEncryptionKeyPair.privateKey,
      adminUserPassword,
      cryptoAdapter
    );
    
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);

    const currentUser = await factory.createUserId("CN=currentuser/O=testtenant", "currentpass123");
    const currentUserKeyBag = new KeyBag(currentUser.userEncryptionKeyPair.privateKey, "currentpass123", cryptoAdapter);
    await currentUserKeyBag.set(
      "doc",
      tenantId,
      PUBLIC_INFOS_KEY_ID,
      (await adminKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!,
    );
    await currentUserKeyBag.set(
      "doc",
      tenantId,
      DEFAULT_TENANT_KEY_ID,
      (await adminKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!,
    );

    tenant = await factory.openTenant(tenantId, adminUser.userSigningKeyPair.publicKey, adminUser.userEncryptionKeyPair.publicKey, currentUser, "currentpass123", currentUserKeyBag);
    
    // Create regular user
    regularUserPassword = "regularpass123";
    regularUser = await factory.createUserId("CN=regularuser/O=testtenant", regularUserPassword);
    
    // Register the admin user in the directory so their key is trusted when verifying signatures
    const directory = await tenant.openDirectory();
    const publicAdminUser = factory.toPublicUserId(adminUser);
    await directory.registerUser(
      publicAdminUser,
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword
    );
  }, 30000); // Increase timeout for crypto operations

  it("should find the document where access was granted using iterateChangesSince", async () => {
    // Grant access to the regular user (register them)
    const directory = await tenant.openDirectory();
    const publicRegularUser = factory.toPublicUserId(regularUser);
    
    await directory.registerUser(
      publicRegularUser,
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword,
      { email: "regularuser@example.com" },
    );
    
    // Get the directory database
    const directoryDB = await tenant.openDB("directory");
    
    // Sync changes to make sure everything is processed
    await directoryDB.syncStoreChanges();
    
    // Use generator-based iterateChangesSince to find documents
    const initialCursor: ProcessChangesCursor | null = null;
    const foundDocuments: Array<{ doc: MindooDoc; cursor: ProcessChangesCursor }> = [];
    
    for await (const { doc, cursor } of directoryDB.iterateChangesSince(initialCursor)) {
      foundDocuments.push({ doc, cursor });
    }
    
    // Verify we found at least one document
    expect(foundDocuments.length).toBeGreaterThan(0);
    
    // Find the document where access was granted
    // Note: Since usernames are now hashed, we search by userSigningPublicKey
    const accessGrantDoc = foundDocuments.find(({ doc }) => {
      const data = doc.getData();
      return data.form === "useroperation" && 
             data.type === "grantaccess" && 
             data.userSigningPublicKey === regularUser.userSigningKeyPair.publicKey;
    });
    
    // Verify we found the access grant document
    expect(accessGrantDoc).toBeDefined();
    expect(accessGrantDoc!.doc).toBeDefined();
    
    // Verify the document content
    const docData = accessGrantDoc!.doc.getData();
    expect(docData.form).toBe("useroperation");
    expect(docData.type).toBe("grantaccess");
    // Username is now stored as hash plus a tenant-readable encrypted details envelope.
    expect(docData.username_hash).toBeDefined();
    expect(typeof docData.username_hash).toBe("string");
    expect(docData.user_details_encrypted).toBeDefined();
    expect(typeof docData.user_details_encrypted).toBe("string");
    expect(docData.userSigningPublicKey).toBe(regularUser.userSigningKeyPair.publicKey);
    expect(docData.userEncryptionPublicKey).toBe(regularUser.userEncryptionKeyPair.publicKey);
    
    // Note: Admin signature verification is now done at entry level via adminOnlyDb flag
    // The directory database only accepts entries signed by the administration key.
    // This means if the document exists, it was signed by the admin - no need for
    // document-level adminSignature fields.
    
    // Verify the document ID and timestamps
    expect(accessGrantDoc!.doc.getId()).toBeDefined();
    expect(accessGrantDoc!.doc.getCreatedAt()).toBeGreaterThan(0);
    expect(accessGrantDoc!.doc.getLastModified()).toBeGreaterThan(0);
    expect(accessGrantDoc!.doc.isDeleted()).toBe(false);
    
    console.log(`Found access grant document: ${accessGrantDoc!.doc.getId()}`);
    console.log(`Document created at: ${new Date(accessGrantDoc!.doc.getCreatedAt()).toISOString()}`);
    console.log(`Document last modified at: ${new Date(accessGrantDoc!.doc.getLastModified()).toISOString()}`);
  });

  it("should resolve tenant-readable user details by signing public key", async () => {
    const directory = await tenant.openDirectory();
    const publicRegularUser = factory.toPublicUserId(regularUser);

    await directory.registerUser(
      publicRegularUser,
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword,
      { email: "regularuser@example.com" },
    );

    const userLookup = await directory.getUserBySigningPublicKey(regularUser.userSigningKeyPair.publicKey);

    expect(userLookup).toMatchObject({
      username: regularUser.username,
      signingPublicKey: regularUser.userSigningKeyPair.publicKey,
      encryptionPublicKey: regularUser.userEncryptionKeyPair.publicKey,
      details: {
        username: regularUser.username,
        email: "regularuser@example.com",
      },
    });
    // New grants carry the current identity-hash bundle (§6.5).
    expect(Array.isArray(userLookup!.identityHashes)).toBe(true);
    expect(userLookup!.identityHashes!.length).toBeGreaterThan(0);
    expect(userLookup!.identityHashesV).toBe(1);
  });

  it("should gracefully handle legacy grant documents without tenant-readable user details", async () => {
    const directory = await tenant.openDirectory();
    const directoryDB = await tenant.openDB("directory");
    const legacyDoc = await directoryDB.createDocumentWithSigningKey(
      adminUser.userSigningKeyPair,
      adminUserPassword,
      PUBLIC_INFOS_KEY_ID,
    );
    const legacyUsernameHash = await (directory as unknown as { hashUsername: (username: string) => Promise<string> })
      .hashUsername(regularUser.username);

    await directoryDB.changeDoc(
      legacyDoc,
      async (doc: MindooDoc) => {
        const data = doc.getData();
        data.form = "useroperation";
        data.type = "grantaccess";
        data.username_hash = legacyUsernameHash;
        data.username_encrypted = "legacy-admin-only-payload";
        data.userSigningPublicKey = regularUser.userSigningKeyPair.publicKey;
        data.userEncryptionPublicKey = regularUser.userEncryptionKeyPair.publicKey;
      },
      {
        signingKeyPair: adminUser.userSigningKeyPair,
        signingKeyPassword: adminUserPassword,
      },
    );

    const userLookup = await directory.getUserBySigningPublicKey(regularUser.userSigningKeyPair.publicKey);

    expect(userLookup).toMatchObject({
      username: legacyUsernameHash,
      signingPublicKey: regularUser.userSigningKeyPair.publicKey,
      encryptionPublicKey: regularUser.userEncryptionKeyPair.publicKey,
      details: null,
    });
    // Legacy grants lack the bundle: it degrades to exact-match [username_hash]
    // at version 0 (flagged for backfill, §6.5).
    expect(userLookup!.identityHashes).toEqual([legacyUsernameHash]);
    expect(userLookup!.identityHashesV).toBe(0);
  });

  async function findGrantDoc(
    tenantRef: MindooTenant,
    signingPublicKey: string,
  ): Promise<MindooDoc | undefined> {
    const directoryDB = await tenantRef.openDB("directory");
    await directoryDB.syncStoreChanges();
    for await (const { doc } of directoryDB.iterateChangesSince(null)) {
      const data = doc.getData();
      if (data.form !== "useroperation" || data.type !== "grantaccess") continue;
      const pairs = [
        ...(Array.isArray(data.userKeyPairs) ? data.userKeyPairs : []),
        ...(Array.isArray(data.revokedUserKeyPairs) ? data.revokedUserKeyPairs : []),
      ];
      if (pairs.some((p) => (p as { signingPublicKey?: string }).signingPublicKey === signingPublicKey)) {
        return doc;
      }
    }
    return undefined;
  }

  it("retains a revoked device on the grant doc (revoked + revokedAt), excluded from active keys (§6.5)", async () => {
    const directory = await tenant.openDirectory();
    const publicRegularUser = factory.toPublicUserId(regularUser);
    const signingKey = regularUser.userSigningKeyPair.publicKey;

    await directory.registerUser(
      publicRegularUser,
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword,
      { email: "regularuser@example.com" },
    );

    // Sanity: active before revoke.
    expect(await directory.getUserPublicKeys(regularUser.username)).not.toBeNull();

    const before = Date.now();
    await directory.revokeUser(
      regularUser.username,
      { signingKeys: [signingKey] },
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword,
    );
    const after = Date.now();

    // Active key lookups no longer see the device.
    expect(await directory.getUserPublicKeys(regularUser.username)).toBeNull();
    expect(await directory.getUserKeyPairs!(regularUser.username)).toEqual([]);

    // The grant overview surfaces it as a revoked device with a timestamp.
    const overview = await directory.getUserGrantOverview!(regularUser.username);
    expect(overview.activeDevices).toEqual([]);
    expect(overview.revokedDevices).toHaveLength(1);
    expect(overview.revokedDevices[0].signingPublicKey).toBe(signingKey);
    expect(overview.revokedDevices[0].revoked).toBe(true);
    expect(overview.revokedDevices[0].revokedAt).toBeGreaterThanOrEqual(before);
    expect(overview.revokedDevices[0].revokedAt).toBeLessThanOrEqual(after);

    // The pair is RETAINED on the doc in the separate revoked list (§6.5);
    // the active list and the mirror arrays exclude it.
    const grantDoc = await findGrantDoc(tenant, signingKey);
    expect(grantDoc).toBeDefined();
    const data = grantDoc!.getData();
    const active = (Array.isArray(data.userKeyPairs) ? data.userKeyPairs : []) as Array<{
      signingPublicKey: string;
    }>;
    const revoked = (Array.isArray(data.revokedUserKeyPairs)
      ? data.revokedUserKeyPairs
      : []) as Array<{ signingPublicKey: string; revokedAt?: number }>;
    expect(active.find((p) => p.signingPublicKey === signingKey)).toBeUndefined();
    const revokedEntry = revoked.find((p) => p.signingPublicKey === signingKey);
    expect(revokedEntry).toBeDefined();
    expect(revokedEntry!.revokedAt).toBeGreaterThanOrEqual(before);
    expect(revokedEntry!.revokedAt).toBeLessThanOrEqual(after);
    expect(data.userSigningPublicKeys).toEqual([]);
  });

  it("updateUserGrant batches details + labels + revoke + restore and recomputes identity_hashes (§6.5)", async () => {
    const directory = await tenant.openDirectory();
    const publicRegularUser = factory.toPublicUserId(regularUser);
    const signingKey = regularUser.userSigningKeyPair.publicKey;

    await directory.registerUser(
      publicRegularUser,
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword,
      { email: "regularuser@example.com" },
    );

    // Batch: rewrite details, label the device, and revoke it — in one change.
    await directory.updateUserGrant!(
      regularUser.username,
      {
        details: { email: "new@example.com", city: "Berlin" },
        deviceLabels: { [signingKey]: "Work laptop" },
        revokeSigningKeys: [signingKey],
      },
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword,
    );

    const afterRevoke = await directory.getUserGrantOverview!(regularUser.username);
    expect(afterRevoke.details?.email).toBe("new@example.com");
    expect(afterRevoke.details?.city).toBe("Berlin");
    expect(afterRevoke.activeDevices).toEqual([]);
    expect(afterRevoke.revokedDevices).toHaveLength(1);
    expect(afterRevoke.revokedDevices[0].label).toBe("Work laptop");
    expect(afterRevoke.revokedDevices[0].revoked).toBe(true);

    // The identity-hash bundle was (re)written at the current version.
    const grantDoc = await findGrantDoc(tenant, signingKey);
    const data = grantDoc!.getData();
    expect(Array.isArray(data.identity_hashes)).toBe(true);
    expect((data.identity_hashes as string[]).length).toBeGreaterThan(0);
    expect(data.identity_hashes_v).toBe(1);

    // Restore the device: it returns to the active list.
    await directory.updateUserGrant!(
      regularUser.username,
      { restoreSigningKeys: [signingKey] },
      adminUser.userSigningKeyPair.privateKey,
      adminUserPassword,
    );

    const afterRestore = await directory.getUserGrantOverview!(regularUser.username);
    expect(afterRestore.revokedDevices).toEqual([]);
    expect(afterRestore.activeDevices).toHaveLength(1);
    expect(afterRestore.activeDevices[0].signingPublicKey).toBe(signingKey);
    expect(await directory.getUserPublicKeys(regularUser.username)).not.toBeNull();
  });
});


