/**
 * Haven / CLI locator for an Iroh-reachable MindooDB server.
 *
 * Paste forms:
 * - `iroh:<ticket>` (ticket already starts with `endpoint`)
 * - raw `endpoint…` ticket
 *
 * Stored locator is `iroh:<endpointId>` so IP changes in the ticket do not
 * create a new connection row. The full ticket stays in `irohTicket`.
 */

const IROH_SCHEME = "iroh:";
const ENDPOINT_PREFIX = "endpoint";

export interface ParsedIrohLocator {
  kind: "iroh";
  /** Full ticket used to dial (with or without the `iroh:` prefix stripped). */
  ticket: string;
  /** Stable connection key, `iroh:<endpointId>` when the id can be parsed. */
  locator: string;
  /** Endpoint id when we can read it from the ticket; otherwise undefined. */
  endpointId?: string;
}

export function isIrohLocator(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith(IROH_SCHEME) || trimmed.startsWith(ENDPOINT_PREFIX);
}

/** An Iroh endpoint id is the 32-byte public key rendered as lowercase hex. */
const ENDPOINT_ID_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Bare lowercase endpoint id, or `null` when the value is not one.
 *
 * Accepts an optional `iroh:` prefix so the same string works as a locator
 * (`iroh:<id>`) and as a directory key (`<id>`). Tickets are not accepted here
 * — use {@link resolveIrohEndpointId} when the input may be either.
 */
export function normalizeIrohEndpointId(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const raw = value.trim().replace(/^iroh:/i, "").toLowerCase();
  return ENDPOINT_ID_PATTERN.test(raw) ? raw : null;
}

/**
 * Endpoint id behind any locator form — bare id, `iroh:<id>`, or a full
 * `endpoint…` ticket — or `null` when it cannot be determined.
 *
 * Use this wherever a value has to stay stable across the peer's network
 * changes: a ticket embeds the current relay and addresses, the id does not.
 */
export function resolveIrohEndpointId(value: string | null | undefined): string | null {
  const normalized = normalizeIrohEndpointId(value);
  if (normalized) {
    return normalized;
  }
  if (!value) {
    return null;
  }
  const ticket = value.trim().replace(/^iroh:/i, "");
  return extractEndpointIdFromTicket(ticket) ?? null;
}

export function parseIrohLocator(value: string): ParsedIrohLocator {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Enter an Iroh ticket first.");
  }
  const storedId = /^iroh:([0-9a-f]{64})$/i.exec(trimmed);
  if (storedId) {
    const endpointId = storedId[1].toLowerCase();
    return {
      kind: "iroh",
      ticket: "",
      locator: `${IROH_SCHEME}${endpointId}`,
      endpointId,
    };
  }
  const ticket = trimmed.startsWith(IROH_SCHEME)
    ? trimmed.slice(IROH_SCHEME.length)
    : trimmed;
  if (!ticket.startsWith(ENDPOINT_PREFIX) || ticket.length < ENDPOINT_PREFIX.length + 8) {
    throw new Error("Enter a valid Iroh endpoint ticket (or iroh:<ticket>).");
  }
  const endpointId = extractEndpointIdFromTicket(ticket);
  return {
    kind: "iroh",
    ticket,
    locator: endpointId ? `${IROH_SCHEME}${endpointId}` : `${IROH_SCHEME}${ticket}`,
    endpointId,
  };
}

/**
 * Iroh endpoint tickets are `endpoint` + base32(postcard(EndpointAddr)).
 * The first 32 bytes of the payload are the public key / endpoint id.
 * If decoding fails we still accept the ticket and use it as the locator.
 */
export function extractEndpointIdFromTicket(ticket: string): string | undefined {
  if (!ticket.startsWith(ENDPOINT_PREFIX)) {
    return undefined;
  }
  const encoded = ticket.slice(ENDPOINT_PREFIX.length).toUpperCase();
  try {
    const bytes = decodeBase32NoPad(encoded);
    if (bytes.length < 32) {
      return undefined;
    }
    return bytesToHex(bytes.subarray(0, 32));
  } catch {
    return undefined;
  }
}

function decodeBase32NoPad(input: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) {
      throw new Error("invalid base32");
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
