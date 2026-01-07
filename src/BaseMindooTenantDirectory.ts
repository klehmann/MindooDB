import { EncryptedPrivateKey, MindooDB, MindooDoc, MindooTenant, MindooTenantDirectory, PublicUserId } from "./types";
import { BaseMindooTenant } from "./BaseMindooTenant";

export class BaseMindooTenantDirectory implements MindooTenantDirectory {
  private tenant: BaseMindooTenant;
  private directoryDB: MindooDB;

  constructor(tenant: BaseMindooTenant) {
    this.tenant = tenant;
  }

  async initialize(): Promise<void> {
    this.directoryDB = await this.tenant.openDB("directory");
  }

  async registerUser(
    userId: PublicUserId,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string
  ): Promise<void> {
    console.log(`[BaseMindooTenantDirectory] Registering user: ${userId.username}`);

    // Cast to BaseMindooTenant to access protected methods
    const baseTenant = this.tenant as BaseMindooTenant;

    // Decrypt the administration private key
    // Note: Administration keys can use salt "signing" (same as user signing keys)
    const adminKey = await this.tenant.decryptPrivateKey(
      administrationPrivateKey,
      administrationPrivateKeyPassword,
      "signing"
    );

    // Sign the user registration with the administration key
    const registrationData = JSON.stringify({
      username: userId.username,
      userSigningPublicKey: userId.userSigningPublicKey,
      userEncryptionPublicKey: userId.userEncryptionPublicKey,
      timestamp: Date.now(),
    });
    const registrationDataBytes = new TextEncoder().encode(registrationData);

    const subtle = this.tenant.getCryptoAdapter().getSubtle();
    const cryptoKey = await subtle.importKey(
      "pkcs8",
      adminKey,
      { name: "Ed25519" },
      false,
      ["sign"]
    );

    const signature = await subtle.sign(
      { name: "Ed25519" },
      cryptoKey,
      registrationDataBytes
    );

    // Add user to directory database
    console.log(`[BaseMindooTenantDirectory] Creating document for user registration`);
    const newDoc = await this.directoryDB.createDocument();
    console.log(`[BaseMindooTenantDirectory] Document created: ${newDoc.getId()}`);
    console.log(`[BaseMindooTenantDirectory] About to call changeDoc to modify document`);
    try {
      await this.directoryDB.changeDoc(newDoc, (doc: MindooDoc) => {
        console.log(`[BaseMindooTenantDirectory] Inside changeDoc callback, modifying document ${doc.getId()}`);
        const data = doc.getData();
        data.form = "useroperation";
        data.type = "grantaccess";
        data.username = userId.username;
        data.userSigningPublicKey = userId.userSigningPublicKey;
        data.userEncryptionPublicKey = userId.userEncryptionPublicKey;
        data.registrationData = baseTenant.uint8ArrayToBase64(registrationDataBytes);
        data.administrationSignature = baseTenant.uint8ArrayToBase64(new Uint8Array(signature));
        console.log(`[BaseMindooTenantDirectory] Finished modifying document data in callback`);
      });
      console.log(`[BaseMindooTenantDirectory] changeDoc completed successfully`);
    } catch (error) {
      console.error(`[BaseMindooTenantDirectory] ERROR in changeDoc:`, error);
      console.error(`[BaseMindooTenantDirectory] Error type: ${error instanceof Error ? error.constructor.name : typeof error}`);
      console.error(`[BaseMindooTenantDirectory] Error message: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof Error && error.stack) {
        console.error(`[BaseMindooTenantDirectory] Error stack: ${error.stack}`);
      }
      throw error;
    }
    
    console.log(`[BaseMindooTenantDirectory] Registered user: ${userId.username}`);
  }

  async findGrantAccessDocument(username: string): Promise<MindooDoc | null> {
    console.log(`[BaseMindooTenantDirectory] Finding grant access document for username: ${username}`);
    
    // Sync changes to make sure everything is processed
    await this.directoryDB.syncStoreChanges();
    
    // Use the generator-based iteration API for cleaner code
    for await (const { doc } of this.directoryDB.iterateChangesSince(null, 100)) {
      const data = doc.getData();
      // Check if this is the grant access document we're looking for
      if (data.form === "useroperation" && 
          data.type === "grantaccess" && 
          data.username === username) {
        console.log(`[BaseMindooTenantDirectory] Found grant access document for username: ${username}`);
        return doc;
      }
    }
    
    console.log(`[BaseMindooTenantDirectory] No grant access document found for username: ${username}`);
    return null;
  }

  async revokeUser(
    username: string,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string
  ): Promise<void> {
    console.log(`[BaseMindooTenantDirectory] Revoking user: ${username}`);

    // Cast to BaseMindooTenant to access protected methods
    const baseTenant = this.tenant as BaseMindooTenant;

    // Decrypt the administration private key
    // Note: Administration keys can use salt "signing" (same as user signing keys)
    const adminKey = await baseTenant.decryptPrivateKey(
      administrationPrivateKey,
      administrationPrivateKeyPassword,
      "signing"
    );

    // Sign the revocation with the administration key
    const revocationData = JSON.stringify({
      username: username,
      revokedAt: Date.now(),
    });
    const revocationDataBytes = new TextEncoder().encode(revocationData);

    const subtle = this.tenant.getCryptoAdapter().getSubtle();
    const cryptoKey = await subtle.importKey(
      "pkcs8",
      adminKey,
      { name: "Ed25519" },
      false,
      ["sign"]
    );

    const signature = await subtle.sign(
      { name: "Ed25519" },
      cryptoKey,
      revocationDataBytes
    );

    // Add revocation record to directory database
    const newDoc = await this.directoryDB.createDocument();
    await this.directoryDB.changeDoc(newDoc, (doc: MindooDoc) => {
      const data = doc.getData();
      data.form = "useroperation";
      data.type = "revokeaccess";
      data.username = username;
      data.revokedAt = Date.now();
      data.revocationData = baseTenant.uint8ArrayToBase64(revocationDataBytes);
      data.revocationSignature = baseTenant.uint8ArrayToBase64(new Uint8Array(signature));
    });
    
    console.log(`[BaseMindooTenantDirectory] Revoked user: ${username}`);
  }

  async validatePublicSigningKey(publicKey: string): Promise<boolean> {
    // Empty implementation returning true
    // TODO: Implement actual validation against directory database
    return true;
  }
}