// Node.js-specific exports
// Re-exports everything from core plus Node.js-specific implementations

// Re-export all core exports
export * from "../core";

// Node.js-specific crypto adapter
export { NodeCryptoAdapter, createCryptoAdapter } from "./crypto/NodeCryptoAdapter";

// Node.js-specific persistent store implementation
export {
  BasicOnDiskContentAddressedStore,
  BasicOnDiskContentAddressedStoreFactory,
} from "./appendonlystores/BasicOnDiskContentAddressedStore";
