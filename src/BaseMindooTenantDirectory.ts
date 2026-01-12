import { EncryptedPrivateKey, MindooDB, MindooDoc, MindooTenant, MindooTenantDirectory, PublicUserId, SigningKeyPair } from "./types";
import { BaseMindooTenant } from "./BaseMindooTenant";

export class BaseMindooTenantDirectory implements MindooTenantDirectory {
  private tenant: BaseMindooTenant;
  private directoryDB: MindooDB;

  // Centralized field lists for signing/verification
  private static readonly GRANT_ACCESS_SIGNED_FIELDS: string[] = [
    "form",
    "type",
    "username",
    "userSigningPublicKey",
    "userEncryptionPublicKey",
    "adminSignatureFields",
  ];

  private static readonly REVOKE_ACCESS_SIGNED_FIELDS: string[] = [
    "form",
    "type",
    "username",
    "revokeDocId",
    "adminSignatureFields",
  ];

  constructor(tenant: BaseMindooTenant) {
    this.tenant = tenant;
  }

  /**
   * Helper method to convert base64 string to Uint8Array.
   * This is needed because base64ToUint8Array is protected in BaseMindooTenant.
   */
  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
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

    // Create SigningKeyPair for the administration key
    const adminSigningKeyPair: SigningKeyPair = {
      publicKey: baseTenant.getAdministrationPublicKey(),
      privateKey: administrationPrivateKey,
    };

    // Create doc signer for administration key
    const docSigner = this.tenant.createDocSignerFor(adminSigningKeyPair);

    // Add user to directory database
    console.log(`[BaseMindooTenantDirectory] Creating document for user registration`);
    const newDoc = await this.directoryDB.createDocument();
    console.log(`[BaseMindooTenantDirectory] Document created: ${newDoc.getId()}`);
    
    try {
      // Set the document data fields, sign, and store signature all in one changeDoc call
      await this.directoryDB.changeDoc(newDoc, async (doc: MindooDoc) => {
        const data = doc.getData();
        data.form = "useroperation";
        data.type = "grantaccess";
        data.username = userId.username;
        data.userSigningPublicKey = userId.userSigningPublicKey;
        data.userEncryptionPublicKey = userId.userEncryptionPublicKey;

        data.adminSignatureFields = BaseMindooTenantDirectory.GRANT_ACCESS_SIGNED_FIELDS;

        // Sign the document items and store the signature
        const signature = await docSigner.signItems(
          doc,
          BaseMindooTenantDirectory.GRANT_ACCESS_SIGNED_FIELDS,
          administrationPrivateKeyPassword
        );
        data.adminSignature = baseTenant.uint8ArrayToBase64(signature);
      });
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

  async findGrantAccessDocuments(username: string): Promise<MindooDoc[]> {
    console.log(`[BaseMindooTenantDirectory] Finding grant access documents for username: ${username}`);
    
    // Sync changes to make sure everything is processed
    await this.directoryDB.syncStoreChanges();
    
    // Cast to BaseMindooTenant to access protected methods
    const baseTenant = this.tenant as BaseMindooTenant;
    
    // Get administration public key for signature verification
    const administrationPublicKey = baseTenant.getAdministrationPublicKey();
    
    // Create a docSigner for verification (we only need it for verifyItems, so we use a dummy SigningKeyPair)
    // The private key won't be used for verification
    const dummySigningKeyPair: SigningKeyPair = {
      publicKey: administrationPublicKey,
      privateKey: {
        ciphertext: "",
        iv: "",
        tag: "",
        salt: "",
        iterations: 0,
      },
    };
    const docSigner = this.tenant.createDocSignerFor(dummySigningKeyPair);
    
    const matchingDocs: MindooDoc[] = [];
    const revokedDocIds = new Set<string>();
    
    // Use the generator-based iteration API for cleaner code
    for await (const { doc } of this.directoryDB.iterateChangesSince(null, 100)) {
      const data = doc.getData();
      
      // Check if this is a grant access document we're looking for
      if (data.form === "useroperation" && 
          data.type === "grantaccess" && 
          data.username === username) {
        // Verify the signature before including the document
        if (data.adminSignature && typeof data.adminSignature === "string" && data.adminSignatureFields && Array.isArray(data.adminSignatureFields)) {
          try {
            const signature = this.base64ToUint8Array(data.adminSignature);
            const isValid = await docSigner.verifyItems(
              doc,
              data.adminSignatureFields,
              signature,
              administrationPublicKey
            );
            
            if (isValid) {
              console.log(`[BaseMindooTenantDirectory] Found valid grant access document for username: ${username}`);
              matchingDocs.push(doc);
            } else {
              console.warn(`[BaseMindooTenantDirectory] Found grant access document with invalid signature for username: ${username}, skipping`);
            }
          } catch (error) {
            console.error(`[BaseMindooTenantDirectory] Error verifying grant access document signature:`, error);
            // Skip documents with signature verification errors
          }
        } else {
          console.warn(`[BaseMindooTenantDirectory] Found grant access document without signature for username: ${username}, skipping`);
        }
      }
      
      // Check if this is a revoke access document for the same username
      if (data.form === "useroperation" && 
          data.type === "revokeaccess" && 
          data.username === username &&
          data.revokeDocId &&
          typeof data.revokeDocId === "string") {
        // Verify the signature before processing the revocation
        if (data.adminSignature && typeof data.adminSignature === "string" && data.adminSignatureFields && Array.isArray(data.adminSignatureFields)) {
          try {
            const signature = this.base64ToUint8Array(data.adminSignature);
            const isValid = await docSigner.verifyItems(
              doc,
              data.adminSignatureFields,
              signature,
              administrationPublicKey
            );
            
            if (isValid) {
              console.log(`[BaseMindooTenantDirectory] Found valid revoke access document for username: ${username}, revoking doc ID: ${data.revokeDocId}`);
              revokedDocIds.add(data.revokeDocId);
            } else {
              console.warn(`[BaseMindooTenantDirectory] Found revoke access document with invalid signature for username: ${username}, skipping`);
            }
          } catch (error) {
            console.error(`[BaseMindooTenantDirectory] Error verifying revoke access document signature:`, error);
            // Skip documents with signature verification errors
          }
        } else {
          console.warn(`[BaseMindooTenantDirectory] Found revoke access document without signature for username: ${username}, skipping`);
        }
      }
    }
    
    // Filter out revoked documents
    const activeDocs = matchingDocs.filter(doc => !revokedDocIds.has(doc.getId()));
    
    if (activeDocs.length === 0) {
      console.log(`[BaseMindooTenantDirectory] No active grant access documents found for username: ${username} (found ${matchingDocs.length} total, ${revokedDocIds.size} revoked)`);
    } else {
      console.log(`[BaseMindooTenantDirectory] Found ${activeDocs.length} active grant access document(s) for username: ${username} (${matchingDocs.length} total, ${revokedDocIds.size} revoked)`);
    }
    
    return activeDocs;
  }

  async revokeUser(
    username: string,
    requestDataWipe: boolean,
    administrationPrivateKey: EncryptedPrivateKey,
    administrationPrivateKeyPassword: string
  ): Promise<void> {
    console.log(`[BaseMindooTenantDirectory] Revoking user: ${username}`);

    // Find all grant access documents for this user
    const grantAccessDocs = await this.findGrantAccessDocuments(username);
    
    // If no grant access documents found, exit early
    if (grantAccessDocs.length === 0) {
      console.log(`[BaseMindooTenantDirectory] No grant access documents found for ${username}, exiting revocation`);
      return;
    }

    // Cast to BaseMindooTenant to access protected methods
    const baseTenant = this.tenant as BaseMindooTenant;

    // Create SigningKeyPair for the administration key
    const adminSigningKeyPair: SigningKeyPair = {
      publicKey: baseTenant.getAdministrationPublicKey(),
      privateKey: administrationPrivateKey,
    };

    // Create doc signer for administration key
    const docSigner = this.tenant.createDocSignerFor(adminSigningKeyPair);

    // Create revocation documents for each grant access document found
    for (const grantAccessDoc of grantAccessDocs) {
      const revokeDocId = grantAccessDoc.getId();

      const newDoc = await this.directoryDB.createDocument();
      
      // Set the document data fields, sign, and store signature all in one changeDoc call
      await this.directoryDB.changeDoc(newDoc, async (doc: MindooDoc) => {
        const data = doc.getData();
        data.form = "useroperation";
        data.type = "revokeaccess";
        data.username = username;
        data.revokeDocId = revokeDocId;
        data.requestDataWipe = requestDataWipe;

        data.adminSignatureFields = BaseMindooTenantDirectory.REVOKE_ACCESS_SIGNED_FIELDS;

        // Sign the document items and store the signature
        const signature = await docSigner.signItems(
          doc,
          BaseMindooTenantDirectory.REVOKE_ACCESS_SIGNED_FIELDS,
          administrationPrivateKeyPassword
        );
        data.adminSignature = baseTenant.uint8ArrayToBase64(signature);
      });

      console.log(`[BaseMindooTenantDirectory] Created revocation document for grant access doc: ${revokeDocId}`);
    }
    
    console.log(`[BaseMindooTenantDirectory] Revoked user: ${username} (created ${grantAccessDocs.length} revocation document(s))`);
  }

  async validatePublicSigningKey(publicKey: string): Promise<boolean> {
    // Empty implementation returning true
    // TODO: Implement actual validation against directory database
    return true;
  }
}