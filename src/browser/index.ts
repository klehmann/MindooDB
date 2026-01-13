// Browser-specific exports
// Re-exports everything from core plus browser-specific implementations

// Re-export all core exports
export * from "../core";

// Browser-specific crypto adapter
export { BrowserCryptoAdapter, createCryptoAdapter } from "./crypto/BrowserCryptoAdapter";
