import type { CryptoAdapter } from "../../core/crypto/CryptoAdapter";

/**
 * Browser implementation of CryptoAdapter.
 * Uses window.crypto which is available in modern browsers.
 */
export class BrowserCryptoAdapter implements CryptoAdapter {
  getSubtle(): SubtleCrypto {
    if (typeof window === "undefined" || !window.crypto || !window.crypto.subtle) {
      throw new Error("Web Crypto API not available in browser environment");
    }
    return window.crypto.subtle;
  }

  getRandomValues(array: Uint8Array): Uint8Array {
    if (typeof window === "undefined" || !window.crypto || !window.crypto.getRandomValues) {
      throw new Error("getRandomValues not available in browser environment");
    }
    return window.crypto.getRandomValues(array);
  }
}

/**
 * Factory function to create the BrowserCryptoAdapter.
 */
export function createCryptoAdapter(): CryptoAdapter {
  return new BrowserCryptoAdapter();
}
