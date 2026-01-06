import { InMemoryAppendOnlyStore } from "./InMemoryAppendOnlyStore";
import { AppendOnlyStore, AppendOnlyStoreFactory } from "./types";

export class InMemoryAppendOnlyStoreFactory implements AppendOnlyStoreFactory {
  createStore(dbId: string): AppendOnlyStore {
    return new InMemoryAppendOnlyStore(dbId);
  }
}