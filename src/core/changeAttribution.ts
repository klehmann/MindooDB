/**
 * Change attribution: who or what (besides the signing user) produced a
 * document change, e.g. an AI agent acting on the user's behalf.
 *
 * The attribution travels inside the change itself (the Automerge change
 * message), never in the plaintext store entry metadata. It is therefore
 * encrypted with the document payload, covered by the entry signature,
 * preserved by snapshots and document copies, and invisible to key-less sync
 * servers. Runtimes that do not know about it simply ignore the message.
 *
 * It is a statement of the writing runtime, not a proof: the signature proves
 * which user key wrote the change, and that the runtime claimed this origin.
 * Changes produced elsewhere (raw Automerge change bytes from a client) carry
 * whatever message their producer chose.
 */

/** Current version of the attribution format. */
export const CHANGE_ATTRIBUTION_VERSION = 1;

/** Key under which the attribution object is stored in the change message JSON. */
export const CHANGE_ATTRIBUTION_MESSAGE_KEY = "mindoo.attribution";

/** Upper bound for the encoded change message, in UTF-16 code units. */
export const MAX_CHANGE_ATTRIBUTION_MESSAGE_LENGTH = 1024;

const MAX_FIELD_LENGTH = 128;

/** Well-known agent channels; other values are allowed. */
export type ChangeAttributionVia = "haven-assistant" | "webmcp" | "mcp" | (string & {});

/**
 * Origin of a document change other than direct user input.
 *
 * Only `kind: "agent"` exists today. All string fields are short labels; they
 * never contain prompts, tool inputs or document content.
 */
export interface ChangeAttribution {
  /** Format version. Written as {@link CHANGE_ATTRIBUTION_VERSION}. */
  v: number;
  /** What produced the change. */
  kind: "agent";
  /** Channel the agent used, e.g. `"haven-assistant"`, `"webmcp"`, `"mcp"`. */
  via: ChangeAttributionVia;
  /** Application (id or name) whose tool wrote the change. */
  app?: string;
  /** Tool name that wrote the change. */
  tool?: string;
  /** Language model, when the writing runtime knows it. */
  model?: string;
  /** Groups all changes of one agent run (e.g. one assistant request). */
  runId?: string;
  /** The user explicitly confirmed this tool call before it ran. */
  confirmed?: boolean;
}

/** Input accepted where an attribution is written; `v` defaults to the current version. */
export type ChangeAttributionInput = Omit<ChangeAttribution, "v"> & { v?: number };

function cleanLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_FIELD_LENGTH ? trimmed.slice(0, MAX_FIELD_LENGTH) : trimmed;
}

function normalize(input: unknown): ChangeAttribution | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  if (raw.kind !== "agent") return undefined;
  const via = cleanLabel(raw.via);
  if (!via) return undefined;
  const v =
    typeof raw.v === "number" && Number.isInteger(raw.v) && raw.v > 0
      ? raw.v
      : CHANGE_ATTRIBUTION_VERSION;
  const result: ChangeAttribution = { v, kind: "agent", via };
  const app = cleanLabel(raw.app);
  if (app) result.app = app;
  const tool = cleanLabel(raw.tool);
  if (tool) result.tool = tool;
  const model = cleanLabel(raw.model);
  if (model) result.model = model;
  const runId = cleanLabel(raw.runId);
  if (runId) result.runId = runId;
  if (raw.confirmed === true) result.confirmed = true;
  return result;
}

/**
 * Encode an attribution as an Automerge change message. Returns `undefined`
 * when there is nothing (valid) to write.
 *
 * @throws Error when the attribution is present but malformed, so callers do
 * not silently write unattributed agent changes.
 */
export function encodeChangeAttribution(
  attribution: ChangeAttributionInput | undefined | null,
): string | undefined {
  if (attribution === undefined || attribution === null) return undefined;
  const normalized = normalize(attribution);
  if (!normalized) {
    throw new Error(
      'Invalid change attribution: expected { kind: "agent", via: <non-empty string> }',
    );
  }
  normalized.v = CHANGE_ATTRIBUTION_VERSION;
  const message = JSON.stringify({ [CHANGE_ATTRIBUTION_MESSAGE_KEY]: normalized });
  if (message.length > MAX_CHANGE_ATTRIBUTION_MESSAGE_LENGTH) {
    throw new Error("Change attribution is too large");
  }
  return message;
}

/**
 * Decode an attribution from an Automerge change message. Tolerant: messages
 * that are absent, not JSON, too large, or JSON without the attribution key
 * yield `undefined`; unknown fields are ignored.
 */
export function decodeChangeAttribution(
  message: string | null | undefined,
): ChangeAttribution | undefined {
  if (typeof message !== "string" || message.length === 0) return undefined;
  if (message.length > MAX_CHANGE_ATTRIBUTION_MESSAGE_LENGTH) return undefined;
  if (!message.includes(CHANGE_ATTRIBUTION_MESSAGE_KEY)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return normalize((parsed as Record<string, unknown>)[CHANGE_ATTRIBUTION_MESSAGE_KEY]);
}
