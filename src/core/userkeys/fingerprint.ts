/**
 * Compare PEMs ignoring whitespace / line-ending differences between client
 * JSON transport, JWT payloads, and directory storage.
 */
export function normalizePublicKeyPem(pem: string): string {
  return pem.replace(/\s+/g, "");
}

/**
 * SHA-256 fingerprint of a public key (PEM), for encryption and signing keys
 * alike — the digest is taken over the decoded SPKI body, which carries the
 * key type, so the two never collide.
 *
 * Matches {@link BaseMindooTenantDirectory}'s device-map keys and Haven's
 * `getPublicKeyFingerprint`: first 8 bytes as colon-separated hex.
 */
export async function fingerprintPublicKeyPem(
  pem: string,
  subtle: SubtleCrypto,
): Promise<string> {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  let source: Uint8Array;
  try {
    source = body ? base64ToBytes(body) : new TextEncoder().encode(pem);
  } catch {
    source = new TextEncoder().encode(pem);
  }
  const digest = await subtle.digest("SHA-256", source as unknown as BufferSource);
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(":");
}

/**
 * Fingerprint of an RSA encryption public key.
 *
 * @deprecated Prefer {@link fingerprintPublicKeyPem}; the algorithm is not
 * specific to encryption keys. Kept so existing call sites keep reading well.
 */
export const fingerprintEncryptionPublicKey = fingerprintPublicKeyPem;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function spkiToPem(spki: ArrayBuffer): string {
  const b64 = bytesToBase64(new Uint8Array(spki));
  const wrapped = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----`;
}
