/**
 * Settings and helpers shared by the Worker and its Durable Objects.
 */

import { parseBodySizeLimitToBytes } from "../server/http/MindooDBServerCore";
import { parseTsaProviders, type TsaProviderConfig } from "../server/timestampProxy";
import type { ServerDataStore } from "../server/ServerDataStore";
import { base64ToBytes } from "../core/utils/base64";
import { INTERNAL_HEADER, jsonResponse } from "./http";
import type { DurableObjectStub, MindooCloudflareEnv, RateLimitBinding } from "./types";

/**
 * Workers' WebCrypto refuses PBKDF2 above 100 000 iterations. Key bags the
 * server derives itself use this count; the server identity must be created
 * with it as well (`cloudflare/scripts/setup.mjs` does).
 */
export const WORKERS_PBKDF2_ITERATIONS = 100_000;

(globalThis as { __MINDOODB_PBKDF2_ITERATIONS?: number }).__MINDOODB_PBKDF2_ITERATIONS =
  WORKERS_PBKDF2_ITERATIONS;

export interface HostSettings {
  jsonBodyLimit: string;
  jsonBodyLimitBytes: number | null;
  tsaProviders: TsaProviderConfig[];
  allowInsecureSyncUrls: boolean;
}

export function createHostSettings(env: MindooCloudflareEnv): HostSettings {
  const jsonBodyLimit = env.MINDOODB_JSON_BODY_LIMIT?.trim() || "5mb";
  const allowInsecureSyncUrls = /^(1|true)$/i.test(env.MINDOODB_ALLOW_INSECURE_SYNC_URLS ?? "");
  return {
    jsonBodyLimit,
    jsonBodyLimitBytes: parseBodySizeLimitToBytes(jsonBodyLimit),
    tsaProviders: parseTsaProviders(env.MINDOODB_TSA_PROVIDERS, {
      allowInsecureUrls: allowInsecureSyncUrls,
    }),
    allowInsecureSyncUrls,
  };
}

/** Put the server identity from the secret where the tenant manager reads it. */
export function seedServerIdentity(dataStore: ServerDataStore, env: MindooCloudflareEnv): void {
  const identity = env.MINDOODB_SERVER_IDENTITY?.trim();
  if (identity && dataStore.readText("server.identity.json") !== identity) {
    dataStore.writeText("server.identity.json", identity);
  }
}

/** Headers naming the addressed object's tenant and database on every request to it. */
export const OBJECT_HEADER = {
  tenantId: "x-mindoodb-tenant",
  dbId: "x-mindoodb-db",
} as const;

export function objectHeaders(tenantId: string, dbId: string): Record<string, string> {
  return { [OBJECT_HEADER.tenantId]: tenantId, [OBJECT_HEADER.dbId]: dbId };
}

/** Headers of a call from one object to another (reaches `/internal/*`). */
export function internalHeaders(tenantId?: string, dbId?: string): Record<string, string> {
  return {
    ...(tenantId && dbId ? objectHeaders(tenantId, dbId) : {}),
    [INTERNAL_HEADER.internalCall]: "1",
  };
}

/** The object serving one database of a tenant; `directory` is also the tenant's hub. */
export function databaseObject(
  env: MindooCloudflareEnv,
  tenantId: string,
  dbId: string,
): DurableObjectStub {
  return env.MINDOODB_DATABASES.get(env.MINDOODB_DATABASES.idFromName(`${tenantId}/${dbId}`));
}

export function serverObject(env: MindooCloudflareEnv): DurableObjectStub {
  return env.MINDOODB_SERVER.get(env.MINDOODB_SERVER.idFromName("server"));
}

/**
 * Enforce one limiter tier; returns the 429 to send, or null. A missing
 * binding means the tier is not configured for this deployment.
 */
export async function rateLimited(
  binding: RateLimitBinding | undefined,
  key: string,
  message: string,
): Promise<Response | null> {
  if (!binding) return null;
  const { success } = await binding.limit({ key });
  return success ? null : jsonResponse(429, { error: message });
}

/**
 * Per-tenant sync-token key: HMAC-SHA256(MINDOODB_JWT_SECRET, "tenant:<id>").
 * Every object serving the tenant derives the same key, so a token issued by
 * the tenant's directory object is accepted by all of its databases.
 */
export async function deriveTenantJwtSecret(
  env: MindooCloudflareEnv,
  tenantId: string,
): Promise<Uint8Array> {
  const secret = env.MINDOODB_JWT_SECRET?.trim();
  if (!secret) {
    throw new Error("MINDOODB_JWT_SECRET is not set; run cloudflare/scripts/setup.mjs");
  }
  const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey(
    "raw",
    base64ToBytes(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await subtle.sign("HMAC", key, new TextEncoder().encode(`tenant:${tenantId}`));
  return new Uint8Array(mac);
}
