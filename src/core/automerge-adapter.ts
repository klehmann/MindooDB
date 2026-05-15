/**
 * Platform-specific Automerge adapter for MindooDB
 *
 * - React Native: Uses react-native-automerge-generated (native Rust via UniFFI)
 * - Browser/Node.js: Uses @automerge/automerge (WASM)
 *
 * Both implementations now provide the same WASM-compatible API.
 */

import * as AutomergeWasm from "@automerge/automerge";

// Type for the unified Automerge API
type AutomergeAPI = typeof AutomergeWasm;

// Runtime detection of available Automerge implementation
let Automerge: AutomergeAPI;
let isNative = false;

function isReactNativeRuntime() {
  return typeof navigator !== "undefined" && navigator.product === "ReactNative";
}

if (isReactNativeRuntime()) {
  try {
    // Keep the optional native module hidden from browser dependency scanners.
    const nativeModuleName = "react-native-automerge-generated";
    const nativeRequire = typeof require === "function" ? require : undefined;
    const nativeModule = nativeRequire?.(nativeModuleName);

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
    // Native module not available (React Native development without native binding)
    Automerge = AutomergeWasm;
    isNative = false;
    console.log('[MindooDB] ℹ Using WASM Automerge (Browser/Node.js mode)');
  }
} else {
  // Browser/Node.js
  Automerge = AutomergeWasm;
  isNative = false;
  console.log('[MindooDB] ℹ Using WASM Automerge (Browser/Node.js mode)');
}

// Export the platform-appropriate implementation
export { Automerge, isNative };
export default Automerge;
