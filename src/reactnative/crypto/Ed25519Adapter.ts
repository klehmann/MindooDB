/**
 * Ed25519 Adapter
 * Implements Ed25519 key generation, signing, and verification using TweetNaCl
 * 
 * TweetNaCl is CommonJS compatible and works directly with Jest without mocking.
 * It provides real Ed25519 elliptic curve operations, audited by Cure53.
 */

import nacl from "tweetnacl";

// Ed25519 key sizes
const ED25519_SEED_SIZE = 32;        // The 32-byte seed (what PKCS8 stores)
const ED25519_PUBLIC_KEY_SIZE = 32;  // The 32-byte public key
const ED25519_SECRET_KEY_SIZE = 64;  // TweetNaCl's format: seed + public key
const ED25519_SIGNATURE_SIZE = 64;

/**
 * Generate Ed25519 key pair
 */
export async function ed25519GenerateKey(): Promise<CryptoKeyPair> {
  const keyPair = nacl.sign.keyPair();
  
  return {
    publicKey: {
      type: "public",
      extractable: true,
      algorithm: { name: "Ed25519" },
      usages: ["verify"],
      _rawPublicKey: keyPair.publicKey,
    } as any,
    privateKey: {
      type: "private",
      extractable: true,
      algorithm: { name: "Ed25519" },
      usages: ["sign"],
      // Store the full 64-byte secret key (TweetNaCl format)
      _rawPrivateKey: keyPair.secretKey,
    } as any,
  };
}

/**
 * Import Ed25519 key from SPKI (public) or PKCS8 (private) format
 */
export async function ed25519ImportKey(
  format: "spki" | "pkcs8",
  keyData: ArrayBuffer | ArrayBufferLike,
  algorithm: { name: "Ed25519" },
  extractable: boolean,
  keyUsages: KeyUsage[]
): Promise<CryptoKey> {
  // Ensure we have an ArrayBuffer (not SharedArrayBuffer)
  // Note: We don't explicitly check for SharedArrayBuffer here because:
  // 1. SharedArrayBuffer may not exist in React Native/Expo Go environments
  // 2. Using (keyData as any) and copying works for both SharedArrayBuffer and ArrayBufferView
  // 3. This approach avoids ReferenceError when SharedArrayBuffer is undefined
  let buffer: ArrayBuffer;
  if (keyData instanceof ArrayBuffer) {
    buffer = keyData;
  } else {
    // Copy from SharedArrayBuffer or ArrayBufferView
    const view = new Uint8Array(keyData as any);
    const copy = new Uint8Array(view.length);
    copy.set(view);
    buffer = copy.buffer;
  }
  const keyBytes = new Uint8Array(buffer);
  
  if (format === "spki") {
    // SPKI format for public keys
    const publicKey = extractEd25519PublicKeyFromSPKI(keyBytes);
    
    return {
      type: "public",
      extractable,
      algorithm,
      usages: keyUsages,
      _rawPublicKey: publicKey,
    } as any;
  } else {
    // PKCS8 format for private keys
    // Extract the 32-byte seed from PKCS8
    const seed = extractEd25519PrivateKeyFromPKCS8(keyBytes);
    
    // Derive the full 64-byte secret key from the seed using TweetNaCl
    const keyPair = nacl.sign.keyPair.fromSeed(seed);
    
    return {
      type: "private",
      extractable,
      algorithm,
      usages: keyUsages,
      // Store the full 64-byte secret key
      _rawPrivateKey: keyPair.secretKey,
    } as any;
  }
}

/**
 * Export Ed25519 key to SPKI (public) or PKCS8 (private) format
 */
export async function ed25519ExportKey(
  format: "spki" | "pkcs8",
  key: CryptoKey
): Promise<ArrayBuffer> {
  if (format === "spki") {
    const publicKey = (key as any)._rawPublicKey;
    if (!publicKey) {
      throw new Error("Key does not contain public key material");
    }
    return encodeEd25519PublicKeyToSPKI(publicKey);
  } else {
    const secretKey = (key as any)._rawPrivateKey;
    if (!secretKey) {
      throw new Error("Key does not contain private key material");
    }
    // PKCS8 stores only the 32-byte seed (first half of TweetNaCl's 64-byte secret key)
    const seed = secretKey.slice(0, ED25519_SEED_SIZE);
    return encodeEd25519PrivateKeyToPKCS8(seed);
  }
}

/**
 * Sign data with Ed25519 private key
 */
export async function ed25519Sign(
  algorithm: { name: "Ed25519" },
  key: CryptoKey,
  data: ArrayBuffer | Uint8Array
): Promise<ArrayBuffer> {
  const secretKey = (key as any)._rawPrivateKey;
  if (!secretKey) {
    throw new Error("Key does not contain private key material");
  }
  
  const dataBytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  
  // Use detached signature (just the signature, not message + signature)
  const signature = nacl.sign.detached(dataBytes, secretKey);
  
  // Ensure we return an ArrayBuffer (not SharedArrayBuffer)
  const copy = new Uint8Array(signature);
  return copy.buffer;
}

/**
 * Verify Ed25519 signature
 */
export async function ed25519Verify(
  algorithm: { name: "Ed25519" },
  key: CryptoKey,
  signature: ArrayBuffer | Uint8Array,
  data: ArrayBuffer | Uint8Array
): Promise<boolean> {
  const publicKey = (key as any)._rawPublicKey;
  if (!publicKey) {
    throw new Error("Key does not contain public key material");
  }
  
  const sigBytes = signature instanceof Uint8Array ? signature : new Uint8Array(signature);
  const dataBytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  
  return nacl.sign.detached.verify(dataBytes, sigBytes, publicKey);
}

/**
 * Extract Ed25519 public key from SPKI format
 * SPKI format: SEQUENCE { AlgorithmIdentifier { OID 1.3.101.112 }, BIT STRING }
 */
function extractEd25519PublicKeyFromSPKI(spki: Uint8Array): Uint8Array {
  let pos = 0;
  
  // Skip outer SEQUENCE tag (0x30)
  if (spki[pos] !== 0x30) {
    throw new Error("Invalid SPKI format: expected SEQUENCE");
  }
  pos++;
  
  // Skip length (can be 1-4 bytes)
  const seqLength = readASN1Length(spki, pos);
  pos += seqLength.bytesRead;
  
  // Skip AlgorithmIdentifier SEQUENCE
  if (spki[pos] !== 0x30) {
    throw new Error("Invalid SPKI format: expected AlgorithmIdentifier SEQUENCE");
  }
  pos++;
  const algIdLength = readASN1Length(spki, pos);
  pos += algIdLength.bytesRead + algIdLength.value;
  
  // Now we should be at the BIT STRING (0x03)
  if (spki[pos] !== 0x03) {
    throw new Error("Invalid SPKI format: expected BIT STRING");
  }
  pos++;
  
  // Read BIT STRING length
  const bitStringLength = readASN1Length(spki, pos);
  pos += bitStringLength.bytesRead;
  
  // Skip the unused bits byte (usually 0x00)
  pos++;
  
  // Extract the 32-byte public key
  if (bitStringLength.value - 1 !== ED25519_PUBLIC_KEY_SIZE) {
    throw new Error(`Invalid Ed25519 public key size: expected ${ED25519_PUBLIC_KEY_SIZE}, got ${bitStringLength.value - 1}`);
  }
  
  return spki.slice(pos, pos + ED25519_PUBLIC_KEY_SIZE);
}

/**
 * Extract Ed25519 private key (seed) from PKCS8 format
 * PKCS8 format: SEQUENCE { version, AlgorithmIdentifier { OID 1.3.101.112 }, OCTET STRING { OCTET STRING { seed } } }
 * 
 * Note: RFC 8410 specifies that Ed25519 private keys in PKCS8 are wrapped in an additional OCTET STRING
 */
function extractEd25519PrivateKeyFromPKCS8(pkcs8: Uint8Array): Uint8Array {
  let pos = 0;
  
  // Skip outer SEQUENCE tag (0x30)
  if (pkcs8[pos] !== 0x30) {
    throw new Error("Invalid PKCS8 format: expected SEQUENCE");
  }
  pos++;
  
  // Skip length
  const seqLength = readASN1Length(pkcs8, pos);
  pos += seqLength.bytesRead;
  
  // Skip version INTEGER (0x02)
  if (pkcs8[pos] !== 0x02) {
    throw new Error("Invalid PKCS8 format: expected version INTEGER");
  }
  pos++;
  const versionLength = readASN1Length(pkcs8, pos);
  pos += versionLength.bytesRead + versionLength.value;
  
  // Skip AlgorithmIdentifier SEQUENCE
  if (pkcs8[pos] !== 0x30) {
    throw new Error("Invalid PKCS8 format: expected AlgorithmIdentifier SEQUENCE");
  }
  pos++;
  const algIdLength = readASN1Length(pkcs8, pos);
  pos += algIdLength.bytesRead + algIdLength.value;
  
  // Now we should be at the outer OCTET STRING (0x04)
  if (pkcs8[pos] !== 0x04) {
    throw new Error("Invalid PKCS8 format: expected OCTET STRING");
  }
  pos++;
  
  // Read outer OCTET STRING length
  const outerOctetLength = readASN1Length(pkcs8, pos);
  pos += outerOctetLength.bytesRead;
  
  // Check if there's an inner OCTET STRING (RFC 8410 format)
  if (pkcs8[pos] === 0x04) {
    // Inner OCTET STRING contains the actual seed
    pos++;
    const innerOctetLength = readASN1Length(pkcs8, pos);
    pos += innerOctetLength.bytesRead;
    
    if (innerOctetLength.value !== ED25519_SEED_SIZE) {
      throw new Error(`Invalid Ed25519 private key size: expected ${ED25519_SEED_SIZE}, got ${innerOctetLength.value}`);
    }
    
    return pkcs8.slice(pos, pos + ED25519_SEED_SIZE);
  } else {
    // Direct seed (older format)
    if (outerOctetLength.value !== ED25519_SEED_SIZE) {
      throw new Error(`Invalid Ed25519 private key size: expected ${ED25519_SEED_SIZE}, got ${outerOctetLength.value}`);
    }
    
    return pkcs8.slice(pos, pos + ED25519_SEED_SIZE);
  }
}

/**
 * Read ASN.1 length field
 * Returns { value: number, bytesRead: number }
 */
function readASN1Length(data: Uint8Array, pos: number): { value: number; bytesRead: number } {
  if (pos >= data.length) {
    throw new Error("Invalid ASN.1: unexpected end of data");
  }
  
  const firstByte = data[pos];
  
  // Short form (length < 128)
  if ((firstByte & 0x80) === 0) {
    return { value: firstByte, bytesRead: 1 };
  }
  
  // Long form (length >= 128)
  const lengthBytes = firstByte & 0x7f;
  if (lengthBytes === 0 || lengthBytes > 4) {
    throw new Error("Invalid ASN.1: invalid length encoding");
  }
  
  if (pos + 1 + lengthBytes > data.length) {
    throw new Error("Invalid ASN.1: unexpected end of data");
  }
  
  let length = 0;
  for (let i = 0; i < lengthBytes; i++) {
    length = (length << 8) | data[pos + 1 + i];
  }
  
  return { value: length, bytesRead: 1 + lengthBytes };
}

/**
 * Encode Ed25519 public key to SPKI format
 */
function encodeEd25519PublicKeyToSPKI(publicKey: Uint8Array): ArrayBuffer {
  if (publicKey.length !== ED25519_PUBLIC_KEY_SIZE) {
    throw new Error(`Invalid Ed25519 public key size: expected ${ED25519_PUBLIC_KEY_SIZE}, got ${publicKey.length}`);
  }
  
  // Ed25519 SPKI structure:
  // SEQUENCE {
  //   SEQUENCE {
  //     OID 1.3.101.112 (Ed25519) = [0x06, 0x03, 0x2b, 0x65, 0x70]
  //   }
  //   BIT STRING { 0x00 (unused bits), publicKey (32 bytes) }
  // }
  
  const oid = new Uint8Array([0x06, 0x03, 0x2b, 0x65, 0x70]); // OID 1.3.101.112
  const algorithmId = encodeASN1Sequence([oid]);
  const bitString = encodeASN1BitString(publicKey);
  const outerSequence = encodeASN1Sequence([algorithmId, bitString]);
  
  // Ensure we return an ArrayBuffer (not SharedArrayBuffer)
  const copy = new Uint8Array(outerSequence);
  return copy.buffer;
}

/**
 * Encode Ed25519 private key (seed) to PKCS8 format
 * Uses RFC 8410 format with wrapped OCTET STRING
 */
function encodeEd25519PrivateKeyToPKCS8(seed: Uint8Array): ArrayBuffer {
  if (seed.length !== ED25519_SEED_SIZE) {
    throw new Error(`Invalid Ed25519 seed size: expected ${ED25519_SEED_SIZE}, got ${seed.length}`);
  }
  
  // Ed25519 PKCS8 structure (RFC 8410):
  // SEQUENCE {
  //   INTEGER 0 (version)
  //   SEQUENCE {
  //     OID 1.3.101.112 (Ed25519) = [0x06, 0x03, 0x2b, 0x65, 0x70]
  //   }
  //   OCTET STRING { OCTET STRING { seed (32 bytes) } }
  // }
  
  const version = encodeASN1Integer(new Uint8Array([0x00])); // INTEGER 0
  const oid = new Uint8Array([0x06, 0x03, 0x2b, 0x65, 0x70]); // OID 1.3.101.112
  const algorithmId = encodeASN1Sequence([oid]);
  
  // Inner OCTET STRING contains the seed
  const innerOctetString = encodeASN1OctetString(seed);
  // Outer OCTET STRING wraps the inner one
  const outerOctetString = encodeASN1OctetString(innerOctetString);
  
  const outerSequence = encodeASN1Sequence([version, algorithmId, outerOctetString]);
  
  // Ensure we return an ArrayBuffer (not SharedArrayBuffer)
  const copy = new Uint8Array(outerSequence);
  return copy.buffer;
}

/**
 * Encode ASN.1 SEQUENCE
 */
function encodeASN1Sequence(items: Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const item of items) {
    totalLength += item.length;
  }
  
  const lengthBytes = encodeASN1Length(totalLength);
  const result = new Uint8Array(1 + lengthBytes.length + totalLength);
  result[0] = 0x30; // SEQUENCE tag
  result.set(lengthBytes, 1);
  
  let pos = 1 + lengthBytes.length;
  for (const item of items) {
    result.set(item, pos);
    pos += item.length;
  }
  
  return result;
}

/**
 * Encode ASN.1 BIT STRING
 */
function encodeASN1BitString(data: Uint8Array): Uint8Array {
  // BIT STRING: tag (0x03) + length + unused bits (0x00) + data
  const length = 1 + data.length; // 1 byte for unused bits + data
  const lengthBytes = encodeASN1Length(length);
  const result = new Uint8Array(1 + lengthBytes.length + length);
  result[0] = 0x03; // BIT STRING tag
  result.set(lengthBytes, 1);
  result[1 + lengthBytes.length] = 0x00; // unused bits
  result.set(data, 1 + lengthBytes.length + 1);
  return result;
}

/**
 * Encode ASN.1 OCTET STRING
 */
function encodeASN1OctetString(data: Uint8Array): Uint8Array {
  const lengthBytes = encodeASN1Length(data.length);
  const result = new Uint8Array(1 + lengthBytes.length + data.length);
  result[0] = 0x04; // OCTET STRING tag
  result.set(lengthBytes, 1);
  result.set(data, 1 + lengthBytes.length);
  return result;
}

/**
 * Encode ASN.1 INTEGER
 */
function encodeASN1Integer(data: Uint8Array): Uint8Array {
  const lengthBytes = encodeASN1Length(data.length);
  const result = new Uint8Array(1 + lengthBytes.length + data.length);
  result[0] = 0x02; // INTEGER tag
  result.set(lengthBytes, 1);
  result.set(data, 1 + lengthBytes.length);
  return result;
}

/**
 * Encode ASN.1 length field
 */
function encodeASN1Length(length: number): Uint8Array {
  if (length < 128) {
    // Short form
    return new Uint8Array([length]);
  }
  
  // Long form
  const bytes: number[] = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>>= 8;
  }
  
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}
