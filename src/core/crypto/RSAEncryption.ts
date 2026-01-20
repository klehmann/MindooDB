import type { CryptoAdapter } from "./CryptoAdapter";
import { Logger, MindooLogger, getDefaultLogLevel } from "../logging";

/**
 * RSA Encryption utilities for network transport security.
 * 
 * Uses RSA-OAEP for encrypting change payloads during network transport.
 * The encrypted data can only be decrypted by the recipient who has
 * the corresponding private key.
 * 
 * This provides an additional layer of security on top of the existing
 * symmetric encryption (AES-256-GCM) used for storage.
 */
export class RSAEncryption {
  private cryptoAdapter: CryptoAdapter;
  private logger: Logger;

  constructor(cryptoAdapter: CryptoAdapter, logger?: Logger) {
    this.cryptoAdapter = cryptoAdapter;
    this.logger =
      logger ||
      new MindooLogger(getDefaultLogLevel(), "RSAEncryption", true);
  }

  /**
   * Import an RSA public key from PEM format.
   * 
   * @param pemKey The public key in PEM format (SPKI)
   * @returns The imported CryptoKey for encryption
   */
  async importPublicKey(pemKey: string): Promise<CryptoKey> {
    this.logger.debug(`Importing RSA public key`);
    
    // Remove PEM headers and decode base64
    const pemContents = pemKey
      .replace(/-----BEGIN PUBLIC KEY-----/g, "")
      .replace(/-----END PUBLIC KEY-----/g, "")
      .replace(/\s/g, "");
    
    const keyData = this.base64ToUint8Array(pemContents);
    
    const subtle = this.cryptoAdapter.getSubtle();
    
    const cryptoKey = await subtle.importKey(
      "spki",
      keyData.buffer as ArrayBuffer,
      {
        name: "RSA-OAEP",
        hash: "SHA-256",
      },
      false, // not extractable
      ["encrypt"]
    );
    
    this.logger.debug(`Successfully imported RSA public key`);
    return cryptoKey;
  }

  /**
   * Import an RSA private key from PEM format.
   * 
   * @param pemKey The private key in PEM format (PKCS#8)
   * @returns The imported CryptoKey for decryption
   */
  async importPrivateKey(pemKey: string): Promise<CryptoKey> {
    this.logger.debug(`Importing RSA private key`);
    
    // Remove PEM headers and decode base64
    const pemContents = pemKey
      .replace(/-----BEGIN PRIVATE KEY-----/g, "")
      .replace(/-----END PRIVATE KEY-----/g, "")
      .replace(/\s/g, "");
    
    const keyData = this.base64ToUint8Array(pemContents);
    
    const subtle = this.cryptoAdapter.getSubtle();
    
    const cryptoKey = await subtle.importKey(
      "pkcs8",
      keyData.buffer as ArrayBuffer,
      {
        name: "RSA-OAEP",
        hash: "SHA-256",
      },
      false, // not extractable
      ["decrypt"]
    );
    
    this.logger.debug(`Successfully imported RSA private key`);
    return cryptoKey;
  }

  /**
   * Encrypt data with an RSA public key.
   * 
   * Note: RSA-OAEP with 3072-bit keys and SHA-256 can only encrypt
   * up to 318 bytes directly. For larger payloads, this method uses
   * hybrid encryption: generates a random AES key, encrypts the data
   * with AES-GCM, then encrypts the AES key with RSA.
   * 
   * @param data The data to encrypt
   * @param publicKey The RSA public key (CryptoKey or PEM string)
   * @returns The encrypted data
   */
  async encrypt(
    data: Uint8Array,
    publicKey: CryptoKey | string
  ): Promise<Uint8Array> {
    this.logger.debug(`Encrypting ${data.length} bytes`);
    
    // Import key if it's a PEM string
    const cryptoKey = typeof publicKey === "string" 
      ? await this.importPublicKey(publicKey)
      : publicKey;
    
    const subtle = this.cryptoAdapter.getSubtle();
    
    // For small payloads (< 318 bytes for 3072-bit RSA with SHA-256),
    // we could encrypt directly. But for consistency and safety,
    // always use hybrid encryption.
    
    // Generate a random 256-bit AES key
    const aesKey = this.cryptoAdapter.getRandomValues(new Uint8Array(32));
    
    // Generate a random 96-bit IV for AES-GCM
    const iv = this.cryptoAdapter.getRandomValues(new Uint8Array(12));
    
    // Import the AES key
    const aesKeyObj = await subtle.importKey(
      "raw",
      aesKey.buffer as ArrayBuffer,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"]
    );
    
    // Encrypt the data with AES-GCM
    const encryptedData = await subtle.encrypt(
      { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
      aesKeyObj,
      data.buffer as ArrayBuffer
    );
    
    // Encrypt the AES key with RSA-OAEP
    const encryptedKey = await subtle.encrypt(
      { name: "RSA-OAEP" },
      cryptoKey,
      aesKey.buffer as ArrayBuffer
    );
    
    // Pack the result: [encryptedKeyLength (2 bytes)][encryptedKey][iv][encryptedData]
    const encryptedKeyBytes = new Uint8Array(encryptedKey);
    const encryptedDataBytes = new Uint8Array(encryptedData);
    
    const result = new Uint8Array(
      2 + encryptedKeyBytes.length + iv.length + encryptedDataBytes.length
    );
    
    // Write encrypted key length (big-endian 16-bit)
    result[0] = (encryptedKeyBytes.length >> 8) & 0xff;
    result[1] = encryptedKeyBytes.length & 0xff;
    
    // Write encrypted key
    result.set(encryptedKeyBytes, 2);
    
    // Write IV
    result.set(iv, 2 + encryptedKeyBytes.length);
    
    // Write encrypted data
    result.set(encryptedDataBytes, 2 + encryptedKeyBytes.length + iv.length);
    
    this.logger.debug(`Encrypted to ${result.length} bytes (hybrid encryption)`);
    return result;
  }

  /**
   * Decrypt data with an RSA private key.
   * 
   * Handles hybrid encryption: extracts the RSA-encrypted AES key,
   * decrypts it with RSA, then uses AES-GCM to decrypt the payload.
   * 
   * @param encryptedData The encrypted data
   * @param privateKey The RSA private key (CryptoKey or PEM string)
   * @returns The decrypted data
   */
  async decrypt(
    encryptedData: Uint8Array,
    privateKey: CryptoKey | string
  ): Promise<Uint8Array> {
    this.logger.debug(`Decrypting ${encryptedData.length} bytes`);
    
    // Import key if it's a PEM string
    const cryptoKey = typeof privateKey === "string"
      ? await this.importPrivateKey(privateKey)
      : privateKey;
    
    const subtle = this.cryptoAdapter.getSubtle();
    
    // Unpack the data: [encryptedKeyLength (2 bytes)][encryptedKey][iv][encryptedData]
    const encryptedKeyLength = (encryptedData[0] << 8) | encryptedData[1];
    
    const encryptedKey = encryptedData.slice(2, 2 + encryptedKeyLength);
    const iv = encryptedData.slice(
      2 + encryptedKeyLength,
      2 + encryptedKeyLength + 12
    );
    const ciphertext = encryptedData.slice(2 + encryptedKeyLength + 12);
    
    // Decrypt the AES key with RSA-OAEP
    const aesKey = await subtle.decrypt(
      { name: "RSA-OAEP" },
      cryptoKey,
      encryptedKey.buffer.slice(encryptedKey.byteOffset, encryptedKey.byteOffset + encryptedKey.byteLength) as ArrayBuffer
    );
    
    // Import the AES key
    const aesKeyObj = await subtle.importKey(
      "raw",
      aesKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
    
    // Decrypt the data with AES-GCM
    const decryptedData = await subtle.decrypt(
      { name: "AES-GCM", iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer },
      aesKeyObj,
      ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer
    );
    
    const result = new Uint8Array(decryptedData);
    this.logger.debug(`Decrypted to ${result.length} bytes`);
    return result;
  }

  /**
   * Convert a base64 string to Uint8Array.
   */
  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Convert a Uint8Array to base64 string.
   */
  private uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}
