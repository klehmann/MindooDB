/**
 * Binary wire format v2 for entry transfer (sync-v5, phase 3).
 *
 * Replaces JSON+base64 bodies on the two payload-heavy endpoints
 * (`getEntries` response, `putEntries` request) with a simple
 * length-prefixed `application/octet-stream` framing:
 *
 * ```
 * [u32 headerLen][header JSON]
 * repeated per entry:
 *   [u32 metaLen][metadata JSON]
 *   [u32 payloadLen][payload bytes]
 * ```
 *
 * All u32 length prefixes are big-endian. Metadata stays JSON (small,
 * compresses well, schema-flexible); only the payload bytes — which are
 * encrypted and therefore incompressible — travel raw. This removes the
 * ~33 % base64 inflation and the cost of JSON-parsing multi-megabyte bodies.
 *
 * The header JSON carries the format discriminator (`format`) and any
 * batch-level fields (e.g. the RSA-wrapped session key of a `getEntries`
 * response). No new dependency is required.
 */

/** Format tag of a binary `getEntries` response (session-key encrypted). */
export const BINARY_GET_ENTRIES_FORMAT = "mdb-entries-v2";

/** Format tag of a binary `putEntries` request. */
export const BINARY_PUT_ENTRIES_FORMAT = "mdb-put-v2";

/** MIME type used for binary entry bodies. */
export const BINARY_ENTRIES_CONTENT_TYPE = "application/octet-stream";

export interface BinaryEntryFrame {
  /** JSON-safe metadata object (already serialized form, e.g. base64 signatures). */
  meta: Record<string, unknown>;
  /** Raw payload bytes for this entry. */
  payload: Uint8Array;
}

export interface BinaryEntryMessage {
  /** Batch-level header (must contain a `format` discriminator). */
  header: Record<string, unknown>;
  entries: BinaryEntryFrame[];
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Encode a batch-level header plus entry frames into one binary body.
 */
export function encodeBinaryEntryMessage(message: BinaryEntryMessage): Uint8Array {
  const headerBytes = textEncoder.encode(JSON.stringify(message.header));
  const metaBytes: Uint8Array[] = new Array(message.entries.length);

  let total = 4 + headerBytes.length;
  for (let i = 0; i < message.entries.length; i++) {
    const meta = textEncoder.encode(JSON.stringify(message.entries[i].meta));
    metaBytes[i] = meta;
    total += 4 + meta.length + 4 + message.entries[i].payload.length;
  }

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;

  view.setUint32(offset, headerBytes.length, false);
  offset += 4;
  out.set(headerBytes, offset);
  offset += headerBytes.length;

  for (let i = 0; i < message.entries.length; i++) {
    const meta = metaBytes[i];
    const payload = message.entries[i].payload;
    view.setUint32(offset, meta.length, false);
    offset += 4;
    out.set(meta, offset);
    offset += meta.length;
    view.setUint32(offset, payload.length, false);
    offset += 4;
    out.set(payload, offset);
    offset += payload.length;
  }

  return out;
}

/**
 * Compute the exact encoded size of a message without building it.
 * Used by clients to partition batches against the server body-size limit.
 */
export function measureBinaryEntryMessage(
  header: Record<string, unknown>,
  entries: BinaryEntryFrame[],
): number {
  let total = 4 + textEncoder.encode(JSON.stringify(header)).length;
  for (const entry of entries) {
    total +=
      4 + textEncoder.encode(JSON.stringify(entry.meta)).length + 4 + entry.payload.length;
  }
  return total;
}

/**
 * Decode a binary entry body produced by {@link encodeBinaryEntryMessage}.
 *
 * Every length prefix is validated against the remaining buffer before use,
 * so truncated or corrupted bodies fail with a clear error instead of an
 * out-of-bounds read.
 */
export function decodeBinaryEntryMessage(data: Uint8Array): BinaryEntryMessage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;

  const readChunk = (what: string): Uint8Array => {
    if (offset + 4 > data.byteLength) {
      throw new Error(`Truncated binary entry message while reading ${what} length`);
    }
    const length = view.getUint32(offset, false);
    offset += 4;
    if (offset + length > data.byteLength) {
      throw new Error(`Truncated binary entry message while reading ${what} (${length} bytes)`);
    }
    const chunk = data.subarray(offset, offset + length);
    offset += length;
    return chunk;
  };

  const headerChunk = readChunk("header");
  const header = JSON.parse(textDecoder.decode(headerChunk)) as Record<string, unknown>;

  const entries: BinaryEntryFrame[] = [];
  while (offset < data.byteLength) {
    const metaChunk = readChunk("entry metadata");
    const payload = readChunk("entry payload");
    entries.push({
      meta: JSON.parse(textDecoder.decode(metaChunk)) as Record<string, unknown>,
      // Copy the payload out of the shared body buffer so callers can retain
      // it without pinning the whole response body in memory.
      payload: new Uint8Array(payload),
    });
  }

  return { header, entries };
}
