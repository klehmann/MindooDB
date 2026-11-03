/**
 * The MindooDB Worker: routes every request of the MindooDB HTTP API to the
 * Durable Object that serves it.
 *
 * - `/system/*` and discovery → the server object (config, tenants, key bag)
 * - `/:tenantId/auth/*`, `/:tenantId/timestamps/*`, the event stream → the
 *   tenant's `directory` object
 * - `/:tenantId/sync/:kind/:op` → the object of the database named by `dbId`
 *   (query string for GET, JSON body, or the binary message header)
 *
 * Paths, status codes and bodies match the Node server.
 */

import {
  BINARY_ENTRIES_CONTENT_TYPE,
  decodeBinaryEntryMessage,
} from "../core/appendonlystores/network/binaryEntryFraming";
import { validateIdentifier, validateTenantIdFormat, ValidationError } from "../server/validation";
import {
  clientAddressKey,
  corsPreflight,
  decorateResponse,
  INTERNAL_HEADER,
  INTERNAL_ORIGIN,
  jsonResponse,
  matchRoute,
  parseCorsOrigins,
  type MatchedRoute,
} from "./http";
import { createHostSettings, databaseObject, OBJECT_HEADER, rateLimited, serverObject } from "./host";
import type { ExecutionContext, MindooCloudflareEnv } from "./types";

const DIRECTORY_DB_ID = "directory";

/** Copy of the request for an object, with internal headers set and client-supplied ones dropped. */
function forward(
  request: Request,
  url: URL,
  body: Uint8Array | null,
  headers: Record<string, string>,
): Request {
  const forwarded = new Headers();
  request.headers.forEach((value, name) => {
    if (!name.toLowerCase().startsWith("x-mindoodb-")) forwarded.set(name, value);
  });
  for (const [name, value] of Object.entries(headers)) forwarded.set(name, value);
  return new Request(`${INTERNAL_ORIGIN}${url.pathname}${url.search}`, {
    method: request.method,
    headers: forwarded,
    body: body && request.method !== "GET" && request.method !== "HEAD" ? (body as unknown as BodyInit) : undefined,
  });
}

/** The database a sync request is for, from wherever the client put `dbId`. */
function syncDbId(request: Request, url: URL, body: Uint8Array | null, name: string): unknown {
  if (request.method === "GET") {
    const dbId = url.searchParams.get("dbId");
    return name === "events" ? dbId || DIRECTORY_DB_ID : dbId;
  }
  if (!body) return undefined;
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (contentType === BINARY_ENTRIES_CONTENT_TYPE) {
    try {
      return decodeBinaryEntryMessage(body).header.dbId;
    } catch {
      return undefined;
    }
  }
  try {
    return (JSON.parse(new TextDecoder().decode(body)) as { dbId?: unknown })?.dbId;
  } catch {
    return undefined;
  }
}

async function handle(
  request: Request,
  env: MindooCloudflareEnv,
  route: MatchedRoute,
  url: URL,
  clientIp: string,
): Promise<Response> {
  const internal = { [INTERNAL_HEADER.clientIp]: clientIp };
  switch (route.kind) {
    case "health":
      return jsonResponse(200, { status: "ok", timestamp: Date.now() });

    case "notFound":
      return jsonResponse(404, { error: "Not found" });

    case "unsupported":
      return jsonResponse(501, { error: `${route.feature} is not available on this server` });

    case "serverInfo":
    case "clusterMirrors":
    case "publicInfosFingerprints":
      return serverObject(env).fetch(forward(request, url, null, internal));

    case "system": {
      const limited = await rateLimited(
        env.MINDOODB_RATE_LIMIT_SYSTEM,
        `system:${clientAddressKey(clientIp)}`,
        "Too many system requests, please try again later",
      );
      if (limited) return limited;
      const body = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
      return serverObject(env).fetch(forward(request, url, body, internal));
    }
  }

  // Everything below is tenant-scoped.
  const tenantId = route.tenantId.toLowerCase();
  try {
    validateTenantIdFormat(tenantId);
  } catch {
    return jsonResponse(400, { error: "Invalid tenant ID format" });
  }
  const body = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
  const settings = createHostSettings(env);
  if (body && settings.jsonBodyLimitBytes !== null && body.byteLength > settings.jsonBodyLimitBytes) {
    return jsonResponse(413, { error: "Request body too large" });
  }
  const toObject = (dbId: string, extra: Record<string, string> = {}) =>
    databaseObject(env, tenantId, dbId).fetch(
      forward(request, url, body, {
        ...internal,
        ...extra,
        [OBJECT_HEADER.tenantId]: tenantId,
        [OBJECT_HEADER.dbId]: dbId,
      }),
    );

  if (route.kind !== "sync") {
    return toObject(DIRECTORY_DB_ID);
  }

  let dbId: string;
  try {
    dbId = validateIdentifier(syncDbId(request, url, body, route.name), "dbId");
  } catch (error) {
    // The object reports a missing tenant first, as the Node server does.
    const message = error instanceof ValidationError ? error.message : "Invalid dbId";
    const probe = await toObject(DIRECTORY_DB_ID);
    return probe.status === 404 ? probe : jsonResponse(400, { error: message });
  }

  if (route.name !== "events") {
    return toObject(dbId);
  }
  // The read gate of an event stream runs in the database it names; the
  // stream itself lives in the tenant's directory object, where every
  // database of the tenant publishes its changes.
  if (dbId !== DIRECTORY_DB_ID) {
    const gateUrl = new URL(url);
    gateUrl.pathname = url.pathname.replace(/\/events\/?$/i, "/capabilities");
    const gate = await databaseObject(env, tenantId, dbId).fetch(
      forward(request, gateUrl, null, {
        ...internal,
        [OBJECT_HEADER.tenantId]: tenantId,
        [OBJECT_HEADER.dbId]: dbId,
      }),
    );
    if (!gate.ok) return gate;
    return toObject(DIRECTORY_DB_ID, { [INTERNAL_HEADER.eventsGatePassed]: "1" });
  }
  return toObject(DIRECTORY_DB_ID);
}

export default {
  async fetch(request: Request, env: MindooCloudflareEnv, _ctx: ExecutionContext): Promise<Response> {
    const origins = parseCorsOrigins(env.MINDOODB_CORS_ORIGIN);
    const preflight = corsPreflight(request, origins);
    if (preflight) return preflight;

    const url = new URL(request.url);
    const clientIp = request.headers.get("cf-connecting-ip") ?? "unknown";
    try {
      const limited = await rateLimited(
        env.MINDOODB_RATE_LIMIT_GLOBAL,
        `global:${clientAddressKey(clientIp)}`,
        "Too many requests, please try again later",
      );
      const response =
        limited ?? (await handle(request, env, matchRoute(request.method, url.pathname), url, clientIp));
      return decorateResponse(request, response, origins);
    } catch (error) {
      console.error("[MindooDB Worker] Unhandled error:", error);
      return decorateResponse(request, jsonResponse(500, { error: "Internal server error" }), origins);
    }
  },
};
