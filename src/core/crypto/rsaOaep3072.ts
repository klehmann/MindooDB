import type { CryptoAdapter } from "./CryptoAdapter";
import { spkiToPem } from "../userkeys/fingerprint";

/**
 * RSA-OAEP 3072 generation used for both device encryption keys and User-Keys.
 * Extracted from {@link BaseMindooTenantFactory.createEncryptionKeyPair} so the
 * userkeys module can mint the same material without depending on the factory.
 */
export async function generateRsaOaep3072(
  cryptoAdapter: CryptoAdapter,
): Promise<{ publicKeyPem: string; privateKeyBytes: Uint8Array }> {
  const subtle = cryptoAdapter.getSubtle();
  const keyPair = await subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const publicKeyBuffer = await subtle.exportKey("spki", keyPair.publicKey);
  const privateKeyBuffer = await subtle.exportKey("pkcs8", keyPair.privateKey);
  return {
    publicKeyPem: spkiToPem(publicKeyBuffer),
    privateKeyBytes: new Uint8Array(privateKeyBuffer),
  };
}

export async function importRsaOaepPrivateKey(
  cryptoAdapter: CryptoAdapter,
  pkcs8: Uint8Array,
  extractable = false,
): Promise<CryptoKey> {
  const bytes = pkcs8.slice();
  return cryptoAdapter.getSubtle().importKey(
    "pkcs8",
    bytes,
    { name: "RSA-OAEP", hash: "SHA-256" },
    extractable,
    ["decrypt"],
  );
}
