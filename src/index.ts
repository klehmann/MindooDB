// Main entry point - auto-detects platform and exports appropriate implementation
// For explicit platform imports, use:
//   import { ... } from 'mindoodb/browser' (browser-specific)
//   import { ... } from 'mindoodb/node' (Node.js-specific)

// Re-export everything from core
export * from "./core";

// Re-export the Base* classes from their original locations
// (these will be moved to core in a future refactor)
export { BaseMindooDB } from "./core/BaseMindooDB";
export { BaseMindooTenant } from "./core/BaseMindooTenant";
export { BaseMindooTenantFactory } from "./core/BaseMindooTenantFactory";

// Re-export platform-specific adapters with auto-detection
// For Node.js environments
export { NodeCryptoAdapter, createCryptoAdapter } from "./node/crypto/NodeCryptoAdapter";
// For browser environments, users should import from 'mindoodb/browser'
export { BrowserCryptoAdapter } from "./browser/crypto/BrowserCryptoAdapter";
