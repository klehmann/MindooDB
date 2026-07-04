import type {
  MindooDBAppBooleanExpression,
  MindooDBAppExpression,
  MindooDBAppViewExpressionDatePart,
  MindooDBAppViewExpressionOperation,
} from "./types";

const OP_TO_HELPER: Record<MindooDBAppViewExpressionOperation, string> = {
  createdAt: "createdAt",
  decryptionKeyId: "decryptionKeyId",
  isWitnessed: "isWitnessed",
  isAwaitingWitness: "isAwaitingWitness",
  attachmentNames: "attachmentNames",
  attachmentLengths: "attachmentLengths",
  attachmentCount: "attachmentCount",
  childCount: "childCount",
  childCategoryCount: "childCategoryCount",
  childDocumentCount: "childDocumentCount",
  descendantCount: "descendantCount",
  descendantCategoryCount: "descendantCategoryCount",
  descendantDocumentCount: "descendantDocumentCount",
  siblingCount: "siblingCount",
  add: "add",
  sub: "sub",
  mul: "mul",
  div: "div",
  mod: "mod",
  eq: "eq",
  neq: "neq",
  gt: "gt",
  gte: "gte",
  lt: "lt",
  lte: "lte",
  and: "and",
  or: "or",
  not: "not",
  concat: "concat",
  lower: "lower",
  upper: "upper",
  trim: "trim",
  left: "left",
  right: "right",
  number: "toNumber",
  string: "toString",
  boolean: "toBoolean",
  contains: "contains",
  startsWith: "startsWith",
  endsWith: "endsWith",
  coalesce: "coalesce",
  exists: "exists",
  notExists: "notExists",
  pathJoin: "pathJoin",
  datePart: "datePart",
};

const BOOLEAN_HELPERS = new Set([
  "boolean",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "and",
  "or",
  "not",
  "contains",
  "startsWith",
  "endsWith",
  "exists",
  "notExists",
  "toBoolean",
  "isWitnessed",
  "isAwaitingWitness",
]);

const DATE_PARTS = new Set<MindooDBAppViewExpressionDatePart>(["year", "month", "day", "quarter"]);

/** Syntax error raised while parsing Formula source text into the shared AST. */
export class MindooDBFormulaSyntaxError extends Error {
  readonly index: number;

  constructor(message: string, index: number) {
    super(message);
    this.name = "MindooDBFormulaSyntaxError";
    this.index = index;
  }
}

/**
 * Parses builder-call style Formula source into the shared expression AST.
 *
 * Example: `v.eq(v.field("status"), "approved")`
 */
export function parseMindooDBFormulaExpression(source: string): MindooDBAppExpression {
  const parser = new FormulaParser(source);
  const expression = parser.parseExpression();
  parser.skipWhitespace();
  if (!parser.isEof()) {
    throw parser.error("Unexpected trailing input");
  }
  return expression;
}

/** Parses Formula source and narrows the result to a boolean expression for filter use cases. */
export function parseMindooDBFormulaBooleanExpression(source: string): MindooDBAppBooleanExpression {
  return parseMindooDBFormulaExpression(source) as MindooDBAppBooleanExpression;
}

/**
 * Formats an expression into canonical Formula source with stable indentation
 * and literal shorthand.
 */
export function formatMindooDBFormulaExpression(
  expression: MindooDBAppExpression,
  options: { indent?: string } = {},
): string {
  const indent = options.indent ?? "  ";
  return formatExpression(expression, 0, indent);
}

/** Best-effort heuristic used by editor integrations to warn about non-boolean filters. */
export function isMindooDBFormulaLikelyBoolean(expression: MindooDBAppExpression): boolean {
  switch (expression.kind) {
    case "literal":
      return typeof expression.value === "boolean";
    case "if":
      return isMindooDBFormulaLikelyBoolean(expression.whenTrue) && isMindooDBFormulaLikelyBoolean(expression.whenFalse);
    case "operation":
      return BOOLEAN_HELPERS.has(OP_TO_HELPER[expression.op]);
    default:
      return false;
  }
}

/** Internal formatter for a single expression node. */
function formatExpression(expression: MindooDBAppExpression, level: number, indent: string): string {
  switch (expression.kind) {
    case "literal":
      return formatLiteralExpression(expression.value);
    case "field":
      return `v.field(${JSON.stringify(expression.path)})`;
    case "value":
      return `v.value(${JSON.stringify(expression.path)})`;
    case "origin":
      return "v.origin()";
    case "variable":
      return expression.name;
    case "if":
      return [
        "v.ifElse(",
        `${repeatIndent(level + 1, indent)}${formatExpression(expression.condition, level + 1, indent)},`,
        `${repeatIndent(level + 1, indent)}${formatExpression(expression.whenTrue, level + 1, indent)},`,
        `${repeatIndent(level + 1, indent)}${formatExpression(expression.whenFalse, level + 1, indent)},`,
        `${repeatIndent(level, indent)})`,
      ].join("\n");
    case "let": {
      const entries = Object.entries(expression.bindings);
      const bindingBlock = entries.length === 0
        ? "{}"
        : [
            "{",
            ...entries.map(([name, value]) =>
              `${repeatIndent(level + 2, indent)}${name}: ${formatExpression(value, level + 2, indent)},`),
            `${repeatIndent(level + 1, indent)}}`,
          ].join("\n");
      const refList = entries.map(([name]) => name).join(", ");
      return [
        "v.let(",
        `${repeatIndent(level + 1, indent)}${bindingBlock},`,
        `${repeatIndent(level + 1, indent)}({ ${refList} }) => ${formatExpression(expression.result, level + 1, indent)},`,
        `${repeatIndent(level, indent)})`,
      ].join("\n");
    }
    case "decrypt": {
      const field = JSON.stringify(expression.field);
      if (!expression.json) {
        return expression.key
          ? `v.decryptField(${field}, ${formatExpression(expression.key, level, indent)})`
          : `v.decryptField(${field})`;
      }
      if (expression.key) {
        return `v.decryptJson(${field}, ${JSON.stringify(expression.path ?? "")}, ${formatExpression(expression.key, level, indent)})`;
      }
      if (expression.path !== undefined) {
        return `v.decryptJson(${field}, ${JSON.stringify(expression.path)})`;
      }
      return `v.decryptJson(${field})`;
    }
    case "json": {
      const field = JSON.stringify(expression.field);
      return expression.path !== undefined
        ? `v.json(${field}, ${JSON.stringify(expression.path)})`
        : `v.json(${field})`;
    }
    case "operation": {
      const helper = OP_TO_HELPER[expression.op];
      if (expression.op === "datePart") {
        return `v.datePart(${formatExpression(expression.args[0]!, level, indent)}, ${JSON.stringify(expression.part ?? "year")})`;
      }
      if (shouldFormatOperationMultiline(expression)) {
        return [
          `v.${helper}(`,
          ...expression.args.map((arg) => `${repeatIndent(level + 1, indent)}${formatExpression(arg, level + 1, indent)},`),
          `${repeatIndent(level, indent)})`,
        ].join("\n");
      }
      return `v.${helper}(${expression.args.map((arg) => formatExpression(arg, level, indent)).join(", ")})`;
    }
  }
}

/** Expands multi-argument wrappers once nested expressions become hard to read inline. */
function shouldFormatOperationMultiline(expression: Extract<MindooDBAppExpression, { kind: "operation" }>): boolean {
  return expression.args.length > 1 && expression.args.some((arg) =>
    arg.kind === "operation" || arg.kind === "if" || arg.kind === "let" || !isInlineExpression(arg));
}

/** Identifies expressions that stay readable on a single line. */
function isInlineExpression(expression: MindooDBAppExpression): boolean {
  switch (expression.kind) {
    case "literal":
    case "field":
    case "value":
    case "origin":
    case "variable":
    case "json":
      return true;
    case "decrypt":
      return expression.key ? isInlineExpression(expression.key) : true;
    case "operation":
      if (expression.op === "datePart") {
        return true;
      }
      return expression.args.every(isInlineExpression);
    case "if":
    case "let":
      return false;
  }
}

/** Emits canonical literal shorthand whenever possible. */
function formatLiteralExpression(value: unknown): string {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "0";
  }
  return formatJsonLike(value);
}

/** Serializes JSON-like literal values, including the explicit `undefined` sentinel. */
function formatJsonLike(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  const serialized = JSON.stringify(value);
  return serialized ?? "null";
}

function repeatIndent(level: number, indent: string): string {
  return indent.repeat(level);
}

/**
 * Small hand-written recursive descent parser for Formula source.
 *
 * It only understands the supported helper-call grammar plus JSON-like
 * literals so editor tooling can validate and prettify formulas without
 * executing JavaScript.
 */
class FormulaParser {
  private index = 0;

  constructor(private readonly source: string) {}

  isEof(): boolean {
    return this.index >= this.source.length;
  }

  skipWhitespace(): void {
    while (!this.isEof() && /\s/.test(this.source[this.index]!)) {
      this.index += 1;
    }
  }

  error(message: string): MindooDBFormulaSyntaxError {
    return new MindooDBFormulaSyntaxError(message, this.index);
  }

  parseExpression(): MindooDBAppExpression {
    this.skipWhitespace();
    const char = this.peek();
    if (!char) {
      throw this.error("Expected expression");
    }
    if (char === "(") {
      this.index += 1;
      const expression = this.parseExpression();
      this.expectChar(")");
      return expression;
    }
    if (char === '"' || char === "'") {
      return { kind: "literal", value: this.parseStringLiteral() };
    }
    if (char === "[" || char === "{") {
      return { kind: "literal", value: this.parseJsonLikeValue() };
    }
    if (char === "-" || /\d/.test(char)) {
      return { kind: "literal", value: this.parseNumberLiteral() };
    }

    const identifier = this.parseIdentifier();
    if (identifier === "v") {
      this.expectChar(".");
      return this.parseHelperCall();
    }
    if (identifier === "true") {
      return { kind: "literal", value: true };
    }
    if (identifier === "false") {
      return { kind: "literal", value: false };
    }
    if (identifier === "null") {
      return { kind: "literal", value: null };
    }
    if (identifier === "undefined") {
      return { kind: "literal", value: undefined };
    }
    return { kind: "variable", name: identifier };
  }

  /** Parses a `v.helper(...)` call and maps it to the corresponding AST node. */
  private parseHelperCall(): MindooDBAppExpression {
    const helper = this.parseIdentifier();
    this.expectChar("(");
    switch (helper) {
      case "literal": {
        const value = this.parseJsonLikeValue();
        this.expectChar(")");
        return { kind: "literal", value };
      }
      case "string": {
        const value = this.parseStringLiteral();
        this.expectChar(")");
        return { kind: "literal", value };
      }
      case "number": {
        const value = this.parseNumberLiteral();
        this.expectChar(")");
        return { kind: "literal", value };
      }
      case "boolean": {
        const value = this.parseBooleanLiteral();
        this.expectChar(")");
        return { kind: "literal", value };
      }
      case "field": {
        const path = this.parseStringLiteral();
        this.expectChar(")");
        return { kind: "field", path };
      }
      case "value": {
        const path = this.parseStringLiteral();
        this.expectChar(")");
        return { kind: "value", path };
      }
      case "origin": {
        this.expectChar(")");
        return { kind: "origin" };
      }
      case "ifElse": {
        const condition = this.parseExpression();
        this.expectChar(",");
        const whenTrue = this.parseExpression();
        this.expectChar(",");
        const whenFalse = this.parseExpression();
        this.consumeOptionalComma();
        this.expectChar(")");
        return { kind: "if", condition: condition as MindooDBAppBooleanExpression, whenTrue, whenFalse };
      }
      case "let": {
        const bindings = this.parseBindingsObject();
        this.expectChar(",");
        const bindingNames = this.parseArrowBindingNames();
        const bindingSet = new Set(Object.keys(bindings));
        for (const name of bindingNames) {
          if (!bindingSet.has(name)) {
            throw this.error(`Unknown let binding '${name}'`);
          }
        }
        this.expectArrow();
        const result = this.parseExpression();
        this.consumeOptionalComma();
        this.expectChar(")");
        return { kind: "let", bindings, result };
      }
      case "datePart": {
        const value = this.parseExpression();
        this.expectChar(",");
        const part = this.parseStringLiteral();
        if (!DATE_PARTS.has(part as MindooDBAppViewExpressionDatePart)) {
          throw this.error(`Unsupported date part '${part}'`);
        }
        this.consumeOptionalComma();
        this.expectChar(")");
        return { kind: "operation", op: "datePart", args: [value], part: part as MindooDBAppViewExpressionDatePart };
      }
      case "decryptField": {
        const field = this.parseStringLiteral();
        let key: MindooDBAppExpression | undefined;
        this.skipWhitespace();
        if (this.peek() === ",") {
          this.index += 1;
          this.skipWhitespace();
          if (this.peek() !== ")") {
            key = this.parseExpression();
          }
        }
        this.consumeOptionalComma();
        this.expectChar(")");
        return { kind: "decrypt", field, key };
      }
      case "decryptJson": {
        const field = this.parseStringLiteral();
        let path: string | undefined;
        let key: MindooDBAppExpression | undefined;
        this.skipWhitespace();
        if (this.peek() === ",") {
          this.index += 1;
          this.skipWhitespace();
          if (this.peek() !== ")") {
            path = this.parseStringLiteral();
            this.skipWhitespace();
            if (this.peek() === ",") {
              this.index += 1;
              this.skipWhitespace();
              if (this.peek() !== ")") {
                key = this.parseExpression();
              }
            }
          }
        }
        this.consumeOptionalComma();
        this.expectChar(")");
        return { kind: "decrypt", field, json: true, path: path === "" ? undefined : path, key };
      }
      case "json": {
        const field = this.parseStringLiteral();
        let path: string | undefined;
        this.skipWhitespace();
        if (this.peek() === ",") {
          this.index += 1;
          this.skipWhitespace();
          if (this.peek() !== ")") {
            path = this.parseStringLiteral();
          }
        }
        this.consumeOptionalComma();
        this.expectChar(")");
        return { kind: "json", field, path: path === "" ? undefined : path };
      }
      default: {
        const args = this.parseExpressionList();
        this.expectChar(")");
        return this.buildOperation(helper, args);
      }
    }
  }

  /** Converts a parsed helper name plus arguments into a generic operation node. */
  private buildOperation(helper: string, args: MindooDBAppExpression[]): MindooDBAppExpression {
    const op = helperToOperation(helper);
    if (!op) {
      throw this.error(`Unknown helper 'v.${helper}'`);
    }
    return { kind: "operation", op, args };
  }

  /** Parses comma-separated expression arguments and accepts a trailing comma. */
  private parseExpressionList(): MindooDBAppExpression[] {
    const args: MindooDBAppExpression[] = [];
    this.skipWhitespace();
    if (this.peek() === ")") {
      return args;
    }
    while (true) {
      args.push(this.parseExpression());
      this.skipWhitespace();
      if (this.peek() === ",") {
        this.index += 1;
        this.skipWhitespace();
        if (this.peek() === ")") {
          return args;
        }
        continue;
      }
      return args;
    }
  }

  /** Parses the first object argument of `v.let(...)` into named bindings. */
  private parseBindingsObject(): Record<string, MindooDBAppExpression> {
    const bindings: Record<string, MindooDBAppExpression> = {};
    this.expectChar("{");
    this.skipWhitespace();
    if (this.peek() === "}") {
      this.index += 1;
      return bindings;
    }
    while (true) {
      const key = this.parsePropertyKey();
      this.expectChar(":");
      bindings[key] = this.parseExpression();
      this.skipWhitespace();
      if (this.peek() === ",") {
        this.index += 1;
        this.skipWhitespace();
        if (this.peek() === "}") {
          this.index += 1;
          return bindings;
        }
        continue;
      }
      this.expectChar("}");
      return bindings;
    }
  }

  /** Parses the destructured parameter list of the `({ a, b }) => ...` let callback. */
  private parseArrowBindingNames(): string[] {
    this.skipWhitespace();
    this.expectChar("(");
    this.expectChar("{");
    const names: string[] = [];
    this.skipWhitespace();
    if (this.peek() === "}") {
      this.index += 1;
      this.expectChar(")");
      return names;
    }
    while (true) {
      names.push(this.parseIdentifier());
      this.skipWhitespace();
      if (this.peek() === ",") {
        this.index += 1;
        continue;
      }
      this.expectChar("}");
      this.expectChar(")");
      return names;
    }
  }

  private expectArrow(): void {
    this.skipWhitespace();
    if (!this.source.startsWith("=>", this.index)) {
      throw this.error("Expected =>");
    }
    this.index += 2;
  }

  private consumeOptionalComma(): void {
    this.skipWhitespace();
    if (this.peek() === ",") {
      this.index += 1;
    }
  }

  private parsePropertyKey(): string {
    this.skipWhitespace();
    const char = this.peek();
    if (char === '"' || char === "'") {
      return this.parseStringLiteral();
    }
    return this.parseIdentifier();
  }

  /** Parses JSON-like literal syntax used by `v.literal(...)` and raw shorthand literals. */
  private parseJsonLikeValue(): unknown {
    this.skipWhitespace();
    const char = this.peek();
    if (!char) {
      throw this.error("Expected value");
    }
    if (char === "{") {
      return this.parseJsonLikeObject();
    }
    if (char === "[") {
      return this.parseJsonLikeArray();
    }
    if (char === '"' || char === "'") {
      return this.parseStringLiteral();
    }
    if (char === "-" || /\d/.test(char)) {
      return this.parseNumberLiteral();
    }
    const identifier = this.parseIdentifier();
    if (identifier === "true") {
      return true;
    }
    if (identifier === "false") {
      return false;
    }
    if (identifier === "null") {
      return null;
    }
    if (identifier === "undefined") {
      return undefined;
    }
    throw this.error(`Unsupported literal '${identifier}'`);
  }

  /** Parses JSON-like object syntax with optional trailing commas. */
  private parseJsonLikeObject(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    this.expectChar("{");
    this.skipWhitespace();
    if (this.peek() === "}") {
      this.index += 1;
      return result;
    }
    while (true) {
      const key = this.parsePropertyKey();
      this.expectChar(":");
      result[key] = this.parseJsonLikeValue();
      this.skipWhitespace();
      if (this.peek() === ",") {
        this.index += 1;
        this.skipWhitespace();
        if (this.peek() === "}") {
          this.index += 1;
          return result;
        }
        continue;
      }
      this.expectChar("}");
      return result;
    }
  }

  /** Parses JSON-like array syntax. */
  private parseJsonLikeArray(): unknown[] {
    const result: unknown[] = [];
    this.expectChar("[");
    this.skipWhitespace();
    if (this.peek() === "]") {
      this.index += 1;
      return result;
    }
    while (true) {
      result.push(this.parseJsonLikeValue());
      this.skipWhitespace();
      if (this.peek() === ",") {
        this.index += 1;
        continue;
      }
      this.expectChar("]");
      return result;
    }
  }

  /** Parses a quoted string literal with the supported escape sequences. */
  private parseStringLiteral(): string {
    this.skipWhitespace();
    const quote = this.peek();
    if (quote !== '"' && quote !== "'") {
      throw this.error("Expected string literal");
    }
    this.index += 1;
    let value = "";
    while (!this.isEof()) {
      const char = this.source[this.index]!;
      this.index += 1;
      if (char === quote) {
        return value;
      }
      if (char === "\\") {
        const next = this.source[this.index]!;
        this.index += 1;
        switch (next) {
          case "\\":
            value += "\\";
            break;
          case '"':
            value += '"';
            break;
          case "'":
            value += "'";
            break;
          case "n":
            value += "\n";
            break;
          case "r":
            value += "\r";
            break;
          case "t":
            value += "\t";
            break;
          default:
            value += next;
            break;
        }
        continue;
      }
      value += char;
    }
    throw this.error("Unterminated string literal");
  }

  /** Parses an integer or decimal number literal. */
  private parseNumberLiteral(): number {
    this.skipWhitespace();
    const start = this.index;
    if (this.peek() === "-") {
      this.index += 1;
    }
    while (!this.isEof() && /\d/.test(this.source[this.index]!)) {
      this.index += 1;
    }
    if (this.peek() === ".") {
      this.index += 1;
      while (!this.isEof() && /\d/.test(this.source[this.index]!)) {
        this.index += 1;
      }
    }
    const raw = this.source.slice(start, this.index);
    const parsed = Number(raw);
    if (!raw || !Number.isFinite(parsed)) {
      throw this.error("Expected number literal");
    }
    return parsed;
  }

  /** Parses the `true` / `false` literals used by `v.boolean(...)`. */
  private parseBooleanLiteral(): boolean {
    const identifier = this.parseIdentifier();
    if (identifier === "true") {
      return true;
    }
    if (identifier === "false") {
      return false;
    }
    throw this.error("Expected boolean literal");
  }

  private parseIdentifier(): string {
    this.skipWhitespace();
    const start = this.index;
    const first = this.peek();
    if (!first || !/[A-Za-z_$]/.test(first)) {
      throw this.error("Expected identifier");
    }
    this.index += 1;
    while (!this.isEof() && /[A-Za-z0-9_$]/.test(this.source[this.index]!)) {
      this.index += 1;
    }
    return this.source.slice(start, this.index);
  }

  private expectChar(expected: string): void {
    this.skipWhitespace();
    if (this.peek() !== expected) {
      throw this.error(`Expected '${expected}'`);
    }
    this.index += 1;
  }

  private peek(): string | undefined {
    return this.source[this.index];
  }
}

function helperToOperation(helper: string): MindooDBAppViewExpressionOperation | null {
  const entries = Object.entries(OP_TO_HELPER) as Array<[MindooDBAppViewExpressionOperation, string]>;
  const match = entries.find(([, helperName]) => helperName === helper);
  return match?.[0] ?? null;
}
