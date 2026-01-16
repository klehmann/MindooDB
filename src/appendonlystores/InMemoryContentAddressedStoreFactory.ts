import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { ContentAddressedStoreFactory, CreateStoreResult, OpenStoreOptions } from "../core/types";

export class InMemoryContentAddressedStoreFactory implements ContentAddressedStoreFactory {
  createStore(dbId: string, _options?: OpenStoreOptions): CreateStoreResult {
    // For in-memory stores, we use a single store for both documents and attachments
    // (no separate attachment store needed for simple/test scenarios)
    // Note: options are ignored for in-memory stores but accepted for interface compatibility
    return {
      docStore: new InMemoryContentAddressedStore(dbId),
      // attachmentStore not provided - will use docStore for attachments
    };
  }
}
