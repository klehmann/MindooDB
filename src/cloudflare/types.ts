/**
 * The slice of the Cloudflare Workers runtime API the MindooDB host uses.
 *
 * Declared here instead of depending on `@cloudflare/workers-types`, so the
 * host compiles and unit-tests with the rest of the package. Shapes follow
 * the runtime: https://developers.cloudflare.com/durable-objects/api/
 */

export type SqlStorageValue = ArrayBuffer | string | number | null;

export interface SqlStorageCursor<T = Record<string, SqlStorageValue>> extends Iterable<T> {
  toArray(): T[];
  readonly rowsWritten: number;
}

export interface SqlStorage {
  exec<T = Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T>;
}

export interface DurableObjectStorage {
  readonly sql: SqlStorage;
  deleteAll(): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface DurableObjectId {
  toString(): string;
}

export interface DurableObjectState {
  readonly id: DurableObjectId;
  readonly storage: DurableObjectStorage;
  waitUntil(promise: Promise<unknown>): void;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

export interface DurableObjectStub {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

/** The slice of an R2 bucket binding used for large entries. */
export interface R2Bucket {
  put(key: string, value: ArrayBuffer | ArrayBufferView): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
}

/** Workers Rate Limiting binding (`ratelimits` in the wrangler config). */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Bindings and variables of the MindooDB Worker (see `cloudflare/wrangler.jsonc`). */
export interface MindooCloudflareEnv {
  MINDOODB_SERVER: DurableObjectNamespace;
  MINDOODB_DATABASES: DurableObjectNamespace;
  /**
   * Optional R2 bucket for entries too large for Durable Object SQLite
   * (rows are capped at 2 MB). Without it such entries are refused.
   */
  MINDOODB_LARGE_ENTRIES?: R2Bucket;

  /** `server.identity.json` content (secret). Created by `cloudflare/scripts/setup.mjs`. */
  MINDOODB_SERVER_IDENTITY?: string;
  /** Password of the server identity (secret). */
  MINDOODB_SERVER_PASSWORD?: string;
  /** Base64 secret from which per-tenant sync-token keys are derived (secret). */
  MINDOODB_JWT_SECRET?: string;
  /** Initial `config.json` (capabilities); `PUT /system/config` stores a replacement. */
  MINDOODB_SERVER_CONFIG?: string;
  /** Comma-separated allowed CORS origins, like the Node server's env var. */
  MINDOODB_CORS_ORIGIN?: string;
  /** JSON body limit, e.g. "5mb" (default). */
  MINDOODB_JSON_BODY_LIMIT?: string;
  /** RFC 3161 providers, same syntax as on Node. */
  MINDOODB_TSA_PROVIDERS?: string;
  MINDOODB_ALLOW_INSECURE_SYNC_URLS?: string;
  /** `0`/`false` refuses pre-v2 login challenge signatures, like on Node. */
  MINDOODB_ACCEPT_LEGACY_CHALLENGE_SIGNATURES?: string;

  /** Optional rate limiters; without them the tier is not enforced. */
  MINDOODB_RATE_LIMIT_GLOBAL?: RateLimitBinding;
  MINDOODB_RATE_LIMIT_AUTH?: RateLimitBinding;
  MINDOODB_RATE_LIMIT_SYNC?: RateLimitBinding;
  MINDOODB_RATE_LIMIT_SYSTEM?: RateLimitBinding;
  MINDOODB_RATE_LIMIT_TIMESTAMP?: RateLimitBinding;
  MINDOODB_RATE_LIMIT_PEER?: RateLimitBinding;
}
