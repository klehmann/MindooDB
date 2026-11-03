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

  /** Optional rate limiters; without them the tier is not enforced. */
  MINDOODB_RATE_LIMIT_GLOBAL?: RateLimitBinding;
  MINDOODB_RATE_LIMIT_AUTH?: RateLimitBinding;
  MINDOODB_RATE_LIMIT_SYNC?: RateLimitBinding;
  MINDOODB_RATE_LIMIT_SYSTEM?: RateLimitBinding;
  MINDOODB_RATE_LIMIT_TIMESTAMP?: RateLimitBinding;
  MINDOODB_RATE_LIMIT_PEER?: RateLimitBinding;
}
