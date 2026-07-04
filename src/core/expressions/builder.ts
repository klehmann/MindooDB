import type {
  MindooDBAppBooleanExpression,
  MindooDBAppExpression,
  MindooDBAppViewExpressionDatePart,
} from "./types";

type Primitive = string | number | boolean | bigint | symbol | null | undefined | Date;
type NonTraversable = Primitive | Array<unknown>;
type StringKey<T> = Extract<keyof T, string>;
type ExpressionKind = MindooDBAppExpression["kind"];
const EXPRESSION_KINDS: ReadonlySet<ExpressionKind> = new Set([
  "literal",
  "field",
  "value",
  "origin",
  "variable",
  "operation",
  "if",
  "let",
  "decrypt",
  "json",
]);

/** Dot-separated field paths available on a source document type. */
export type MindooDBAppFieldPath<T> = T extends NonTraversable
  ? never
  : {
      [K in StringKey<T>]:
        T[K] extends NonTraversable
          ? `${K}`
          : `${K}` | `${K}.${MindooDBAppFieldPath<T[K]>}`;
    }[StringKey<T>];

/** Resolves the value type located at a dot-separated path. */
export type MindooDBAppPathValue<T, TPath extends string> =
  TPath extends `${infer Head}.${infer Tail}`
    ? Head extends keyof T
      ? MindooDBAppPathValue<T[Head], Tail>
      : unknown
    : TPath extends keyof T
      ? T[TPath]
      : unknown;

/**
 * Helper arguments accepted by the TypeScript builder.
 *
 * Callers can pass a prebuilt expression node or any raw literal value. Raw
 * values are wrapped into `{ kind: "literal" }` nodes automatically.
 */
export type MindooDBAppExpressionInput<T = unknown> = MindooDBAppExpression<T> | T;

type ExpressionResult<TExpression> = TExpression extends MindooDBAppExpression<infer TResult> ? TResult : TExpression;

type LetBindings = Record<string, MindooDBAppExpressionInput<unknown>>;
type LetBindingRefs<TBindings extends LetBindings> = {
  [K in keyof TBindings]: MindooDBAppExpression<ExpressionResult<TBindings[K]>>;
};

function variable<T = unknown>(name: string): MindooDBAppExpression<T> {
  return { kind: "variable", name };
}

/** Distinguishes AST nodes from plain literals before normalizing builder input. */
function isExpression<T = unknown>(value: MindooDBAppExpressionInput<T>): value is MindooDBAppExpression<T> {
  return typeof value === "object"
    && value !== null
    && "kind" in value
    && typeof value.kind === "string"
    && EXPRESSION_KINDS.has(value.kind as ExpressionKind);
}

/** Normalizes raw builder input into an expression node. */
function toExpression<T>(value: MindooDBAppExpressionInput<T>): MindooDBAppExpression<T> {
  return isExpression(value) ? value : { kind: "literal", value };
}

/** Vectorized form of `toExpression()` for variadic helpers. */
function toExpressionList<T>(values: MindooDBAppExpressionInput<T>[]): MindooDBAppExpression<T>[] {
  return values.map((value) => toExpression(value));
}

/**
 * Creates the typed builder API used by applications to author Formula
 * expressions in TypeScript.
 *
 * The first generic parameter describes the source document shape used by
 * `field()`. The optional second generic parameter describes previously
 * computed column values referenced via `value()`.
 */
export function createViewLanguage<
  TDocument extends Record<string, unknown>,
  TValueContext extends Record<string, unknown> = Record<string, unknown>,
>() {
  return {
    literal<T>(value: T): MindooDBAppExpression<T> {
      return { kind: "literal", value };
    },
    string(value: string): MindooDBAppExpression<string> {
      return { kind: "literal", value };
    },
    number(value: number): MindooDBAppExpression<number> {
      return { kind: "literal", value };
    },
    boolean(value: boolean): MindooDBAppBooleanExpression {
      return { kind: "literal", value };
    },
    field<TPath extends MindooDBAppFieldPath<TDocument>>(path: TPath): MindooDBAppExpression<MindooDBAppPathValue<TDocument, TPath>> {
      return { kind: "field", path };
    },
    value<TPath extends MindooDBAppFieldPath<TValueContext>>(path: TPath): MindooDBAppExpression<MindooDBAppPathValue<TValueContext, TPath>> {
      return { kind: "value", path };
    },
    origin(): MindooDBAppExpression<string> {
      return { kind: "origin" };
    },
    createdAt(): MindooDBAppExpression<string | null> {
      return { kind: "operation", op: "createdAt", args: [] };
    },
    decryptionKeyId(): MindooDBAppExpression<string | null> {
      return { kind: "operation", op: "decryptionKeyId", args: [] };
    },
    isWitnessed(): MindooDBAppBooleanExpression {
      return { kind: "operation", op: "isWitnessed", args: [] };
    },
    isAwaitingWitness(): MindooDBAppBooleanExpression {
      return { kind: "operation", op: "isAwaitingWitness", args: [] };
    },
    attachmentNames(): MindooDBAppExpression<string[]> {
      return { kind: "operation", op: "attachmentNames", args: [] };
    },
    attachmentLengths(): MindooDBAppExpression<number[]> {
      return { kind: "operation", op: "attachmentLengths", args: [] };
    },
    attachmentCount(): MindooDBAppExpression<number> {
      return { kind: "operation", op: "attachmentCount", args: [] };
    },
    childCount(): MindooDBAppExpression<number> {
      return { kind: "operation", op: "childCount", args: [] };
    },
    childCategoryCount(): MindooDBAppExpression<number> {
      return { kind: "operation", op: "childCategoryCount", args: [] };
    },
    childDocumentCount(): MindooDBAppExpression<number> {
      return { kind: "operation", op: "childDocumentCount", args: [] };
    },
    descendantCount(): MindooDBAppExpression<number> {
      return { kind: "operation", op: "descendantCount", args: [] };
    },
    descendantCategoryCount(): MindooDBAppExpression<number> {
      return { kind: "operation", op: "descendantCategoryCount", args: [] };
    },
    descendantDocumentCount(): MindooDBAppExpression<number> {
      return { kind: "operation", op: "descendantDocumentCount", args: [] };
    },
    siblingCount(): MindooDBAppExpression<number> {
      return { kind: "operation", op: "siblingCount", args: [] };
    },
    add(left: MindooDBAppExpressionInput, right: MindooDBAppExpressionInput): MindooDBAppExpression<number> {
      return { kind: "operation", op: "add", args: [toExpression(left), toExpression(right)] };
    },
    sub(left: MindooDBAppExpressionInput, right: MindooDBAppExpressionInput): MindooDBAppExpression<number> {
      return { kind: "operation", op: "sub", args: [toExpression(left), toExpression(right)] };
    },
    mul(left: MindooDBAppExpressionInput, right: MindooDBAppExpressionInput): MindooDBAppExpression<number> {
      return { kind: "operation", op: "mul", args: [toExpression(left), toExpression(right)] };
    },
    div(left: MindooDBAppExpressionInput, right: MindooDBAppExpressionInput): MindooDBAppExpression<number> {
      return { kind: "operation", op: "div", args: [toExpression(left), toExpression(right)] };
    },
    mod(left: MindooDBAppExpressionInput, right: MindooDBAppExpressionInput): MindooDBAppExpression<number> {
      return { kind: "operation", op: "mod", args: [toExpression(left), toExpression(right)] };
    },
    eq(left: MindooDBAppExpressionInput, right: MindooDBAppExpressionInput): MindooDBAppBooleanExpression {
      return { kind: "operation", op: "eq", args: [toExpression(left), toExpression(right)] };
    },
    neq(left: MindooDBAppExpressionInput, right: MindooDBAppExpressionInput): MindooDBAppBooleanExpression {
      return { kind: "operation", op: "neq", args: [toExpression(left), toExpression(right)] };
    },
    gt(left: MindooDBAppExpressionInput, right: MindooDBAppExpressionInput): MindooDBAppBooleanExpression {
      return { kind: "operation", op: "gt", args: [toExpression(left), toExpression(right)] };
    },
    gte(left: MindooDBAppExpressionInput, right: MindooDBAppExpressionInput): MindooDBAppBooleanExpression {
      return { kind: "operation", op: "gte", args: [toExpression(left), toExpression(right)] };
    },
    lt(left: MindooDBAppExpressionInput, right: MindooDBAppExpressionInput): MindooDBAppBooleanExpression {
      return { kind: "operation", op: "lt", args: [toExpression(left), toExpression(right)] };
    },
    lte(left: MindooDBAppExpressionInput, right: MindooDBAppExpressionInput): MindooDBAppBooleanExpression {
      return { kind: "operation", op: "lte", args: [toExpression(left), toExpression(right)] };
    },
    and(...args: MindooDBAppExpressionInput<boolean>[]): MindooDBAppBooleanExpression {
      return { kind: "operation", op: "and", args: toExpressionList(args) };
    },
    or(...args: MindooDBAppExpressionInput<boolean>[]): MindooDBAppBooleanExpression {
      return { kind: "operation", op: "or", args: toExpressionList(args) };
    },
    not(value: MindooDBAppExpressionInput<boolean>): MindooDBAppBooleanExpression {
      return { kind: "operation", op: "not", args: [toExpression(value)] };
    },
    concat(...args: MindooDBAppExpressionInput[]): MindooDBAppExpression<string> {
      return { kind: "operation", op: "concat", args: toExpressionList(args) };
    },
    lower(value: MindooDBAppExpressionInput): MindooDBAppExpression<string> {
      return { kind: "operation", op: "lower", args: [toExpression(value)] };
    },
    upper(value: MindooDBAppExpressionInput): MindooDBAppExpression<string> {
      return { kind: "operation", op: "upper", args: [toExpression(value)] };
    },
    trim(value: MindooDBAppExpressionInput): MindooDBAppExpression<string> {
      return { kind: "operation", op: "trim", args: [toExpression(value)] };
    },
    left(value: MindooDBAppExpressionInput, by: MindooDBAppExpressionInput): MindooDBAppExpression<string> {
      return { kind: "operation", op: "left", args: [toExpression(value), toExpression(by)] };
    },
    right(value: MindooDBAppExpressionInput, by: MindooDBAppExpressionInput): MindooDBAppExpression<string> {
      return { kind: "operation", op: "right", args: [toExpression(value), toExpression(by)] };
    },
    toNumber(value: MindooDBAppExpressionInput): MindooDBAppExpression<number | null> {
      return { kind: "operation", op: "number", args: [toExpression(value)] };
    },
    toString(value: MindooDBAppExpressionInput): MindooDBAppExpression<string> {
      return { kind: "operation", op: "string", args: [toExpression(value)] };
    },
    toBoolean(value: MindooDBAppExpressionInput): MindooDBAppBooleanExpression {
      return { kind: "operation", op: "boolean", args: [toExpression(value)] };
    },
    contains(left: MindooDBAppExpressionInput, right: MindooDBAppExpressionInput): MindooDBAppBooleanExpression {
      return { kind: "operation", op: "contains", args: [toExpression(left), toExpression(right)] };
    },
    startsWith(left: MindooDBAppExpressionInput, right: MindooDBAppExpressionInput): MindooDBAppBooleanExpression {
      return { kind: "operation", op: "startsWith", args: [toExpression(left), toExpression(right)] };
    },
    endsWith(left: MindooDBAppExpressionInput, right: MindooDBAppExpressionInput): MindooDBAppBooleanExpression {
      return { kind: "operation", op: "endsWith", args: [toExpression(left), toExpression(right)] };
    },
    coalesce<T>(...args: MindooDBAppExpressionInput<T>[]): MindooDBAppExpression<T> {
      return { kind: "operation", op: "coalesce", args: toExpressionList(args) };
    },
    exists(value: MindooDBAppExpressionInput): MindooDBAppBooleanExpression {
      return { kind: "operation", op: "exists", args: [toExpression(value)] };
    },
    notExists(value: MindooDBAppExpressionInput): MindooDBAppBooleanExpression {
      return { kind: "operation", op: "notExists", args: [toExpression(value)] };
    },
    pathJoin(...args: MindooDBAppExpressionInput[]): MindooDBAppExpression<string> {
      return { kind: "operation", op: "pathJoin", args: toExpressionList(args) };
    },
    datePart(value: MindooDBAppExpressionInput, part: MindooDBAppViewExpressionDatePart): MindooDBAppExpression<string | number | null> {
      return { kind: "operation", op: "datePart", args: [toExpression(value)], part };
    },
    decryptField(field: string, key?: MindooDBAppExpressionInput<string>): MindooDBAppExpression<string | null> {
      return { kind: "decrypt", field, key: key === undefined ? undefined : toExpression(key) };
    },
    decryptJson(field: string, path?: string, key?: MindooDBAppExpressionInput<string>): MindooDBAppExpression<unknown> {
      return { kind: "decrypt", field, json: true, path, key: key === undefined ? undefined : toExpression(key) };
    },
    json(field: string, path?: string): MindooDBAppExpression<unknown> {
      return { kind: "json", field, path };
    },
    ifElse<T>(
      condition: MindooDBAppExpressionInput<boolean>,
      whenTrue: MindooDBAppExpressionInput<T>,
      whenFalse: MindooDBAppExpressionInput<T>,
    ): MindooDBAppExpression<T> {
      return {
        kind: "if",
        condition: toExpression(condition),
        whenTrue: toExpression(whenTrue),
        whenFalse: toExpression(whenFalse),
      };
    },
    let<TBindings extends LetBindings, TResult>(
      bindings: TBindings,
      build: (refs: LetBindingRefs<TBindings>) => MindooDBAppExpressionInput<TResult>,
    ): MindooDBAppExpression<TResult> {
      const normalizedBindings = Object.fromEntries(
        Object.entries(bindings).map(([name, value]) => [name, toExpression(value)]),
      ) as Record<string, MindooDBAppExpression>;
      const refs = Object.fromEntries(
        Object.keys(normalizedBindings).map((name) => [name, variable(name)]),
      ) as LetBindingRefs<TBindings>;
      return {
        kind: "let",
        bindings: normalizedBindings,
        result: toExpression(build(refs)),
      };
    },
  };
}
