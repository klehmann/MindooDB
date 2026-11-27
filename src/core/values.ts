/**
 * Typed document values that plain JSON cannot express.
 *
 * A typed value is a tagged plain object, e.g. `{ "$mindoo": "counter",
 * "value": 0 }`. It is JSON-safe (survives postMessage, RPC and persistence)
 * and can be used anywhere a value is written: `createDocument({
 * initialValues })`, assignments inside `changeDoc()`, JSON patch `set` and
 * `listInsert` values, and nested inside any of them. MindooDB turns the tags
 * into its CRDT representation when it writes them; reads always return plain
 * values (see {@link MindooValue}). The tag format is part of the public
 * contract so that clients without this module (the App SDK) can produce it.
 *
 * The object key `$mindoo` is reserved: an object carrying it must be a valid
 * typed value, otherwise the write is rejected.
 */

/** Reserved object key that marks a typed value. */
export const MINDOO_VALUE_TAG = "$mindoo";

/**
 * A string that is replaced as a whole on concurrent writes instead of being
 * merged character by character. Reads back as a plain string.
 */
export interface MindooAtomicValue {
  $mindoo: "atomic";
  value: string;
}

/**
 * A number whose concurrent increments are summed on merge. Reads back as a
 * plain number; change it with `counterIncrement` / `incrementCounter()`.
 */
export interface MindooCounterValue {
  $mindoo: "counter";
  value: number;
}

/**
 * A point in time. `value` is epoch milliseconds or an ISO 8601 date-time
 * string. Reads back as a `Date` from `getData()`; JSON hosts (Haven, the App
 * SDK) present it as an ISO 8601 string.
 */
export interface MindooTimestampValue {
  $mindoo: "timestamp";
  value: number | string;
}

/**
 * Collaborative text, merged character by character. A plain string is
 * collaborative text as well, except from {@link LARGE_STRING_ATOMIC_THRESHOLD}
 * characters on: those are stored atomic unless written with this tag.
 */
export interface MindooTextValue {
  $mindoo: "text";
  value: string;
}

export type MindooTypedValue =
  | MindooAtomicValue
  | MindooCounterValue
  | MindooTimestampValue
  | MindooTextValue;

/**
 * Plain strings of at least this many characters are written as atomic
 * strings instead of collaborative text. Collaborative text keeps one
 * Automerge operation per character, which costs 100–500 bytes of memory per
 * character whenever the document is loaded; a 10 MB text alone exceeds what
 * a WebAssembly instance can hold. A larger string that people really edit
 * together is written with {@link MindooValue.text}; assigning a string to a
 * field that already holds text keeps it text and stores only the change.
 */
export const LARGE_STRING_ATOMIC_THRESHOLD = 64 * 1024;

/**
 * A string assigned to a field that already holds collaborative text is
 * stored as a splice of the changed part (like `updateText()`) when the old or
 * the new text has at least this many characters. Shorter strings are
 * replaced as a whole, as before, so two concurrent assignments of a short
 * value still end with one of them instead of a mix of both. Long texts are
 * where a whole rewrite costs: one new operation per character, kept forever.
 */
export const TEXT_ASSIGN_SPLICE_THRESHOLD = 1024;

export type MindooTypedValueKind = MindooTypedValue["$mindoo"];

/** Factory and helpers for {@link MindooTypedValue}s. */
export const MindooValue = {
  /**
   * An atomic string: use it for identifiers, status and enum values, URLs,
   * hashes and stored text cursors. Plain strings (below
   * {@link LARGE_STRING_ATOMIC_THRESHOLD} characters) are collaborative text,
   * where two concurrent changes of `"open"` to `"closed"` and `"blocked"` can
   * interleave into a mix of both words.
   */
  atomic(value: string): MindooAtomicValue {
    if (typeof value !== "string") {
      throw new Error("MindooValue.atomic value must be a string");
    }
    return { $mindoo: "atomic", value };
  },

  /**
   * A collaborative counter with an initial value (a safe integer). Create it
   * once; every later change should be a `counterIncrement`, because writing
   * a new counter is an assignment that does not merge with concurrent
   * increments.
   */
  counter(value = 0): MindooCounterValue {
    assertCounterAmount(value, "MindooValue.counter value");
    return { $mindoo: "counter", value };
  },

  /**
   * Collaborative text, merged character by character with concurrent edits.
   * Plain strings already are, up to {@link LARGE_STRING_ATOMIC_THRESHOLD}
   * characters; use this for a larger text that people edit together. Change
   * it later with `updateText()` or text splices.
   */
  text(value: string): MindooTextValue {
    if (typeof value !== "string") {
      throw new Error("MindooValue.text value must be a string");
    }
    return { $mindoo: "text", value };
  },

  /** A timestamp from a `Date`, epoch milliseconds or an ISO 8601 string. */
  timestamp(value: Date | number | string): MindooTimestampValue {
    return {
      $mindoo: "timestamp",
      value: toTimestampDate(value, "MindooValue.timestamp value").toISOString(),
    };
  },

  /** Whether `value` is a tagged typed value (any kind). */
  isTyped(value: unknown): value is MindooTypedValue {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(value, MINDOO_VALUE_TAG)
    );
  },
} as const;

/** Automerge counters are 64-bit integers; JS callers are limited to safe integers. */
export function assertCounterAmount(amount: unknown, label: string): asserts amount is number {
  if (typeof amount !== "number" || !Number.isSafeInteger(amount)) {
    throw new Error(`${label} must be a safe integer`);
  }
}

/** Accepts a Date, epoch milliseconds, or an ISO 8601 string. */
export function toTimestampDate(value: unknown, label: string): Date {
  let date: Date | null = null;
  if (value instanceof Date) {
    date = new Date(value.getTime());
  } else if (typeof value === "number" && Number.isFinite(value)) {
    date = new Date(value);
  } else if (typeof value === "string" && value.trim() !== "") {
    date = new Date(value);
  }
  if (!date || Number.isNaN(date.getTime())) {
    throw new Error(
      `${label} must be a Date, epoch milliseconds or an ISO 8601 date-time string`,
    );
  }
  return date;
}

/** Validates a tagged value and returns it with a normalized shape. */
export function parseTypedValue(value: Record<string, unknown>): MindooTypedValue {
  const kind = value[MINDOO_VALUE_TAG];
  switch (kind) {
    case "atomic":
      if (typeof value.value !== "string") {
        throw new Error('Typed value "atomic" needs a string value');
      }
      return { $mindoo: "atomic", value: value.value };
    case "counter":
      assertCounterAmount(value.value, 'Typed value "counter"');
      return { $mindoo: "counter", value: value.value };
    case "timestamp":
      return {
        $mindoo: "timestamp",
        value: toTimestampDate(value.value, 'Typed value "timestamp"').getTime(),
      };
    case "text":
      if (typeof value.value !== "string") {
        throw new Error('Typed value "text" needs a string value');
      }
      return { $mindoo: "text", value: value.value };
    default:
      throw new Error(
        `Unknown typed value ${JSON.stringify(kind)}; the "${MINDOO_VALUE_TAG}" key is reserved for MindooValue.atomic/counter/timestamp/text`,
      );
  }
}
