/**
 * React Native Crypto Adapter
 * Auto-detects and uses the best available crypto implementation:
 * 1. react-native-quick-crypto (native, fast) - for dev builds and production
 * 2. ExpoGoCryptoAdapter (JS-only, slower) - fallback for Expo Go
 */

import type { CryptoAdapter } from "../../core/crypto/CryptoAdapter";
import { ExpoGoCryptoAdapter } from "./ExpoGoCryptoAdapter";
import { QuickCryptoAdapter, isQuickCryptoAvailable } from "./QuickCryptoAdapter";

/**
 * React Native Crypto Adapter
 * Automatically selects the best available crypto implementation
 */
export class ReactNativeCryptoAdapter implements CryptoAdapter {
  private adapter: CryptoAdapter;
  
  /**
   * Indicates whether the adapter is using native crypto (react-native-quick-crypto)
   * or the slower JavaScript-only fallback (ExpoGoCryptoAdapter)
   */
  public readonly isUsingNativeCrypto: boolean;

  constructor() {
    // Try react-native-quick-crypto first, fall back to ExpoGoCryptoAdapter
    if (isQuickCryptoAvailable()) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const quickCrypto = require("react-native-quick-crypto");
        this.adapter = new QuickCryptoAdapter(quickCrypto);
        this.isUsingNativeCrypto = true;
        console.log("[MindooDB] Using react-native-quick-crypto (native crypto)");
        return;
      } catch (error) {
        // Fall through to ExpoGoCryptoAdapter
        console.warn("[MindooDB] Failed to initialize react-native-quick-crypto:", error);
      }
    }

    // Fallback to JS-only implementation
    this.adapter = new ExpoGoCryptoAdapter();
    this.isUsingNativeCrypto = false;
    console.warn(
      "[MindooDB] react-native-quick-crypto not available. " +
      "Falling back to JavaScript-only crypto (slower). " +
      "For better performance, create a development build with react-native-quick-crypto."
    );
  }

  /**
   * Get the SubtleCrypto interface
   */
  getSubtle(): SubtleCrypto {
    return this.adapter.getSubtle();
  }

  /**
   * Get random values
   */
  getRandomValues(array: Uint8Array): Uint8Array {
    return this.adapter.getRandomValues(array);
  }
}

/**
 * Factory function to create the ReactNativeCryptoAdapter
 */
export function createCryptoAdapter(): CryptoAdapter {
  return new ReactNativeCryptoAdapter();
}
