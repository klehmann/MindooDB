/**
 * HTTP glue between the Workers `fetch` API and the platform-neutral handlers:
 * route matching, body parsing, responses, CORS and security headers. The
 * Node server gets the same from Express, helmet, cors and body-parser; this
 * module mirrors their observable behaviour for the MindooDB API.
 */

import { BINARY_ENTRIES_CONTENT_TYPE } from "../core/appendonlystores/network/binaryEntryFraming";
import { StoreKind } from "../core/appendonlystores/types";
import { SYNC_ROUTES, type SyncRouteName } from "../server/http/MindooDBServerCore";
import {
  isBytesResponse,
  isJsonResponse,
  type ServerRequest,
  type ServerResponse,
} from "../server/http/types";
import { TIMESTAMP_QUERY_CONTENT_TYPE } from "../server/timestampProxy";

/** Headers the Worker sets on requests it forwards to Durable Objects. */
export const INTERNAL_HEADER = {
  clientIp: "x-mindoodb-client-ip",
  /** The sync-events read gate already ran against `?dbId=` in that database's object. */
  eventsGatePassed: "x-mindoodb-events-gate-passed",
  /**
   * Marks calls between the objects themselves. `/internal/*` routes refuse
   * requests without it; the Worker drops every `x-mindoodb-*` header a
   * client sends, so no outside request can carry it.
   */
  internalCall: "x-mindoodb-internal-call",
} as const;

export function isInternalCall(request: Request): boolean {
  return request.headers.get(INTERNAL_HEADER.internalCall) === "1";
}

/** Host name of requests between the Worker and its Durable Objects. */
export const INTERNAL_ORIGIN = "https://mindoodb.internal";

export type MatchedRoute =
  | { kind: "health" }
  | { kind: "serverInfo" }
  | { kind: "clusterMirrors" }
  | { kind: "publicInfosFingerprints"; tenantId: string }
  | { kind: "unsupported"; feature: string }
  | { kind: "system"; path: string }
  | { kind: "peer"; path: string }
  | { kind: "tenantAuth"; tenantId: string; phase: "challenge" | "authenticate" }
  | { kind: "timestamp"; tenantId: string }
  | { kind: "sync"; tenantId: string; storeKind: StoreKind; name: SyncRouteName }
  | { kind: "tenantNotFound"; tenantId: string }
  | { kind: "notFound" };

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Map a request onto the API. Like Express's defaults, literal segments match
 * case-insensitively and a trailing slash is ignored.
 */
export function matchRoute(method: string, pathname: string): MatchedRoute {
  const trimmed = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const segments = trimmed.split("/").slice(1).map(decodeSegment);
  const lower = segments.map((segment) => segment.toLowerCase());
  const m = method.toUpperCase();

  if (m === "GET" && lower.length === 1 && lower[0] === "health") return { kind: "health" };
  if (lower[0] === ".well-known") {
    if (m === "GET" && lower.length === 2 && lower[1] === "mindoodb-server-info") return { kind: "serverInfo" };
    if (m === "GET" && lower.length === 2 && lower[1] === "mindoodb-cluster") return { kind: "clusterMirrors" };
    if (
      m === "GET" &&
      lower.length === 4 &&
      lower[1] === "mindoodb-tenants" &&
      lower[3] === "publicinfos-fingerprints"
    ) {
      return { kind: "publicInfosFingerprints", tenantId: segments[2] };
    }
    return { kind: "notFound" };
  }
  if (lower[0] === "device") return { kind: "unsupported", feature: "Device discovery" };
  if (lower[0] === "system") {
    if (lower[1] === "peer") return { kind: "peer", path: trimmed };
    return { kind: "system", path: trimmed };
  }
  if (lower.length < 2 || segments[0] === "") return { kind: "notFound" };

  const tenantId = segments[0];
  if (m === "POST" && lower.length === 3 && lower[1] === "auth") {
    if (lower[2] === "challenge" || lower[2] === "authenticate") {
      return { kind: "tenantAuth", tenantId, phase: lower[2] };
    }
  }
  if (m === "POST" && lower.length === 3 && lower[1] === "timestamps" && lower[2] === "rfc3161") {
    return { kind: "timestamp", tenantId };
  }
  if (lower.length === 4 && lower[1] === "sync") {
    const storeKind = lower[2] === "docs" ? StoreKind.docs : lower[2] === "attachments" ? StoreKind.attachments : null;
    const route = SYNC_ROUTES.find((candidate) => candidate.name.toLowerCase() === lower[3]);
    if (storeKind && route && route.method === m) {
      return { kind: "sync", tenantId, storeKind, name: route.name };
    }
  }
  // Express runs the tenant guard before matching tenant routes, so an
  // unknown tenant answers 404 "not found on server" for any path below it.
  return { kind: "tenantNotFound", tenantId };
}

export function jsonResponse(status: number, body: unknown, headers?: HeadersInit): Response {
  const result = new Response(JSON.stringify(body), { status, headers });
  result.headers.set("content-type", "application/json; charset=utf-8");
  return result;
}

/** Turn a handler result into a `Response`. Event streams are the caller's business. */
export function toResponse(response: ServerResponse): Response {
  if (isJsonResponse(response)) {
    return jsonResponse(response.status, response.json, response.headers);
  }
  if (isBytesResponse(response)) {
    // Cloudflare compresses at the edge when the client accepts it.
    return new Response(response.bytes as unknown as BodyInit, { status: response.status, headers: response.headers });
  }
  throw new Error("Event stream responses must be handled by the caller");
}

function parseBodyLimit(contentType: string | null): "json" | "raw" | "none" {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (type === "application/json" || type.endsWith("+json")) return "json";
  if (type === BINARY_ENTRIES_CONTENT_TYPE || type === TIMESTAMP_QUERY_CONTENT_TYPE) return "raw";
  return "none";
}

export interface ParseRequestOptions {
  params: Record<string, string | undefined>;
  jsonBodyLimitBytes: number | null;
  /** Body bytes the Worker already read (to route by `dbId`). */
  body?: Uint8Array;
}

/**
 * Build a {@link ServerRequest}, or the error response body-parser would have
 * sent (413 too large, 400 invalid JSON).
 */
export async function toServerRequest(
  request: Request,
  options: ParseRequestOptions,
): Promise<ServerRequest | Response> {
  const url = new URL(request.url);
  const headers: Record<string, string | undefined> = {};
  request.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  const query: Record<string, unknown> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    query[key] = values.length === 1 ? values[0] : values;
  }

  let body: any = {};
  let rawBody: Uint8Array | undefined;
  let jsonBodyBytes: number | undefined;
  const kind = parseBodyLimit(request.headers.get("content-type"));
  if (kind !== "none" && request.method !== "GET" && request.method !== "HEAD") {
    const bytes = options.body ?? new Uint8Array(await request.arrayBuffer());
    if (options.jsonBodyLimitBytes !== null && bytes.byteLength > options.jsonBodyLimitBytes) {
      return jsonResponse(413, { error: "Request body too large" });
    }
    if (kind === "json") {
      if (bytes.byteLength > 0) {
        try {
          body = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          return jsonResponse(400, { error: "Invalid JSON body" });
        }
        jsonBodyBytes = bytes.byteLength;
      }
    } else {
      rawBody = bytes;
    }
  }

  return {
    method: request.method.toUpperCase(),
    path: url.pathname,
    params: options.params,
    query,
    headers,
    body,
    rawBody,
    jsonBodyBytes,
    httpVersion: "1.1",
    clientIp: headers[INTERNAL_HEADER.clientIp] ?? headers["cf-connecting-ip"],
  };
}

/**
 * Headers helmet sets by default on the Node server. Kept identical so a
 * client sees the same security posture from both hosts.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' https: 'unsafe-inline';upgrade-insecure-requests",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "origin-agent-cluster": "?1",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-dns-prefetch-control": "off",
  "x-download-options": "noopen",
  "x-frame-options": "SAMEORIGIN",
  "x-permitted-cross-domain-policies": "none",
  "x-xss-protection": "0",
};

export function parseCorsOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The `Access-Control-Allow-Origin` value the `cors` package would send:
 * a single configured origin always, one of several only when it matches.
 */
function allowedOrigin(origins: string[], requestOrigin: string | null): string | null {
  if (origins.length === 0) return null;
  if (origins.length === 1) return origins[0];
  return requestOrigin && origins.includes(requestOrigin) ? requestOrigin : null;
}

/** Answer a CORS preflight, or null when CORS is off (then OPTIONS falls through). */
export function corsPreflight(request: Request, origins: string[]): Response | null {
  if (request.method !== "OPTIONS" || origins.length === 0) return null;
  const response = new Response(null, { status: 204 });
  const origin = allowedOrigin(origins, request.headers.get("origin"));
  if (origin) response.headers.set("access-control-allow-origin", origin);
  response.headers.set("vary", "Origin, Access-Control-Request-Headers");
  response.headers.set("access-control-allow-methods", "GET,POST,PUT,DELETE");
  response.headers.set("access-control-allow-headers", "Content-Type,Authorization");
  response.headers.set("content-length", "0");
  return withSecurityHeaders(response);
}

/** Security and CORS headers on every response. */
export function decorateResponse(request: Request, response: Response, origins: string[]): Response {
  // Responses from fetch() and Durable Objects have immutable headers.
  const decorated = new Response(response.body, response);
  const origin = allowedOrigin(origins, request.headers.get("origin"));
  if (origin) {
    decorated.headers.set("access-control-allow-origin", origin);
    decorated.headers.append("vary", "Origin");
  }
  return withSecurityHeaders(decorated);
}

function withSecurityHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!response.headers.has(name)) response.headers.set(name, value);
  }
  return response;
}

/**
 * Rate-limit key for a client address. IPv6 addresses collapse to their /56
 * prefix like express-rate-limit's `ipKeyGenerator`: one client routinely
 * holds many addresses of a /64.
 */
export function clientAddressKey(address: string | null | undefined): string {
  if (!address) return "unknown";
  if (!address.includes(":")) return address;
  const [head, tail = ""] = address.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const groups = address.includes("::")
    ? [...headGroups, ...new Array(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill("0"), ...tailGroups]
    : headGroups;
  const hex = groups.slice(0, 4).map((group) => group.padStart(4, "0"));
  if (hex.length < 4) return address;
  return `${hex[0]}:${hex[1]}:${hex[2]}:${hex[3].substring(0, 2)}00::/56`;
}
