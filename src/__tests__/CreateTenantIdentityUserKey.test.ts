import { IsolatedInMemoryStoreFactory } from "./_helpers/multiDevice";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { decryptPrivateKey } from "../core/crypto/privateKeyEncryption";
import { USERKEY_PRIVATE_SALT } from "../core/userkeys/types";
import { fingerprintUserPublicKey } from "../core/userkeys/UserKeyDocument";
import { DEFAULT_TENANT_KEY_ID } from "../core/types";

const PASSWORD = "identity-pass";

describe("createTenant mints the identity User-Key", () => {
  jest.setTimeout(120000);

  test("empty live-bag password still wraps default to the existing identity pair", async () => {
    const cryptoAdapter = new NodeCryptoAdapter();
    const factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), cryptoAdapter);
    const adminUser = await factory.createUserId("cn=admin/o=uk-create", PASSWORD);
    const appUser = await factory.createUserId("cn=karsten/o=uk-create", PASSWORD);
    await factory.ensureUserKeyPair(appUser, PASSWORD);
    const identityFingerprint = await fingerprintUserPublicKey(
      appUser.userKeyPair!.publicKey,
      cryptoAdapter,
    );
    const publicKeyBefore = appUser.userKeyPair!.publicKey;

    const subtle = cryptoAdapter.getSubtle();
    const signingKey = await subtle.importKey(
      "pkcs8",
      await decryptPrivateKey(cryptoAdapter, appUser.userSigningKeyPair.privateKey, PASSWORD, "signing"),
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    const encryptionKey = await subtle.importKey(
      "pkcs8",
      await decryptPrivateKey(
        cryptoAdapter,
        appUser.userEncryptionKeyPair.privateKey,
        PASSWORD,
        "encryption",
      ),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["decrypt"],
    );
    const userKeyPrivateBytes = new Uint8Array(
      await decryptPrivateKey(
        cryptoAdapter,
        appUser.userKeyPair!.privateKey,
        PASSWORD,
        USERKEY_PRIVATE_SALT,
      ),
    );

    const created = await factory.createTenant({
      tenantId: `uk-create-${Date.now().toString(16)}`,
      adminUser,
      adminPassword: PASSWORD,
      appUser,
      userPassword: "",
      preDecryptedAppUserKeys: { signingKey, encryptionKey, userKeyPrivateBytes },
    });

    expect(appUser.userKeyPair!.publicKey).toBe(publicKeyBefore);
    const directory = await created.tenant.openDirectory();
    const wrap = await directory.wrapKeyForUser!(DEFAULT_TENANT_KEY_ID, appUser.username);
    expect(wrap).not.toBeNull();
    expect(Object.keys(wrap!.devices)).toEqual([identityFingerprint]);
  });

  test("refuses to mint a second pair when the identity User-Key cannot be opened", async () => {
    const cryptoAdapter = new NodeCryptoAdapter();
    const factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), cryptoAdapter);
    const adminUser = await factory.createUserId("cn=admin/o=uk-refuse", PASSWORD);
    const appUser = await factory.createUserId("cn=karsten/o=uk-refuse", PASSWORD);
    await factory.ensureUserKeyPair(appUser, PASSWORD);
    const publicKeyBefore = appUser.userKeyPair!.publicKey;

    const subtle = cryptoAdapter.getSubtle();
    const signingKey = await subtle.importKey(
      "pkcs8",
      await decryptPrivateKey(cryptoAdapter, appUser.userSigningKeyPair.privateKey, PASSWORD, "signing"),
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    const encryptionKey = await subtle.importKey(
      "pkcs8",
      await decryptPrivateKey(
        cryptoAdapter,
        appUser.userEncryptionKeyPair.privateKey,
        PASSWORD,
        "encryption",
      ),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["decrypt"],
    );

    await expect(
      factory.createTenant({
        tenantId: `uk-refuse-${Date.now().toString(16)}`,
        adminUser,
        adminPassword: PASSWORD,
        appUser,
        userPassword: "",
        preDecryptedAppUserKeys: { signingKey, encryptionKey },
      }),
    ).rejects.toThrow(/second pair/);
    expect(appUser.userKeyPair!.publicKey).toBe(publicKeyBefore);
  });
});
