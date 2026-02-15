/**
 * Expo Go Crypto Adapter
 * JavaScript-only implementation of CryptoAdapter for Expo Go
 * Uses pure JS crypto libraries since native modules don't work in Expo Go
 */

import type { CryptoAdapter } from "../../core/crypto/CryptoAdapter";
import { SubtleCryptoPolyfill } from "./SubtleCryptoPolyfill";

// Dynamic import of expo-standard-web-crypto to handle environments where it's not available
let getRandomValuesFn: ((array: Uint8Array) => Uint8Array) | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const expoStandardWebCrypto = require("expo-standard-web-crypto");
  // Handle both default export and named export
  getRandomValuesFn = expoStandardWebCrypto.getRandomValues || expoStandardWebCrypto.default?.getRandomValues;
} catch {
  // expo-standard-web-crypto not available, will use fallback
}

/**
 * Expo Go Crypto Adapter
 * Implements the CryptoAdapter interface using JavaScript-only crypto libraries
 */
export class ExpoGoCryptoAdapter implements CryptoAdapter {
  private subtle: SubtleCryptoPolyfill;

  constructor() {
    this.subtle = new SubtleCryptoPolyfill();
  }

  /**
   * Get the SubtleCrypto interface
   */
  getSubtle(): SubtleCrypto {
    return this.subtle as unknown as SubtleCrypto;
  }

  /**
   * Get random values using expo-standard-web-crypto or fallback
   */
  getRandomValues(array: Uint8Array): Uint8Array {
    if (getRandomValuesFn) {
      return getRandomValuesFn(array);
    }
    
    // Fallback: use global crypto if available (e.g., in Node.js tests)
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      return crypto.getRandomValues(array);
    }
    
    throw new Error(
      "getRandomValues not available. " +
      "Install expo-standard-web-crypto for React Native support."
    );
  }
}
