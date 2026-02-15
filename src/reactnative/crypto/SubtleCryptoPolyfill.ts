/**
 * SubtleCrypto Polyfill
 * Implements the Web Crypto API SubtleCrypto interface using JavaScript-only libraries
 * Only implements methods actually used by MindooDB
 */

import * as ed25519 from "./Ed25519Adapter";
import * as rsa from "./RSAAdapter";
import * as aes from "./AESAdapter";
import * as pbkdf2 from "./PBKDF2Adapter";
import * as hmac from "./HMACAdapter";
import * as sha256 from "./SHA256Adapter";

/**
 * NotSupportedError for unimplemented methods
 */
class NotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotSupportedError";
  }
}

/**
 * SubtleCrypto polyfill implementation
 * Note: We use 'as any' for type compatibility since we only implement a subset of methods
 */
export class SubtleCryptoPolyfill {
  /**
   * Generate a cryptographic key
   */
  async generateKey(
    algorithm: RsaHashedKeyGenParams | EcKeyGenParams | AesKeyGenParams | { name: "Ed25519" } | "Ed25519",
    extractable: boolean,
    keyUsages: KeyUsage[]
  ): Promise<CryptoKeyPair | CryptoKey> {
    const alg = typeof algorithm === "string" ? { name: algorithm } : algorithm;
    if (alg.name === "Ed25519") {
      return ed25519.ed25519GenerateKey();
    } else if (alg.name === "RSA-OAEP") {
      const params = alg as RsaHashedKeyGenParams;
      return rsa.rsaGenerateKey(
        {
          name: "RSA-OAEP",
          modulusLength: params.modulusLength,
          publicExponent: new Uint8Array(params.publicExponent),
          hash: params.hash as "SHA-256",
        },
        extractable,
        keyUsages
      );
    } else if (alg.name === "AES-GCM") {
      const params = alg as AesKeyGenParams;
      // Generate random key material
      const keyLength = params.length / 8; // Convert bits to bytes
      const keyMaterial = new Uint8Array(keyLength);
      // Use crypto.getRandomValues if available, otherwise throw
      if (typeof crypto !== "undefined" && crypto.getRandomValues) {
        crypto.getRandomValues(keyMaterial);
      } else {
        throw new Error("getRandomValues not available");
      }
      
      return {
        type: "secret",
        extractable,
        algorithm: {
          name: "AES-GCM",
          length: params.length,
        },
        usages: keyUsages,
        _rawKey: keyMaterial.buffer,
      } as any;
    } else {
      throw new NotSupportedError(`Algorithm ${alg.name} is not supported`);
    }
  }

  /**
   * Import a key
   */
  async importKey(
    format: KeyFormat,
    keyData: BufferSource | JsonWebKey,
    algorithm:
      | RsaHashedImportParams
      | EcKeyImportParams
      | AesKeyAlgorithm
      | HmacImportParams
      | { name: "Ed25519" },
    extractable: boolean,
    keyUsages: KeyUsage[]
  ): Promise<CryptoKey> {
    if (format === "jwk") {
      throw new NotSupportedError("JWK format is not supported");
    }
    let keyBuffer: ArrayBuffer;
    if (keyData instanceof ArrayBuffer) {
      keyBuffer = keyData;
    } else if (typeof SharedArrayBuffer !== 'undefined' && keyData instanceof SharedArrayBuffer) {
      // Convert SharedArrayBuffer to ArrayBuffer by copying
      // Note: SharedArrayBuffer may not exist in React Native/Expo Go environments
      const view = new Uint8Array(keyData);
      const copy = new Uint8Array(view.length);
      copy.set(view);
      keyBuffer = copy.buffer;
    } else {
      // ArrayBufferView - copy to ensure we have an ArrayBuffer
      const view = keyData as ArrayBufferView;
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      const copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      keyBuffer = copy.buffer;
    }
    
    const alg = typeof algorithm === "string" ? { name: algorithm } : algorithm;
    if (alg.name === "Ed25519") {
      return ed25519.ed25519ImportKey(
        format as "spki" | "pkcs8",
        keyBuffer,
        alg as { name: "Ed25519" },
        extractable,
        keyUsages
      );
    } else if (alg.name === "RSA-OAEP") {
      const params = alg as RsaHashedImportParams;
      return rsa.rsaImportKey(
        format as "spki" | "pkcs8",
        keyBuffer,
        {
          name: "RSA-OAEP",
          hash: params.hash as "SHA-256",
        },
        extractable,
        keyUsages
      );
    } else if (alg.name === "AES-GCM") {
      if (format !== "raw") {
        throw new Error("AES-GCM keys can only be imported in 'raw' format");
      }
      const params = alg as AesKeyAlgorithm;
      const keyBytes = new Uint8Array(keyBuffer);
      
      return {
        type: "secret",
        extractable,
        algorithm: {
          name: "AES-GCM",
          length: params.length || keyBytes.length * 8,
        },
        usages: keyUsages,
        _rawKey: keyBuffer,
      } as any;
    } else if (alg.name === "HMAC") {
      if (format !== "raw") {
        throw new Error("HMAC keys can only be imported in 'raw' format");
      }
      const params = alg as HmacImportParams;
      
      return {
        type: "secret",
        extractable,
        algorithm: {
          name: "HMAC",
          hash: params.hash,
          length: new Uint8Array(keyBuffer).length * 8,
        },
        usages: keyUsages,
        _rawKey: keyBuffer,
      } as any;
    } else if (alg.name === "PBKDF2") {
      // PBKDF2 key import - treat the keyData as raw password material
      // This is used for PBKDF2 key derivation
      return {
        type: "secret",
        extractable,
        algorithm: alg as any,
        usages: keyUsages,
        _rawKey: keyBuffer,
      } as any;
    } else {
      throw new NotSupportedError(`Algorithm ${alg.name} is not supported`);
    }
  }

  /**
   * Export a key
   */
  async exportKey(format: KeyFormat, key: CryptoKey): Promise<ArrayBuffer | JsonWebKey> {
    if (format === "jwk") {
      throw new NotSupportedError("JWK format is not supported");
    }
    if (format === "raw") {
      // For raw keys (AES, HMAC), export the raw key material
      const rawKey = (key as any)._rawKey;
      if (!rawKey) {
        throw new Error("Key does not contain raw key material");
      }
      return rawKey instanceof ArrayBuffer ? rawKey : rawKey.buffer;
    } else if (format === "spki" || format === "pkcs8") {
      if (key.algorithm.name === "Ed25519") {
        return ed25519.ed25519ExportKey(format, key);
      } else if (key.algorithm.name === "RSA-OAEP") {
        return rsa.rsaExportKey(format, key);
      } else {
        throw new Error(`Cannot export ${key.algorithm.name} key in ${format} format`);
      }
    } else {
      throw new NotSupportedError(`Export format ${format} is not supported`);
    }
  }

  /**
   * Sign data
   */
  async sign(
    algorithm: AlgorithmIdentifier | RsaPssParams | EcdsaParams | { name: "Ed25519" } | { name: "HMAC" },
    key: CryptoKey,
    data: BufferSource
): Promise<ArrayBuffer> {
    const dataBuffer = data instanceof ArrayBuffer ? data : data.buffer;
    
    const alg = typeof algorithm === "string" ? { name: algorithm } : algorithm;
    if (alg.name === "Ed25519") {
      return ed25519.ed25519Sign(alg as { name: "Ed25519" }, key, dataBuffer);
    } else if (algorithm === "HMAC" || alg.name === "HMAC") {
      const rawKey = (key as any)._rawKey;
      if (!rawKey) {
        throw new Error("Key does not contain raw key material");
      }
      return hmac.hmacSign(rawKey, dataBuffer);
    } else {
      throw new NotSupportedError(`Signing algorithm ${alg.name || algorithm} is not supported`);
    }
  }

  /**
   * Verify a signature
   */
  async verify(
    algorithm: AlgorithmIdentifier | RsaPssParams | EcdsaParams | { name: "Ed25519" } | { name: "HMAC" },
    key: CryptoKey,
    signature: BufferSource,
    data: BufferSource
  ): Promise<boolean> {
    const sigBuffer = signature instanceof ArrayBuffer ? signature : signature.buffer;
    const dataBuffer = data instanceof ArrayBuffer ? data : data.buffer;
    
    const alg = typeof algorithm === "string" ? { name: algorithm } : algorithm;
    if (alg.name === "Ed25519") {
      return ed25519.ed25519Verify(alg as { name: "Ed25519" }, key, sigBuffer, dataBuffer);
    } else if (algorithm === "HMAC" || alg.name === "HMAC") {
      const rawKey = (key as any)._rawKey;
      if (!rawKey) {
        throw new Error("Key does not contain raw key material");
      }
      return hmac.hmacVerify(rawKey, sigBuffer, dataBuffer);
    } else {
      throw new NotSupportedError(`Verification algorithm ${alg.name || algorithm} is not supported`);
    }
  }

  /**
   * Encrypt data
   */
  async encrypt(
    algorithm: RsaOaepParams | AesGcmParams,
    key: CryptoKey,
    data: BufferSource
  ): Promise<ArrayBuffer> {
    const dataBuffer = data instanceof ArrayBuffer ? data : data.buffer;
    
    if (algorithm.name === "RSA-OAEP") {
      return rsa.rsaEncrypt(algorithm as rsa.RSAOAEPParams, key, dataBuffer);
    } else if (algorithm.name === "AES-GCM") {
      const params = algorithm as AesGcmParams;
      return aes.aesGcmEncrypt(
        {
          name: "AES-GCM",
          iv: params.iv,
          tagLength: params.tagLength,
        },
        key,
        dataBuffer
      );
    } else {
      throw new NotSupportedError(`Encryption algorithm ${algorithm.name} is not supported`);
    }
  }

  /**
   * Decrypt data
   */
  async decrypt(
    algorithm: RsaOaepParams | AesGcmParams,
    key: CryptoKey,
    data: BufferSource
  ): Promise<ArrayBuffer> {
    const dataBuffer = data instanceof ArrayBuffer ? data : data.buffer;
    
    if (algorithm.name === "RSA-OAEP") {
      return rsa.rsaDecrypt(algorithm as rsa.RSAOAEPParams, key, dataBuffer);
    } else if (algorithm.name === "AES-GCM") {
      const params = algorithm as AesGcmParams;
      return aes.aesGcmDecrypt(
        {
          name: "AES-GCM",
          iv: params.iv,
          tagLength: params.tagLength,
        },
        key,
        dataBuffer
      );
    } else {
      throw new NotSupportedError(`Decryption algorithm ${algorithm.name} is not supported`);
    }
  }

  /**
   * Derive a key using PBKDF2
   */
  async deriveKey(
    algorithm: Pbkdf2Params,
    baseKey: CryptoKey,
    derivedKeyType: AesDerivedKeyParams,
    extractable: boolean,
    keyUsages: KeyUsage[]
  ): Promise<CryptoKey> {
    if (algorithm.name !== "PBKDF2") {
      throw new NotSupportedError(`Key derivation algorithm ${algorithm.name} is not supported`);
    }
    
    const rawKey = (baseKey as any)._rawKey;
    if (!rawKey) {
      throw new Error("Base key does not contain raw key material");
    }
    
    return pbkdf2.pbkdf2DeriveKey(
      {
        name: "PBKDF2",
        salt: algorithm.salt,
        iterations: algorithm.iterations,
        hash: algorithm.hash as "SHA-256",
      },
      rawKey,
      {
        name: "AES-GCM",
        length: derivedKeyType.length,
      }
    );
  }

  /**
   * Compute digest
   */
  async digest(algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> {
    const dataBuffer = data instanceof ArrayBuffer ? data : data.buffer;
    
    const alg = typeof algorithm === "string" ? algorithm : algorithm.name;
    if (alg === "SHA-256") {
      return sha256.sha256Digest(dataBuffer);
    } else {
      throw new NotSupportedError(`Digest algorithm ${alg} is not supported`);
    }
  }

  // Unimplemented methods - throw NotSupportedError
  async deriveBits(
    algorithm: AlgorithmIdentifier,
    baseKey: CryptoKey,
    length: number
  ): Promise<ArrayBuffer> {
    throw new NotSupportedError("deriveBits is not implemented");
  }

  async wrapKey(
    format: KeyFormat,
    key: CryptoKey,
    wrappingKey: CryptoKey,
    wrapAlgorithm: AlgorithmIdentifier
  ): Promise<ArrayBuffer> {
    throw new NotSupportedError("wrapKey is not implemented");
  }

  async unwrapKey(
    format: KeyFormat,
    wrappedKey: BufferSource,
    unwrappingKey: CryptoKey,
    unwrapAlgorithm: AlgorithmIdentifier,
    unwrappedKeyAlgorithm: AlgorithmIdentifier,
    extractable: boolean,
    keyUsages: KeyUsage[]
  ): Promise<CryptoKey> {
    throw new NotSupportedError("unwrapKey is not implemented");
  }
}
