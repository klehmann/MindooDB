/**
 * File-backed {@link PurgedDocRegistry}, for code that holds a path rather
 * than a {@link ServerDataStore} (tools and tests).
 */

import { basename, dirname } from "path";

import { PurgedDocRegistry as DataStorePurgedDocRegistry } from "../../server/PurgedDocRegistry";
import { FsServerDataStore } from "./FsServerDataStore";

export class PurgedDocRegistry extends DataStorePurgedDocRegistry {
  constructor(filePath: string) {
    super(new FsServerDataStore(dirname(filePath)), basename(filePath));
  }
}
