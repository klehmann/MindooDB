import { MissingDependencyError } from "../../errors";
import { generateRandomUuid } from "../../utils/idGeneration";
import { planAttachmentReadByWalkingMetadata } from "../AttachmentReadPlanner";
import { createIdBloomSummary } from "../bloom";
import { computeBatchMaterializationPlan, computeDocumentMaterializationPlan } from "../MaterializationPlanner";
import { scanDocScopedEntries } from "../scanUtils";
import type {
  AttachmentReadPlan,
  AttachmentReadPlanOptions,
  ContentAddressedStore,
  ContentAddressedStoreFactory,
  CreateStoreResult,
  DocumentMaterializationBatchPlan,
  DocumentMaterializationPlan,
  MaterializationPlanOptions,
  OpenStoreOptions,
  StoreHead,
  StoreIdBloomSummary,
  StoreIndexBuildStatus,
  StoreScanCursor,
  StoreScanFilters,
  StoreScanResult,
} from "../types";
import { StoreKind } from "../types";
import type { StoreEntry, StoreEntryMetadata, StoreEntryType } from "../../types";
import { Logger, MindooLogger, getDefaultLogLevel } from "../../logging";
import { createMemorySqliteBackend, type SqliteStoreBackend } from "./SqliteDriver";
import { base64ToBytes, bytesToBase64 } from "../../utils/base64";


function serializeMetadata(meta: StoreEntryMetadata): string {
  return JSON.stringify({
    ...meta,
    signature: bytesToBase64(meta.signature),
    metadataSignature: meta.metadataSignature ? bytesToBase64(meta.metadataSignature) : undefined,
  });
}

function deserializeMetadata(json: string): StoreEntryMetadata {
  const parsed = JSON.parse(json) as StoreEntryMetadata & { signature: string; metadataSignature?: string };
  return {
    ...parsed,
    signature: base64ToBytes(parsed.signature),
    metadataSignature: parsed.metadataSignature ? base64ToBytes(parsed.metadataSignature) : undefined,
  };
}

/**
 * Persistent ContentAddressedStore backed by SQLite-shaped tables.
 * Not imported by `mindoodb/browser`.
 */
export class SqliteContentAddressedStore implements ContentAddressedStore {
  private ready: Promise<void>;
  private nextReceiptOrder = 1;
  private storeEpoch = generateRandomUuid();
  private readonly logger: Logger;
  private readonly indexingEnabled: boolean;

  constructor(
    private readonly dbId: string,
    private readonly storeKind: StoreKind,
    private readonly backend: SqliteStoreBackend,
    logger?: Logger,
    options?: OpenStoreOptions,
  ) {
    this.logger = logger || new MindooLogger(getDefaultLogLevel(), `SqliteStore:${dbId}:${storeKind}`, true);
    this.indexingEnabled = options?.indexingEnabled !== false;
    this.ready = this.bootstrap(options);
  }

  private async bootstrap(options?: OpenStoreOptions): Promise<void> {
    await this.backend.init();
    if (options?.clearLocalDataOnStartup) {
      await this.backend.clearAll();
    }
    const epoch = await this.backend.getMeta("epoch");
    const next = await this.backend.getMeta("nextReceiptOrder");
    if (epoch) {
      this.storeEpoch = epoch;
    } else {
      await this.backend.setMeta("epoch", this.storeEpoch);
    }
    this.nextReceiptOrder = next ? Number(next) : 1;
  }

  private async persistCounters(): Promise<void> {
    await this.backend.setMeta("epoch", this.storeEpoch);
    await this.backend.setMeta("nextReceiptOrder", String(this.nextReceiptOrder));
  }

  getId(): string {
    return this.dbId;
  }

  getStoreKind(): StoreKind {
    return this.storeKind;
  }

  getCacheIdentity(): string {
    return `sqlite:${this.dbId}:${this.storeKind}`;
  }

  async putEntries(entries: StoreEntry[]): Promise<void> {
    await this.ready;
    if (entries.length > 0) {
      await this.backend.transaction(() => this.insertNewEntries(entries));
    }
  }

  /** One transaction per batch, one existence query for all ids. */
  private async insertNewEntries(entries: StoreEntry[]): Promise<void> {
    const present = new Set(await this.backend.hasEntries(entries.map((entry) => entry.id)));
    const fresh: StoreEntry[] = [];
    for (const entry of entries) {
      if (!present.has(entry.id)) {
        present.add(entry.id);
        fresh.push(entry);
      }
    }
    if (fresh.length === 0) {
      return;
    }
    // Reserve the receipt orders before writing: should the batch not commit
    // as a whole (see SqlBackendOptions.externalContent), an interrupted batch
    // leaves a gap in the sequence, never two entries with one order.
    let receiptOrder = this.nextReceiptOrder;
    this.nextReceiptOrder += fresh.length;
    await this.persistCounters();
    for (const entry of fresh) {
      const { encryptedData, receiptOrder: _ignored, ...rest } = entry;
      const metadata: StoreEntryMetadata = {
        ...rest,
        receiptOrder: receiptOrder++,
      };
      await this.backend.insertEntry(
        serializeMetadata(metadata),
        encryptedData,
        entry.contentHash,
        entry.docId,
        entry.entryType,
        entry.createdAt,
        metadata.receiptOrder ?? 0,
        entry.id,
      );
    }
  }

  async applyWitnessReceipts(receipts: StoreEntryMetadata[]): Promise<void> {
    await this.ready;
    await this.backend.transaction(() => this.updateReceipts(receipts));
  }

  private async updateReceipts(receipts: StoreEntryMetadata[]): Promise<void> {
    for (const receipt of receipts) {
      if (receipt.receivedAt === undefined) {
        continue;
      }
      const json = await this.backend.getMetadataJson(receipt.id);
      if (!json) {
        continue;
      }
      const existing = deserializeMetadata(json);
      if (
        existing.receivedAt === receipt.receivedAt &&
        existing.receivedByPublicKey === receipt.receivedByPublicKey
      ) {
        continue;
      }
      const next: StoreEntryMetadata = {
        ...existing,
        receivedAt: receipt.receivedAt,
        receivedByPublicKey: receipt.receivedByPublicKey,
        receivedDateSignature: receipt.receivedDateSignature,
        receiptScheme: receipt.receiptScheme,
        receiptOrder: this.nextReceiptOrder++,
      };
      await this.backend.updateEntryMeta(receipt.id, serializeMetadata(next), next.receiptOrder ?? 0);
    }
    await this.persistCounters();
  }

  async getEntries(ids: string[]): Promise<StoreEntry[]> {
    await this.ready;
    const rows = new Map((await this.backend.getEntryRows(ids)).map((row) => [row.id, row]));
    const result: StoreEntry[] = [];
    for (const id of ids) {
      const row = rows.get(id);
      if (row) {
        result.push({ ...deserializeMetadata(row.metaJson), encryptedData: row.data });
      }
    }
    return result;
  }

  async getEntryMetadata(id: string): Promise<StoreEntryMetadata | null> {
    await this.ready;
    const json = await this.backend.getMetadataJson(id);
    return json ? deserializeMetadata(json) : null;
  }

  async planAttachmentReadByWalkingMetadata(
    lastChunkId: string,
    attachmentSize: number,
    options: AttachmentReadPlanOptions,
  ): Promise<AttachmentReadPlan> {
    return planAttachmentReadByWalkingMetadata(this, lastChunkId, attachmentSize, options);
  }

  async hasEntries(ids: string[]): Promise<string[]> {
    await this.ready;
    const present = new Set(await this.backend.hasEntries(ids));
    return ids.filter((id) => present.has(id));
  }

  async findNewEntries(knownIds: string[]): Promise<StoreEntryMetadata[]> {
    await this.ready;
    const known = new Set(knownIds);
    return (await this.allMetadata()).filter((meta) => !known.has(meta.id));
  }

  async findNewEntriesForDoc(knownIds: string[], docId: string): Promise<StoreEntryMetadata[]> {
    await this.ready;
    const known = new Set(knownIds);
    return (await this.metadataForDoc(docId)).filter((meta) => !known.has(meta.id));
  }

  async findEntries(
    type: StoreEntryType,
    creationDateFrom: number | null,
    creationDateUntil: number | null,
  ): Promise<StoreEntryMetadata[]> {
    await this.ready;
    return (await this.allMetadata()).filter((metadata) => {
      if (metadata.entryType !== type) {
        return false;
      }
      if (creationDateFrom !== null && metadata.createdAt < creationDateFrom) {
        return false;
      }
      if (creationDateUntil !== null && metadata.createdAt >= creationDateUntil) {
        return false;
      }
      return true;
    });
  }

  async getAllIds(): Promise<string[]> {
    await this.ready;
    return this.backend.getAllIds();
  }

  async scanEntriesSince(
    cursor: StoreScanCursor | null,
    limit: number = Number.MAX_SAFE_INTEGER,
    filters?: StoreScanFilters,
  ): Promise<StoreScanResult> {
    await this.ready;
    if (filters?.docId) {
      return scanDocScopedEntries(await this.metadataForDoc(filters.docId), cursor, limit, filters);
    }
    const page: StoreEntryMetadata[] = [];
    let scanCursor = cursor;
    const batch = Math.min(Math.max(limit, 1), 500);
    while (page.length < limit) {
      const rows = await this.backend.scanMetadataJson(
        scanCursor?.receiptOrder ?? null,
        scanCursor?.id ?? null,
        batch,
      );
      if (rows.length === 0) {
        break;
      }
      for (const json of rows) {
        const meta = deserializeMetadata(json);
        if (this.matchesScanFilters(meta, filters)) {
          page.push(meta);
          if (page.length >= limit) {
            break;
          }
        }
      }
      const lastRaw = deserializeMetadata(rows[rows.length - 1]);
      scanCursor = { receiptOrder: lastRaw.receiptOrder ?? 0, id: lastRaw.id };
      if (rows.length < batch) {
        break;
      }
    }
    const last = page.length > 0 ? page[page.length - 1] : null;
    let hasMore = false;
    if (last) {
      const peek = await this.backend.scanMetadataJson(last.receiptOrder ?? 0, last.id, 32);
      hasMore = peek.some((json) => this.matchesScanFilters(deserializeMetadata(json), filters));
    }
    return {
      entries: page,
      nextCursor: last ? { receiptOrder: last.receiptOrder ?? 0, id: last.id } : cursor,
      hasMore,
    };
  }

  async getIdBloomSummary(): Promise<StoreIdBloomSummary> {
    return createIdBloomSummary(await this.getAllIds());
  }

  async getStoreHead(): Promise<StoreHead> {
    await this.ready;
    return { epoch: this.storeEpoch, maxReceiptOrder: this.nextReceiptOrder - 1 };
  }

  async planDocumentMaterialization(
    docId: string,
    options?: MaterializationPlanOptions,
  ): Promise<DocumentMaterializationPlan> {
    await this.ready;
    return computeDocumentMaterializationPlan(docId, await this.metadataForDoc(docId), options);
  }

  async planDocumentMaterializationBatch(
    docIds: string[],
    options?: MaterializationPlanOptions,
  ): Promise<DocumentMaterializationBatchPlan> {
    await this.ready;
    return computeBatchMaterializationPlan(await this.allMetadata(), docIds, options);
  }

  async resolveDependencies(startId: string, options?: Record<string, unknown>): Promise<string[]> {
    await this.ready;
    const stopAtEntryType = options?.stopAtEntryType as string | undefined;
    const maxDepth = options?.maxDepth as number | undefined;
    const includeStart = options?.includeStart !== false;
    const result: string[] = [];
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number; from: string | null }> = [{ id: startId, depth: 0, from: null }];
    let queueIdx = 0;
    while (queueIdx < queue.length) {
      const { id, depth, from } = queue[queueIdx++];
      if (visited.has(id)) {
        continue;
      }
      visited.add(id);
      if (maxDepth !== undefined && depth > maxDepth) {
        continue;
      }
      const entry = await this.getEntryMetadata(id);
      if (!entry) {
        throw new MissingDependencyError({
          startId,
          missingId: id,
          referencedBy: from,
          depth,
          resolvedCount: result.length,
        });
      }
      if (stopAtEntryType && entry.entryType === stopAtEntryType && id !== startId) {
        result.push(id);
        continue;
      }
      if (id !== startId || includeStart) {
        result.push(id);
      }
      for (const depId of entry.dependencyIds) {
        if (!visited.has(depId)) {
          queue.push({ id: depId, depth: depth + 1, from: id });
        }
      }
    }
    result.reverse();
    return result;
  }

  async purgeDocHistory(docId: string): Promise<void> {
    await this.ready;
    const ids = (await this.metadataForDoc(docId)).map((meta) => meta.id);
    await this.backend.transaction(() => this.backend.deleteEntries(ids));
  }

  /**
   * Deletes the chunks of one attachment (local copies only; append-only
   * stores elsewhere keep them). Same selection as the IndexedDB store: chunk
   * entries of `docId` with that attachment id, or with the chunk-id prefix of
   * attachments written before chunks carried their attachment id.
   */
  async deleteEntriesForAttachment(docId: string, attachmentId: string): Promise<number> {
    await this.ready;
    const prefix = `${docId}_a_${attachmentId}_`;
    const ids = (await this.metadataForDoc(docId))
      .filter(
        (meta) =>
          meta.entryType === "attachment_chunk" &&
          (meta.attachmentId === attachmentId || meta.id.startsWith(prefix)),
      )
      .map((meta) => meta.id);
    if (ids.length === 0) {
      return 0;
    }
    return this.backend.transaction(() => this.backend.deleteEntries(ids));
  }

  async deleteEntriesById(entryIds: string[]): Promise<number> {
    await this.ready;
    return this.backend.transaction(() => this.backend.deleteEntries(entryIds));
  }

  async clearAllLocalData(): Promise<void> {
    await this.ready;
    await this.backend.clearAll();
    this.nextReceiptOrder = 1;
    this.storeEpoch = generateRandomUuid();
    await this.persistCounters();
  }

  async awaitIndexReady(): Promise<StoreIndexBuildStatus> {
    return this.getIndexBuildStatus();
  }

  getIndexBuildStatus(): StoreIndexBuildStatus {
    return { phase: "ready", indexingEnabled: this.indexingEnabled, progress01: 1 };
  }

  async getStats(): Promise<{ entryCount: number; contentCount: number; docCount: number }> {
    await this.ready;
    return {
      entryCount: await this.backend.countEntries(),
      contentCount: await this.backend.countContent(),
      docCount: await this.backend.countDocs(),
    };
  }

  private async allMetadata(): Promise<StoreEntryMetadata[]> {
    return (await this.backend.getAllMetadataJson()).map(deserializeMetadata);
  }

  private async metadataForDoc(docId: string): Promise<StoreEntryMetadata[]> {
    return (await this.backend.getMetadataJsonByDoc(docId)).map(deserializeMetadata);
  }

  private matchesScanFilters(meta: StoreEntryMetadata, filters?: StoreScanFilters): boolean {
    if (filters?.docId && meta.docId !== filters.docId) {
      return false;
    }
    if (filters?.entryTypes && filters.entryTypes.length > 0 && !filters.entryTypes.includes(meta.entryType)) {
      return false;
    }
    if (filters?.creationDateFrom != null && meta.createdAt < filters.creationDateFrom) {
      return false;
    }
    if (filters?.creationDateUntil != null && meta.createdAt >= filters.creationDateUntil) {
      return false;
    }
    return true;
  }
}

export class SqliteContentAddressedStoreFactory implements ContentAddressedStoreFactory {
  constructor(
    private readonly createBackend: (dbId: string, kind: StoreKind) => SqliteStoreBackend = () =>
      createMemorySqliteBackend(),
  ) {}

  createStore(dbId: string, options?: OpenStoreOptions): CreateStoreResult {
    return {
      docStore: new SqliteContentAddressedStore(
        dbId,
        StoreKind.docs,
        this.createBackend(dbId, StoreKind.docs),
        undefined,
        options,
      ),
      attachmentStore: new SqliteContentAddressedStore(
        dbId,
        StoreKind.attachments,
        this.createBackend(dbId, StoreKind.attachments),
        undefined,
        options,
      ),
    };
  }
}
