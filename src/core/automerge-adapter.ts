/**
 * Platform-specific Automerge adapter for MindooDB
 *
 * - React Native: Uses react-native-automerge-generated (native Rust via UniFFI)
 * - Browser/Node.js: Uses @automerge/automerge/slim (WASM)
 *
 * Both implementations now provide the same WASM-compatible API.
 */

import * as AutomergeWasm from "@automerge/automerge/slim";

// Type for the unified Automerge API
type AutomergeAPI = typeof AutomergeWasm;

// Runtime detection of available Automerge implementation
let Automerge: AutomergeAPI;
let isNative = false;

try {
  // Try to load native Automerge (React Native only)
  // @ts-ignore - Module may not exist on Node.js/Browser
  const nativeModule = require('react-native-automerge-generated');

  if (nativeModule?.Automerge) {
    // Use the WASM-compatible API from react-native-automerge-generated
    Automerge = nativeModule.Automerge as AutomergeAPI;
    isNative = true;
    console.log('[MindooDB] ✓ Using native Rust Automerge (react-native-automerge-generated)');
  } else {
    // Module loaded but Automerge API not available
    Automerge = AutomergeWasm;
    console.log('[MindooDB] ⚠ Native module loaded but Automerge API unavailable, using WASM');
  }
} catch (error) {
  // Native module not available (Browser/Node.js)
  Automerge = AutomergeWasm;
  isNative = false;
  console.log('[MindooDB] ℹ Using WASM Automerge (Browser/Node.js mode)');
}

// Export the platform-appropriate implementation
export { Automerge, isNative };
export default Automerge;
