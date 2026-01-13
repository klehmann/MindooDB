import type { CryptoAdapter } from "../../core/crypto/CryptoAdapter";

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
 * Factory function to create the NodeCryptoAdapter.
 */
export function createCryptoAdapter(): CryptoAdapter {
  return new NodeCryptoAdapter();
}
