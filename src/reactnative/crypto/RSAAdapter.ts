/**
 * RSA-OAEP Adapter
 * Implements RSA-OAEP encryption/decryption using node-forge
 */

import forge from "node-forge";
import { pemToArrayBuffer, arrayBufferToPEM } from "./KeyFormatConverter";

export interface RSAOAEPParams {
  name: "RSA-OAEP";
  label?: BufferSource;
}

export interface RSAKeyGenParams {
  name: "RSA-OAEP";
  modulusLength: number;
  publicExponent: Uint8Array;
  hash: "SHA-256";
}

/**
 * Generate RSA-OAEP key pair
 */
export async function rsaGenerateKey(
  algorithm: RSAKeyGenParams,
  extractable: boolean,
  keyUsages: KeyUsage[]
): Promise<CryptoKeyPair> {
  // Convert public exponent from Uint8Array to bigint
  // Usually [1, 0, 1] = 65537
  let exponent = 0n;
  for (let i = 0; i < algorithm.publicExponent.length; i++) {
    exponent = (exponent << 8n) | BigInt(algorithm.publicExponent[i]);
  }
  
  // Generate RSA key pair using node-forge
  const keyPair = forge.pki.rsa.generateKeyPair({
    bits: algorithm.modulusLength,
    e: Number(exponent), // Usually 65537
  });
  
  // Convert to PEM format for storage
  const publicKeyPem = forge.pki.publicKeyToPem(keyPair.publicKey);
  const privateKeyPem = forge.pki.privateKeyToPem(keyPair.privateKey);
  
  return {
    publicKey: {
      type: "public",
      extractable,
      algorithm: {
        name: "RSA-OAEP",
        modulusLength: algorithm.modulusLength,
        publicExponent: algorithm.publicExponent,
        hash: algorithm.hash,
      },
      usages: keyUsages.filter((u) => u === "encrypt"),
      _forgePublicKey: keyPair.publicKey,
      _pemPublicKey: publicKeyPem,
    } as any,
    privateKey: {
      type: "private",
      extractable,
      algorithm: {
        name: "RSA-OAEP",
        modulusLength: algorithm.modulusLength,
        publicExponent: algorithm.publicExponent,
        hash: algorithm.hash,
      },
      usages: keyUsages.filter((u) => u === "decrypt"),
      _forgePrivateKey: keyPair.privateKey,
      _pemPrivateKey: privateKeyPem,
    } as any,
  };
}

/**
 * Import RSA key from SPKI (public) or PKCS8 (private) format
 */
export async function rsaImportKey(
  format: "spki" | "pkcs8",
  keyData: ArrayBuffer,
  algorithm: { name: "RSA-OAEP"; hash: "SHA-256" },
  extractable: boolean,
  keyUsages: KeyUsage[]
): Promise<CryptoKey> {
  const keyBytes = new Uint8Array(keyData);
  
  // Convert to PEM format for node-forge
  const pem = arrayBufferToPEM(keyBytes.buffer, format === "spki" ? "PUBLIC KEY" : "PRIVATE KEY");
  
  try {
    if (format === "spki") {
      const publicKey = forge.pki.publicKeyFromPem(pem);
      const publicKeyPem = forge.pki.publicKeyToPem(publicKey);
      
      // Extract modulus length from key
      const modulusLength = publicKey.n.bitLength();
      
      return {
        type: "public",
        extractable,
        algorithm: {
          name: "RSA-OAEP",
          modulusLength,
          publicExponent: new Uint8Array([1, 0, 1]), // Usually 65537
          hash: algorithm.hash,
        },
        usages: keyUsages.filter((u) => u === "encrypt"),
        _forgePublicKey: publicKey,
        _pemPublicKey: publicKeyPem,
      } as any;
    } else {
      const privateKey = forge.pki.privateKeyFromPem(pem);
      const privateKeyPem = forge.pki.privateKeyToPem(privateKey);
      
      // Extract modulus length from key
      const modulusLength = privateKey.n.bitLength();
      
      return {
        type: "private",
        extractable,
        algorithm: {
          name: "RSA-OAEP",
          modulusLength,
          publicExponent: new Uint8Array([1, 0, 1]), // Usually 65537
          hash: algorithm.hash,
        },
        usages: keyUsages.filter((u) => u === "decrypt"),
        _forgePrivateKey: privateKey,
        _pemPrivateKey: privateKeyPem,
      } as any;
    }
  } catch (error) {
    throw new Error(`Failed to import RSA key: ${error}`);
  }
}

/**
 * Export RSA key to SPKI (public) or PKCS8 (private) format
 */
export async function rsaExportKey(format: "spki" | "pkcs8", key: CryptoKey): Promise<ArrayBuffer> {
  if (format === "spki") {
    const pem = (key as any)._pemPublicKey;
    if (!pem) {
      throw new Error("Key does not contain public key material");
    }
    return pemToArrayBuffer(pem);
  } else {
    const pem = (key as any)._pemPrivateKey;
    if (!pem) {
      throw new Error("Key does not contain private key material");
    }
    return pemToArrayBuffer(pem);
  }
}

/**
 * Encrypt data with RSA-OAEP
 */
export async function rsaEncrypt(
  algorithm: RSAOAEPParams,
  key: CryptoKey,
  data: ArrayBuffer | Uint8Array
): Promise<ArrayBuffer> {
  const publicKey = (key as any)._forgePublicKey;
  if (!publicKey) {
    throw new Error("Key does not contain public key material");
  }
  
  const dataBytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  
  // RSA-OAEP encryption with SHA-256
  // node-forge encrypt returns a binary string, convert to ArrayBuffer
  const dataBuf = forge.util.createBuffer(dataBytes.buffer as ArrayBuffer);
  const encrypted = publicKey.encrypt(dataBuf.getBytes(), "RSA-OAEP", {
    md: forge.md.sha256.create(),
    mgf1: {
      md: forge.md.sha256.create(),
    },
  });
  
  // Convert binary string to ArrayBuffer
  const encryptedBytes = new Uint8Array(encrypted.length);
  for (let i = 0; i < encrypted.length; i++) {
    encryptedBytes[i] = encrypted.charCodeAt(i) & 0xff;
  }
  
  return encryptedBytes.buffer;
}

/**
 * Decrypt data with RSA-OAEP
 */
export async function rsaDecrypt(
  algorithm: RSAOAEPParams,
  key: CryptoKey,
  data: ArrayBuffer | Uint8Array
): Promise<ArrayBuffer> {
  const privateKey = (key as any)._forgePrivateKey;
  if (!privateKey) {
    throw new Error("Key does not contain private key material");
  }
  
  const dataBytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  
  // RSA-OAEP decryption with SHA-256
  // node-forge decrypt expects a binary string
  const encryptedStr = forge.util.createBuffer(dataBytes.buffer as ArrayBuffer).getBytes();
  const decrypted = privateKey.decrypt(encryptedStr, "RSA-OAEP", {
    md: forge.md.sha256.create(),
    mgf1: {
      md: forge.md.sha256.create(),
    },
  });
  
  // Convert binary string to ArrayBuffer
  const decryptedBytes = new Uint8Array(decrypted.length);
  for (let i = 0; i < decrypted.length; i++) {
    decryptedBytes[i] = decrypted.charCodeAt(i) & 0xff;
  }
  
  return decryptedBytes.buffer;
}
