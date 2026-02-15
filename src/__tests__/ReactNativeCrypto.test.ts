/**
 * Tests for React Native Crypto Adapters
 * Tests all crypto operations used by MindooDB
 */

import { ExpoGoCryptoAdapter } from "../reactnative/crypto/ExpoGoCryptoAdapter";

// Mock expo-standard-web-crypto
jest.mock("expo-standard-web-crypto");

describe("ExpoGoCryptoAdapter", () => {
  let adapter: ExpoGoCryptoAdapter;
  let subtle: SubtleCrypto;

  beforeAll(() => {
    adapter = new ExpoGoCryptoAdapter();
    subtle = adapter.getSubtle();
  });

  describe("getRandomValues", () => {
    it("should generate random values", () => {
      const array = new Uint8Array(32);
      const result = adapter.getRandomValues(array);
      
      expect(result).toBe(array);
      // Check that values are not all zeros (very unlikely)
      const allZeros = array.every((val) => val === 0);
      expect(allZeros).toBe(false);
    });
  });

  describe("Ed25519", () => {
    it("should generate Ed25519 key pair", async () => {
      const keyPair = await subtle.generateKey(
        { name: "Ed25519" },
        true,
        ["sign", "verify"]
      );

      expect(keyPair).toHaveProperty("publicKey");
      expect(keyPair).toHaveProperty("privateKey");
      expect(keyPair.publicKey.algorithm.name).toBe("Ed25519");
      expect(keyPair.privateKey.algorithm.name).toBe("Ed25519");
    });

    it("should export and import Ed25519 public key", async () => {
      const keyPair = await subtle.generateKey(
        { name: "Ed25519" },
        true,
        ["sign", "verify"]
      );

      // Export public key
      const exported = await subtle.exportKey("spki", keyPair.publicKey);
      expect(exported).toBeInstanceOf(ArrayBuffer);
      expect(exported.byteLength).toBeGreaterThan(0);

      // Import public key
      const imported = await subtle.importKey(
        "spki",
        exported,
        { name: "Ed25519" },
        false,
        ["verify"]
      );

      expect(imported.algorithm.name).toBe("Ed25519");
      expect(imported.type).toBe("public");
    });

    it("should export and import Ed25519 private key", async () => {
      const keyPair = await subtle.generateKey(
        { name: "Ed25519" },
        true,
        ["sign", "verify"]
      );

      // Export private key
      const exported = await subtle.exportKey("pkcs8", keyPair.privateKey);
      expect(exported).toBeInstanceOf(ArrayBuffer);
      expect(exported.byteLength).toBeGreaterThan(0);

      // Import private key
      const imported = await subtle.importKey(
        "pkcs8",
        exported,
        { name: "Ed25519" },
        false,
        ["sign"]
      );

      expect(imported.algorithm.name).toBe("Ed25519");
      expect(imported.type).toBe("private");
    });

    it("should sign and verify with Ed25519", async () => {
      const keyPair = await subtle.generateKey(
        { name: "Ed25519" },
        true,
        ["sign", "verify"]
      );

      const message = new TextEncoder().encode("Hello, World!");
      
      // Sign
      const signature = await subtle.sign(
        { name: "Ed25519" },
        keyPair.privateKey,
        message
      );

      expect(signature).toBeInstanceOf(ArrayBuffer);
      expect(signature.byteLength).toBe(64); // Ed25519 signatures are 64 bytes

      // Verify
      const isValid = await subtle.verify(
        { name: "Ed25519" },
        keyPair.publicKey,
        signature,
        message
      );

      expect(isValid).toBe(true);

      // Verify with wrong message should fail
      const wrongMessage = new TextEncoder().encode("Wrong message");
      const isValidWrong = await subtle.verify(
        { name: "Ed25519" },
        keyPair.publicKey,
        signature,
        wrongMessage
      );

      expect(isValidWrong).toBe(false);
    });
  });

  describe("RSA-OAEP", () => {
    it("should generate RSA-OAEP key pair", async () => {
      const keyPair = await subtle.generateKey(
        {
          name: "RSA-OAEP",
          modulusLength: 3072,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["encrypt", "decrypt"]
      );

      expect(keyPair).toHaveProperty("publicKey");
      expect(keyPair).toHaveProperty("privateKey");
      expect(keyPair.publicKey.algorithm.name).toBe("RSA-OAEP");
      expect(keyPair.privateKey.algorithm.name).toBe("RSA-OAEP");
    });

    it("should export and import RSA-OAEP public key", async () => {
      const keyPair = await subtle.generateKey(
        {
          name: "RSA-OAEP",
          modulusLength: 3072,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["encrypt", "decrypt"]
      );

      // Export public key
      const exported = await subtle.exportKey("spki", keyPair.publicKey);
      expect(exported).toBeInstanceOf(ArrayBuffer);

      // Import public key
      const imported = await subtle.importKey(
        "spki",
        exported,
        { name: "RSA-OAEP", hash: "SHA-256" },
        false,
        ["encrypt"]
      );

      expect(imported.algorithm.name).toBe("RSA-OAEP");
      expect(imported.type).toBe("public");
    });

    it("should encrypt and decrypt with RSA-OAEP", async () => {
      const keyPair = await subtle.generateKey(
        {
          name: "RSA-OAEP",
          modulusLength: 3072,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["encrypt", "decrypt"]
      );

      const message = new TextEncoder().encode("Hello, RSA!");

      // Encrypt
      const encrypted = await subtle.encrypt(
        { name: "RSA-OAEP" },
        keyPair.publicKey,
        message
      );

      expect(encrypted).toBeInstanceOf(ArrayBuffer);
      expect(encrypted.byteLength).toBeGreaterThan(message.length);

      // Decrypt
      const decrypted = await subtle.decrypt(
        { name: "RSA-OAEP" },
        keyPair.privateKey,
        encrypted
      );

      expect(new TextDecoder().decode(decrypted)).toBe("Hello, RSA!");
    });
  });

  describe("AES-GCM", () => {
    it("should generate AES-GCM key", async () => {
      const key = await subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
      );

      expect(key.algorithm.name).toBe("AES-GCM");
      expect((key.algorithm as AesKeyAlgorithm).length).toBe(256);
    });

    it("should import and export AES-GCM key", async () => {
      // Generate random key material
      const keyMaterial = new Uint8Array(32);
      adapter.getRandomValues(keyMaterial);

      // Import
      const imported = await subtle.importKey(
        "raw",
        keyMaterial.buffer,
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
      );

      expect(imported.algorithm.name).toBe("AES-GCM");

      // Export
      const exported = await subtle.exportKey("raw", imported);
      expect(exported).toBeInstanceOf(ArrayBuffer);
      expect(new Uint8Array(exported)).toEqual(keyMaterial);
    });

    it("should encrypt and decrypt with AES-GCM", async () => {
      const key = await subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
      );

      const message = new TextEncoder().encode("Hello, AES-GCM!");
      const iv = new Uint8Array(12);
      adapter.getRandomValues(iv);

      // Encrypt
      const encrypted = await subtle.encrypt(
        { name: "AES-GCM", iv, tagLength: 128 },
        key,
        message
      );

      expect(encrypted).toBeInstanceOf(ArrayBuffer);
      expect(encrypted.byteLength).toBeGreaterThan(message.length);

      // Decrypt
      const decrypted = await subtle.decrypt(
        { name: "AES-GCM", iv, tagLength: 128 },
        key,
        encrypted
      );

      expect(new TextDecoder().decode(decrypted)).toBe("Hello, AES-GCM!");
    });
  });

  describe("PBKDF2", () => {
    it("should derive key using PBKDF2", async () => {
      const password = new TextEncoder().encode("myPassword123");
      const salt = new Uint8Array(16);
      adapter.getRandomValues(salt);

      // Import password as key - PBKDF2 is not an import algorithm
      // We need to import the password as a raw key, then use it for PBKDF2 derivation
      const passwordKey = await subtle.importKey(
        "raw",
        password,
        { name: "PBKDF2" } as any, // This will be handled specially
        false,
        ["deriveKey"]
      );

      // Derive key
      const derivedKey = await subtle.deriveKey(
        {
          name: "PBKDF2",
          salt,
          iterations: 100000,
          hash: "SHA-256",
        },
        passwordKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
      );

      expect(derivedKey.algorithm.name).toBe("AES-GCM");
      expect((derivedKey.algorithm as AesKeyAlgorithm).length).toBe(256);
    });

    it("should derive same key with same parameters", async () => {
      const password = new TextEncoder().encode("myPassword123");
      const salt = new Uint8Array(16);
      salt.fill(0x42); // Fixed salt for reproducibility

      const passwordKey = await subtle.importKey(
        "raw",
        password,
        "PBKDF2",
        false,
        ["deriveKey"]
      );

      // Derive key twice
      const derivedKey1 = await subtle.deriveKey(
        {
          name: "PBKDF2",
          salt,
          iterations: 1000,
          hash: "SHA-256",
        },
        passwordKey,
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
      );

      const derivedKey2 = await subtle.deriveKey(
        {
          name: "PBKDF2",
          salt,
          iterations: 1000,
          hash: "SHA-256",
        },
        passwordKey,
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
      );

      // Export and compare
      const key1 = await subtle.exportKey("raw", derivedKey1);
      const key2 = await subtle.exportKey("raw", derivedKey2);

      expect(new Uint8Array(key1)).toEqual(new Uint8Array(key2));
    });
  });

  describe("HMAC-SHA256", () => {
    it("should sign and verify with HMAC-SHA256", async () => {
      const secret = new Uint8Array(32);
      adapter.getRandomValues(secret);

      const key = await subtle.importKey(
        "raw",
        secret,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"]
      );

      const message = new TextEncoder().encode("Hello, HMAC!");

      // Sign
      const signature = await subtle.sign("HMAC", key, message);

      expect(signature).toBeInstanceOf(ArrayBuffer);
      expect(signature.byteLength).toBe(32); // SHA-256 produces 32 bytes

      // Verify
      const isValid = await subtle.verify("HMAC", key, signature, message);
      expect(isValid).toBe(true);

      // Verify with wrong message should fail
      const wrongMessage = new TextEncoder().encode("Wrong message");
      const isValidWrong = await subtle.verify("HMAC", key, signature, wrongMessage);
      expect(isValidWrong).toBe(false);
    });
  });

  describe("SHA-256", () => {
    it("should compute SHA-256 digest", async () => {
      const message = new TextEncoder().encode("Hello, SHA-256!");

      const digest = await subtle.digest("SHA-256", message);

      expect(digest).toBeInstanceOf(ArrayBuffer);
      expect(digest.byteLength).toBe(32); // SHA-256 produces 32 bytes
    });

    it("should produce consistent digests", async () => {
      const message = new TextEncoder().encode("Test message");

      const digest1 = await subtle.digest("SHA-256", message);
      const digest2 = await subtle.digest("SHA-256", message);

      expect(new Uint8Array(digest1)).toEqual(new Uint8Array(digest2));
    });
  });

  describe("Unimplemented methods", () => {
    it("should throw NotSupportedError for deriveBits", async () => {
      const key = await subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt"]
      );

      await expect(
        subtle.deriveBits({ name: "PBKDF2" } as any, key, 256)
      ).rejects.toThrow(/NotSupportedError|not implemented/i);
    });

    it("should throw NotSupportedError for wrapKey", async () => {
      const key = await subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt"]
      );

      await expect(
        subtle.wrapKey("raw", key, key, { name: "AES-GCM" } as any)
      ).rejects.toThrow(/NotSupportedError|not implemented/i);
    });

    it("should throw NotSupportedError for unwrapKey", async () => {
      const key = await subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt"]
      );

      await expect(
        subtle.unwrapKey(
          "raw",
          new Uint8Array(16),
          key,
          { name: "AES-GCM" } as any,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt"]
        )
      ).rejects.toThrow(/NotSupportedError|not implemented/i);
    });
  });
});
