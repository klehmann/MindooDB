/**
 * Framework-neutral request and response shapes of the MindooDB server.
 *
 * The route handlers in {@link MindooDBServerCore} take a {@link ServerRequest}
 * and return a {@link ServerResponse}. A host adapts its HTTP stack to these:
 * Express on Node (`node/server/MindooDBServer.ts`), the `fetch` handler of a
 * serverless runtime elsewhere. Transport concerns that differ per host — body
 * parsing limits, compression, CORS, security headers, rate-limit storage,
 * streaming — stay in the adapter.
 */

import type { StoreKind } from "../../core/appendonlystores/types";
import type { SyncChangeEvent } from "../SyncEventBus";

export interface ServerRequest {
  /** Upper-case HTTP method. */
  method: string;
  /** Request path as the route saw it (used in logs only). */
  path: string;
  /** Route parameters, already URL-decoded (`tenantId`, `backupFile`, …). */
  params: Record<string, string | undefined>;
  /** Query string values; a host may hand over repeated keys as arrays. */
  query: Record<string, unknown>;
  /** Header values by lower-case name. */
  headers: Record<string, string | undefined>;
  /** Parsed JSON body; an empty object when the request had none. */
  body: any;
  /** Raw body of the octet-stream routes (`putEntriesBinary`, RFC 3161). */
  rawBody?: Uint8Array;
  /** Byte size of the parsed JSON body, for diagnostics. */
  jsonBodyBytes?: number;
  /** "1.1", "2.0", … when the host knows it. */
  httpVersion?: string;
  /** Client address as used for logs. */
  clientIp?: string;

  // Set by the guards below, then read by handlers and rate-limit keys.
  /** Validated, lower-cased tenant id ({@link MindooDBServerCore.tenantGuard}). */
  tenantId?: string;
  /** Authenticated system admin ({@link MindooDBServerCore.systemAdminGuard}). */
  systemAdmin?: { username: string; publicsignkey: string };
  /** Caller of a sync request, when its token verified. */
  syncPrincipal?: string;
  /** Caller of a timestamp request. */
  timestampPrincipal?: string;
  /** Trusted server behind a peer token ({@link PeerHttpHandlers.peerGuard}). */
  peerName?: string;
}

/** A sync event subscription the host keeps open as a Server-Sent-Events stream. */
export interface SyncEventStreamSpec {
  tenantId: string;
  storeKind: StoreKind;
}

export type ServerResponse =
  | {
      status: number;
      json: unknown;
      headers?: Record<string, string>;
    }
  | {
      status: number;
      bytes: Uint8Array;
      headers: Record<string, string>;
      /**
       * Set for binary entry messages: the bytes that are framing and metadata
       * rather than encrypted payload. A host compresses only when this part
       * is large enough to be worth it.
       */
      binaryEntryFrameBytes?: number;
    }
  | {
      status: 200;
      events: SyncEventStreamSpec;
    };

/** Hand-off for work that must finish after the response (fire-and-forget on Node). */
export type BackgroundTaskScheduler = (task: Promise<unknown>) => void;

/** What the change-event handlers need from the host's event bus. */
export interface SyncEventPublisher {
  publish(event: SyncChangeEvent): void;
  /** Publishing is skipped entirely while nobody listens. */
  readonly listenerCount: number;
}

export function jsonResponse(
  status: number,
  json: unknown,
  headers?: Record<string, string>,
): ServerResponse {
  return headers ? { status, json, headers } : { status, json };
}

export function isJsonResponse(
  response: ServerResponse,
): response is Extract<ServerResponse, { json: unknown }> {
  return "json" in response;
}

export function isBytesResponse(
  response: ServerResponse,
): response is Extract<ServerResponse, { bytes: Uint8Array }> {
  return "bytes" in response;
}

export function isEventStreamResponse(
  response: ServerResponse,
): response is Extract<ServerResponse, { events: SyncEventStreamSpec }> {
  return "events" in response;
}
