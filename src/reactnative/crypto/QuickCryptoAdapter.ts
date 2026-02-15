/**
 * Quick Crypto Adapter
 * Wrapper for react-native-quick-crypto native module
 * Provides high-performance crypto operations for React Native native builds
 */

import type { CryptoAdapter } from "../../core/crypto/CryptoAdapter";

/**
 * Interface for the react-native-quick-crypto module
 */
interface QuickCryptoModule {
  subtle: SubtleCrypto;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

/**
 * Quick Crypto Adapter
 * Uses react-native-quick-crypto for native crypto operations
 * This provides significantly better performance than the JS-only ExpoGoCryptoAdapter
 */
export class QuickCryptoAdapter implements CryptoAdapter {
  private quickCrypto: QuickCryptoModule;

  constructor(quickCrypto: QuickCryptoModule) {
    if (!quickCrypto || !quickCrypto.subtle) {
      throw new Error(
        "react-native-quick-crypto subtle API is not available. " +
        "Make sure you have a development build with react-native-quick-crypto installed."
      );
    }
    this.quickCrypto = quickCrypto;
  }

  /**
   * Get the SubtleCrypto interface from react-native-quick-crypto
   */
  getSubtle(): SubtleCrypto {
    return this.quickCrypto.subtle;
  }

  /**
   * Get random values using react-native-quick-crypto
   */
  getRandomValues(array: Uint8Array): Uint8Array {
    if (this.quickCrypto.getRandomValues) {
      return this.quickCrypto.getRandomValues(array);
    }
    if (typeof global !== "undefined" && global.crypto?.getRandomValues) {
      return global.crypto.getRandomValues(array);
    }
    throw new Error("react-native-quick-crypto getRandomValues is not available");
  }
}

/**
 * Check if react-native-quick-crypto is available
 * @returns true if the module is available and functional
 */
export function isQuickCryptoAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const quickCrypto = require("react-native-quick-crypto");
    if (!quickCrypto || !quickCrypto.subtle || typeof quickCrypto.subtle.generateKey !== "function") {
      return false;
    }
    const hasRandomValues =
      typeof quickCrypto.getRandomValues === "function" ||
      (typeof global !== "undefined" && typeof global.crypto?.getRandomValues === "function");
    if (!hasRandomValues) {
      return false;
    }

    // Ensure the native Hash implementation is actually available.
    // In Expo Go or a misbuilt dev client, these can throw "Not implemented".
    if (typeof quickCrypto.createHash === "function") {
      const hash = quickCrypto.createHash("sha256");
      hash.update("mindoodb-quick-crypto-test");
      hash.digest();
    }

    return true;
  } catch {
    return false;
  }
}
