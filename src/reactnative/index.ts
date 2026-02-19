// React Native-specific exports
// Re-exports everything from core plus React Native-specific implementations

// Re-export all core exports
export * from "../core/index";

// Re-export Base* classes that aren't in core/index
export { BaseMindooDB } from "../core/BaseMindooDB";
export { BaseMindooTenant } from "../core/BaseMindooTenant";
export { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";

// React Native-specific crypto adapters
export { ReactNativeCryptoAdapter, createCryptoAdapter } from "./crypto/ReactNativeCryptoAdapter";
export { ExpoGoCryptoAdapter } from "./crypto/ExpoGoCryptoAdapter";
export { QuickCryptoAdapter, isQuickCryptoAvailable } from "./crypto/QuickCryptoAdapter";

// React Native-specific cache store
export { MMKVLocalCacheStore, type MMKVInterface, type AsyncStorageInterface } from "./cache/MMKVLocalCacheStore";
