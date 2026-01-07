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
    const adminKey = await this.tenant.decryptPrivateKey(
      administrationPrivateKey,
      administrationPrivateKeyPassword,
      "administration"
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
    const newDoc = await this.directoryDB.createDocument();
    await this.directoryDB.changeDoc(newDoc, (doc: MindooDoc) => {
      const data = doc.getData();
      data.form = "useroperation";
      data.type = "grantaccess";
      data.username = userId.username;
      data.userSigningPublicKey = userId.userSigningPublicKey;
      data.userEncryptionPublicKey = userId.userEncryptionPublicKey;
      data.registrationData = baseTenant.uint8ArrayToBase64(registrationDataBytes);
      data.administrationSignature = baseTenant.uint8ArrayToBase64(new Uint8Array(signature));
    });
    
    console.log(`[BaseMindooTenantDirectory] Registered user: ${userId.username}`);
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
    const adminKey = await baseTenant.decryptPrivateKey(
      administrationPrivateKey,
      administrationPrivateKeyPassword,
      "administration"
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
}