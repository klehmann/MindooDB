import type { ContentAddressedStore } from "../../core/types";
import type {
  StoreEntry,
  StoreEntryMetadata,
  MindooTenantDirectory,
  StoreEntryType,
  StoreScanCursor,
  StoreScanFilters,
  StoreScanResult,
  StoreIdBloomSummary,
  StoreCompactionStatus,
} from "../../core/types";
import type {
  AttachmentReadPlan,
  AttachmentReadPlanOptions,
  DocumentMaterializationBatchPlan,
  DocumentMaterializationPlan,
  MaterializationPlanOptions,
} from "../../core/appendonlystores/types";
import { createIdBloomSummary } from "../../core/appendonlystores/bloom";
import type { CryptoAdapter } from "../../core/crypto/CryptoAdapter";
import type {
  NetworkEncryptedEntry,
  NetworkAuthTokenPayload,
  NetworkSyncCapabilities,
} from "../../core/appendonlystores/network/types";
import { NetworkError, NetworkErrorType } from "../../core/appendonlystores/network/types";
import { RSAEncryption } from "../../core/crypto/RSAEncryption";
import { verifyEntrySignatureCrypto } from "../../core/crypto/EntrySignature";
import { computeContentHash } from "../../core/utils/idGeneration";
import { AuthenticationService } from "../../core/appendonlystores/network/AuthenticationService";
import { Logger, MindooLogger, getDefaultLogLevel } from "../../core/logging";
import type { TimestampProvider } from "../../core/accesscontrol/timestamp/TimestampProvider";
import type { AccessDecision } from "../../core/accesscontrol/types";

/**
 * Server-side Tier 1 access evaluator (docs/accesscontrol.md §7). Given a
 * pushed entry and the database it targets, returns whether the entry is
 * allowed by the identity-tier policy at the entry's trusted time. Supplied by
 * the host server, which has access to the directory-state node and can resolve
 * the author's identity set; kept as a callback so this transport layer stays
 * decoupled from the directory implementation and remains easy to unit-test.
 */
export type ServerTier1Evaluator = (
  entry: StoreEntry,
  dbid: string
) => Promise<AccessDecision>;

/**
 * Resolves a wipe-targeted signing key to the id of the admin-signed grant
 * document carrying its remote-wipe directive (docs/accesscontrol.md §6.5), or
 * null if the key is not wipe-targeted. Supplied by the host server from the
 * directory; kept as a callback so this transport layer stays decoupled.
 */
export type WipeGrantDocIdResolver = (signingKey: string) => Promise<string | null>;

/**
 * Server-side database-open gate. Given the authenticated principal and the
 * store's database id, returns whether that database may be synced at all under
 * the tenant's `databaseCreationPolicy`. Coarser than the per-entry read
 * evaluator: a denied database rejects every sync operation (reads and writes)
 * for that database. `"directory"` is never gated (it must always sync), and the
 * tenant admin is exempt. Supplied by the host server from the directory.
 */
export type ServerDbAccessEvaluator = (
  principal: { signingKey?: string },
  dbid: string
) => Promise<boolean>;

/**
 * Resolves the per-user revoked decryption-key-id blacklist for the
 * authenticated principal (docs/accesscontrol.md §13). Derived from the
 * `acl_keydistribution_` `pullfrom` lists at the directory head. When present,
 * the server silently omits store entries whose `decryptionKeyId` is revoked
 * from every read/serve path, and refuses pushes carrying a revoked
 * `decryptionKeyId`. Supplied by the host server from the directory; kept as a
 * callback so this transport layer stays decoupled. The `"directory"` store is
 * never blacklisted (it must always sync so the policy can be read).
 */
export type ServerRevokedKeyResolver = (
  principal: { signingKey?: string }
) => Promise<Set<string>>;

/** Optional access-control wiring for the server store (docs/accesscontrol.md §5–§7). */
export interface ServerAccessControlOptions {
  /** The trusted-time provider used to stamp receipts on accepted entries (§5, §13). */
  timestampProvider?: TimestampProvider;
  /** The database id witnessed entries are bound to (the store's db context). */
  witnessDbid?: string;
  /** Tier 1 evaluator; when present, denied pushes are rejected with ACCESS_DENIED. */
  tier1Evaluator?: ServerTier1Evaluator;
  /**
   * Remote-wipe resolver (§6.5). When present, a wipe-scoped token is served
   * only the admin-signed grant document carrying its directive (on the
   * directory store) and nothing else (on data stores); pushes are denied.
   */
  wipeGrantDocIdResolver?: WipeGrantDocIdResolver;
  /**
   * Database-open gate. When present, every authenticated sync operation on a
   * non-allowed database is rejected with ACCESS_DENIED (reads and writes).
   * Absent keeps the legacy behavior (any synced database id is accepted).
   */
  dbAccessEvaluator?: ServerDbAccessEvaluator;
  /**
   * Per-user revoked-key blacklist resolver (§13). When present, store entries
   * whose `decryptionKeyId` is revoked for the principal are silently omitted
   * from reads and rejected on push. Absent keeps unfiltered serving. Never
   * wired for the `"directory"` store.
   */
  revokedKeyResolver?: ServerRevokedKeyResolver;
}

/**
 * Server-side network handler for ContentAddressedStore operations.
 * 
 * This class handles incoming sync requests from clients:
 * 1. Validates authentication tokens
 * 2. Retrieves entries from the local store
 * 3. Encrypts entries with the requesting user's RSA public key
 * 4. Returns encrypted entries to the client
 * 
 * This is not a ContentAddressedStore implementation itself, but rather
 * a service that wraps a local ContentAddressedStore and handles network requests.
 */
export class ServerNetworkContentAddressedStore {
  private localStore: ContentAddressedStore;
  private directory: MindooTenantDirectory;
  private authService: AuthenticationService;
  private rsaEncryption: RSAEncryption;
  private cryptoAdapter: CryptoAdapter;
  private logger: Logger;
  /** Trusted-time provider for stamping receipts; undefined disables access-control v1. */
  private timestampProvider?: TimestampProvider;
  /** Database id bound into witness receipts for this store. */
  private witnessDbid?: string;
  /** Optional Tier 1 evaluator; undefined keeps the legacy membership-only check. */
  private tier1Evaluator?: ServerTier1Evaluator;
  /** Optional remote-wipe resolver; undefined disables wipe-scoped serving. */
  private wipeGrantDocIdResolver?: WipeGrantDocIdResolver;
  /** Optional database-open gate; undefined keeps any-database serving. */
  private dbAccessEvaluator?: ServerDbAccessEvaluator;
  /** Optional per-user revoked-key blacklist resolver; undefined disables it. */
  private revokedKeyResolver?: ServerRevokedKeyResolver;
  /** The directory database id, where grant documents live (§6.5). */
  private static readonly DIRECTORY_DB_ID = "directory";
  /**
   * Server-side cap on a single `scanEntriesSince` page (DoS guard). A client
   * may request fewer, but never more — an unbounded/huge `limit` would let a
   * caller force the server to materialize and serialize the entire store in one
   * response. Clients page via `nextCursor`/`hasMore` to read more.
   */
  static readonly MAX_SCAN_PAGE_SIZE = 1000;

  /**
   * Create a new ServerNetworkContentAddressedStore.
   * 
   * @param localStore The local store containing the actual data
   * @param directory The tenant directory for user lookup
   * @param authService The authentication service for token validation
   * @param cryptoAdapter The crypto adapter for encryption
   * @param logger Optional logger instance
   */
  constructor(
    localStore: ContentAddressedStore,
    directory: MindooTenantDirectory,
    authService: AuthenticationService,
    cryptoAdapter: CryptoAdapter,
    logger?: Logger,
    accessControl?: ServerAccessControlOptions
  ) {
    this.localStore = localStore;
    this.directory = directory;
    this.authService = authService;
    this.cryptoAdapter = cryptoAdapter;
    this.logger =
      logger ||
      new MindooLogger(getDefaultLogLevel(), `ServerNetworkStore:${localStore.getId()}`, true);
    const rsaLogger = this.logger.createChild("RSAEncryption");
    this.rsaEncryption = new RSAEncryption(cryptoAdapter, rsaLogger);
    this.timestampProvider = accessControl?.timestampProvider;
    this.witnessDbid = accessControl?.witnessDbid;
    this.tier1Evaluator = accessControl?.tier1Evaluator;
    this.wipeGrantDocIdResolver = accessControl?.wipeGrantDocIdResolver;
    this.dbAccessEvaluator = accessControl?.dbAccessEvaluator;
    this.revokedKeyResolver = accessControl?.revokedKeyResolver;
  }

  /**
   * Resolve the reader's RSA encryption public key for transport encryption.
   * Prefers the authenticated device signing key (so key-based tokens whose
   * `sub` is a key, not a username, still resolve), falling back to a
   * username-based lookup for legacy tokens. Returns null when no active grant
   * is found.
   */
  private async resolveReaderEncryptionKey(
    payload: NetworkAuthTokenPayload,
  ): Promise<string | null> {
    if (payload.deviceSigningKey && typeof this.directory.getUserBySigningPublicKey === "function") {
      const lookup = await this.directory.getUserBySigningPublicKey(payload.deviceSigningKey);
      if (lookup?.encryptionPublicKey) {
        return lookup.encryptionPublicKey;
      }
    }
    const userKeys = await this.directory.getUserPublicKeys(payload.sub);
    return userKeys?.encryptionPublicKey ?? null;
  }

  /**
   * Compute the id allow-list for a (possibly wipe-scoped) token
   * (docs/accesscontrol.md §6.5). Returns:
   *  - `null` for a normal token: serving is unrestricted; OR
   *  - a `Set<string>` for a wipe-scoped token: only these entry ids may be
   *    served. On the directory store this is exactly the admin-signed grant
   *    document carrying the directive; on any data store it is empty.
   */
  private async wipeAllowedIds(
    payload: NetworkAuthTokenPayload,
  ): Promise<Set<string> | null> {
    if (!payload.wipe || !payload.deviceSigningKey || !this.wipeGrantDocIdResolver) {
      return null;
    }
    // A wipe-targeted device gets no data-database content at all.
    if (this.localStore.getId() !== ServerNetworkContentAddressedStore.DIRECTORY_DB_ID) {
      return new Set<string>();
    }
    const grantDocId = await this.wipeGrantDocIdResolver(payload.deviceSigningKey);
    if (!grantDocId) {
      return new Set<string>();
    }
    const metas = await this.localStore.findNewEntriesForDoc([], grantDocId);
    return new Set(metas.map((m) => m.id));
  }

  /**
   * The authenticated principal used for blacklist resolution: the device
   * signing public key carried by the token (§13).
   */
  private readPrincipal(payload: NetworkAuthTokenPayload): { signingKey?: string } {
    return { signingKey: payload.deviceSigningKey };
  }

  /**
   * The set of revoked decryption key ids for the request's principal (§13), or
   * `null` when the blacklist is disabled (no resolver) or this is the directory
   * store (never blacklisted, so its policy can always be read). Resolved once
   * per request and reused across the per-entry filter.
   */
  private async resolveRevokedKeyIds(
    payload: NetworkAuthTokenPayload,
  ): Promise<Set<string> | null> {
    if (!this.revokedKeyResolver) return null;
    if (this.localStore.getId() === ServerNetworkContentAddressedStore.DIRECTORY_DB_ID) {
      return null;
    }
    return this.revokedKeyResolver(this.readPrincipal(payload));
  }

  /** Drop metadata whose `decryptionKeyId` is in the revoked set (§13). */
  private filterMetasByRevokedKeys<T extends { decryptionKeyId?: string }>(
    metas: T[],
    revoked: Set<string> | null,
  ): T[] {
    if (!revoked || revoked.size === 0) return metas;
    return metas.filter((m) => !m.decryptionKeyId || !revoked.has(m.decryptionKeyId));
  }

  /**
   * Drop ids whose entry `decryptionKeyId` is revoked (§13). Resolves each id's
   * metadata from the local store; ids with no resolvable metadata are kept
   * (they carry no revocable key).
   */
  private async filterIdsByRevokedKeys(
    ids: string[],
    revoked: Set<string> | null,
  ): Promise<string[]> {
    if (!revoked || revoked.size === 0) return ids;
    const kept: string[] = [];
    for (const id of ids) {
      const meta = await this.localStore.getEntryMetadata(id);
      if (!meta?.decryptionKeyId || !revoked.has(meta.decryptionKeyId)) {
        kept.push(id);
      }
    }
    return kept;
  }

  /**
   * Get the ID of the underlying store.
   */
  getId(): string {
    return this.localStore.getId();
  }

  /**
   * Handle a challenge request from a client.
   *
   * The username is optional: a client may identify itself by its device
   * signing public key instead, so the server never needs the cleartext name.
   *
   * @param username The username requesting authentication (optional)
   * @param options.signingPublicKey The device signing public key the client is
   *        identifying with, when no username is supplied
   * @returns The challenge string
   */
  async handleChallengeRequest(
    username?: string,
    options?: { signingPublicKey?: string },
  ): Promise<string> {
    this.logger.debug(`Handling challenge request${username ? ` for user: ${username}` : " by signing key"}`);
    return this.authService.generateChallenge(username, options);
  }

  /**
   * Handle an authentication request from a client.
   * 
   * @param challenge The challenge string
   * @param signature The client's signature
   * @returns The authentication result with JWT token
   */
  async handleAuthenticate(challenge: string, signature: Uint8Array): Promise<{
    success: boolean;
    token?: string;
    error?: string;
  }> {
    this.logger.debug(`Handling authentication for challenge: ${challenge}`);
    return this.authService.authenticate(challenge, signature);
  }

  /**
   * Handle a findNewEntries request from a client.
   * 
   * @param token The JWT access token
   * @param knownIds The entry IDs the client already has
   * @returns List of new entry metadata
   */
  async handleFindNewEntries(
    token: string,
    knownIds: string[]
  ): Promise<StoreEntryMetadata[]> {
    this.logger.debug(`Handling findNewEntries request`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);
    
    // Find new entries
    const newEntries = await this.localStore.findNewEntries(knownIds);
    this.logger.debug(`Found ${newEntries.length} new entries`);
    
    const allowed = await this.wipeAllowedIds(tokenPayload);
    const scoped = allowed ? newEntries.filter((e) => allowed.has(e.id)) : newEntries;
    const revoked = await this.resolveRevokedKeyIds(tokenPayload);
    return this.filterMetasByRevokedKeys(scoped, revoked);
  }

  /**
   * Handle a findNewEntriesForDoc request from a client.
   * This is an optimized version that only returns entries for a specific document.
   * 
   * @param token The JWT access token
   * @param knownIds The entry IDs the client already has for this document
   * @param docId The document ID to filter by
   * @returns List of new entry metadata for the specified document
   */
  async handleFindNewEntriesForDoc(
    token: string,
    knownIds: string[],
    docId: string
  ): Promise<StoreEntryMetadata[]> {
    this.logger.debug(`Handling findNewEntriesForDoc request for doc ${docId}`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);
    
    // Find new entries for the specific document
    const newEntries = await this.localStore.findNewEntriesForDoc(knownIds, docId);
    this.logger.debug(`Found ${newEntries.length} new entries for doc ${docId}`);
    
    const allowed = await this.wipeAllowedIds(tokenPayload);
    const scoped = allowed ? newEntries.filter((e) => allowed.has(e.id)) : newEntries;
    const revoked = await this.resolveRevokedKeyIds(tokenPayload);
    return this.filterMetasByRevokedKeys(scoped, revoked);
  }

  /**
   * Handle a findEntries request from a client.
   * 
   * @param token The JWT access token
   * @param type The entry type to filter by
   * @param creationDateFrom Optional start timestamp (inclusive)
   * @param creationDateUntil Optional end timestamp (exclusive)
   * @returns List of entry metadata matching the criteria
   */
  async handleFindEntries(
    token: string,
    type: StoreEntryType,
    creationDateFrom: number | null,
    creationDateUntil: number | null
  ): Promise<StoreEntryMetadata[]> {
    this.logger.debug(`Handling findEntries request for type ${type}`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);
    
    // Find entries
    const entries = await this.localStore.findEntries(
      type,
      creationDateFrom,
      creationDateUntil
    );
    this.logger.debug(`Found ${entries.length} entries`);
    
    const allowed = await this.wipeAllowedIds(tokenPayload);
    const scoped = allowed ? entries.filter((e) => allowed.has(e.id)) : entries;
    const revoked = await this.resolveRevokedKeyIds(tokenPayload);
    return this.filterMetasByRevokedKeys(scoped, revoked);
  }

  /**
   * Handle a cursor-based scanEntriesSince request from a client.
   * Uses local store native support when available, with legacy fallback.
   */
  async handleScanEntriesSince(
    token: string,
    cursor: StoreScanCursor | null,
    limit?: number,
    filters?: StoreScanFilters
  ): Promise<StoreScanResult> {
    this.logger.debug(`Handling scanEntriesSince request`);

    // Validate token
    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);

    // Wipe-scoped token (§6.5): return only the allowed entries (the grant
    // directive on the directory store, nothing on data stores) in a single
    // terminal page, regardless of cursor.
    const allowed = await this.wipeAllowedIds(tokenPayload);
    if (allowed) {
      if (allowed.size === 0) {
        return { entries: [], nextCursor: cursor, hasMore: false };
      }
      const all = await this.localStore.findNewEntries([]);
      const entries = all.filter((e) => allowed.has(e.id));
      return { entries, nextCursor: cursor, hasMore: false };
    }

    // Clamp the page size server-side (DoS guard): never trust the client's
    // `limit` to bound the work/response. A missing or non-finite limit falls
    // back to the maximum page size.
    const requestedLimit =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.floor(limit)
        : ServerNetworkContentAddressedStore.MAX_SCAN_PAGE_SIZE;
    const effectiveLimit = Math.max(
      1,
      Math.min(requestedLimit, ServerNetworkContentAddressedStore.MAX_SCAN_PAGE_SIZE),
    );

    // Per-user revoked-key blacklist (§13): silently omit revoked entries from
    // the page. Filtering after paging only shrinks a page; the store's own
    // cursor still advances so the client keeps making progress.
    const revoked = await this.resolveRevokedKeyIds(tokenPayload);

    if (this.localStore.scanEntriesSince) {
      const result = await this.localStore.scanEntriesSince(cursor, effectiveLimit, filters);
      return { ...result, entries: this.filterMetasByRevokedKeys(result.entries, revoked) };
    }

    // Fallback: emulate cursor scan using existing metadata query.
    const all = filters?.docId
      ? await this.localStore.findNewEntriesForDoc([], filters.docId)
      : await this.localStore.findNewEntries([]);
    const sorted = all
      .filter((meta) => {
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
      .sort((a, b) => {
        const leftReceiptOrder = a.receiptOrder ?? 0;
        const rightReceiptOrder = b.receiptOrder ?? 0;
        return leftReceiptOrder === rightReceiptOrder
          ? a.id.localeCompare(b.id)
          : leftReceiptOrder - rightReceiptOrder;
      });

    const max = effectiveLimit;
    const startIndex =
      cursor === null
        ? 0
        : sorted.findIndex((meta) =>
            (meta.receiptOrder ?? 0) > cursor.receiptOrder ||
            ((meta.receiptOrder ?? 0) === cursor.receiptOrder && meta.id > cursor.id)
          );

    if (startIndex === -1) {
      return { entries: [], nextCursor: cursor, hasMore: false };
    }

    const page = sorted.slice(startIndex, startIndex + max);
    const last = page.length > 0 ? page[page.length - 1] : null;
    return {
      entries: this.filterMetasByRevokedKeys(page, revoked),
      nextCursor: last ? { receiptOrder: last.receiptOrder ?? 0, id: last.id } : cursor,
      hasMore: startIndex + page.length < sorted.length,
    };
  }

  /**
   * Handle a getIdBloomSummary request from a client.
   */
  async handleGetIdBloomSummary(token: string): Promise<StoreIdBloomSummary> {
    this.logger.debug(`Handling getIdBloomSummary request`);

    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);

    if (this.localStore.getIdBloomSummary) {
      return this.localStore.getIdBloomSummary();
    }

    const ids = await this.localStore.getAllIds();
    return createIdBloomSummary(ids);
  }

  /**
   * Handle sync capability negotiation.
   */
  async handleGetCapabilities(token: string): Promise<NetworkSyncCapabilities> {
    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);

    return {
      protocolVersion: "sync-v4",
      supportsCursorScan: typeof this.localStore.scanEntriesSince === "function",
      supportsIdBloomSummary: typeof this.localStore.getIdBloomSummary === "function",
      supportsCompactionStatus: typeof this.localStore.getCompactionStatus === "function",
      supportsMaterializationPlanning:
        typeof this.localStore.planDocumentMaterialization === "function",
      supportsBatchMaterializationPlanning:
        typeof this.localStore.planDocumentMaterializationBatch === "function",
      supportsAttachmentReadPlanning:
        typeof this.localStore.planAttachmentReadByWalkingMetadata === "function",
      // Access-control v1 negotiation (docs/accesscontrol.md §4). `serverTime`
      // lets the client run its clock-skew guard before syncing; the flag
      // advertises that this server stamps witness receipts and enforces Tier 1.
      serverTime: Date.now(),
      supportsAccessControlV1: this.timestampProvider !== undefined,
      supportsRemoteWipeV1: this.wipeGrantDocIdResolver !== undefined,
    };
  }

  /**
   * Handle a getCompactionStatus request from a client.
   */
  async handleGetCompactionStatus(token: string): Promise<StoreCompactionStatus> {
    this.logger.debug(`Handling getCompactionStatus request`);

    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);

    if (this.localStore.getCompactionStatus) {
      return this.localStore.getCompactionStatus();
    }

    return {
      enabled: false,
      compactionMinFiles: 0,
      compactionMaxBytes: 0,
      totalCompactions: 0,
      totalCompactedFiles: 0,
      totalCompactedBytes: 0,
      totalCompactionDurationMs: 0,
      lastCompactionAt: null,
      lastCompactedFiles: 0,
      lastCompactedBytes: 0,
      lastCompactionDurationMs: 0,
    };
  }

  /**
   * Handle a getEntries request from a client.
   * Encrypts the entries with the client's RSA public key.
   * 
   * @param token The JWT access token
   * @param ids The IDs of entries to retrieve
   * @returns The entries with RSA-encrypted payloads
   */
  async handleGetEntries(
    token: string,
    ids: string[]
  ): Promise<NetworkEncryptedEntry[]> {
    this.logger.debug(`Handling getEntries request for ${ids.length} entries`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    const username = tokenPayload.sub;
    this.logger.debug(`Token validated for user: ${username}`);

    // Resolve the reader's RSA encryption public key for transport encryption.
    // Prefer the authenticated device signing key, which works for key-based
    // tokens whose `sub` is a key rather than a cleartext username; fall back to
    // the username for legacy tokens.
    const encryptionPublicKey = await this.resolveReaderEncryptionKey(tokenPayload);
    if (!encryptionPublicKey) {
      throw new NetworkError(
        NetworkErrorType.USER_NOT_FOUND,
        `User "${username}" is not found, or has no active access grant on this server. `
          + `The tenant's directory database may not have been synced to this server yet, `
          + `or the access was revoked.`,
      );
    }
    
    this.logger.debug(`Retrieved encryption key for user: ${username}`);
    
    // Restrict a wipe-scoped token to only the grant directive (§6.5).
    const allowed = await this.wipeAllowedIds(tokenPayload);
    const requestedIds = allowed ? ids.filter((id) => allowed.has(id)) : ids;

    // Get the entries from local store
    const entries = await this.localStore.getEntries(requestedIds);
    this.logger.debug(`Retrieved ${entries.length} entries from local store`);

    // Per-user revoked-key blacklist (§13): fail-closed on the data-serving
    // path. Even if a client already knows a revoked entry's id, the server
    // never hands back its bytes. A StoreEntry carries its own decryptionKeyId,
    // so we filter without an extra metadata lookup.
    const revoked = await this.resolveRevokedKeyIds(tokenPayload);
    const servableEntries = this.filterMetasByRevokedKeys(entries, revoked);

    // Encrypt each entry with the user's RSA public key
    const encryptedEntries = await this.encryptEntriesForUser(
      servableEntries,
      encryptionPublicKey
    );
    
    this.logger.debug(`Encrypted ${encryptedEntries.length} entries for user: ${username}`);
    return encryptedEntries;
  }

  async handleGetEntryMetadata(
    token: string,
    id: string
  ): Promise<StoreEntryMetadata | null> {
    this.logger.debug(`Handling getEntryMetadata request for ${id}`);

    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);

    const allowed = await this.wipeAllowedIds(tokenPayload);
    if (allowed && !allowed.has(id)) {
      return null;
    }
    const meta = await this.localStore.getEntryMetadata(id);
    if (!meta) return null;
    // Per-user revoked-key blacklist (§13): fail-closed — never reveal metadata
    // for a revoked entry.
    const revoked = await this.resolveRevokedKeyIds(tokenPayload);
    if (revoked && meta.decryptionKeyId && revoked.has(meta.decryptionKeyId)) {
      return null;
    }
    return meta;
  }

  /**
   * Handle a putEntries request from a client.
   * 
   * @param token The JWT access token
   * @param entries The entries to store
   */
  async handlePutEntries(token: string, entries: StoreEntry[]): Promise<StoreEntryMetadata[]> {
    this.logger.debug(`Handling putEntries request for ${entries.length} entries`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);

    // A wipe-targeted device may not push anything (§6.5): it exists only to
    // receive the wipe directive and then delete its local copy.
    if (tokenPayload.wipe && this.wipeGrantDocIdResolver) {
      throw new NetworkError(
        NetworkErrorType.ACCESS_DENIED,
        "Device is targeted for remote wipe and may not push entries",
      );
    }

    // Per-user revoked-key blacklist (§13): a revoked key id is also a write
    // blacklist — the user may neither receive further updates for it nor push
    // new ones. Resolved once per batch (null for the directory store / when the
    // blacklist is disabled).
    const revokedKeyIds = await this.resolveRevokedKeyIds(tokenPayload);

    // A single acceptance time for this batch so receipts are consistent and a
    // batch cannot interleave with the witness's own monotonic clock (§5.3).
    const receivedAt = Date.now();
    const stampedMetadata: StoreEntryMetadata[] = [];

    // Storage-format floor (requireMetadataSignatureSince): this is the
    // authoritative v2 enforcement point. The server compares the admin-signed
    // cutoff against its OWN clock (receivedAt) — never the entry's
    // attacker-settable createdAt — so once the cutoff has passed, no new v1
    // entry can be ingested and a forged v1 entry cannot bypass the floor by
    // backdating. Resolved once per batch. The directory store is exempt: it
    // must always accept so the policy that defines the floor can be read.
    let requireMetadataSignature = false;
    if (
      (this.witnessDbid ?? this.localStore.getId()) !== "directory" &&
      typeof this.directory.getRequireMetadataSignatureSince === "function"
    ) {
      const cutoff = await this.directory.getRequireMetadataSignatureSince();
      requireMetadataSignature = cutoff !== undefined && receivedAt >= cutoff;
    }

    // Process each entry
    const toStore: StoreEntry[] = [];
    // Audit #4 (revocation lag): force a directory trust refresh once at the
    // start of the batch so a just-pushed revocation is observed immediately
    // instead of lagging by up to DIRECTORY_SYNC_INTERVAL_MS. The refresh
    // updates the shared trust cache, so subsequent entries in the batch reuse
    // it without re-syncing.
    let forceTrustRefresh = true;
    for (const entry of entries) {
      // Reject a push carrying a revoked decryptionKeyId (§13). The user has
      // been removed from this key's distribution, so the server refuses to
      // ingest or propagate further writes under it.
      if (
        revokedKeyIds &&
        entry.decryptionKeyId &&
        revokedKeyIds.has(entry.decryptionKeyId)
      ) {
        throw new NetworkError(
          NetworkErrorType.ACCESS_DENIED,
          `Entry ${entry.id} carries a revoked decryptionKeyId and may not be pushed`,
        );
      }

      // Verify the entry was created by a trusted user (baseline Tier 1).
      const isValidKey = await this.directory.validatePublicSigningKey(
        entry.createdByPublicKey,
        { forceRefresh: forceTrustRefresh },
      );
      forceTrustRefresh = false;
      if (!isValidKey) {
        throw new NetworkError(
          NetworkErrorType.INVALID_SIGNATURE,
          `Entry ${entry.id} was not signed by a trusted user`
        );
      }

      // Zero-trust ingest (audit finding #1 & #5): the server must not witness or
      // propagate an entry it cannot authenticate. Verify that the served bytes
      // hash to the entry's contentHash and that the author signature (the
      // metadata-binding signature when present, otherwise the legacy ciphertext
      // signature) is valid. A trusted key alone is NOT sufficient: anyone
      // holding any trusted key could otherwise push entries with mismatched or
      // absent signatures.
      const subtle = this.cryptoAdapter.getSubtle();
      const actualHash = await computeContentHash(entry.encryptedData, subtle);
      if (actualHash !== entry.contentHash) {
        throw new NetworkError(
          NetworkErrorType.INVALID_SIGNATURE,
          `Entry ${entry.id} content hash does not match its payload`
        );
      }
      // Enforce the v2 floor with a clear, dedicated error before the generic
      // signature check (which would also reject it via requireMetadataSignature).
      if (requireMetadataSignature && !entry.metadataSignature) {
        throw new NetworkError(
          NetworkErrorType.INVALID_SIGNATURE,
          `Entry ${entry.id} must carry a v2 metadata signature (tenant requires v2 as of the configured cutoff)`
        );
      }
      const isValidSignature = await verifyEntrySignatureCrypto(
        entry,
        entry.encryptedData,
        entry.createdByPublicKey,
        subtle,
        { requireMetadataSignature },
      );
      if (!isValidSignature) {
        throw new NetworkError(
          NetworkErrorType.INVALID_SIGNATURE,
          `Entry ${entry.id} has an invalid author signature`
        );
      }

      // Rule-based Tier 1 enforcement (docs/accesscontrol.md §7). The server can
      // only decide the identity tier; content-tier (Tier 2) gates are deferred
      // to clients and treated as allowed here.
      if (this.tier1Evaluator) {
        const decision = await this.tier1Evaluator(entry, this.witnessDbid ?? this.localStore.getId());
        if (!decision.allowed) {
          throw new NetworkError(
            NetworkErrorType.ACCESS_DENIED,
            `Entry ${entry.id} denied by Tier 1 policy: ${decision.reason}`
          );
        }
      }

      // Stamp a witness receipt onto the accepted entry (§5.3). Self-authored
      // entries (the witness pushing its own data) are not self-witnessed.
      //
      // Legacy entries (no `entryVersion`) are NOT witnessed: they predate the
      // witness era and the version-aware trusted-time rule treats them as
      // stable at their `createdAt` (see core/storeEntryTime.ts). Stamping a
      // `receivedAt = now` on them when an old local DB first syncs to a fresh
      // server would collapse every old doc onto "today" and re-introduce the
      // "access since: today" bug. Only witness-era writers (`entryVersion`
      // present) are eligible for a receipt.
      if (
        this.timestampProvider
        && entry.entryVersion !== undefined
        && entry.createdByPublicKey !== this.timestampProvider.issuerPublicKey
      ) {
        const stamp = await this.timestampProvider.stamp(
          entry,
          { dbid: this.witnessDbid ?? this.localStore.getId(), receivedAt }
        );
        const witnessed: StoreEntry = { ...entry, ...stamp };
        toStore.push(witnessed);
        stampedMetadata.push(this.toMetadata(witnessed));
      } else {
        toStore.push(entry);
        stampedMetadata.push(this.toMetadata(entry));
      }
    }
    
    // Store all entries (witnessed where applicable)
    await this.localStore.putEntries(toStore);
    this.logger.debug(`Successfully stored ${toStore.length} entries`);
    return stampedMetadata;
  }

  /** Project a store entry to its metadata (including any witness fields). */
  private toMetadata(entry: StoreEntry): StoreEntryMetadata {
    const { encryptedData: _encryptedData, ...metadata } = entry;
    return metadata as StoreEntryMetadata;
  }

  /**
   * Handle a hasEntries request from a client.
   * Checks which of the provided IDs exist in the store.
   * 
   * @param token The JWT access token
   * @param ids The IDs to check for existence
   * @returns List of IDs that exist in the store
   */
  async handleHasEntries(token: string, ids: string[]): Promise<string[]> {
    this.logger.debug(`Handling hasEntries request for ${ids.length} IDs`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);
    
    // Check which IDs exist in local store
    const existingIds = await this.localStore.hasEntries(ids);
    this.logger.debug(`Found ${existingIds.length} existing entries out of ${ids.length} checked`);
    
    const allowed = await this.wipeAllowedIds(tokenPayload);
    const scoped = allowed ? existingIds.filter((id) => allowed.has(id)) : existingIds;
    const revoked = await this.resolveRevokedKeyIds(tokenPayload);
    return this.filterIdsByRevokedKeys(scoped, revoked);
  }

  /**
   * Handle a getAllIds request from a client.
   * This is used by clients to determine which entries they need to push.
   * 
   * @param token The JWT access token
   * @returns List of all entry IDs in the store
   */
  async handleGetAllIds(token: string): Promise<string[]> {
    this.logger.debug(`Handling getAllIds request`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);
    
    // Get all entry IDs from local store
    const allIds = await this.localStore.getAllIds();
    this.logger.debug(`Returning ${allIds.length} entry IDs`);
    
    const allowed = await this.wipeAllowedIds(tokenPayload);
    const scoped = allowed ? allIds.filter((id) => allowed.has(id)) : allIds;
    const revoked = await this.resolveRevokedKeyIds(tokenPayload);
    return this.filterIdsByRevokedKeys(scoped, revoked);
  }

  /**
   * Handle a resolveDependencies request from a client.
   * Resolves the dependency chain starting from an entry ID.
   * 
   * @param token The JWT access token
   * @param startId The entry ID to start traversal from
   * @param options Optional traversal options
   * @returns List of entry IDs in dependency order
   */
  async handleResolveDependencies(
    token: string,
    startId: string,
    options?: Record<string, unknown>
  ): Promise<string[]> {
    this.logger.debug(`Handling resolveDependencies request for ${startId}`);
    
    // Validate token
    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);
    
    // A wipe-scoped token may not traverse the DAG beyond its grant directive.
    const allowed = await this.wipeAllowedIds(tokenPayload);
    if (allowed) {
      return allowed.has(startId) ? [startId] : [];
    }

    // Resolve dependencies in local store
    const resolvedIds = await this.localStore.resolveDependencies(startId, options);
    this.logger.debug(`Resolved ${resolvedIds.length} dependencies`);
    
    const revoked = await this.resolveRevokedKeyIds(tokenPayload);
    return this.filterIdsByRevokedKeys(resolvedIds, revoked);
  }

  async handlePlanDocumentMaterialization(
    token: string,
    docId: string,
    options?: MaterializationPlanOptions
  ): Promise<DocumentMaterializationPlan> {
    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);
    return this.localStore.planDocumentMaterialization(docId, options);
  }

  async handlePlanDocumentMaterializationBatch(
    token: string,
    docIds: string[],
    options?: MaterializationPlanOptions
  ): Promise<DocumentMaterializationBatchPlan> {
    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);
    return this.localStore.planDocumentMaterializationBatch(docIds, options);
  }

  async handlePlanAttachmentReadByWalkingMetadata(
    token: string,
    lastChunkId: string,
    attachmentSize: number,
    options: AttachmentReadPlanOptions,
  ): Promise<AttachmentReadPlan> {
    const tokenPayload = await this.validateToken(token);
    this.logger.debug(`Token validated for user: ${tokenPayload.sub}`);
    if (!this.localStore.planAttachmentReadByWalkingMetadata) {
      throw new Error("Remote store does not support attachment read planning");
    }
    return this.localStore.planAttachmentReadByWalkingMetadata(lastChunkId, attachmentSize, options);
  }

  /**
   * Validate a JWT token and return the payload.
   * 
   * @param token The JWT token
   * @returns The token payload
   * @throws NetworkError if token is invalid
   */
  private async validateToken(token: string): Promise<NetworkAuthTokenPayload> {
    const payload = await this.authService.validateToken(token);
    
    if (!payload) {
      throw new NetworkError(
        NetworkErrorType.INVALID_TOKEN,
        "Invalid or expired token"
      );
    }

    // Database-open gate (docs/accesscontrol.md, directory-restricted policy).
    // Applied here so it covers every authenticated sync operation (reads and
    // writes) in one place. The directory store is never wired with an
    // evaluator, so it always syncs.
    if (this.dbAccessEvaluator) {
      const dbid = this.witnessDbid ?? this.localStore.getId();
      const allowed = await this.dbAccessEvaluator(
        { signingKey: payload.deviceSigningKey },
        dbid,
      );
      if (!allowed) {
        throw new NetworkError(
          NetworkErrorType.ACCESS_DENIED,
          `Database "${dbid}" is not in the tenant's allowed database list`,
        );
      }
    }
    
    return payload;
  }

  /**
   * Encrypt entries with a user's RSA public key.
   * Transforms StoreEntry[] to NetworkEncryptedEntry[].
   */
  private async encryptEntriesForUser(
    entries: StoreEntry[],
    encryptionPublicKey: string
  ): Promise<NetworkEncryptedEntry[]> {
    const results: NetworkEncryptedEntry[] = [];
    
    // Import the public key once for all entries
    const publicKey = await this.rsaEncryption.importPublicKey(encryptionPublicKey);
    
    for (const entry of entries) {
      // Encrypt the payload with RSA
      const rsaEncryptedPayload = await this.rsaEncryption.encrypt(
        entry.encryptedData,
        publicKey
      );
      
      // Create NetworkEncryptedEntry with all metadata plus RSA-encrypted payload
      const encryptedEntry: NetworkEncryptedEntry = {
        entryType: entry.entryType,
        id: entry.id,
        contentHash: entry.contentHash,
        docId: entry.docId,
        dependencyIds: entry.dependencyIds,
        createdAt: entry.createdAt,
        createdByPublicKey: entry.createdByPublicKey,
        decryptionKeyId: entry.decryptionKeyId,
        snapshotHeadHashes: entry.snapshotHeadHashes,
        snapshotHeadEntryIds: entry.snapshotHeadEntryIds,
        signature: entry.signature,
        originalSize: entry.originalSize,
        encryptedSize: entry.encryptedSize,
        attachmentRefs: entry.attachmentRefs,
        rsaEncryptedPayload,
      };
      
      results.push(encryptedEntry);
    }
    
    return results;
  }
}
