import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { ContentAddressedStoreFactory, CreateStoreResult, OpenStoreOptions, StoreKind } from "../core/types";

export class InMemoryContentAddressedStoreFactory implements ContentAddressedStoreFactory {
  createStore(dbId: string, options?: OpenStoreOptions): CreateStoreResult {
    return {
      docStore: new InMemoryContentAddressedStore(dbId, StoreKind.docs, undefined, options),
      attachmentStore: new InMemoryContentAddressedStore(
        dbId,
        StoreKind.attachments,
        undefined,
        options,
      ),
    };
  }
}
