/**
 * Response compression middleware (sync-v5, phase 3).
 *
 * Compresses JSON responses with brotli or gzip based on the client's
 * `Accept-Encoding` header, using Node's built-in `zlib` (no dependency).
 *
 * Scope: only `res.json(...)` responses are compressed — that covers every
 * sync/auth/system endpoint of the MindooDB server. The biggest win is on the
 * highly redundant metadata endpoints (`scanEntriesSince`, `findNewEntries`,
 * `hasEntries`, bloom summaries), which typically shrink 5–10×; base64
 * payload responses still shrink by ~25 %. Binary (`application/octet-stream`)
 * responses are left alone: their payloads are encrypted and incompressible.
 *
 * Server-Sent-Events and other streaming responses never go through
 * `res.json`, so they are unaffected by design.
 */

import type { Request, Response, NextFunction } from "express";
import * as zlib from "zlib";

/** Do not compress bodies smaller than this (headers would outweigh the win). */
export const COMPRESSION_THRESHOLD_BYTES = 1024;

/**
 * Brotli quality for dynamic responses. The default (11) is designed for
 * static assets and is far too slow for per-request compression; 4 is the
 * common dynamic-content setting (fast, still noticeably better than gzip).
 */
const BROTLI_DYNAMIC_QUALITY = 4;

type SupportedEncoding = "br" | "gzip";

/** Pick the best encoding the client advertises, preferring brotli. */
function chooseEncoding(acceptEncoding: string | undefined): SupportedEncoding | null {
  if (!acceptEncoding) {
    return null;
  }
  const normalized = acceptEncoding.toLowerCase();
  // Reject explicit q=0 opt-outs; otherwise a simple substring check is
  // sufficient for the encodings we offer.
  const accepts = (name: string): boolean => {
    const match = normalized
      .split(",")
      .map((part) => part.trim())
      .find((part) => part === name || part.startsWith(`${name};`));
    if (!match) return false;
    const q = /;\s*q=([0-9.]+)/.exec(match);
    return !q || Number(q[1]) > 0;
  };
  if (accepts("br")) return "br";
  if (accepts("gzip")) return "gzip";
  return null;
}

function compress(
  raw: Buffer,
  encoding: SupportedEncoding,
  level: { brotliQuality: number; gzipLevel: number } = {
    brotliQuality: BROTLI_DYNAMIC_QUALITY,
    gzipLevel: zlib.constants.Z_DEFAULT_COMPRESSION,
  },
): Promise<Buffer> {
  // Re-view the buffer to satisfy zlib's InputType (excludes SharedArrayBuffer-backed views).
  const input = new Uint8Array(raw.buffer as ArrayBuffer, raw.byteOffset, raw.byteLength);
  return new Promise((resolve, reject) => {
    if (encoding === "br") {
      zlib.brotliCompress(
        input,
        {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: level.brotliQuality,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
          },
        },
        (err, buf) => (err ? reject(err) : resolve(buf)),
      );
    } else {
      zlib.gzip(input, { level: level.gzipLevel }, (err, buf) => (err ? reject(err) : resolve(buf)));
    }
  });
}

/**
 * Below this share of compressible bytes a binary entry body is sent as is:
 * the encrypted payloads do not shrink, so compressing an attachment batch
 * would only burn server CPU.
 */
const BINARY_MIN_COMPRESSIBLE_SHARE = 0.25;

/**
 * Send a binary entry body (`application/octet-stream`, see
 * binaryEntryFraming.ts), compressed when the client accepts it and enough
 * of the body is metadata.
 *
 * The metadata JSON in each frame (ids, hashes, keys, signatures) shrinks by
 * roughly 40 %; the encrypted payloads are incompressible. Fastest settings
 * on purpose: at brotli quality 1 a 250-entry batch compresses in about a
 * millisecond and saves as much as quality 4, and the payload part costs
 * almost nothing because brotli stores incompressible blocks raw.
 *
 * @param compressibleBytes How many bytes of `body` are metadata.
 */
export async function sendBinaryEntryBody(
  req: Request,
  res: Response,
  body: Uint8Array,
  compressibleBytes: number,
): Promise<void> {
  const raw = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const encoding =
    raw.length >= COMPRESSION_THRESHOLD_BYTES &&
    compressibleBytes >= raw.length * BINARY_MIN_COMPRESSIBLE_SHARE
      ? chooseEncoding(req.headers["accept-encoding"] as string | undefined)
      : null;
  if (encoding) {
    try {
      const compressed = await compress(raw, encoding, { brotliQuality: 1, gzipLevel: 1 });
      res.setHeader("Content-Encoding", encoding);
      res.setHeader("Vary", "Accept-Encoding");
      res.send(compressed);
      return;
    } catch {
      // Fall through to the uncompressed body.
    }
  }
  res.send(raw);
}

/**
 * Express middleware that transparently compresses `res.json` bodies above
 * {@link COMPRESSION_THRESHOLD_BYTES} when the client accepts br/gzip.
 */
export function jsonCompressionMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const originalJson = res.json.bind(res);

  res.json = ((body: unknown): Response => {
    const payload = JSON.stringify(body);
    const raw = Buffer.from(payload ?? "null", "utf-8");
    const encoding =
      raw.length >= COMPRESSION_THRESHOLD_BYTES
        ? chooseEncoding(req.headers["accept-encoding"] as string | undefined)
        : null;

    if (!encoding) {
      return originalJson(body);
    }

    // Compress asynchronously off the response path; fall back to the plain
    // JSON body if compression fails for any reason.
    void compress(raw, encoding)
      .then((compressed) => {
        if (res.headersSent) {
          return;
        }
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Content-Encoding", encoding);
        res.setHeader("Vary", "Accept-Encoding");
        res.send(compressed);
      })
      .catch(() => {
        if (!res.headersSent) {
          originalJson(body);
        }
      });
    return res;
  }) as Response["json"];

  next();
}
