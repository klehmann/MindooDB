import * as http from "http";
import * as zlib from "zlib";

import express from "express";

import {
  COMPRESSION_THRESHOLD_BYTES,
  jsonCompressionMiddleware,
} from "../node/server/compressionMiddleware";

/** Re-view a Buffer as a plain Uint8Array to satisfy zlib's InputType. */
function toZlibInput(buf: Buffer): Uint8Array {
  return new Uint8Array(buf.buffer as ArrayBuffer, buf.byteOffset, buf.byteLength);
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/**
 * Raw HTTP GET without any client-side content negotiation or transparent
 * decompression (unlike fetch/undici), so the wire format can be asserted.
 */
function rawGet(port: number, path: string, headers: http.OutgoingHttpHeaders): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers },
      (res) => {
        const chunks: Uint8Array[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(toZlibInput(chunk)));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("jsonCompressionMiddleware (sync-v5 phase 3)", () => {
  let server: http.Server;
  let port: number;

  const bigPayload = {
    entries: Array.from({ length: 200 }, (_, i) => ({
      id: `entry-${i}`,
      docId: `doc-${i % 10}`,
      entryType: "doc_change",
      createdAt: 1700000000000 + i,
      receiptOrder: i + 1,
    })),
  };
  const smallPayload = { ok: true };

  beforeAll(async () => {
    const app = express();
    app.use(jsonCompressionMiddleware);
    app.get("/big", (_req, res) => {
      res.json(bigPayload);
    });
    app.get("/small", (_req, res) => {
      res.json(smallPayload);
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address();
        port = typeof address === "object" && address ? address.port : 0;
        resolve();
      });
    });

    // Sanity: the big payload must actually be above the threshold.
    expect(Buffer.byteLength(JSON.stringify(bigPayload))).toBeGreaterThan(
      COMPRESSION_THRESHOLD_BYTES,
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  test("compresses large JSON with brotli when the client accepts br", async () => {
    const res = await rawGet(port, "/big", { "Accept-Encoding": "br, gzip" });

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.headers.vary).toContain("Accept-Encoding");

    const decompressed = zlib.brotliDecompressSync(toZlibInput(res.body));
    expect(JSON.parse(decompressed.toString("utf-8"))).toEqual(bigPayload);
    // The whole point: the wire body is significantly smaller.
    expect(res.body.length).toBeLessThan(decompressed.length / 2);
  });

  test("falls back to gzip when the client only accepts gzip", async () => {
    const res = await rawGet(port, "/big", { "Accept-Encoding": "gzip" });

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");

    const decompressed = zlib.gunzipSync(toZlibInput(res.body));
    expect(JSON.parse(decompressed.toString("utf-8"))).toEqual(bigPayload);
  });

  test("sends plain JSON when the client does not accept compression", async () => {
    const res = await rawGet(port, "/big", {});

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(res.body.toString("utf-8"))).toEqual(bigPayload);
  });

  test("respects an explicit q=0 opt-out", async () => {
    const res = await rawGet(port, "/big", { "Accept-Encoding": "br;q=0, gzip;q=0" });

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(res.body.toString("utf-8"))).toEqual(bigPayload);
  });

  test("leaves small bodies uncompressed even when the client accepts br", async () => {
    const res = await rawGet(port, "/small", { "Accept-Encoding": "br, gzip" });

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(res.body.toString("utf-8"))).toEqual(smallPayload);
  });
});
