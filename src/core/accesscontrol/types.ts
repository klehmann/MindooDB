import { CUSTOM_DOC_ID_REGEX } from "../types";
import { getDatabaseIdValidationError } from "../databaseIdValidation";

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
  /**
   * Optional allowlist of `decryptionKeyId`s that a `doc_create` may use in the
   * governed scope (tenant default, or a single database when set on a per-db
   * policy). This is a **Tier 1** write constraint: `decryptionKeyId` is
   * cleartext entry metadata the server already reads, so it is enforced at the
   * witness and re-checked on every honest client — unlike `withfields` (Tier
   * 2). Absent/empty = unconstrained (backward compatible). Non-empty = a
   * `doc_create` whose `decryptionKeyId` is not in the set is denied, even if an
   * allow rule would otherwise match (a hard create-key gate).
   *
   * Use cases: forbid the shared `default` key (omit `"default"` to require a
   * named key), or enforce a rotating key by pointing the allowlist at the
   * current rotation key. Rotation is just a new policy revision on the
   * directory time-travel chain, so each change is auditable via
   * {@link AccessDecision} replay and `wasAllowedAt`. Because evaluation runs
   * against the directory state at each entry's trusted time, documents created
   * under an earlier policy are grandfathered automatically — tightening the
   * allowlist never retroactively invalidates valid history.
   */
  allowedCreateKeyIds?: string[];
  /**
   * Optional default `decryptionKeyId` for a `doc_create` that does not specify
   * one in the governed scope (tenant default, or a single database when set on
   * a per-db policy). Unlike {@link allowedCreateKeyIds}, this is NOT a security
   * control: the sync server never selects keys, so this is a client-side
   * create-time convenience that fills in the key when the caller omits it
   * (replacing the hardcoded `"default"` fallback). The create-key gate
   * ({@link allowedCreateKeyIds}) remains authoritative.
   *
   * When both fields are set on the same policy document, `defaultCreateKeyId`
   * MUST be a member of `allowedCreateKeyIds` (enforced by
   * {@link validateAccessPolicy} at write time), otherwise the default would be
   * self-denying. Like every policy field it layers per-db over the tenant
   * default in {@link effectivePolicy}.
   */
  defaultCreateKeyId?: string;
  /**
   * Governs whether tenant members may open/sync arbitrary database ids.
   *
   * This is a **tenant-level** control and is only read from the tenant default
   * policy (`acl_defaultpolicy`); it is intentionally NOT layered through a
   * per-db `acl_dbpolicy_*` document. Defaults to `"open"` when omitted.
   *
   * - `"open"` (default): any syntactically valid database id may be opened and
   *   synced — today's behavior, convenient for quick experimentation.
   * - `"directory-restricted"`: only the `"directory"` database (always
   *   implicitly allowed) and the ids listed in {@link allowedDbIds} may be
   *   opened or synced. The tenant admin is exempt and may use any id.
   */
  databaseCreationPolicy?: "open" | "directory-restricted";
  /**
   * The set of database ids that may be opened/synced when
   * {@link databaseCreationPolicy} is `"directory-restricted"`. `"directory"` is
   * always implicitly allowed and need not be listed; every other id (including
   * `"main"`) must be listed explicitly. Ignored when the policy is `"open"`.
   * Tenant-level only (not layered per-db).
   */
  allowedDbIds?: string[];
  /**
   * Storage-format floor: a trusted-time cutoff (ms since epoch) at and after
   * which a store entry MUST carry the v2 metadata-binding author signature
   * (`metadataSignature`, `entryVersion >= 2`). Entries whose trusted time is
   * strictly BEFORE this cutoff may still verify via the legacy ciphertext-only
   * signature, so genuine older history (and old tenants migrating in) keeps
   * loading.
   *
   * This is a **tenant-level** control read only from the tenant default policy
   * (`acl_defaultpolicy`); it is NOT layered per-db. Absent = no requirement
   * (fully backward compatible — the legacy fallback always applies).
   *
   * Security model (zero-trust server): the authoritative enforcement is the
   * sync server's push gate, which compares the cutoff against ITS OWN clock at
   * ingest (`receivedAt = now`). After the cutoff, no new v1 entry can be
   * accepted, so a forged v1 entry cannot bypass the floor by backdating its
   * self-asserted `createdAt`. Honest clients additionally re-check on read
   * using each entry's {@link entryTrustedTime} as defense in depth. Because the
   * cutoff lives in the admin-signed policy document, a hostile relay cannot
   * move it. New tenants are created with this set to their creation time so the
   * whole tenant is v2-only from entry #1.
   */
  requireMetadataSignatureSince?: number;
}

/**
 * The effective baseline defaults when a policy document exists but omits a
 * field (§6.1). Snapshot and purge default to denied (admin-only).
 */
export const DEFAULT_POLICY_DEFAULTS: Required<
  Omit<
    DefaultAccessPolicyDoc,
    | "form"
    | "type"
    | "disableAllAccessChecksAndPolicies"
    | "allowedCreateKeyIds"
    | "defaultCreateKeyId"
    | "databaseCreationPolicy"
    | "allowedDbIds"
    | "requireMetadataSignatureSince"
  >
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
  /**
   * Targeted usernames/groups (JSON {@link RuleTargets}) encrypted with the
   * tenant default key, base64-encoded — a display aid for admin UIs so they can
   * show who a rule targets without reversing the salted hashes. Encrypted with
   * the tenant default key (not `$publicinfos`), so it stays opaque to the sync
   * server while remaining readable by tenant clients. Empty when the rule was
   * authored from raw hashes / pseudo-tokens only (nothing cleartext to show).
   */
  users_encrypted: string;
  action: "allow" | "deny";
}

/**
 * Decrypted targets of a rule, for admin-UI display only (never serialized to
 * the directory). Populated by {@link AclRuleDoc.users_encrypted} /
 * {@link ReadRuleDoc.users_encrypted} on the listing APIs.
 */
export interface RuleTargets {
  usernames: string[];
  groups: string[];
}

/** A trusted timestamping witness (sync server), §6.4. */
export interface TrustedWitnessDoc {
  form: typeof ACCESS_CONTROL_FORM;
  type: "trustedwitness";
  /** Ed25519 public key, PEM. */
  witnessPublicKey: string;
  serverUrl?: string;
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
 * Validate a {@link DefaultAccessPolicyDoc} (tenant default or per-db) before
 * it is written. Enforces that a `defaultCreateKeyId`, when set together with a
 * non-empty `allowedCreateKeyIds` on the SAME document, is a member of that
 * allowlist — otherwise the default would be self-denying (the create-key gate
 * would reject every default-keyed `doc_create`). Throws on violation.
 *
 * This is a per-document check: the allowlist and default can in principle come
 * from different layers (tenant vs per-db), which write-time validation cannot
 * see; the resolver ({@link effectivePolicy} consumers, e.g.
 * `getEffectiveDefaultCreateKeyId`) applies the cross-layer safety net.
 */
export function validateAccessPolicy(
  policy: Partial<Omit<DefaultAccessPolicyDoc, "form" | "type">>
): void {
  if (
    policy.defaultCreateKeyId !== undefined &&
    Array.isArray(policy.allowedCreateKeyIds) &&
    policy.allowedCreateKeyIds.length > 0 &&
    !policy.allowedCreateKeyIds.includes(policy.defaultCreateKeyId)
  ) {
    throw new Error(
      `defaultCreateKeyId "${policy.defaultCreateKeyId}" must be one of allowedCreateKeyIds ` +
        `[${policy.allowedCreateKeyIds.join(", ")}]`
    );
  }

  if (
    policy.databaseCreationPolicy !== undefined &&
    policy.databaseCreationPolicy !== "open" &&
    policy.databaseCreationPolicy !== "directory-restricted"
  ) {
    throw new Error(
      `databaseCreationPolicy "${String(policy.databaseCreationPolicy)}" must be ` +
        `"open" or "directory-restricted"`
    );
  }

  if (policy.allowedDbIds !== undefined) {
    if (!Array.isArray(policy.allowedDbIds)) {
      throw new Error("allowedDbIds must be an array of database ids");
    }
    for (const dbId of policy.allowedDbIds) {
      const error = getDatabaseIdValidationError(dbId, "allowedDbIds entry");
      if (error) {
        throw new Error(error);
      }
    }
  }

  if (policy.requireMetadataSignatureSince !== undefined) {
    if (
      typeof policy.requireMetadataSignatureSince !== "number" ||
      !Number.isFinite(policy.requireMetadataSignatureSince) ||
      policy.requireMetadataSignatureSince < 0
    ) {
      throw new Error(
        "requireMetadataSignatureSince must be a non-negative epoch-millisecond timestamp",
      );
    }
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
): Required<
  Omit<
    DefaultAccessPolicyDoc,
    | "form"
    | "type"
    | "allowedCreateKeyIds"
    | "defaultCreateKeyId"
    | "databaseCreationPolicy"
    | "allowedDbIds"
    | "requireMetadataSignatureSince"
  >
> & {
  allowedCreateKeyIds?: string[];
  defaultCreateKeyId?: string;
} {
  const pick = <K extends keyof typeof DEFAULT_POLICY_DEFAULTS>(field: K): boolean => {
    if (dbPolicy && dbPolicy[field] !== undefined) return dbPolicy[field] as boolean;
    if (tenantDefault && tenantDefault[field] !== undefined) return tenantDefault[field] as boolean;
    return DEFAULT_POLICY_DEFAULTS[field];
  };
  const disable =
    (dbPolicy?.disableAllAccessChecksAndPolicies ?? tenantDefault?.disableAllAccessChecksAndPolicies) ===
    true;
  // Per-db precedence: a database policy's allowlist (when defined) fully
  // overrides the tenant default's — it is not merged/unioned, so a database
  // can both tighten and loosen the tenant-wide create-key constraint.
  const allowedCreateKeyIds =
    (dbPolicy && dbPolicy.allowedCreateKeyIds) ??
    (tenantDefault && tenantDefault.allowedCreateKeyIds) ??
    undefined;
  // Same per-db precedence for the default create key: a per-db default fully
  // overrides the tenant default's, so a database can pick its own default key.
  const defaultCreateKeyId =
    (dbPolicy && dbPolicy.defaultCreateKeyId) ??
    (tenantDefault && tenantDefault.defaultCreateKeyId) ??
    undefined;
  return {
    disableAllAccessChecksAndPolicies: disable,
    denyDocCreate: pick("denyDocCreate"),
    denyDocChange: pick("denyDocChange"),
    denyDocDelete: pick("denyDocDelete"),
    denyDocUndelete: pick("denyDocUndelete"),
    denyDocSnapshot: pick("denyDocSnapshot"),
    denyDocPurge: pick("denyDocPurge"),
    allowedCreateKeyIds,
    defaultCreateKeyId,
  };
}

// ===========================================================================
// Read access control (docs/accesscontrol.md — read-side).
//
// The read-side mirrors the write-side two-tier model but is intentionally
// **metadata-only**: a read rule may scope by author identity, target database
// and `decryptionKeyId`, but never by document content (`withfields`). That
// keeps every read decision evaluable by the zero-trust sync server from the
// cleartext entry metadata it already holds, so the server can gate delivery.
//
// There are deliberately NO client-trusted dates (`notBefore`/`notAfter`) on
// read rules. A client-evaluated validity window would be clock-spoofable and
// would reintroduce the wall-clock dependency the write side forbids (see the
// no-`${now}` note above). Time-bound access is therefore expressed as
// **revocation by policy revision**: an admin (or a scheduled automation)
// flips the allow rule to deny / removes the user, and on the next directory
// sync the server stops delivering and the client purges the scope.
//
// All read-side documents share `form: "accesscontrol"` and are
// `$publicinfos`-encrypted so the server can read them.
// ===========================================================================

/** The `type` value of a read rule document (read-side analogue of {@link RuleType}). */
export const READ_RULE_TYPE = "doc_read" as const;
export type ReadRuleType = typeof READ_RULE_TYPE;

/**
 * The default tenant read policy, or a per-database read policy (same shape).
 *
 * Unlike the write side, the **absence** of any read policy document means
 * "read access is unrestricted" — preserving today's behavior where read
 * access is governed purely by key possession. Creating an `acl_readpolicy`
 * with `defaultReadAccess: "deny"` is what switches a tenant to a default-deny
 * read posture.
 */
export interface DefaultReadPolicyDoc {
  form: typeof ACCESS_CONTROL_FORM;
  type: "readpolicy";
  /**
   * Baseline read access when no rule matches. `"allow"` (the implicit default
   * when the document is absent) keeps key-possession as the only gate;
   * `"deny"` requires an explicit allow rule to read.
   */
  defaultReadAccess?: "allow" | "deny";
  /**
   * Master off switch for read checks. When true, the server delivers and the
   * client retains everything regardless of read rules (key possession still
   * applies). Mirrors {@link DefaultAccessPolicyDoc.disableAllAccessChecksAndPolicies}.
   */
  disableAllReadChecks?: boolean;
}

/**
 * A single read rule (read-side analogue of {@link AclRuleDoc}). Metadata-only:
 * it gates by target database, optional `decryptionKeyId` scope, and the acting
 * user's identity. No `withfields`, no `notBefore`/`notAfter`.
 */
export interface ReadRuleDoc {
  form: typeof ACCESS_CONTROL_FORM;
  type: ReadRuleType;
  /** Stable id, surfaced in {@link AccessDecision.matchedRuleId}. */
  ruleId: string;
  description?: string;
  /** Target database, or `"*"` for all databases in the tenant. */
  dbid: string | "*";
  /**
   * Optional key scope: the rule only applies to entries whose
   * `decryptionKeyId` is in this list. Absent/empty = applies to every key in
   * the database (document-level read control).
   */
  decryptionKeyIds?: string[];
  /** User + group hashes, plus reserved pseudo-tokens (`$everyone`, `$admin`). */
  users_hashes: string[];
  /**
   * Targeted usernames/groups (JSON {@link RuleTargets}) encrypted with the
   * tenant default key, base64-encoded — a display aid for admin UIs (see
   * {@link AclRuleDoc.users_encrypted}). Opaque to the sync server. Empty when
   * the rule was authored from raw hashes / pseudo-tokens only.
   */
  users_encrypted: string;
  action: "allow" | "deny";
}

/**
 * One wrapped version of a rotated key inside a {@link KeyDeliveryRecipient}.
 *
 * A `keyId` can hold several versions in the KeyBag after rotation, and
 * decryption tries them all. Delivering only the newest version would leave a
 * recipient unable to read documents encrypted under an earlier version, so a
 * delivery carries every version the preparer holds.
 */
export interface KeyDeliveryVersion {
  /** The KeyBag version timestamp (`createdAt`) of this key version; 0 if unknown. */
  keyVersionCreatedAt: number;
  /**
   * This version's symmetric key bytes wrapped to the recipient's RSA-OAEP
   * encryption public key (see `RSAEncryption.encrypt`), base64-encoded. Only
   * the holder of the matching private key — never the admin who publishes the
   * doc — can unwrap it.
   */
  wrappedKey: string;
}

/** One recipient of a wrapped key inside a {@link KeyDeliveryDoc}. */
export interface KeyDeliveryRecipient {
  /** `username_hash` (salted v2) of the recipient. */
  username_hash: string;
  /**
   * Every stored version of the key, wrapped to this recipient (newest first).
   * Includes all rotation versions so previously-encrypted documents remain
   * decryptable after the recipient imports the delivery.
   */
  versions: KeyDeliveryVersion[];
}

/**
 * An admin-published, admin-blind key delivery document (read-side key push).
 *
 * The wrapped bytes are produced by a key-*holder* (a regular user who already
 * has the key) using each recipient's public encryption key; the admin merely
 * signs and writes the directory document. An admin outside the recipient set
 * therefore never sees the plaintext key. On sync, a recipient client detects
 * a delivery targeting it, RSA-unwraps the key, imports it into its KeyBag, and
 * the existing reveal-on-add visibility path surfaces the now-readable docs.
 */
export interface KeyDeliveryDoc {
  form: typeof ACCESS_CONTROL_FORM;
  type: "keydelivery";
  /** The symmetric key id being delivered (matches `decryptionKeyId`). */
  keyId: string;
  /** The key-holder's signing public key that prepared the wrapped bytes (audit). */
  preparedByPublicKey: string;
  /** One entry per recipient, each carrying all wrapped key versions. */
  recipients: KeyDeliveryRecipient[];
}

/**
 * The output of preparing a key delivery (the key-holder step), handed to an
 * admin to {@link KeyDeliveryDoc | publish}. It carries everything the
 * directory document needs except the admin signature.
 */
export interface KeyDeliveryPayload {
  keyId: string;
  preparedByPublicKey: string;
  recipients: KeyDeliveryRecipient[];
}

// ---------------------------------------------------------------------------
// Read-side fixed/pattern document IDs
// ---------------------------------------------------------------------------

/** Singleton id of the tenant default read policy document. */
export const ACL_READ_POLICY_DOC_ID = "acl_readpolicy";

const ACL_DB_READ_POLICY_PREFIX = "acl_dbreadpolicy_";
const ACL_READ_RULE_PREFIX = "acl_readrule_";
const ACL_KEY_DELIVERY_PREFIX = "acl_keydelivery_";

/** Document id for a per-database read policy. */
export function aclDbReadPolicyDocId(dbid: string): string {
  return assertValidDocId(ACL_DB_READ_POLICY_PREFIX + encodeAclIdComponent(dbid));
}

/** Document id for a single read rule, keyed by its stable `ruleId`. */
export function aclReadRuleDocId(ruleId: string): string {
  return assertValidDocId(ACL_READ_RULE_PREFIX + encodeAclIdComponent(ruleId));
}

/**
 * Document id for a key delivery, keyed by the delivered key id and a
 * fingerprint that disambiguates concurrent deliveries (e.g. a hash of the
 * recipient set or the key version). Keying by `keyId_fingerprint` lets several
 * deliveries of the same key (to different audiences/versions) coexist.
 */
export function aclKeyDeliveryDocId(keyId: string, fingerprint: string): string {
  return assertValidDocId(
    ACL_KEY_DELIVERY_PREFIX + encodeAclIdComponent(keyId) + "_" + encodeAclIdComponent(fingerprint)
  );
}

/**
 * Validate a {@link ReadRuleDoc} (minus the assigned `form`/`ruleId`, which the
 * directory sets). Read rules are metadata-only: they must not carry
 * `withfields`, and the closed action set applies. Throws on the first
 * violation.
 */
export function validateReadRule(rule: {
  type: ReadRuleType;
  dbid: string;
  action: "allow" | "deny";
  users_hashes: string[];
  decryptionKeyIds?: string[];
}): void {
  if (rule.type !== READ_RULE_TYPE) {
    throw new Error(`read rule has unknown type "${rule.type}" (expected "${READ_RULE_TYPE}")`);
  }
  if (rule.action !== "allow" && rule.action !== "deny") {
    throw new Error(`read rule has invalid action "${rule.action}" (expected "allow" or "deny")`);
  }
  if (typeof rule.dbid !== "string" || rule.dbid.length === 0) {
    throw new Error('read rule requires a non-empty `dbid` (or "*")');
  }
  if (!Array.isArray(rule.users_hashes) || rule.users_hashes.length === 0) {
    throw new Error("read rule requires a non-empty `users_hashes` array");
  }
  if (
    rule.decryptionKeyIds !== undefined &&
    (!Array.isArray(rule.decryptionKeyIds) ||
      rule.decryptionKeyIds.some((k) => typeof k !== "string"))
  ) {
    throw new Error("read rule `decryptionKeyIds` must be an array of strings when present");
  }
}

/** Fully-resolved read policy: baseline access plus the master switch. */
export interface EffectiveReadPolicy {
  /** Baseline access when no rule matches. */
  defaultReadAccess: "allow" | "deny";
  /** When true, read checks are bypassed entirely. */
  disableAllReadChecks: boolean;
}

/**
 * Compute the effective read policy by layering a per-db read policy over the
 * tenant default. An absent tenant default means read access is unrestricted,
 * which is represented as `defaultReadAccess: "allow"`.
 */
export function effectiveReadPolicy(
  tenantDefault: DefaultReadPolicyDoc | null | undefined,
  dbPolicy: DefaultReadPolicyDoc | null | undefined
): EffectiveReadPolicy {
  const access =
    dbPolicy?.defaultReadAccess ?? tenantDefault?.defaultReadAccess ?? "allow";
  const disable =
    (dbPolicy?.disableAllReadChecks ?? tenantDefault?.disableAllReadChecks) === true;
  return {
    defaultReadAccess: access === "deny" ? "deny" : "allow",
    disableAllReadChecks: disable,
  };
}
