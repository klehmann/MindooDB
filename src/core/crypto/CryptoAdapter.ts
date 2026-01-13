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
