// Browser-specific exports
// Re-exports everything from core plus browser-specific implementations

// Re-export all core exports
export * from "../core";

// Re-export Base* classes that aren't in core/index
export { BaseMindooDB } from "../core/BaseMindooDB";
export { BaseMindooTenant } from "../core/BaseMindooTenant";
export { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";

// Browser-specific crypto adapter
export { BrowserCryptoAdapter, createCryptoAdapter } from "./crypto/BrowserCryptoAdapter";

// Browser-specific IndexedDB content-addressed store
export { IndexedDBContentAddressedStore } from "./appendonlystores/IndexedDBContentAddressedStore";
export { IndexedDBContentAddressedStoreFactory } from "./appendonlystores/IndexedDBContentAddressedStoreFactory";
