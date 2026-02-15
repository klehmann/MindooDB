/**
 * Key Format Converter
 * Handles conversions between PEM format and raw key material for Ed25519 and RSA keys
 */

/**
 * Convert PEM string to ArrayBuffer (base64 decoded)
 */
export function pemToArrayBuffer(pem: string): ArrayBuffer {
  // Remove PEM headers and whitespace
  const pemContents = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s/g, "");
  
  // Decode base64
  const binary = atob(pemContents);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Convert ArrayBuffer to PEM string
 */
export function arrayBufferToPEM(buffer: ArrayBuffer, type: "PUBLIC KEY" | "PRIVATE KEY"): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  
  const header = type === "PUBLIC KEY" 
    ? "-----BEGIN PUBLIC KEY-----"
    : "-----BEGIN PRIVATE KEY-----";
  const footer = type === "PUBLIC KEY"
    ? "-----END PUBLIC KEY-----"
    : "-----END PRIVATE KEY-----";
  
  // Format with line breaks (64 chars per line)
  const lines = [];
  for (let i = 0; i < base64.length; i += 64) {
    lines.push(base64.slice(i, i + 64));
  }
  
  return `${header}\n${lines.join("\n")}\n${footer}`;
}

/**
 * Convert Uint8Array to base64 string
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert base64 string to Uint8Array
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
