import { CUSTOM_DOC_ID_REGEX } from "../types";

/**
 * Access-control directory schema (docs/accesscontrol.md §6) plus the
 * evaluation result type (§7).
 *
 * All access-control state lives in the admin-only `directory` database and
 * syncs to every participant. Several documents use **fixed document IDs** so
 * they can be read by direct lookup without an index/view. Every field the
 * SERVER must evaluate for Tier 1 is encrypted with the `$publicinfos` key (so
 * the server can read it without the tenant key); `withfields` (Tier 2) is
 * never readable by the server.
 */

/** The `form` value shared by every access-control directory document (§6). */
export const ACCESS_CONTROL_FORM = "accesscontrol" as const;

// ---------------------------------------------------------------------------
// Closed enum sets (§6.3). Unknown values are validation errors at rule
// creation time — there is no regex or open-ended operator in v1.
// ---------------------------------------------------------------------------

/** Operation types a rule can govern. Mirrors the relevant `StoreEntryType`s. */
export type RuleType =
  | "doc_create"
  | "doc_change"
  | "doc_delete"
  | "doc_undelete"
  | "doc_snapshot"
  | "doc_purge";

/** All valid {@link RuleType} values, for validation and iteration. */
export const RULE_TYPES: readonly RuleType[] = [
  "doc_create",
  "doc_change",
  "doc_delete",
  "doc_undelete",
  "doc_snapshot",
  "doc_purge",
];

/** Comparison operators usable in a {@link WithFieldClause}. Closed set. */
export type Operator =
  | "equals"
  | "notEquals"
  | "contains"
  | "containsAny"
  | "containsAll"
  | "exists"
  | "notExists"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

/** All valid {@link Operator} values. */
export const OPERATORS: readonly Operator[] = [
  "equals",
  "notEquals",
  "contains",
  "containsAny",
  "containsAll",
  "exists",
  "notExists",
  "gt",
  "gte",
  "lt",
  "lte",
];

/**
 * Placeholders resolved at evaluation time against the acting user.
 *
 * There is deliberately NO `${now}` / wall-clock placeholder: ACL evaluation
 * must be a pure, deterministic function of the entry plus directory state
 * (§7, §10), and a wall-clock value would make replicas disagree.
 */
export type Placeholder = "${user.username}" | "${user.usernames}" | "${user.groups}";

/** All valid {@link Placeholder} values. */
export const PLACEHOLDERS: readonly Placeholder[] = [
  "${user.username}",
  "${user.usernames}",
  "${user.groups}",
];

/** Returns true if `value` is a recognized {@link Placeholder}. */
export function isPlaceholder(value: unknown): value is Placeholder {
  return typeof value === "string" && (PLACEHOLDERS as readonly string[]).includes(value);
}

/**
 * Reserved pseudo-tokens stored literally in `users_hashes`. They are NOT
 * secret (§6.3):
 * - `$everyone` — all registered users;
 * - `$admin` — the tenant admin only;
 * - `$author` — the original creator of the document being modified
 *   (meaningful only on `doc_change`/`doc_delete`/`doc_undelete`).
 */
export const PSEUDO_TOKEN_EVERYONE = "$everyone" as const;
export const PSEUDO_TOKEN_ADMIN = "$admin" as const;
export const PSEUDO_TOKEN_AUTHOR = "$author" as const;
export const RESERVED_PSEUDO_TOKENS: readonly string[] = [
  PSEUDO_TOKEN_EVERYONE,
  PSEUDO_TOKEN_ADMIN,
  PSEUDO_TOKEN_AUTHOR,
];

// ---------------------------------------------------------------------------
// Document interfaces (§6)
// ---------------------------------------------------------------------------

/** Which document state a {@link WithFieldClause} is evaluated against (§6.3). */
export type WithFieldWhen = "before" | "after";

/**
 * A single content condition inside a Tier 2 rule (§6.3). The presence of any
 * `withfields` clause on a rule makes the rule Tier 2 (client-only), because it
 * depends on encrypted document content the server cannot read.
 */
export interface WithFieldClause {
  /** Dot-path inside the document, e.g. `myeditors` or `meta.owner`. */
  key: string;
  op: Operator;
  /** Literal value or a {@link Placeholder} resolved against the acting user. */
  value: string | number | boolean | string[] | Placeholder;
  /**
   * Which document state to evaluate against. Op-appropriate defaults when
   * omitted: `doc_create` => "after" (no before state exists); all other ops
   * => "before" (authorization must look at the existing document, otherwise a
   * user could self-authorize within the same change).
   */
  when?: WithFieldWhen;
}

/**
 * The default tenant policy, or a per-database policy (same shape), §6.1/§6.2.
 *
 * The mere existence of `acl_defaultpolicy` is what activates access control;
 * a brand-new tenant has no such document and therefore runs with no checks.
 * Once the document exists, omitted fields take the stated defaults — see
 * {@link DEFAULT_POLICY_DEFAULTS} and {@link effectivePolicy}.
 */
export interface DefaultAccessPolicyDoc {
  form: typeof ACCESS_CONTROL_FORM;
  type: "defaultpolicy";
  /**
   * Master off switch (§7 step 0). When true, ALL checks and rules (including
   * standalone deny rules) are bypassed. Defaults to false when the document
   * exists.
   */
  disableAllAccessChecksAndPolicies?: boolean;
  denyDocCreate?: boolean; // default false
  denyDocChange?: boolean; // default false
  denyDocDelete?: boolean; // default false
  denyDocUndelete?: boolean; // default false
  denyDocSnapshot?: boolean; // default true (admin-only by default)
  denyDocPurge?: boolean; // default true (admin-only by default)
}

/**
 * The effective baseline defaults when a policy document exists but omits a
 * field (§6.1). Snapshot and purge default to denied (admin-only).
 */
export const DEFAULT_POLICY_DEFAULTS: Required<
  Omit<DefaultAccessPolicyDoc, "form" | "type" | "disableAllAccessChecksAndPolicies">
> = {
  denyDocCreate: false,
  denyDocChange: false,
  denyDocDelete: false,
  denyDocUndelete: false,
  denyDocSnapshot: true,
  denyDocPurge: true,
};

/** Map a {@link RuleType} to the policy `deny<Op>` field that gates it. */
export const RULE_TYPE_TO_DENY_FIELD: Record<
  RuleType,
  keyof typeof DEFAULT_POLICY_DEFAULTS
> = {
  doc_create: "denyDocCreate",
  doc_change: "denyDocChange",
  doc_delete: "denyDocDelete",
  doc_undelete: "denyDocUndelete",
  doc_snapshot: "denyDocSnapshot",
  doc_purge: "denyDocPurge",
};

/** A single access-control rule (§6.3). */
export interface AclRuleDoc {
  form: typeof ACCESS_CONTROL_FORM;
  type: RuleType;
  /** Stable id, surfaced in {@link AccessDecision.matchedRuleId}. */
  ruleId: string;
  description?: string;
  /** Target database, or `"*"` for all databases in the tenant. */
  dbid: string | "*";
  /** Presence makes the rule Tier 2 (client-only). */
  withfields?: WithFieldClause[];
  /** User + group hashes, plus reserved pseudo-tokens. */
  users_hashes: string[];
  /** Usernames encrypted with `$publicinfos` (audit/debug aid). */
  users_encrypted: string;
  action: "allow" | "deny";
}

/** A trusted timestamping witness (sync server), §6.4. */
export interface TrustedWitnessDoc {
  form: typeof ACCESS_CONTROL_FORM;
  type: "trustedwitness";
  /** Ed25519 public key, PEM. */
  witnessPublicKey: string;
  serverUrl?: string;
  /** Optional validity window (ms epoch). */
  notBefore?: number;
  notAfter?: number;
}

/** Tier an {@link AccessDecision} was reached at. */
export type AccessTier = "tier1" | "tier2";

/** Result of an access-control evaluation (§7). */
export interface AccessDecision {
  allowed: boolean;
  /** Human-readable explanation, for audit logs and the Haven UI. */
  reason: string;
  /** Set to the `ruleId` of the rule that decided, when a rule decided. */
  matchedRuleId?: string;
  tier: AccessTier;
}

// ---------------------------------------------------------------------------
// Fixed/pattern document IDs (§6)
// ---------------------------------------------------------------------------

/** Singleton id of the tenant default policy document. */
export const ACL_DEFAULT_POLICY_DOC_ID = "acl_defaultpolicy";

const ACL_DB_POLICY_PREFIX = "acl_dbpolicy_";
const ACL_TRUSTED_WITNESS_PREFIX = "acl_trustedwitness_";
const ACL_RULE_PREFIX = "acl_rule_";

/**
 * Encode an arbitrary string into a component made only of `[A-Za-z0-9_]`, so
 * it can be embedded in a fixed document ID that satisfies
 * {@link CUSTOM_DOC_ID_REGEX} (§6).
 *
 * The encoding is injective and reversible: ASCII letters and digits pass
 * through unchanged; every other byte (including a literal `_`) is escaped as
 * `_` followed by two lowercase hex digits. Because every literal underscore is
 * escaped, decoding is unambiguous. Examples:
 * - `directory` -> `directory`
 * - `test-db`   -> `test_2ddb`
 * - `a_b`       -> `a_5fb`
 */
export function encodeAclIdComponent(raw: string): string {
  let out = "";
  const bytes = new TextEncoder().encode(raw);
  for (const byte of bytes) {
    const isLetter =
      (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
    const isDigit = byte >= 0x30 && byte <= 0x39;
    if (isLetter || isDigit) {
      out += String.fromCharCode(byte);
    } else {
      out += "_" + byte.toString(16).padStart(2, "0");
    }
  }
  return out;
}

/** Inverse of {@link encodeAclIdComponent}. */
export function decodeAclIdComponent(encoded: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    const ch = encoded[i];
    if (ch === "_") {
      const hex = encoded.slice(i + 1, i + 3);
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(ch.charCodeAt(0));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Document id for a per-database policy (§6.2). */
export function aclDbPolicyDocId(dbid: string): string {
  return assertValidDocId(ACL_DB_POLICY_PREFIX + encodeAclIdComponent(dbid));
}

/** Document id for a trusted-witness entry, keyed by witness fingerprint (§6.4). */
export function aclTrustedWitnessDocId(fingerprint: string): string {
  return assertValidDocId(ACL_TRUSTED_WITNESS_PREFIX + encodeAclIdComponent(fingerprint));
}

/** Document id for a single rule, keyed by its stable `ruleId` (§6.3). */
export function aclRuleDocId(ruleId: string): string {
  return assertValidDocId(ACL_RULE_PREFIX + encodeAclIdComponent(ruleId));
}

function assertValidDocId(id: string): string {
  if (!CUSTOM_DOC_ID_REGEX.test(id)) {
    throw new Error(
      `Internal error: computed ACL document id "${id}" does not satisfy CUSTOM_DOC_ID_REGEX`
    );
  }
  return id;
}

// ---------------------------------------------------------------------------
// Validation (§6.3: closed operator/placeholder set; doc_create can't use before)
// ---------------------------------------------------------------------------

/**
 * Validate a {@link WithFieldClause} against the closed operator/placeholder
 * set and the op-specific `when` constraints. Throws a descriptive error on
 * the first violation. `ruleType` is needed to reject `when: "before"` on
 * `doc_create` (no before state exists).
 */
export function validateWithFieldClause(clause: WithFieldClause, ruleType: RuleType): void {
  if (typeof clause.key !== "string" || clause.key.length === 0) {
    throw new Error("withfields clause requires a non-empty string `key`");
  }
  if (!(OPERATORS as readonly string[]).includes(clause.op)) {
    throw new Error(`withfields clause has unknown operator "${clause.op}"`);
  }
  if (typeof clause.value === "string" && clause.value.startsWith("${") && !isPlaceholder(clause.value)) {
    throw new Error(`withfields clause uses unknown placeholder "${clause.value}"`);
  }
  if (clause.when !== undefined && clause.when !== "before" && clause.when !== "after") {
    throw new Error(`withfields clause has invalid \`when\` "${clause.when}"`);
  }
  if (ruleType === "doc_create" && clause.when === "before") {
    throw new Error('doc_create rules cannot use `when: "before"` (no before state exists)');
  }
}

/**
 * Validate an {@link AclRuleDoc} (minus the assigned `form`/`ruleId`, which the
 * directory sets). Enforces the closed type/operator/placeholder sets and the
 * `withfields` constraints (§6.3). Throws on the first violation.
 */
export function validateAclRule(rule: {
  type: RuleType;
  dbid: string;
  action: "allow" | "deny";
  users_hashes: string[];
  withfields?: WithFieldClause[];
}): void {
  if (!(RULE_TYPES as readonly string[]).includes(rule.type)) {
    throw new Error(`rule has unknown type "${rule.type}"`);
  }
  if (rule.action !== "allow" && rule.action !== "deny") {
    throw new Error(`rule has invalid action "${rule.action}" (expected "allow" or "deny")`);
  }
  if (typeof rule.dbid !== "string" || rule.dbid.length === 0) {
    throw new Error("rule requires a non-empty `dbid` (or \"*\")");
  }
  if (!Array.isArray(rule.users_hashes) || rule.users_hashes.length === 0) {
    throw new Error("rule requires a non-empty `users_hashes` array");
  }
  for (const clause of rule.withfields ?? []) {
    validateWithFieldClause(clause, rule.type);
  }
}

/**
 * Compute the effective policy by layering DB policy over the tenant default
 * and filling omitted fields with {@link DEFAULT_POLICY_DEFAULTS} (§6.2, §7).
 *
 * Returns a fully-populated set of `deny<Op>` flags plus the master switch.
 * A `null`/absent default policy means access control was never enabled, which
 * callers should treat as "all allowed" before calling this.
 */
export function effectivePolicy(
  tenantDefault: DefaultAccessPolicyDoc | null | undefined,
  dbPolicy: DefaultAccessPolicyDoc | null | undefined
): Required<Omit<DefaultAccessPolicyDoc, "form" | "type">> {
  const pick = <K extends keyof typeof DEFAULT_POLICY_DEFAULTS>(field: K): boolean => {
    if (dbPolicy && dbPolicy[field] !== undefined) return dbPolicy[field] as boolean;
    if (tenantDefault && tenantDefault[field] !== undefined) return tenantDefault[field] as boolean;
    return DEFAULT_POLICY_DEFAULTS[field];
  };
  const disable =
    (dbPolicy?.disableAllAccessChecksAndPolicies ?? tenantDefault?.disableAllAccessChecksAndPolicies) ===
    true;
  return {
    disableAllAccessChecksAndPolicies: disable,
    denyDocCreate: pick("denyDocCreate"),
    denyDocChange: pick("denyDocChange"),
    denyDocDelete: pick("denyDocDelete"),
    denyDocUndelete: pick("denyDocUndelete"),
    denyDocSnapshot: pick("denyDocSnapshot"),
    denyDocPurge: pick("denyDocPurge"),
  };
}
