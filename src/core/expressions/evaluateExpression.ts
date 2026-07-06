import type { MindooDBAppExpression } from "./types";

/**
 * Expression evaluation — the runtime counterpart of the builder
 * (`createViewLanguage`) and the formula parser. Moved into mindoodb core
 * from the `mindoodb-view-language` package so ad-hoc queries and
 * summary-backed views evaluate the same language the apps author views in
 * (the old package re-exports these symbols for compatibility).
 *
 * The view-tree builder intentionally did NOT move: its role is taken over
 * by summary-backed ephemeral VirtualViews (`db.queryView()`).
 */

/**
 * Context an expression is evaluated against. `doc` carries the document's
 * (or summary entry's) field values; `values` earlier column results;
 * `counts` is only populated in view contexts.
 */
export type ExpressionEvaluationContext = {
  doc: Record<string, unknown>;
  values: Record<string, unknown>;
  origin: string;
  createdAt?: string | null;
  decryptionKeyId?: string | null;
  witnessed?: boolean;
  awaitingWitness?: boolean;
  counts?: Partial<ExpressionViewRowCounts>;
  variables: Record<string, unknown>;
  /** Pre-resolved plaintext for `decrypt` nodes, keyed by field name. */
  decrypted?: Record<string, unknown>;
};

/** A field whose ciphertext a view/query definition needs decrypted before evaluation. */
export type DecryptRequest = {
  field: string;
  key?: MindooDBAppExpression;
};

type AttachmentLike = {
  fileName?: unknown;
  size?: unknown;
};

export type ExpressionViewRowCounts = {
  childCount: number;
  childCategoryCount: number;
  childDocumentCount: number;
  descendantCount: number;
  descendantCategoryCount: number;
  descendantDocumentCount: number;
  siblingCount: number;
};

/** Operation nodes that only make sense inside a materialized view tree. */
export const VIEW_CONTEXT_OPERATIONS: ReadonlySet<string> = new Set([
  "childCount",
  "childCategoryCount",
  "childDocumentCount",
  "descendantCount",
  "descendantCategoryCount",
  "descendantDocumentCount",
  "siblingCount",
]);

/** Reads a dot-separated path from an object and returns `undefined` when any segment is missing. */
export function getFieldValue(source: Record<string, unknown>, path: string): unknown {
  if (!path) {
    return undefined;
  }
  return path.split(".").reduce<unknown>((current, part) => {
    if (current && typeof current === "object" && part in current) {
      return (current as Record<string, unknown>)[part];
    }
    return undefined;
  }, source);
}

export function expressionToNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function expressionToBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized !== "" && normalized !== "false" && normalized !== "0" && normalized !== "no";
  }
  return Boolean(value);
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number" || typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function leftString(value: unknown, by: unknown): string {
  const text = String(value ?? "");
  if (typeof by === "number") {
    const count = Number.isFinite(by) ? Math.max(0, Math.trunc(by)) : 0;
    return text.slice(0, count);
  }
  const delimiter = String(by ?? "");
  const index = text.indexOf(delimiter);
  return index === -1 ? text : text.slice(0, index);
}

function rightString(value: unknown, by: unknown): string {
  const text = String(value ?? "");
  if (typeof by === "number") {
    const count = Number.isFinite(by) ? Math.max(0, Math.trunc(by)) : 0;
    return count === 0 ? "" : text.slice(-count);
  }
  const delimiter = String(by ?? "");
  const index = text.lastIndexOf(delimiter);
  return index === -1 ? text : text.slice(index + delimiter.length);
}

function getAttachmentList(doc: Record<string, unknown>): AttachmentLike[] {
  const attachments = doc._attachments;
  return Array.isArray(attachments) ? attachments as AttachmentLike[] : [];
}

function getViewRowCount(context: ExpressionEvaluationContext, key: keyof ExpressionViewRowCounts): number {
  return context.counts?.[key] ?? 0;
}

/** Evaluates a single operation node after its arguments have been recursively resolved. */
function evaluateOperation(
  expression: Extract<MindooDBAppExpression, { kind: "operation" }>,
  context: ExpressionEvaluationContext
): unknown {
  const args = expression.args.map((arg) => evaluateExpression(arg, context));
  switch (expression.op) {
    case "createdAt":
      return context.createdAt ?? null;
    case "decryptionKeyId":
      return context.decryptionKeyId ?? null;
    case "isWitnessed":
      return context.witnessed ?? false;
    case "isAwaitingWitness":
      return context.awaitingWitness ?? false;
    case "attachmentNames":
      return getAttachmentList(context.doc)
        .map((attachment) => attachment.fileName)
        .filter((value): value is string => typeof value === "string");
    case "attachmentLengths":
      return getAttachmentList(context.doc)
        .map((attachment) => attachment.size)
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    case "attachmentCount":
      return getAttachmentList(context.doc).length;
    case "childCount":
      return getViewRowCount(context, "childCount");
    case "childCategoryCount":
      return getViewRowCount(context, "childCategoryCount");
    case "childDocumentCount":
      return getViewRowCount(context, "childDocumentCount");
    case "descendantCount":
      return getViewRowCount(context, "descendantCount");
    case "descendantCategoryCount":
      return getViewRowCount(context, "descendantCategoryCount");
    case "descendantDocumentCount":
      return getViewRowCount(context, "descendantDocumentCount");
    case "siblingCount":
      return getViewRowCount(context, "siblingCount");
    case "add":
      return (expressionToNumber(args[0]) ?? 0) + (expressionToNumber(args[1]) ?? 0);
    case "sub":
      return (expressionToNumber(args[0]) ?? 0) - (expressionToNumber(args[1]) ?? 0);
    case "mul":
      return (expressionToNumber(args[0]) ?? 0) * (expressionToNumber(args[1]) ?? 0);
    case "div": {
      const divisor = expressionToNumber(args[1]);
      return divisor && divisor !== 0 ? (expressionToNumber(args[0]) ?? 0) / divisor : null;
    }
    case "mod": {
      const divisor = expressionToNumber(args[1]);
      return divisor && divisor !== 0 ? (expressionToNumber(args[0]) ?? 0) % divisor : null;
    }
    case "eq":
      return args[0] === args[1];
    case "neq":
      return args[0] !== args[1];
    case "gt":
      return String(args[0] ?? "") > String(args[1] ?? "");
    case "gte":
      return String(args[0] ?? "") >= String(args[1] ?? "");
    case "lt":
      return String(args[0] ?? "") < String(args[1] ?? "");
    case "lte":
      return String(args[0] ?? "") <= String(args[1] ?? "");
    case "and":
      return args.every((value) => expressionToBoolean(value));
    case "or":
      return args.some((value) => expressionToBoolean(value));
    case "not":
      return !expressionToBoolean(args[0]);
    case "concat":
      return args.filter((part) => part !== null && part !== undefined && part !== "").join("");
    case "lower":
      return String(args[0] ?? "").toLowerCase();
    case "upper":
      return String(args[0] ?? "").toUpperCase();
    case "trim":
      return String(args[0] ?? "").trim();
    case "left":
      return leftString(args[0], args[1]);
    case "right":
      return rightString(args[0], args[1]);
    case "number":
      return expressionToNumber(args[0]);
    case "string":
      return String(args[0] ?? "");
    case "boolean":
      return expressionToBoolean(args[0]);
    case "contains":
      return String(args[0] ?? "").toLowerCase().includes(String(args[1] ?? "").toLowerCase());
    case "startsWith":
      return String(args[0] ?? "").toLowerCase().startsWith(String(args[1] ?? "").toLowerCase());
    case "endsWith":
      return String(args[0] ?? "").toLowerCase().endsWith(String(args[1] ?? "").toLowerCase());
    case "coalesce":
      return args.find((value) => value !== null && value !== undefined && value !== "");
    case "exists":
      return args[0] !== null && args[0] !== undefined && args[0] !== "";
    case "notExists":
      return args[0] === null || args[0] === undefined || args[0] === "";
    case "pathJoin":
      return args
        .map((part) => String(part ?? "").trim())
        .filter(Boolean)
        .join("\\");
    case "datePart": {
      const date = toDate(args[0]);
      if (!date) {
        return null;
      }
      switch (expression.part) {
        case "year":
          return date.getUTCFullYear();
        case "month":
          return String(date.getUTCMonth() + 1).padStart(2, "0");
        case "day":
          return String(date.getUTCDate()).padStart(2, "0");
        case "quarter":
          return `Q${Math.ceil((date.getUTCMonth() + 1) / 3)}`;
        default:
          return null;
      }
    }
  }
}

/**
 * Parses a JSON string into a value (objects/values pass through unchanged),
 * then optionally selects a nested value via a dot `path`. Returns null when
 * the input is nullish or the string is not valid JSON.
 */
function parseAndExtract(value: unknown, path?: string): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!path) {
    return parsed;
  }
  if (parsed && typeof parsed === "object") {
    return getFieldValue(parsed as Record<string, unknown>, path);
  }
  return undefined;
}

/**
 * Evaluates an expression against a document plus the current view/value
 * context. This is the runtime counterpart of the builder and parser.
 */
export function evaluateExpression(expression: MindooDBAppExpression, context: ExpressionEvaluationContext): unknown {
  switch (expression.kind) {
    case "literal":
      return expression.value;
    case "field":
      return getFieldValue(context.doc, expression.path);
    case "value":
      return getFieldValue(context.values, expression.path);
    case "origin":
      return context.origin;
    case "variable":
      return context.variables[expression.name];
    case "if":
      return expressionToBoolean(evaluateExpression(expression.condition, context))
        ? evaluateExpression(expression.whenTrue, context)
        : evaluateExpression(expression.whenFalse, context);
    case "let": {
      const nextVariables = { ...context.variables };
      for (const [name, valueExpression] of Object.entries(expression.bindings)) {
        nextVariables[name] = evaluateExpression(valueExpression, {
          ...context,
          variables: nextVariables,
        });
      }
      return evaluateExpression(expression.result, {
        ...context,
        variables: nextVariables,
      });
    }
    case "decrypt": {
      const raw = context.decrypted?.[expression.field] ?? null;
      if (!expression.json) {
        return raw;
      }
      return parseAndExtract(raw, expression.path);
    }
    case "json":
      return parseAndExtract(getFieldValue(context.doc, expression.field), expression.path);
    case "operation":
      return evaluateOperation(expression, context);
  }
}

/** Generic AST walker visiting every node of an expression tree. */
function walkExpression(expression: MindooDBAppExpression, visit: (node: MindooDBAppExpression) => void): void {
  visit(expression);
  switch (expression.kind) {
    case "operation":
      for (const arg of expression.args) {
        walkExpression(arg, visit);
      }
      break;
    case "if":
      walkExpression(expression.condition, visit);
      walkExpression(expression.whenTrue, visit);
      walkExpression(expression.whenFalse, visit);
      break;
    case "let":
      for (const binding of Object.values(expression.bindings)) {
        walkExpression(binding, visit);
      }
      walkExpression(expression.result, visit);
      break;
    case "decrypt":
      if (expression.key) {
        walkExpression(expression.key, visit);
      }
      break;
    case "literal":
    case "field":
    case "value":
    case "origin":
    case "variable":
    case "json":
      break;
  }
}

/**
 * Walks an expression tree and collects every `decrypt` node so the host
 * runtime knows which `_encrypted` fields it must decrypt before evaluation.
 * `json` nodes need no decryption and are ignored.
 */
export function collectDecryptRequests(expression: MindooDBAppExpression): DecryptRequest[] {
  const requests: DecryptRequest[] = [];
  walkExpression(expression, (node) => {
    if (node.kind === "decrypt") {
      requests.push({ field: node.field, key: node.key });
    }
  });
  return requests;
}

/**
 * Operations reading the document's managed `_attachments` array. They are
 * "context" operations (no `field` node), so the coverage machinery must
 * account for them explicitly: on the summary path they only work when the
 * summary stores the attachment projection.
 */
const ATTACHMENT_OPERATIONS = new Set(["attachmentNames", "attachmentLengths", "attachmentCount"]);

/**
 * Collects every document field path (`field` and `json` nodes) an
 * expression references. Basis of the query engine's coverage check against
 * the summary configuration. Attachment operations count as a reference to
 * `_attachments` — they read that managed field even without a field node.
 */
export function getReferencedFields(expression: MindooDBAppExpression): string[] {
  const paths = new Set<string>();
  walkExpression(expression, (node) => {
    if (node.kind === "field") {
      paths.add(node.path);
    } else if (node.kind === "json") {
      paths.add(node.field);
    } else if (node.kind === "operation" && ATTACHMENT_OPERATIONS.has(node.op)) {
      paths.add("_attachments");
    }
  });
  return Array.from(paths);
}

/**
 * Collects expression capabilities relevant for the query engine's
 * guardrails: whether the expression needs decryption or a view-tree
 * context (neither can be answered from the summary buffer).
 */
export function analyzeExpressionRequirements(expression: MindooDBAppExpression): {
  needsDecryption: boolean;
  needsViewContext: boolean;
  viewContextOperations: string[];
} {
  let needsDecryption = false;
  const viewContextOperations = new Set<string>();
  walkExpression(expression, (node) => {
    if (node.kind === "decrypt") {
      needsDecryption = true;
    } else if (node.kind === "operation" && VIEW_CONTEXT_OPERATIONS.has(node.op)) {
      viewContextOperations.add(node.op);
    }
  });
  return {
    needsDecryption,
    needsViewContext: viewContextOperations.size > 0,
    viewContextOperations: Array.from(viewContextOperations),
  };
}
