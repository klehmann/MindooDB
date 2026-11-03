/**
 * Glue between Express and the platform-neutral handlers in
 * {@link MindooDBServerCore}: turns an Express request into a
 * {@link ServerRequest} and writes a {@link ServerResponse} back.
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";

import {
  isBytesResponse,
  isJsonResponse,
  type ServerRequest,
  type ServerResponse,
} from "../../server/http/types";
import { sendBinaryEntryBody } from "./compressionMiddleware";

/** Snapshot of an Express request, including what earlier guards resolved. */
export function toServerRequest(req: Request): ServerRequest {
  const rawBody = Buffer.isBuffer(req.body)
    ? new Uint8Array(req.body.buffer, req.body.byteOffset, req.body.byteLength)
    : undefined;
  return {
    method: req.method.toUpperCase(),
    path: req.path,
    params: req.params,
    query: req.query as Record<string, unknown>,
    headers: req.headers as Record<string, string | undefined>,
    body: rawBody ? {} : req.body,
    rawBody,
    jsonBodyBytes: req.jsonBodyBytes,
    httpVersion: req.httpVersion,
    clientIp: req.ip,
    tenantId: req.tenantId,
    systemAdmin: req.systemAdmin,
    syncPrincipal: req.syncPrincipal,
    timestampPrincipal: req.timestampPrincipal,
  };
}

/** Copy what a guard resolved back onto the Express request for later middleware. */
function applyGuardResults(req: Request, serverRequest: ServerRequest): void {
  req.tenantId = serverRequest.tenantId;
  req.systemAdmin = serverRequest.systemAdmin;
  req.syncPrincipal = serverRequest.syncPrincipal;
  req.timestampPrincipal = serverRequest.timestampPrincipal;
}

/** Write a JSON or binary response. Event streams are the caller's business. */
export async function sendServerResponse(
  req: Request,
  res: Response,
  response: ServerResponse,
): Promise<void> {
  if (isJsonResponse(response)) {
    for (const [name, value] of Object.entries(response.headers ?? {})) {
      res.setHeader(name, value);
    }
    res.status(response.status).json(response.json);
    return;
  }
  if (isBytesResponse(response)) {
    for (const [name, value] of Object.entries(response.headers)) {
      res.setHeader(name, value);
    }
    res.status(response.status);
    if (response.binaryEntryFrameBytes !== undefined) {
      await sendBinaryEntryBody(req, res, response.bytes, response.binaryEntryFrameBytes);
      return;
    }
    const bytes = response.bytes;
    res.send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return;
  }
  throw new Error("Event stream responses must be handled by the route");
}

/**
 * Express route handler running a core handler. Anything the handler did not
 * turn into a response goes to the Express error handler, as a throw from a
 * synchronous handler would.
 */
export function route(
  handler: (request: ServerRequest) => ServerResponse | Promise<ServerResponse>,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const response = await handler(toServerRequest(req));
      await sendServerResponse(req, res, response);
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Express middleware running a core guard: a returned response ends the
 * request, null continues with the guard's results on the request.
 */
export function guard(
  check: (request: ServerRequest) => ServerResponse | null | Promise<ServerResponse | null>,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const serverRequest = toServerRequest(req);
    let rejection: ServerResponse | null;
    try {
      rejection = await check(serverRequest);
    } catch (error) {
      next(error);
      return;
    }
    if (rejection) {
      await sendServerResponse(req, res, rejection);
      return;
    }
    applyGuardResults(req, serverRequest);
    next();
  };
}
