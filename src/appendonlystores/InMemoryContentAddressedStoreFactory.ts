import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { ContentAddressedStore, ContentAddressedStoreFactory } from "../core/types";

export class InMemoryContentAddressedStoreFactory implements ContentAddressedStoreFactory {
  createStore(dbId: string): ContentAddressedStore {
    return new InMemoryContentAddressedStore(dbId);
  }
}

// Legacy export for backward compatibility
/** @deprecated Use InMemoryContentAddressedStoreFactory instead */
export const InMemoryAppendOnlyStoreFactory = InMemoryContentAddressedStoreFactory;
