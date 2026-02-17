/**
 * Node.js filesystem-backed implementation of {@link ContentAddressedStore}.
 *
 * This module provides a persistent, crash-resilient content-addressed store
 * designed for the MindooDB sync protocol.  Each database gets its own
 * directory subtree where entry metadata (JSON) and encrypted payloads (binary)
 * are stored as individual files.  An optional in-memory index accelerates
 * lookups, cursor-based scans, and bloom-filter generation for efficient
 * network sync.
 *
 * ### On-disk layout
 *
 * ```
 * <basePath>/<dbId>/
 *   entries/                  one JSON file per entry id (source of truth)
 *   content/                  one .bin file per unique contentHash
 *   metadata-index.json       compact snapshot of the in-memory index
 *   metadata-segments/        append-only mutation log (upsert / delete)
 * ```
 *
 * ### Durability & crash safety
 *
 * Every file write follows a write-tmp → fsync → atomic-rename → dir-fsync
 * protocol so readers never observe partially written data.  Metadata segments
 * provide a low-write-amplification WAL that is periodically compacted into a
 * full snapshot.
 *
 * ### Indexing
 *
 * When `indexingEnabled` is true (the default), the store maintains three
 * in-memory structures:
 *   - `entries` — Map<id, metadata> for O(1) point lookups
 *   - `docIndex` — Map<docId, Set<id>> for fast per-document queries
 *   - `orderedMetadata` — sorted array for O(log N) cursor scans
 *
 * On startup the index is reconstructed from (snapshot + segments), then
 * validated against the authoritative entry files.
 *
 * @module BasicOnDiskContentAddressedStore
 */

import { mkdir, readdir, readFile, rm, access, rename, unlink, open, stat } from "fs/promises";
import { constants as fsConstants } from "fs";
import * as path from "path";
import {
  ContentAddressedStore,
  ContentAddressedStoreFactory,
  CreateStoreResult,
  OpenStoreOptions,
  StoreIndexBuildStatus,
  StoreCompactionStatus,
  AwaitIndexReadyOptions,
  StoreScanCursor,
  StoreScanFilters,
  StoreScanResult,
  StoreIdBloomSummary,
} from "../../core/appendonlystores/types";
import { createIdBloomSummary } from "../../core/appendonlystores/bloom";
import type { StoreEntry, StoreEntryMetadata, StoreEntryType } from "../../core/types";
import { Logger, MindooLogger, getDefaultLogLevel } from "../../core/logging";

// ---------------------------------------------------------------------------
// Serialization types
// ---------------------------------------------------------------------------

/**
 * JSON-safe representation of {@link StoreEntryMetadata}.
 *
 * The only difference from the runtime type is that the `signature` field
 * (a `Uint8Array` at runtime) is stored as a base64-encoded string so it
 * can be written directly to JSON files and metadata segments.
 */
interface SerializedStoreEntryMetadata extends Omit<StoreEntryMetadata, "signature"> {
  signature: string; // base64
}

/**
 * A segment record that inserts or updates an entry in the metadata index.
 * Written to append-only segment files after each successful `putEntries`.
 */
interface SerializedMetadataSegmentRecordUpsert {
  op: "upsert";
  metadata: SerializedStoreEntryMetadata;
}

/**
 * A segment record that removes an entry from the metadata index.
 * Written to append-only segment files during `purgeDocHistory`.
 */
interface SerializedMetadataSegmentRecordDelete {
  op: "delete";
  id: string;
}

/**
 * Union of all possible records inside a metadata segment file.
 * Each segment file contains a JSON array of these records.
 */
type SerializedMetadataSegmentRecord =
  | SerializedMetadataSegmentRecordUpsert
  | SerializedMetadataSegmentRecordDelete;

/**
 * When the number of uncompacted segment files reaches this threshold,
 * the store will persist a fresh metadata-index snapshot and delete the
 * covered segment files.  Set to 0 to disable file-count–based compaction.
 */
const DEFAULT_METADATA_SEGMENT_COMPACTION_MIN_FILES = 32;

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/**
 * Convert a runtime {@link StoreEntryMetadata} to its JSON-safe form.
 * The only transformation is encoding the binary `signature` as base64.
 */
function serializeMetadata(metadata: StoreEntryMetadata): SerializedStoreEntryMetadata {
  return {
    ...metadata,
    signature: Buffer.from(metadata.signature).toString("base64"),
  };
}

/**
 * Restore a {@link StoreEntryMetadata} from its JSON-safe serialized form.
 * Decodes the base64 `signature` back into a `Uint8Array`.
 */
function deserializeMetadata(serialized: SerializedStoreEntryMetadata): StoreEntryMetadata {
  return {
    ...serialized,
    signature: new Uint8Array(Buffer.from(serialized.signature, "base64")),
  };
}

// ---------------------------------------------------------------------------
// Filename helpers
// ---------------------------------------------------------------------------

/**
 * Derive the on-disk filename for an entry's metadata file.
 * The entry id is URI-encoded so it is safe for any filesystem.
 */
function toEntryFileName(id: string): string {
  return `${encodeURIComponent(id)}.json`;
}

/**
 * Recover an entry id from its on-disk metadata filename.
 * Reverses the encoding applied by {@link toEntryFileName}.
 */
function fromEntryFileName(fileName: string): string {
  const withoutExt = fileName.endsWith(".json") ? fileName.slice(0, -5) : fileName;
  return decodeURIComponent(withoutExt);
}

/**
 * Generate a temporary file path for atomic writes.
 *
 * The suffix includes the process PID, current timestamp, and a random token
 * to avoid collisions when multiple processes or rapid sequential writes
 * target the same final path.
 */
function tempPathFor(finalPath: string): string {
  return `${finalPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Node.js persistent ContentAddressedStore implementation.
 *
 * On-disk layout per database id:
 *
 *   <basePath>/<dbId>/
 *     entries/                // one metadata JSON file per entry id
 *     content/                // one binary payload file per contentHash
 *     metadata-index.json     // compact snapshot of ordered metadata (optional)
 *     metadata-segments/      // append-only metadata mutation log (optional)
 *
 * Design goals:
 * - Strong visibility: readers only observe committed files (atomic rename).
 * - Crash resilience: fsync + rename + directory fsync for durability.
 * - High sync/read throughput: in-memory ordered index + cursor scan.
 * - Low write amplification: append metadata segments, compact periodically.
 */
export class BasicOnDiskContentAddressedStore implements ContentAddressedStore {
  // ---------------------------------------------------------------------------
  // Configuration (immutable after construction)
  // ---------------------------------------------------------------------------

  /** Unique database identifier; used as the top-level directory name. */
  private readonly dbId: string;

  /** Logger scoped to this store instance. */
  private readonly logger: Logger;

  /** Root directory for this database: `<basePath>/<dbId>`. */
  private readonly storeRoot: string;

  /** Directory containing one JSON metadata file per entry id. */
  private readonly entriesDir: string;

  /** Directory containing one `.bin` payload file per unique contentHash. */
  private readonly contentDir: string;

  /** Path to the compact metadata-index snapshot file. */
  private readonly metadataIndexPath: string;

  /** Directory containing append-only metadata segment files. */
  private readonly metadataSegmentsDir: string;

  /** Whether in-memory indexing is active (default true). */
  private readonly indexingEnabled: boolean;

  /** Trigger compaction when this many segment files have accumulated. */
  private readonly metadataSegmentCompactionMinFiles: number;

  /** Trigger compaction when segment files exceed this total byte size. */
  private readonly metadataSegmentCompactionMaxBytes: number;

  /**
   * Set of segment file names that have been replayed into the in-memory
   * index (or were appended by this process).  Only these files are eligible
   * for compaction — files that appeared concurrently from another process
   * are excluded until they have been replayed.
   */
  private readonly appliedMetadataSegmentFiles = new Set<string>();

  /** Cumulative compaction statistics exposed via {@link getCompactionStatus}. */
  private compactionStatus: StoreCompactionStatus;

  // ---------------------------------------------------------------------------
  // Async initialization
  // ---------------------------------------------------------------------------

  /**
   * Resolves once the store directories exist and the in-memory index has been
   * built.  Every public method awaits this promise before proceeding.
   */
  private initPromise: Promise<void>;

  // ---------------------------------------------------------------------------
  // In-memory indexes (populated only when indexingEnabled = true)
  // ---------------------------------------------------------------------------

  /**
   * Primary index: entry id -> full metadata.
   * Provides O(1) point lookups for `hasEntries`, `getEntries`,
   * `readMetadataById`, and dependency traversal.
   */
  private entries = new Map<string, StoreEntryMetadata>();

  /**
   * Secondary index: docId -> set of entry ids belonging to that document.
   * Enables fast per-document queries in `findNewEntriesForDoc`.
   */
  private docIndex = new Map<string, Set<string>>();

  /**
   * Reference count per content hash.  Tracks how many entry ids share the
   * same payload blob, used during `purgeDocHistory` to decide whether a
   * content file can be safely deleted.
   */
  private contentRefCount = new Map<string, number>();

  /**
   * All metadata sorted by `(createdAt ASC, id ASC)`.
   * Supports O(log N) lower-bound binary search for cursor-based scans
   * in {@link scanEntriesSince}.
   */
  private orderedMetadata: StoreEntryMetadata[] = [];

  /** Current phase and progress of the index build (building / ready). */
  private indexStatus: StoreIndexBuildStatus;

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  /**
   * Create a new on-disk content-addressed store for the given database id.
   *
   * Initialization (directory creation, index loading) happens asynchronously.
   * All public methods internally await the init promise so callers do not
   * need to wait explicitly — but {@link awaitIndexReady} can be used to
   * observe progress.
   *
   * @param dbId     Unique database identifier (becomes the directory name).
   * @param logger   Optional logger; a default console logger is created if omitted.
   * @param options  Store configuration (base path, indexing, compaction thresholds, etc.).
   */
  constructor(dbId: string, logger?: Logger, options?: OpenStoreOptions) {
    this.dbId = dbId;
    this.logger =
      logger ||
      new MindooLogger(getDefaultLogLevel(), `BasicOnDiskStore:${dbId}`, true);
    this.storeRoot = path.join(options?.basePath?.toString() || ".mindoodb-store", dbId);
    this.entriesDir = path.join(this.storeRoot, "entries");
    this.contentDir = path.join(this.storeRoot, "content");
    this.metadataIndexPath = path.join(this.storeRoot, "metadata-index.json");
    this.metadataSegmentsDir = path.join(this.storeRoot, "metadata-segments");
    this.indexingEnabled = options?.indexingEnabled !== false;
    const compactionOption = options?.metadataSegmentCompactionMinFiles;
    this.metadataSegmentCompactionMinFiles =
      compactionOption === undefined || compactionOption === null
        ? DEFAULT_METADATA_SEGMENT_COMPACTION_MIN_FILES
        : Math.max(0, Math.floor(Number(compactionOption)));
    const compactionMaxBytesOption = options?.metadataSegmentCompactionMaxBytes;
    this.metadataSegmentCompactionMaxBytes =
      compactionMaxBytesOption === undefined || compactionMaxBytesOption === null
        ? 0
        : Math.max(0, Math.floor(Number(compactionMaxBytesOption)));
    this.compactionStatus = {
      enabled:
        this.indexingEnabled &&
        (this.metadataSegmentCompactionMinFiles > 0 || this.metadataSegmentCompactionMaxBytes > 0),
      compactionMinFiles: this.metadataSegmentCompactionMinFiles,
      compactionMaxBytes: this.metadataSegmentCompactionMaxBytes,
      totalCompactions: 0,
      totalCompactedFiles: 0,
      totalCompactedBytes: 0,
      totalCompactionDurationMs: 0,
      lastCompactionAt: null,
      lastCompactedFiles: 0,
      lastCompactedBytes: 0,
      lastCompactionDurationMs: 0,
    };
    this.indexStatus = {
      phase: this.indexingEnabled ? "building" : "ready",
      indexingEnabled: this.indexingEnabled,
      progress01: this.indexingEnabled ? 0 : 1,
    };

    this.initPromise = this.initialize(options);
  }

  /**
   * One-time async initialization performed in the constructor's microtask.
   *
   * Steps:
   * 1. Optionally wipe all local data (if `clearLocalDataOnStartup`).
   * 2. Ensure on-disk directory structure exists.
   * 3. When indexing is enabled:
   *    a. Attempt to load the persisted metadata-index snapshot (fast path).
   *    b. Replay any append-only segment files written since the snapshot.
   *    c. Validate the resulting in-memory index against the authoritative
   *       entry files on disk.
   *    d. If validation fails (stale snapshot, corruption, etc.), do a full
   *       rebuild from the entry files and write a fresh snapshot.
   */
  private async initialize(options?: OpenStoreOptions): Promise<void> {
    if (options?.clearLocalDataOnStartup) {
      await this.clearAllLocalDataInternal();
    }

    await mkdir(this.entriesDir, { recursive: true });
    await mkdir(this.contentDir, { recursive: true });
    await mkdir(this.metadataSegmentsDir, { recursive: true });

    if (!this.indexingEnabled) {
      this.indexStatus = {
        phase: "ready",
        indexingEnabled: false,
        progress01: 1,
      };
      return;
    }

    // Startup path:
    // 1) load snapshot (fast path)
    // 2) replay append-only segments (apply recent mutations)
    // 3) validate against authoritative entry files
    // 4) rebuild from entry files when snapshot/segments are stale/corrupt
    await this.tryLoadPersistedIndex();
    await this.replayMetadataSegments();
    const indexCoverageOk = await this.validatePersistedIndexCoverage();
    if (!indexCoverageOk) {
      await this.rebuildInMemoryIndexes();
      await this.persistMetadataIndex();
      await this.clearMetadataSegments(Array.from(this.appliedMetadataSegmentFiles));
    }
    this.indexStatus = {
      phase: "ready",
      indexingEnabled: true,
      progress01: 1,
    };
  }

  /** Block until async initialization has completed. Called by every public method. */
  private async ensureInitialized(): Promise<void> {
    await this.initPromise;
  }

  /**
   * Unconditionally remove the entire store directory tree and reset all
   * in-memory state.  Called by the constructor when `clearLocalDataOnStartup`
   * is set, and by {@link clearAllLocalData} at runtime.
   */
  private async clearAllLocalDataInternal(): Promise<void> {
    await rm(this.storeRoot, { recursive: true, force: true });
    this.entries.clear();
    this.docIndex.clear();
    this.contentRefCount.clear();
    this.orderedMetadata = [];
    this.appliedMetadataSegmentFiles.clear();
  }

  /**
   * Full index rebuild from the authoritative entry files on disk.
   *
   * Clears all in-memory structures, reads every `entries/*.json` file,
   * populates the primary, secondary, and ref-count indexes, and finally
   * sorts `orderedMetadata` by `(createdAt, id)`.
   *
   * This is the slowest startup path (O(N) filesystem reads) and is only
   * used when the persisted snapshot + segments cannot be validated.
   */
  private async rebuildInMemoryIndexes(): Promise<void> {
    this.entries.clear();
    this.docIndex.clear();
    this.contentRefCount.clear();
    this.orderedMetadata = [];

    const files = await this.listEntryFiles();
    for (const fileName of files) {
      const metadata = await this.readMetadataByFileName(fileName);
      if (!metadata) {
        continue;
      }

      this.entries.set(metadata.id, metadata);
      if (!this.docIndex.has(metadata.docId)) {
        this.docIndex.set(metadata.docId, new Set());
      }
      this.docIndex.get(metadata.docId)!.add(metadata.id);
      this.contentRefCount.set(
        metadata.contentHash,
        (this.contentRefCount.get(metadata.contentHash) || 0) + 1
      );
      this.orderedMetadata.push(metadata);
    }
    this.orderedMetadata.sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt - b.createdAt));
  }

  /**
   * Attempt to hydrate the in-memory index from the persisted
   * `metadata-index.json` snapshot.
   *
   * This is the fast startup path: a single file read replaces the need to
   * enumerate and parse every individual entry file.
   *
   * @returns `true` if the snapshot was loaded successfully; `false` if it
   *          does not exist or could not be parsed (caller should fall back
   *          to a full rebuild).
   */
  private async tryLoadPersistedIndex(): Promise<boolean> {
    if (!(await this.fileExists(this.metadataIndexPath))) {
      return false;
    }

    try {
      const raw = await readFile(this.metadataIndexPath, "utf-8");
      const serialized = JSON.parse(raw) as SerializedStoreEntryMetadata[];
      const loaded = serialized.map((s) => deserializeMetadata(s));
      this.entries.clear();
      this.docIndex.clear();
      this.contentRefCount.clear();
      this.orderedMetadata = [];

      for (const metadata of loaded) {
        this.entries.set(metadata.id, metadata);
        if (!this.docIndex.has(metadata.docId)) {
          this.docIndex.set(metadata.docId, new Set());
        }
        this.docIndex.get(metadata.docId)!.add(metadata.id);
        this.contentRefCount.set(
          metadata.contentHash,
          (this.contentRefCount.get(metadata.contentHash) || 0) + 1
        );
        this.orderedMetadata.push(metadata);
      }
      return true;
    } catch (err) {
      this.logger.warn(`Failed to load metadata index, rebuilding from entry files: ${String(err)}`);
      return false;
    }
  }

  /**
   * Validate that the in-memory index (loaded from snapshot + segments)
   * is consistent with the authoritative entry files on disk.
   *
   * Checks two invariants:
   * 1. The number of entry files matches `this.entries.size`.
   * 2. Every entry file's id exists in the in-memory map.
   *
   * This is a cheap O(N) directory listing + set-membership check (no file
   * reads) that catches stale snapshots, missing segments, and external
   * mutations that happened while the process was down.
   *
   * @returns `true` if the index fully covers the on-disk entries.
   */
  private async validatePersistedIndexCoverage(): Promise<boolean> {
    if (!this.indexingEnabled) {
      return true;
    }

    // The entry files are the source of truth.
    // Snapshot+segments are only an acceleration structure.
    const files = await this.listEntryFiles();
    if (files.length !== this.entries.size) {
      return false;
    }

    for (const fileName of files) {
      const entryId = fromEntryFileName(fileName);
      if (!this.entries.has(entryId)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Write a full metadata-index snapshot to disk.
   *
   * Serializes the entire `orderedMetadata` array to `metadata-index.json`
   * using an atomic write.  After this, all segment files that have been
   * replayed into the in-memory state are redundant and can be deleted.
   */
  private async persistMetadataIndex(): Promise<void> {
    if (!this.indexingEnabled) {
      return;
    }
    const serialized = JSON.stringify(this.orderedMetadata.map((m) => serializeMetadata(m)));
    await this.writeFileAtomic(this.metadataIndexPath, serialized);
  }

  /**
   * Delete the given segment files from disk and remove them from the
   * `appliedMetadataSegmentFiles` tracking set.
   *
   * Deletion failures (e.g. race with another process) are silently ignored.
   */
  private async clearMetadataSegments(files: string[]): Promise<void> {
    for (const fileName of files) {
      const filePath = path.join(this.metadataSegmentsDir, fileName);
      await unlink(filePath).catch(() => {
        // Ignore races or already-deleted files.
      });
      this.appliedMetadataSegmentFiles.delete(fileName);
    }
  }

  /**
   * List all `.json` segment files in the segments directory, sorted
   * lexicographically.  Since segment filenames are prefixed with a
   * millisecond timestamp, lexicographic order approximates chronological
   * append order.
   */
  private async listMetadataSegmentFiles(): Promise<string[]> {
    try {
      const files = await readdir(this.metadataSegmentsDir);
      return files.filter((f) => f.endsWith(".json")).sort();
    } catch {
      return [];
    }
  }

  /**
   * Replay all segment files into the in-memory index.
   *
   * Each segment file contains a JSON array of upsert/delete records.
   * They are applied in lexicographic filename order (≈ chronological order)
   * on top of whatever state the snapshot already provided.
   *
   * Successfully replayed files are tracked in `appliedMetadataSegmentFiles`
   * so they become eligible for compaction.  Corrupt or unreadable segment
   * files are warned about and skipped — the subsequent
   * {@link validatePersistedIndexCoverage} step will catch any resulting
   * inconsistencies.
   */
  private async replayMetadataSegments(): Promise<void> {
    // Segments are replayed in lexicographic filename order.
    // Segment names encode timestamp first, so lexical order approximates append order.
    const files = await this.listMetadataSegmentFiles();
    for (const fileName of files) {
      const filePath = path.join(this.metadataSegmentsDir, fileName);
      try {
        const raw = await readFile(filePath, "utf-8");
        const records = JSON.parse(raw) as SerializedMetadataSegmentRecord[];
        for (const record of records) {
          if (record.op === "upsert") {
            const metadata = deserializeMetadata(record.metadata);
            this.applyMetadataUpsert(metadata);
          } else if (record.op === "delete") {
            this.applyMetadataDelete(record.id);
          }
        }
        this.appliedMetadataSegmentFiles.add(fileName);
      } catch (err) {
        this.logger.warn(`Failed to replay metadata segment ${fileName}: ${String(err)}`);
      }
    }
  }

  /**
   * Append a new segment file containing the given mutation records.
   *
   * Segment files act as a lightweight write-ahead log: rather than
   * rewriting the entire metadata-index snapshot on every mutation, we
   * append a small file.  This keeps per-write I/O proportional to the
   * batch size rather than total store size.
   *
   * After writing, triggers {@link maybeCompactMetadataSegments} to check
   * whether the accumulated segments should be folded into a fresh snapshot.
   */
  private async appendMetadataSegment(records: SerializedMetadataSegmentRecord[]): Promise<void> {
    if (!this.indexingEnabled || records.length === 0) {
      return;
    }
    // Name carries time + pid + random suffix to minimize cross-process collisions.
    const segmentName = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.json`;
    const segmentPath = path.join(this.metadataSegmentsDir, segmentName);
    await this.writeFileAtomic(segmentPath, JSON.stringify(records));
    this.appliedMetadataSegmentFiles.add(segmentName);
    await this.maybeCompactMetadataSegments();
  }

  /**
   * Conditionally compact metadata segments when a threshold is exceeded.
   *
   * Two independent thresholds can trigger compaction:
   * - **File count**: the number of applied segment files ≥
   *   `metadataSegmentCompactionMinFiles`.
   * - **Total bytes**: the cumulative size of applied segment files ≥
   *   `metadataSegmentCompactionMaxBytes`.
   *
   * Compaction writes a fresh metadata-index snapshot (which already
   * includes all replayed segment data) and then deletes the covered
   * segment files.  Only files tracked in `appliedMetadataSegmentFiles`
   * are compacted — files written concurrently by another process are
   * left untouched.
   *
   * Compaction statistics are accumulated in `this.compactionStatus`.
   */
  private async maybeCompactMetadataSegments(): Promise<void> {
    if (
      this.metadataSegmentCompactionMinFiles <= 0 &&
      this.metadataSegmentCompactionMaxBytes <= 0
    ) {
      return;
    }
    const allSegmentFiles = await this.listMetadataSegmentFiles();

    // Only compact files we have actually replayed or appended.
    // This avoids deleting a file that appeared concurrently but is not yet represented
    // in our in-memory state/snapshot.
    const compactableFiles = allSegmentFiles.filter((fileName) =>
      this.appliedMetadataSegmentFiles.has(fileName)
    );
    if (compactableFiles.length === 0) {
      return;
    }

    const compactByFileCount =
      this.metadataSegmentCompactionMinFiles > 0 &&
      compactableFiles.length >= this.metadataSegmentCompactionMinFiles;
    const compactableBytes =
      this.metadataSegmentCompactionMaxBytes > 0
        ? await this.computeSegmentFilesTotalBytes(compactableFiles)
        : 0;
    const compactByBytes =
      this.metadataSegmentCompactionMaxBytes > 0 &&
      compactableBytes >= this.metadataSegmentCompactionMaxBytes;
    if (!compactByFileCount && !compactByBytes) {
      return;
    }

    const compactedFiles = compactableFiles.length;
    const compactedBytes =
      compactableBytes > 0 ? compactableBytes : await this.computeSegmentFilesTotalBytes(compactableFiles);
    const startedAt = Date.now();
    // Compaction = materialize full snapshot, then delete covered segments.
    await this.persistMetadataIndex();
    await this.clearMetadataSegments(compactableFiles);
    const durationMs = Date.now() - startedAt;
    this.compactionStatus.totalCompactions += 1;
    this.compactionStatus.totalCompactedFiles += compactedFiles;
    this.compactionStatus.totalCompactedBytes += compactedBytes;
    this.compactionStatus.totalCompactionDurationMs += durationMs;
    this.compactionStatus.lastCompactionAt = Date.now();
    this.compactionStatus.lastCompactedFiles = compactedFiles;
    this.compactionStatus.lastCompactedBytes = compactedBytes;
    this.compactionStatus.lastCompactionDurationMs = durationMs;
  }

  /**
   * Sum the on-disk sizes of the given segment files.
   * Used to evaluate the byte-based compaction threshold.
   * Files that have been deleted between listing and stat are silently skipped.
   */
  private async computeSegmentFilesTotalBytes(files: string[]): Promise<number> {
    let totalBytes = 0;
    for (const fileName of files) {
      const filePath = path.join(this.metadataSegmentsDir, fileName);
      try {
        const stats = await stat(filePath);
        totalBytes += stats.size;
      } catch {
        // Ignore races where a segment vanished after listing.
      }
    }
    return totalBytes;
  }

  // ---------------------------------------------------------------------------
  // In-memory index helpers
  // ---------------------------------------------------------------------------

  /**
   * Compare two metadata entries by the canonical sort key `(createdAt, id)`.
   * Used to maintain and query the `orderedMetadata` sorted array.
   */
  private compareMetadata(a: StoreEntryMetadata, b: StoreEntryMetadata): number {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt - b.createdAt;
    }
    return a.id.localeCompare(b.id);
  }

  /**
   * Binary search for the first index in `orderedMetadata` that is strictly
   * greater than the given cursor position `(createdAt, id)`.
   *
   * Returns 0 when cursor is `null` (start from the beginning).
   * Runs in O(log N) time.
   */
  private lowerBoundForCursor(cursor: StoreScanCursor | null): number {
    if (cursor === null) {
      return 0;
    }
    let left = 0;
    let right = this.orderedMetadata.length;
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      const candidate = this.orderedMetadata[mid];
      const greater =
        candidate.createdAt > cursor.createdAt ||
        (candidate.createdAt === cursor.createdAt && candidate.id > cursor.id);
      if (greater) {
        right = mid;
      } else {
        left = mid + 1;
      }
    }
    return left;
  }

  /**
   * Test whether a metadata entry passes the given scan filters.
   * Evaluates docId, entryTypes whitelist, and creationDate range.
   * Returns `true` when no filters are provided or all checks pass.
   */
  private metadataMatchesFilters(meta: StoreEntryMetadata, filters?: StoreScanFilters): boolean {
    if (filters?.docId && meta.docId !== filters.docId) {
      return false;
    }
    if (filters?.entryTypes && filters.entryTypes.length > 0 && !filters.entryTypes.includes(meta.entryType)) {
      return false;
    }
    if (filters?.creationDateFrom !== undefined && filters.creationDateFrom !== null && meta.createdAt < filters.creationDateFrom) {
      return false;
    }
    if (filters?.creationDateUntil !== undefined && filters.creationDateUntil !== null && meta.createdAt >= filters.creationDateUntil) {
      return false;
    }
    return true;
  }

  /**
   * Insert a metadata entry into `orderedMetadata` at the correct sorted
   * position using binary search + splice.  O(log N) search + O(N) splice.
   */
  private insertOrderedMetadata(meta: StoreEntryMetadata): void {
    let left = 0;
    let right = this.orderedMetadata.length;
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (this.compareMetadata(this.orderedMetadata[mid], meta) < 0) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }
    this.orderedMetadata.splice(left, 0, meta);
  }

  /**
   * Remove an entry from `orderedMetadata` by id.
   * Uses a linear scan; acceptable because removals (purge) are rare.
   */
  private removeOrderedMetadataById(id: string): void {
    const idx = this.orderedMetadata.findIndex((m) => m.id === id);
    if (idx >= 0) {
      this.orderedMetadata.splice(idx, 1);
    }
  }

  /**
   * Remove an entry from all in-memory indexes.
   *
   * Updates `entries`, `docIndex`, `orderedMetadata`, and `contentRefCount`.
   * When the content hash reference count drops to zero, the hash is removed
   * from the ref-count map (the caller is responsible for deleting the
   * on-disk content file if needed).
   */
  private applyMetadataDelete(id: string): void {
    const existing = this.entries.get(id);
    if (!existing) {
      return;
    }
    this.entries.delete(id);
    this.docIndex.get(existing.docId)?.delete(id);
    if ((this.docIndex.get(existing.docId)?.size || 0) === 0) {
      this.docIndex.delete(existing.docId);
    }
    this.removeOrderedMetadataById(id);
    const nextRef = (this.contentRefCount.get(existing.contentHash) || 1) - 1;
    if (nextRef <= 0) {
      this.contentRefCount.delete(existing.contentHash);
    } else {
      this.contentRefCount.set(existing.contentHash, nextRef);
    }
  }

  /**
   * Insert or replace an entry in all in-memory indexes.
   *
   * If the id already exists, the old entry is removed first (via
   * {@link applyMetadataDelete}) before the new one is inserted.
   * Updates `entries`, `docIndex`, `orderedMetadata`, and `contentRefCount`.
   */
  private applyMetadataUpsert(metadata: StoreEntryMetadata): void {
    const existing = this.entries.get(metadata.id);
    if (existing) {
      this.applyMetadataDelete(metadata.id);
    }
    this.entries.set(metadata.id, metadata);
    if (!this.docIndex.has(metadata.docId)) {
      this.docIndex.set(metadata.docId, new Set());
    }
    this.docIndex.get(metadata.docId)!.add(metadata.id);
    this.contentRefCount.set(
      metadata.contentHash,
      (this.contentRefCount.get(metadata.contentHash) || 0) + 1
    );
    this.insertOrderedMetadata(metadata);
  }

  // ---------------------------------------------------------------------------
  // Filesystem I/O helpers
  // ---------------------------------------------------------------------------

  /** List all `.json` files in the `entries/` directory. */
  private async listEntryFiles(): Promise<string[]> {
    try {
      const files = await readdir(this.entriesDir);
      return files.filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
  }

  /** Resolve the absolute path to the metadata file for a given entry id. */
  private metadataPathForId(id: string): string {
    return path.join(this.entriesDir, toEntryFileName(id));
  }

  /** Resolve the absolute path to the binary content file for a given hash. */
  private contentPathForHash(contentHash: string): string {
    return path.join(this.contentDir, `${contentHash}.bin`);
  }

  /** Check whether a file exists without reading its contents. */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Write data to a file with full crash-safety guarantees.
   *
   * Protocol:
   * 1. Write to a temporary file (unique per process + timestamp + random).
   * 2. `fsync` the temp file to flush OS buffers to disk.
   * 3. Atomically `rename` temp → final path (POSIX guarantees atomicity).
   * 4. `fsync` the parent directory so the new directory entry is durable.
   *
   * This ensures readers never observe a partially written file, even after
   * an unclean shutdown.
   */
  private async writeFileAtomic(filePath: string, data: Uint8Array | string): Promise<void> {
    // Durability protocol:
    // 1) write temp file
    // 2) fsync temp file contents
    // 3) atomic rename temp -> final
    // 4) fsync parent directory (persist directory entry update)
    const tmpPath = tempPathFor(filePath);
    const tmpHandle = await open(tmpPath, "w");
    try {
      await tmpHandle.writeFile(data);
      await tmpHandle.sync();
    } finally {
      await tmpHandle.close();
    }
    await rename(tmpPath, filePath);
    await this.syncParentDirectory(filePath);
  }

  /**
   * Fsync the parent directory of a file to ensure its directory entry
   * update is persisted.  Required on POSIX systems after rename/unlink
   * to guarantee that the directory metadata change survives a crash.
   *
   * Failures are logged at debug level and swallowed — some platforms
   * (e.g. certain macOS configurations) do not support opening directories
   * for fsync.
   */
  private async syncParentDirectory(filePath: string): Promise<void> {
    const dirPath = path.dirname(filePath);
    try {
      const dirHandle = await open(dirPath, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch (err) {
      this.logger.debug(`Directory fsync skipped for ${dirPath}: ${String(err)}`);
    }
  }

  /**
   * Look up an entry's metadata by id.
   *
   * When indexing is enabled, this is an O(1) in-memory map lookup.
   * Otherwise, falls back to reading the entry file from disk.
   *
   * @returns The metadata if found, or `null`.
   */
  private async readMetadataById(id: string): Promise<StoreEntryMetadata | null> {
    if (this.indexingEnabled) {
      return this.entries.get(id) || null;
    }

    const filePath = this.metadataPathForId(id);
    if (!(await this.fileExists(filePath))) {
      return null;
    }
    const raw = await readFile(filePath, "utf-8");
    return deserializeMetadata(JSON.parse(raw) as SerializedStoreEntryMetadata);
  }

  /**
   * Read and deserialize a metadata entry directly from its on-disk file.
   * Used during index rebuilds and non-indexed fallback paths.
   * Parse failures are logged and result in `null`.
   */
  private async readMetadataByFileName(fileName: string): Promise<StoreEntryMetadata | null> {
    const filePath = path.join(this.entriesDir, fileName);
    try {
      const raw = await readFile(filePath, "utf-8");
      const metadata = deserializeMetadata(JSON.parse(raw) as SerializedStoreEntryMetadata);
      return metadata;
    } catch (err) {
      this.logger.warn(`Failed to read metadata file ${fileName}: ${String(err)}`);
      return null;
    }
  }

  /**
   * Return all metadata entries in the store.
   *
   * When indexing is enabled, returns a shallow copy of `orderedMetadata`
   * (already sorted).  Otherwise, reads and parses every entry file from
   * disk (unsorted).
   */
  private async listAllMetadata(): Promise<StoreEntryMetadata[]> {
    if (this.indexingEnabled) {
      return [...this.orderedMetadata];
    }
    const files = await this.listEntryFiles();
    const result: StoreEntryMetadata[] = [];
    for (const fileName of files) {
      const metadata = await this.readMetadataByFileName(fileName);
      if (metadata) {
        result.push(metadata);
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // ContentAddressedStore interface — public API
  // ---------------------------------------------------------------------------

  /** Return the database id this store was created for. */
  getId(): string {
    return this.dbId;
  }

  /**
   * Persist one or more entries to disk.
   *
   * For each entry the method:
   * 1. Skips if the metadata file already exists (content-addressed idempotency).
   * 2. Writes the encrypted payload to `content/<hash>.bin` (deduplicated by hash).
   * 3. Writes the metadata to `entries/<id>.json`.
   * 4. Updates the in-memory index and appends a segment record.
   *
   * The commit order (content → metadata → segment) ensures that a crash at
   * any point leaves the store in a consistent state: orphaned content blobs
   * are harmless, and the index can always be rebuilt from the metadata files.
   */
  async putEntries(entries: StoreEntry[]): Promise<void> {
    await this.ensureInitialized();
    let hasMutation = false;
    const segmentRecords: SerializedMetadataSegmentRecord[] = [];

    for (const entry of entries) {
      const metadataPath = this.metadataPathForId(entry.id);

      if (await this.fileExists(metadataPath)) {
        continue;
      }

      // Commit order is intentional:
      // - write payload by content hash first (deduplicated)
      // - write metadata by id second (entry becomes discoverable)
      // - append segment record last (index acceleration catches up)
      const contentPath = this.contentPathForHash(entry.contentHash);
      if (!(await this.fileExists(contentPath))) {
        await this.writeFileAtomic(contentPath, entry.encryptedData);
      }

      const { encryptedData, ...metadata } = entry;
      const serialized = JSON.stringify(serializeMetadata(metadata));
      await this.writeFileAtomic(metadataPath, serialized);
      hasMutation = true;

      if (this.indexingEnabled) {
        this.applyMetadataUpsert(metadata);
        segmentRecords.push({
          op: "upsert",
          metadata: serializeMetadata(metadata),
        });
      }
    }

    if (hasMutation && this.indexingEnabled) {
      await this.appendMetadataSegment(segmentRecords);
    }
  }

  /**
   * Retrieve full entries (metadata + encrypted payload) by id.
   *
   * IDs that are not found or whose content file is missing are silently
   * omitted from the result.  When indexing is enabled, the metadata lookup
   * is O(1); the content read is always a disk I/O.
   */
  async getEntries(ids: string[]): Promise<StoreEntry[]> {
    await this.ensureInitialized();
    const result: StoreEntry[] = [];

    for (const id of ids) {
      const metadata = await this.readMetadataById(id);
      if (!metadata) {
        continue;
      }

      const contentPath = this.contentPathForHash(metadata.contentHash);
      if (!(await this.fileExists(contentPath))) {
        this.logger.warn(`Content ${metadata.contentHash} not found for entry ${id}`);
        continue;
      }

      const encryptedData = new Uint8Array(await readFile(contentPath));
      result.push({ ...metadata, encryptedData });
    }
    return result;
  }

  /**
   * Check which of the given ids exist in the store.
   *
   * When indexing is enabled, this is a fast in-memory set-membership test.
   * Otherwise, it checks for the existence of the corresponding metadata
   * file on disk.
   *
   * @returns The subset of `ids` that are present in the store.
   */
  async hasEntries(ids: string[]): Promise<string[]> {
    await this.ensureInitialized();
    const existing: string[] = [];

    for (const id of ids) {
      if (this.indexingEnabled) {
        if (this.entries.has(id)) {
          existing.push(id);
        }
      } else {
        if (await this.fileExists(this.metadataPathForId(id))) {
          existing.push(id);
        }
      }
    }
    return existing;
  }

  /**
   * Find all entries whose ids are not in `knownIds`.
   *
   * Used during sync to discover entries the caller has not yet seen.
   * Returns metadata only (no payload).
   */
  async findNewEntries(knownIds: string[]): Promise<StoreEntryMetadata[]> {
    await this.ensureInitialized();
    const known = new Set(knownIds);
    const all = await this.listAllMetadata();
    return all.filter((meta) => !known.has(meta.id));
  }

  /**
   * Find entries for a specific document that are not in `knownIds`.
   *
   * When indexing is enabled, leverages the `docIndex` for an O(K) scan
   * (K = entries for this doc) instead of the full store.
   */
  async findNewEntriesForDoc(knownIds: string[], docId: string): Promise<StoreEntryMetadata[]> {
    await this.ensureInitialized();
    const known = new Set(knownIds);

    if (this.indexingEnabled) {
      const ids = this.docIndex.get(docId) || new Set();
      const result: StoreEntryMetadata[] = [];
      for (const id of ids) {
        if (known.has(id)) {
          continue;
        }
        const metadata = this.entries.get(id);
        if (metadata) {
          result.push(metadata);
        }
      }
      return result;
    }

    const all = await this.listAllMetadata();
    return all.filter((meta) => meta.docId === docId && !known.has(meta.id));
  }

  /**
   * Find entries matching a given type and optional creation-date range.
   *
   * @param type              Entry type to filter by (e.g. "doc_change").
   * @param creationDateFrom  Inclusive lower bound (epoch ms), or `null` for no lower bound.
   * @param creationDateUntil Exclusive upper bound (epoch ms), or `null` for no upper bound.
   * @returns Metadata of all matching entries.
   */
  async findEntries(
    type: StoreEntryType,
    creationDateFrom: number | null,
    creationDateUntil: number | null
  ): Promise<StoreEntryMetadata[]> {
    await this.ensureInitialized();
    const all = await this.listAllMetadata();
    return all.filter((meta) => {
      if (meta.entryType !== type) {
        return false;
      }
      if (creationDateFrom !== null && meta.createdAt < creationDateFrom) {
        return false;
      }
      if (creationDateUntil !== null && meta.createdAt >= creationDateUntil) {
        return false;
      }
      return true;
    });
  }

  /**
   * Return all entry ids in the store.
   *
   * When indexing is enabled, returns ids in `(createdAt, id)` order.
   * Without indexing, order depends on the filesystem directory listing.
   */
  async getAllIds(): Promise<string[]> {
    await this.ensureInitialized();
    if (this.indexingEnabled) {
      return this.orderedMetadata.map((m) => m.id);
    }
    const files = await this.listEntryFiles();
    return files.map(fromEntryFileName);
  }

  /**
   * Cursor-based paginated scan over entry metadata.
   *
   * Designed for high-volume synchronization: the caller repeatedly advances
   * a cursor to stream through all entries in deterministic
   * `(createdAt ASC, id ASC)` order, optionally applying filters.
   *
   * **Indexed path** (default):
   * - O(log N) binary search for the cursor position.
   * - O(pageSize) slice for unfiltered scans; O(scan window) for filtered.
   *
   * **Non-indexed fallback**:
   * - Reads and sorts *all* metadata on every call.  Suitable only for
   *   small stores or when indexing is explicitly disabled.
   *
   * @param cursor  Position to resume from (exclusive), or `null` to start
   *                from the beginning.
   * @param limit   Maximum number of entries to return in this page.
   * @param filters Optional filters (docId, entryTypes, date range).
   * @returns A page of metadata entries, the next cursor, and a `hasMore` flag.
   */
  async scanEntriesSince(
    cursor: StoreScanCursor | null,
    limit: number = Number.MAX_SAFE_INTEGER,
    filters?: StoreScanFilters
  ): Promise<StoreScanResult> {
    await this.ensureInitialized();
    if (this.indexingEnabled) {
      // Indexed path: O(logN) lower-bound + O(pageSize) slice/filter.
      const startIndex = this.lowerBoundForCursor(cursor);

      if (!filters || Object.keys(filters).length === 0) {
        const page = this.orderedMetadata.slice(startIndex, startIndex + limit);
        const last = page.length > 0 ? page[page.length - 1] : null;
        return {
          entries: page,
          nextCursor: last ? { createdAt: last.createdAt, id: last.id } : cursor,
          hasMore: startIndex + page.length < this.orderedMetadata.length,
        };
      }

      const page: StoreEntryMetadata[] = [];
      let idx = startIndex;
      while (idx < this.orderedMetadata.length && page.length < limit) {
        const meta = this.orderedMetadata[idx];
        if (this.metadataMatchesFilters(meta, filters)) {
          page.push(meta);
        }
        idx++;
      }

      let hasMore = false;
      while (idx < this.orderedMetadata.length) {
        if (this.metadataMatchesFilters(this.orderedMetadata[idx], filters)) {
          hasMore = true;
          break;
        }
        idx++;
      }

      const last = page.length > 0 ? page[page.length - 1] : null;
      return {
        entries: page,
        nextCursor: last ? { createdAt: last.createdAt, id: last.id } : cursor,
        hasMore,
      };
    }

    // Non-indexed fallback: scan and sort all metadata on demand.
    const all = (await this.listAllMetadata())
      .filter((meta) => {
        if (filters?.docId && meta.docId !== filters.docId) {
          return false;
        }
        if (filters?.entryTypes && filters.entryTypes.length > 0 && !filters.entryTypes.includes(meta.entryType)) {
          return false;
        }
        if (filters?.creationDateFrom !== undefined && filters.creationDateFrom !== null && meta.createdAt < filters.creationDateFrom) {
          return false;
        }
        if (filters?.creationDateUntil !== undefined && filters.creationDateUntil !== null && meta.createdAt >= filters.creationDateUntil) {
          return false;
        }
        return true;
      })
      .sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt - b.createdAt));

    const startIndex =
      cursor === null
        ? 0
        : all.findIndex((meta) => meta.createdAt > cursor.createdAt || (meta.createdAt === cursor.createdAt && meta.id > cursor.id));

    if (startIndex === -1) {
      return { entries: [], nextCursor: cursor, hasMore: false };
    }

    const page = all.slice(startIndex, startIndex + limit);
    const last = page.length > 0 ? page[page.length - 1] : null;
    return {
      entries: page,
      nextCursor: last ? { createdAt: last.createdAt, id: last.id } : cursor,
      hasMore: startIndex + page.length < all.length,
    };
  }

  /**
   * Build a bloom filter summary of all entry ids in this store.
   *
   * The summary is a compact probabilistic set representation that a remote
   * peer can use during sync to cheaply test which of its own ids are
   * *definitely absent* from this store — avoiding per-id network
   * round-trips.  See {@link createIdBloomSummary} for details on the bloom
   * filter implementation.
   *
   * @returns A serializable {@link StoreIdBloomSummary} with a base64-encoded
   *          bitset, suitable for transmission over the network.
   */
  async getIdBloomSummary(): Promise<StoreIdBloomSummary> {
    await this.ensureInitialized();
    const ids = await this.getAllIds();
    return createIdBloomSummary(ids);
  }

  /**
   * Traverse the dependency graph starting from a given entry id.
   *
   * Performs a breadth-first traversal through `dependencyIds` links,
   * collecting all reachable entries.  The result is returned in
   * **dependency-first order** (deepest dependencies first) so callers
   * can process entries from oldest to newest.
   *
   * Use cases:
   * - Loading all chunks of a large attachment (traverse from the last
   *   chunk back to the first).
   * - Reconstructing a document state by collecting all changes.
   * - Stopping at snapshots to avoid loading the full history.
   *
   * @param startId  The entry id to begin traversal from.
   * @param options  Optional traversal controls:
   *   - `stopAtEntryType` — stop expanding when hitting this type (the
   *     matching entry is still included).
   *   - `maxDepth` — maximum number of hops from `startId`.
   *   - `includeStart` — whether `startId` itself appears in the result
   *     (default `true`).
   * @returns Entry ids in dependency-first order.
   */
  async resolveDependencies(
    startId: string,
    options?: Record<string, unknown>
  ): Promise<string[]> {
    await this.ensureInitialized();

    const stopAtEntryType = options?.stopAtEntryType as string | undefined;
    const maxDepth = options?.maxDepth as number | undefined;
    const includeStart = options?.includeStart !== false;

    // Breadth-first traversal with a visited set.
    // We reverse at the end to return dependency-first order.
    const result: string[] = [];
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (visited.has(id)) {
        continue;
      }
      visited.add(id);

      if (maxDepth !== undefined && depth > maxDepth) {
        continue;
      }

      const entry = await this.readMetadataById(id);
      if (!entry) {
        continue;
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
          queue.push({ id: depId, depth: depth + 1 });
        }
      }
    }

    result.reverse();
    return result;
  }

  /**
   * Permanently delete all entries belonging to a document (GDPR purge).
   *
   * Steps:
   * 1. Identify all metadata entries with the given `docId`.
   * 2. Delete each metadata file and update the in-memory index.
   * 3. Delete orphaned content blobs — content files whose hash is no
   *    longer referenced by any remaining entry.
   * 4. Append "delete" segment records so the index stays consistent
   *    across restarts.
   *
   * @param docId  The document whose entire history should be erased.
   */
  async purgeDocHistory(docId: string): Promise<void> {
    await this.ensureInitialized();

    const all = await this.listAllMetadata();
    const toDelete = all.filter((meta) => meta.docId === docId);
    if (toDelete.length === 0) {
      return;
    }

    // GDPR purge removes all metadata for one document, then drops orphaned payloads.
    const deletedHashes = new Set<string>();
    const deletedIds: string[] = [];
    for (const meta of toDelete) {
      deletedHashes.add(meta.contentHash);
      deletedIds.push(meta.id);
      const metadataPath = this.metadataPathForId(meta.id);
      await unlink(metadataPath).catch(() => {
        // Ignore races or already-deleted files.
      });
      await this.syncParentDirectory(metadataPath);

      if (this.indexingEnabled) {
        this.applyMetadataDelete(meta.id);
      }
    }

    const remaining = await this.listAllMetadata();
    const remainingHashes = new Set(remaining.map((m) => m.contentHash));

    for (const hash of deletedHashes) {
      if (!remainingHashes.has(hash)) {
        const contentPath = this.contentPathForHash(hash);
        await unlink(contentPath).catch(() => {
          // Ignore races or already-deleted files.
        });
        await this.syncParentDirectory(contentPath);
      }
    }

    if (this.indexingEnabled) {
      await this.appendMetadataSegment(
        deletedIds.map((id) => ({ op: "delete" as const, id }))
      );
    }
  }

  /**
   * Delete all data for this database and recreate empty directories.
   *
   * Resets the index status to "building" temporarily, removes the entire
   * store root, and re-creates the directory structure.  The index is
   * immediately marked "ready" afterwards since the store is now empty.
   */
  async clearAllLocalData(): Promise<void> {
    await this.ensureInitialized();
    this.indexStatus = {
      phase: this.indexingEnabled ? "building" : "ready",
      indexingEnabled: this.indexingEnabled,
      progress01: this.indexingEnabled ? 0 : 1,
    };
    await this.clearAllLocalDataInternal();
    await mkdir(this.entriesDir, { recursive: true });
    await mkdir(this.contentDir, { recursive: true });
    await mkdir(this.metadataSegmentsDir, { recursive: true });
    if (this.indexingEnabled) {
      this.indexStatus = { phase: "ready", indexingEnabled: true, progress01: 1 };
    }
  }

  /**
   * Wait until the in-memory index has finished building and return its
   * status.  Since initialization is fully awaited via `initPromise`, this
   * effectively waits for the constructor's async init to complete.
   */
  async awaitIndexReady(_options?: AwaitIndexReadyOptions): Promise<StoreIndexBuildStatus> {
    await this.ensureInitialized();
    return this.indexStatus;
  }

  /** Return the current index build status without waiting. */
  getIndexBuildStatus(): StoreIndexBuildStatus {
    return this.indexStatus;
  }

  /** Return a snapshot of cumulative metadata-segment compaction statistics. */
  async getCompactionStatus(): Promise<StoreCompactionStatus> {
    return { ...this.compactionStatus };
  }
}

/**
 * Factory that creates {@link BasicOnDiskContentAddressedStore} instances.
 *
 * Implements the {@link ContentAddressedStoreFactory} interface so it can be
 * plugged into MindooDB's store creation pipeline.  Each call to
 * `createStore` returns a fresh store backed by its own on-disk directory
 * under the configured base path.
 */
export class BasicOnDiskContentAddressedStoreFactory implements ContentAddressedStoreFactory {
  /**
   * Create a new on-disk content-addressed store for the given database.
   *
   * @param dbId    Unique database identifier (becomes the directory name).
   * @param options Store configuration forwarded to the constructor.
   * @returns A {@link CreateStoreResult} containing the new store as `docStore`.
   */
  createStore(dbId: string, options?: OpenStoreOptions): CreateStoreResult {
    return {
      docStore: new BasicOnDiskContentAddressedStore(dbId, undefined, options),
    };
  }
}
