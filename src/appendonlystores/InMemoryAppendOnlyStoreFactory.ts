import { InMemoryAppendOnlyStore } from "../core/appendonlystores/InMemoryAppendOnlyStore";
import { AppendOnlyStore, AppendOnlyStoreFactory } from "../core/types";

export class InMemoryAppendOnlyStoreFactory implements AppendOnlyStoreFactory {
  createStore(dbId: string): AppendOnlyStore {
    return new InMemoryAppendOnlyStore(dbId);
  }
}