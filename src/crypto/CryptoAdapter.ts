/**
 * CryptoAdapter provides a platform-agnostic interface to the Web Crypto API.
 * This allows BaseMindooTenant to work in both browser and Node.js environments.
 */
export interface CryptoAdapter {
  /**
   * Get the SubtleCrypto interface for cryptographic operations.
   * In browsers: window.crypto.subtle
   * In Node.js: crypto.webcrypto.subtle
   */
  getSubtle(): SubtleCrypto;

  /**
   * Get random values for key generation and IVs.
   * In browsers: window.crypto.getRandomValues
   * In Node.js: crypto.webcrypto.getRandomValues
   */
  getRandomValues(array: Uint8Array): Uint8Array;
}

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
 * Node.js implementation of CryptoAdapter.
 * Uses crypto.webcrypto which is available in Node.js 15+.
 */
export class NodeCryptoAdapter implements CryptoAdapter {
  private crypto: Crypto;

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto = require("crypto");
    
    if (!nodeCrypto) {
      throw new Error("Failed to load crypto module");
    }
    
    // In Node.js 15+, crypto.webcrypto provides the Web Crypto API
    // In Node.js 20+, globalThis.crypto is also available, but webcrypto is more reliable
    if (!nodeCrypto.webcrypto) {
      throw new Error("Web Crypto API not available. Node.js 15+ required.");
    }
    
    // Validate that webcrypto has the required methods
    if (typeof nodeCrypto.webcrypto.getRandomValues !== "function" || !nodeCrypto.webcrypto.subtle) {
      throw new Error("Web Crypto API incomplete. Missing getRandomValues or subtle.");
    }
    
    this.crypto = nodeCrypto.webcrypto;
  }

  getSubtle(): SubtleCrypto {
    if (!this.crypto || !this.crypto.subtle) {
      throw new Error("Web Crypto API subtle not available");
    }
    return this.crypto.subtle;
  }

  getRandomValues(array: Uint8Array): Uint8Array {
    if (!this) {
      throw new Error("getRandomValues called without 'this' context. Method must be bound.");
    }
    if (!this.crypto) {
      throw new Error("Crypto instance not initialized. This should not happen.");
    }
    if (!this.crypto.getRandomValues) {
      throw new Error("getRandomValues not available in Node.js environment");
    }
    return this.crypto.getRandomValues(array);
  }
}

/**
 * Factory function to create the appropriate CryptoAdapter based on the environment.
 * Automatically detects browser vs Node.js and returns the appropriate adapter.
 */
export function createCryptoAdapter(): CryptoAdapter {
  // Check if we're in a browser environment
  if (typeof window !== "undefined" && window.crypto && window.crypto.subtle) {
    return new BrowserCryptoAdapter();
  }

  // Otherwise, assume Node.js
  return new NodeCryptoAdapter();
}

