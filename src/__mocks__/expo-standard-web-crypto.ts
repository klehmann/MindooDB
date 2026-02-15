/**
 * Mock for expo-standard-web-crypto
 * Uses Node.js crypto for getRandomValues in tests
 */

import crypto from "crypto";

// Export getRandomValues directly for CommonJS compatibility
export function getRandomValues(array: Uint8Array): Uint8Array {
  const randomBytes = crypto.randomBytes(array.length);
  array.set(randomBytes);
  return array;
}

// Also export as default for ESM compatibility
export default {
  getRandomValues,
};
