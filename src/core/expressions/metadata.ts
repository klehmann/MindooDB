export type MindooDBViewLanguageHelperCategory =
  | "literals"
  | "context"
  | "conversion"
  | "arithmetic"
  | "comparison"
  | "boolean"
  | "string"
  | "nullability"
  | "date"
  | "path"
  | "control-flow"
  | "crypto"
  | "json";

export type MindooDBViewLanguageArgumentKind =
  | "expression"
  | "boolean-expression"
  | "field-path"
  | "value-path"
  | "literal"
  | "string"
  | "number"
  | "boolean"
  | "date-part"
  | "bindings"
  | "builder";

export interface MindooDBViewLanguageHelperArgument {
  name: string;
  kind: MindooDBViewLanguageArgumentKind;
  description: string;
  optional?: boolean;
  variadic?: boolean;
}

export interface MindooDBViewLanguageHelperMetadata {
  name: string;
  category: MindooDBViewLanguageHelperCategory;
  summary: string;
  description: string;
  signature: string;
  returnType: string;
  arguments: MindooDBViewLanguageHelperArgument[];
  examples?: string[];
}

function helper(
  name: string,
  category: MindooDBViewLanguageHelperCategory,
  summary: string,
  description: string,
  signature: string,
  returnType: string,
  args: MindooDBViewLanguageHelperArgument[],
  examples?: string[],
): MindooDBViewLanguageHelperMetadata {
  return {
    name,
    category,
    summary,
    description,
    signature,
    returnType,
    arguments: args,
    examples,
  };
}

export const mindooDBViewLanguageHelpers = [
  helper("literal", "literals", "Wrap any serializable constant value.", "Creates a literal expression from any JSON-serializable value.", "literal(value)", "Expression<T>", [
    { name: "value", kind: "literal", description: "The constant value to embed into the expression tree." },
  ], ["v.literal(\"hello\")", "v.literal({ status: \"draft\" })"]),
  helper("string", "literals", "Wrap a string constant.", "Shortcut for creating a string literal expression.", "string(value)", "Expression<string>", [
    { name: "value", kind: "string", description: "The string constant to embed." },
  ], ["v.string(\"approved\")"]),
  helper("number", "literals", "Wrap a numeric constant.", "Shortcut for creating a number literal expression.", "number(value)", "Expression<number>", [
    { name: "value", kind: "number", description: "The numeric constant to embed." },
  ], ["v.number(42)"]),
  helper("boolean", "literals", "Wrap a boolean constant.", "Shortcut for creating a boolean literal expression.", "boolean(value)", "BooleanExpression", [
    { name: "value", kind: "boolean", description: "The boolean constant to embed." },
  ], ["v.boolean(true)"]),
  helper("field", "context", "Read a value from the source document.", "Resolves a dot-separated path against the source document passed into evaluation.", "field(path)", "Expression<TField>", [
    { name: "path", kind: "field-path", description: "A dot-separated field path from the source document type." },
  ], ["v.field(\"employee\")", "v.field(\"project.name\")"]),
  helper("value", "context", "Read a previously computed column value.", "Resolves a dot-separated path against the current value context built from earlier columns.", "value(path)", "Expression<TValue>", [
    { name: "path", kind: "value-path", description: "A dot-separated path from the typed value context." },
  ], ["v.value(\"amount\")"]),
  helper("origin", "context", "Return the current row origin.", "Reads the origin/source identifier for the current row or document.", "origin()", "Expression<string>", [], ["v.origin()"]),
  helper("createdAt", "context", "Return the current document creation timestamp.", "Reads the ISO-8601 creation timestamp provided as document metadata by the host runtime.", "createdAt()", "Expression<string | null>", [], ["v.createdAt()"]),
  helper("decryptionKeyId", "context", "Return the current document decryption key id.", "Reads the optional decryption key identifier provided as document metadata by the host runtime.", "decryptionKeyId()", "Expression<string | null>", [], ["v.decryptionKeyId()"]),
  helper("isWitnessed", "context", "Whether the document has been witnessed by a server.", "Reads the host runtime's per-document witness state. Returns true only for witness-era documents (written with a store entryVersion) whose entries have all received a trusted-server receipt. Legacy documents (no entryVersion) and not-yet-synced documents return false.", "isWitnessed()", "BooleanExpression", [], ["v.isWitnessed()", "v.not(v.isWitnessed())"]),
  helper("isAwaitingWitness", "context", "Whether the document is waiting to be witnessed.", "Reads the host runtime's per-document witness state. Returns true for a witness-era document (written with a store entryVersion) that has been created or edited locally and not yet synced to a server. Clears to false once witnessed. Legacy documents (no entryVersion) return false.", "isAwaitingWitness()", "BooleanExpression", [], ["v.isAwaitingWitness()", "v.not(v.isAwaitingWitness())"]),
  helper("attachmentNames", "context", "List attachment file names.", "Reads the current document's `_attachments` array and returns the `fileName` values as a string array.", "attachmentNames()", "Expression<string[]>", [], ["v.attachmentNames()"]),
  helper("attachmentLengths", "context", "List attachment sizes.", "Reads the current document's `_attachments` array and returns the numeric `size` values as a number array.", "attachmentLengths()", "Expression<number[]>", [], ["v.attachmentLengths()"]),
  helper("attachmentCount", "context", "Count document attachments.", "Reads the current document's `_attachments` array and returns the number of attachment entries.", "attachmentCount()", "Expression<number>", [], ["v.attachmentCount()"]),
  helper("childCount", "context", "Count direct child entries.", "Returns the number of direct child entries for the current view row.", "childCount()", "Expression<number>", [], ["v.childCount()"]),
  helper("childCategoryCount", "context", "Count direct child categories.", "Returns the number of direct child category entries for the current view row.", "childCategoryCount()", "Expression<number>", [], ["v.childCategoryCount()"]),
  helper("childDocumentCount", "context", "Count direct child documents.", "Returns the number of direct child document entries for the current view row.", "childDocumentCount()", "Expression<number>", [], ["v.childDocumentCount()"]),
  helper("descendantCount", "context", "Count descendant entries.", "Returns the number of descendant entries below the current view row.", "descendantCount()", "Expression<number>", [], ["v.descendantCount()"]),
  helper("descendantCategoryCount", "context", "Count descendant categories.", "Returns the number of descendant category entries below the current view row.", "descendantCategoryCount()", "Expression<number>", [], ["v.descendantCategoryCount()"]),
  helper("descendantDocumentCount", "context", "Count descendant documents.", "Returns the number of descendant document entries below the current view row.", "descendantDocumentCount()", "Expression<number>", [], ["v.descendantDocumentCount()"]),
  helper("siblingCount", "context", "Count sibling entries.", "Returns the number of sibling entries for the current view row.", "siblingCount()", "Expression<number>", [], ["v.siblingCount()"]),
  helper("toNumber", "conversion", "Convert a value to a finite number.", "Attempts numeric conversion and returns null when the input is not a finite number.", "toNumber(value)", "Expression<number | null>", [
    { name: "value", kind: "expression", description: "The expression to convert." },
  ], ["v.toNumber(v.field(\"hours\"))"]),
  helper("toString", "conversion", "Convert a value to text.", "Converts the input expression to a string value.", "toString(value)", "Expression<string>", [
    { name: "value", kind: "expression", description: "The expression to convert." },
  ], ["v.toString(v.field(\"hours\"))"]),
  helper("toBoolean", "conversion", "Convert a value to boolean using runtime truthiness rules.", "Converts the input expression to a boolean expression using the runtime's normalization rules.", "toBoolean(value)", "BooleanExpression", [
    { name: "value", kind: "expression", description: "The expression to convert." },
  ], ["v.toBoolean(v.field(\"status\"))"]),
  helper("add", "arithmetic", "Add two expressions.", "Converts both inputs to numbers and returns their sum.", "add(left, right)", "Expression<number>", [
    { name: "left", kind: "expression", description: "The left numeric expression." },
    { name: "right", kind: "expression", description: "The right numeric expression." },
  ], ["v.add(v.field(\"hours\"), v.number(2))"]),
  helper("sub", "arithmetic", "Subtract one expression from another.", "Converts both inputs to numbers and subtracts right from left.", "sub(left, right)", "Expression<number>", [
    { name: "left", kind: "expression", description: "The left numeric expression." },
    { name: "right", kind: "expression", description: "The right numeric expression." },
  ], ["v.sub(v.field(\"hours\"), v.number(1))"]),
  helper("mul", "arithmetic", "Multiply two expressions.", "Converts both inputs to numbers and multiplies them.", "mul(left, right)", "Expression<number>", [
    { name: "left", kind: "expression", description: "The left numeric expression." },
    { name: "right", kind: "expression", description: "The right numeric expression." },
  ], ["v.mul(v.field(\"hours\"), v.field(\"rate\"))"]),
  helper("div", "arithmetic", "Divide one expression by another.", "Converts both inputs to numbers and returns null for invalid or zero divisors.", "div(left, right)", "Expression<number>", [
    { name: "left", kind: "expression", description: "The dividend expression." },
    { name: "right", kind: "expression", description: "The divisor expression." },
  ], ["v.div(v.field(\"total\"), v.field(\"count\"))"]),
  helper("mod", "arithmetic", "Return a numeric remainder.", "Converts both inputs to numbers and returns null for invalid or zero divisors.", "mod(left, right)", "Expression<number>", [
    { name: "left", kind: "expression", description: "The dividend expression." },
    { name: "right", kind: "expression", description: "The divisor expression." },
  ], ["v.mod(v.field(\"index\"), v.number(2))"]),
  helper("eq", "comparison", "Compare two expressions for strict equality.", "Returns true only when both evaluated values are strictly equal.", "eq(left, right)", "BooleanExpression", [
    { name: "left", kind: "expression", description: "The left expression." },
    { name: "right", kind: "expression", description: "The right expression." },
  ], ["v.eq(v.field(\"status\"), v.string(\"approved\"))"]),
  helper("neq", "comparison", "Compare two expressions for strict inequality.", "Returns true when the evaluated values differ.", "neq(left, right)", "BooleanExpression", [
    { name: "left", kind: "expression", description: "The left expression." },
    { name: "right", kind: "expression", description: "The right expression." },
  ], ["v.neq(v.field(\"status\"), v.string(\"draft\"))"]),
  helper("gt", "comparison", "Check whether the left expression sorts after the right expression.", "Performs runtime ordering comparison; numeric fields should usually be wrapped in toNumber() first.", "gt(left, right)", "BooleanExpression", [
    { name: "left", kind: "expression", description: "The left expression." },
    { name: "right", kind: "expression", description: "The right expression." },
  ], ["v.gt(v.toNumber(v.field(\"hours\")), v.number(0))"]),
  helper("gte", "comparison", "Check whether the left expression sorts after or equal to the right expression.", "Performs runtime ordering comparison; numeric fields should usually be wrapped in toNumber() first.", "gte(left, right)", "BooleanExpression", [
    { name: "left", kind: "expression", description: "The left expression." },
    { name: "right", kind: "expression", description: "The right expression." },
  ]),
  helper("lt", "comparison", "Check whether the left expression sorts before the right expression.", "Performs runtime ordering comparison; numeric fields should usually be wrapped in toNumber() first.", "lt(left, right)", "BooleanExpression", [
    { name: "left", kind: "expression", description: "The left expression." },
    { name: "right", kind: "expression", description: "The right expression." },
  ]),
  helper("lte", "comparison", "Check whether the left expression sorts before or equal to the right expression.", "Performs runtime ordering comparison; numeric fields should usually be wrapped in toNumber() first.", "lte(left, right)", "BooleanExpression", [
    { name: "left", kind: "expression", description: "The left expression." },
    { name: "right", kind: "expression", description: "The right expression." },
  ]),
  helper("and", "boolean", "Require that all conditions are truthy.", "Combines multiple boolean expressions with logical AND.", "and(...conditions)", "BooleanExpression", [
    { name: "conditions", kind: "boolean-expression", description: "The boolean expressions that must all evaluate to true.", variadic: true },
  ], ["v.and(v.exists(v.field(\"employee\")), v.gt(v.toNumber(v.field(\"hours\")), v.number(0)))"]),
  helper("or", "boolean", "Require that at least one condition is truthy.", "Combines multiple boolean expressions with logical OR.", "or(...conditions)", "BooleanExpression", [
    { name: "conditions", kind: "boolean-expression", description: "The boolean expressions where any true result passes.", variadic: true },
  ]),
  helper("not", "boolean", "Negate a boolean expression.", "Returns the logical inverse of the input condition.", "not(condition)", "BooleanExpression", [
    { name: "condition", kind: "boolean-expression", description: "The condition to negate." },
  ]),
  helper("concat", "string", "Join non-empty parts into a string.", "Converts parts to strings, skips nullish and empty values, and joins the rest.", "concat(...parts)", "Expression<string>", [
    { name: "parts", kind: "expression", description: "The values to join into a single string.", variadic: true },
  ], ["v.concat(v.field(\"employee\"), v.string(\": \"), v.field(\"note\"))"]),
  helper("lower", "string", "Convert a value to lower-case text.", "Stringifies the input and returns a lower-case result.", "lower(value)", "Expression<string>", [
    { name: "value", kind: "expression", description: "The expression to normalize." },
  ]),
  helper("upper", "string", "Convert a value to upper-case text.", "Stringifies the input and returns an upper-case result.", "upper(value)", "Expression<string>", [
    { name: "value", kind: "expression", description: "The expression to normalize." },
  ]),
  helper("trim", "string", "Trim surrounding whitespace.", "Stringifies the input and removes leading and trailing whitespace.", "trim(value)", "Expression<string>", [
    { name: "value", kind: "expression", description: "The expression to trim." },
  ]),
  helper("left", "string", "Take text from the left side of a value.", "When `by` is a number, returns the first N characters. When `by` is a string, returns the text before the first occurrence of that delimiter. If the delimiter is missing, the original string is returned.", "left(value, by)", "Expression<string>", [
    { name: "value", kind: "expression", description: "The source expression to convert to text first." },
    { name: "by", kind: "expression", description: "Either a character count or a delimiter string." },
  ], ["v.left(v.field(\"code\"), 3)", "v.left(v.field(\"code\"), \"_\")"]),
  helper("right", "string", "Take text from the right side of a value.", "When `by` is a number, returns the last N characters. When `by` is a string, returns the text after the last occurrence of that delimiter. If the delimiter is missing, the original string is returned.", "right(value, by)", "Expression<string>", [
    { name: "value", kind: "expression", description: "The source expression to convert to text first." },
    { name: "by", kind: "expression", description: "Either a character count or a delimiter string." },
  ], ["v.right(v.field(\"code\"), 2)", "v.right(v.field(\"code\"), \"_\")"]),
  helper("contains", "string", "Check for case-insensitive containment.", "Returns true when the left text includes the right text ignoring case.", "contains(left, right)", "BooleanExpression", [
    { name: "left", kind: "expression", description: "The haystack expression." },
    { name: "right", kind: "expression", description: "The needle expression." },
  ]),
  helper("startsWith", "string", "Check for a case-insensitive prefix.", "Returns true when the left text starts with the right text ignoring case.", "startsWith(left, right)", "BooleanExpression", [
    { name: "left", kind: "expression", description: "The full text expression." },
    { name: "right", kind: "expression", description: "The expected prefix." },
  ]),
  helper("endsWith", "string", "Check for a case-insensitive suffix.", "Returns true when the left text ends with the right text ignoring case.", "endsWith(left, right)", "BooleanExpression", [
    { name: "left", kind: "expression", description: "The full text expression." },
    { name: "right", kind: "expression", description: "The expected suffix." },
  ]),
  helper("coalesce", "nullability", "Return the first present value.", "Returns the first value that is not null, undefined, or an empty string.", "coalesce(...expressions)", "Expression<T>", [
    { name: "expressions", kind: "expression", description: "Fallback expressions evaluated in order.", variadic: true },
  ], ["v.coalesce(v.field(\"note\"), v.string(\"No note\"))"]),
  helper("exists", "nullability", "Check whether a value is present.", "Returns true for values that are not null, undefined, or an empty string.", "exists(value)", "BooleanExpression", [
    { name: "value", kind: "expression", description: "The expression to test." },
  ]),
  helper("notExists", "nullability", "Check whether a value is missing.", "Returns true for values that are null, undefined, or an empty string.", "notExists(value)", "BooleanExpression", [
    { name: "value", kind: "expression", description: "The expression to test." },
  ]),
  helper("datePart", "date", "Extract a date component.", "Extracts year, month, day, or quarter from a date-like value.", "datePart(value, part)", "Expression<string | number | null>", [
    { name: "value", kind: "expression", description: "The date-like expression to inspect." },
    { name: "part", kind: "date-part", description: "The date component to extract: year, month, day, or quarter." },
  ], ["v.datePart(v.field(\"workDate\"), \"month\")"]),
  helper("pathJoin", "path", "Join path segments with backslashes.", "Stringifies, trims, and joins non-empty segments into a path-like string.", "pathJoin(...parts)", "Expression<string>", [
    { name: "parts", kind: "expression", description: "The path segments to join.", variadic: true },
  ], ["v.pathJoin(v.field(\"project.code\"), v.field(\"employee\"))"]),
  helper("ifElse", "control-flow", "Branch between two expressions.", "Evaluates the condition and returns either the true branch or the false branch expression.", "ifElse(condition, whenTrue, whenFalse)", "Expression<T>", [
    { name: "condition", kind: "boolean-expression", description: "The condition that controls the branch." },
    { name: "whenTrue", kind: "expression", description: "The expression returned when the condition is truthy." },
    { name: "whenFalse", kind: "expression", description: "The expression returned when the condition is falsy." },
  ], ["v.ifElse(v.exists(v.field(\"note\")), v.field(\"note\"), v.string(\"(none)\"))"]),
  helper("let", "control-flow", "Bind intermediate expressions to names.", "Creates named intermediate expressions and exposes them to a builder callback for reuse.", "let(bindings, build)", "Expression<T>", [
    { name: "bindings", kind: "bindings", description: "An object of named intermediate expressions." },
    { name: "build", kind: "builder", description: "A callback that receives typed references to the bindings and returns the final expression." },
  ], ["v.let({ hours: v.toNumber(v.field(\"hours\")) }, ({ hours }) => v.coalesce(hours, v.number(0)))"]),
  helper("decryptField", "crypto", "Decrypt an encrypted field to plaintext.", "Decrypts a `<name>_encrypted` field and returns the plaintext string. The optional `key` names the symmetric key id; when omitted the host falls back to the field's `<name>_encrypted_key` companion and finally the tenant default key. Decryption is performed out-of-band by the host runtime, so this requires the named key to be present in the source tenant's unlocked key bag.", "decryptField(field, key?)", "Expression<string | null>", [
    { name: "field", kind: "string", description: "The encrypted field name, e.g. \"user_details_encrypted\"." },
    { name: "key", kind: "expression", description: "Optional key id (literal or expression) overriding the default key resolution.", optional: true },
  ], ["v.decryptField(\"user_details_encrypted\")", "v.decryptField(\"contact_encrypted\", v.field(\"contact_encrypted_key\"))"]),
  helper("decryptJson", "crypto", "Decrypt an encrypted field and parse it as JSON.", "Decrypts a `<name>_encrypted` field, parses the plaintext with JSON.parse, and returns the resulting object/value. The optional dot `path` selects a nested value. The optional `key` overrides default key resolution (when supplying a key without a path, pass an empty string for the path). Requires the named key in the source tenant's unlocked key bag.", "decryptJson(field, path?, key?)", "Expression<unknown>", [
    { name: "field", kind: "string", description: "The encrypted field name, e.g. \"user_details_encrypted\"." },
    { name: "path", kind: "string", description: "Optional dot-separated path into the parsed JSON, e.g. \"address.city\".", optional: true },
    { name: "key", kind: "expression", description: "Optional key id (literal or expression) overriding the default key resolution.", optional: true },
  ], ["v.decryptJson(\"user_details_encrypted\", \"username\")", "v.decryptJson(\"contact_encrypted\", \"email\", v.field(\"contact_encrypted_key\"))"]),
  helper("json", "json", "Read a plain JSON field as an object.", "Reads a field and parses it with JSON.parse when it is a string, passing objects/values through unchanged. The optional dot `path` selects a nested value. Use this for regular (non-encrypted) JSON fields.", "json(field, path?)", "Expression<unknown>", [
    { name: "field", kind: "string", description: "The field name holding a JSON string or object." },
    { name: "path", kind: "string", description: "Optional dot-separated path into the parsed JSON, e.g. \"address.city\".", optional: true },
  ], ["v.json(\"profile\")", "v.json(\"profile\", \"address.city\")"]),
] as const satisfies readonly MindooDBViewLanguageHelperMetadata[];

export const mindooDBViewLanguageHelpersByName = Object.freeze(
  Object.fromEntries(mindooDBViewLanguageHelpers.map((helperDef) => [helperDef.name, helperDef])),
) as Readonly<Record<(typeof mindooDBViewLanguageHelpers)[number]["name"], MindooDBViewLanguageHelperMetadata>>;

export function getMindooDBViewLanguageHelper(name: string): MindooDBViewLanguageHelperMetadata | undefined {
  return mindooDBViewLanguageHelpersByName[name as keyof typeof mindooDBViewLanguageHelpersByName];
}
