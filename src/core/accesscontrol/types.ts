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

/**
 * Operation types a rule can govern. The `doc_*` mutation types mirror the
 * relevant `StoreEntryType`s. `doc_read` is special: it is NOT a store entry
 * type but a **database-level read/sync gate** (§6.6) — it decides whether a
 * user/group may open and sync a database at all. Because it is the coarse
 * gate in front of every sync operation for a database, it also gates writes
 * (a user who cannot read a database cannot create data in it either); `dbid`
 * is therefore the only scope that matters for a `doc_read` rule, and content
 * (`withfields`) clauses are not allowed on it.
 */
export type RuleType =
  | "doc_create"
  | "doc_change"
  | "doc_delete"
  | "doc_undelete"
  | "doc_snapshot"
  | "doc_purge"
  | "doc_read";

/** All valid {@link RuleType} values, for validation and iteration. */
export const RULE_TYPES: readonly RuleType[] = [
  "doc_create",
  "doc_change",
  "doc_delete",
  "doc_undelete",
  "doc_snapshot",
  "doc_purge",
  "doc_read",
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
   * Database read/sync gate (§6.6). When true, members may NOT open or sync the
   * governed database(s) unless an explicit `doc_read` allow rule grants them
   * access; when false (the default), reading is open and key possession is the
   * only thing that decides what a user can actually decrypt.
   *
   * This is the coarse per-database gate that sits in front of EVERY sync
   * operation: a user denied read access can neither pull nor push (so they
   * cannot create data in the database either — read is required to create).
   * Like the other `deny<Op>` flags it layers per-db over the tenant default in
   * {@link effectivePolicy}. The tenant admin is always exempt and the
   * `"directory"` database is never gated (it must always sync so the policy
   * itself can be read). Defaults to false.
   */
  denyDocRead?: boolean; // default false (reading open unless explicitly denied)
  /**
   * Optional default `decryptionKeyId` for a `doc_create` that does not specify
   * one in the governed scope (tenant default, or a single database when set on
   * a per-db policy). This is NOT a security control: the sync server never
   * selects keys, so this is a client-side create-time convenience that fills in
   * the key when the caller omits it (replacing the hardcoded `"default"`
   * fallback). Which keys a user may create or read under is governed by **key
   * possession** (the key distribution model, docs/accesscontrol.md §13), not by
   * a policy gate. Like every policy field it layers per-db over the tenant
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
  denyDocRead: false,
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
  doc_read: "denyDocRead",
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
 * the directory). Populated by {@link AclRuleDoc.users_encrypted} on the
 * listing APIs.
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
  // `doc_read` is a database-level gate (§6.6); it has no document content to
  // match, so content clauses are meaningless and would make the rule Tier 2
  // (client-only) when the server must be able to enforce the read gate.
  if (rule.type === "doc_read" && (rule.withfields?.length ?? 0) > 0) {
    throw new Error("doc_read rules are database-level and cannot use `withfields`");
  }
  for (const clause of rule.withfields ?? []) {
    validateWithFieldClause(clause, rule.type);
  }
}

/**
 * Validate a {@link DefaultAccessPolicyDoc} (tenant default or per-db) before
 * it is written. Throws on violation.
 */
export function validateAccessPolicy(
  policy: Partial<Omit<DefaultAccessPolicyDoc, "form" | "type">>
): void {
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
    | "defaultCreateKeyId"
    | "databaseCreationPolicy"
    | "allowedDbIds"
    | "requireMetadataSignatureSince"
  >
> & {
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
  // Per-db precedence for the default create key: a per-db default fully
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
    denyDocRead: pick("denyDocRead"),
    defaultCreateKeyId,
  };
}

/**
 * Key distribution type tag (the `type` field of a {@link KeyDistributionDoc}).
 */
export const KEY_DISTRIBUTION_TYPE = "keydistribution" as const;

/** Key ids that may never be governed by a distribution document. */
export const PROTECTED_DISTRIBUTION_KEY_IDS: readonly string[] = ["default", "$publicinfos"];

/**
 * One distributed version of a key in the {@link KeyDistributionDoc.keyVersions}
 * manifest. `fingerprint` is the SHA-256 hex of the raw symmetric key bytes and
 * is the stable identity used to (a) verify unwrapped bytes on import and (b)
 * scope `pullfrom` deletion to exactly the listed versions. `createdAt` is the
 * KeyBag version timestamp, used for display and to set the imported version's
 * stamp.
 */
export interface KeyVersionRef {
  createdAt: number;
  /** SHA-256 hex of the raw key bytes of this version. */
  fingerprint: string;
}

/**
 * Wrapped key material for a single recipient device: a map from version
 * fingerprint to the base64 RSA-OAEP-wrapped raw key bytes of that version.
 * Every entry must cover ALL of the manifest's version fingerprints (full
 * coverage), so a recipient can decrypt documents encrypted under any version.
 */
export type DeviceWrappedVersions = Record<string, string>;

/**
 * The single authoritative document governing the distribution of one symmetric
 * key (`keyId`). Stored at the fixed id `acl_keydistribution_<keyId>` (singleton
 * per key); publish is always an upsert of the full desired state.
 *
 * The wrapped bytes (`pushto_users_keys`) are produced by a key-*holder* using
 * each recipient device's RSA encryption public key; the admin merely signs and
 * writes the document, so an admin outside the recipient set never sees the
 * plaintext key. Syncing clients reconcile their KeyBags against the head state:
 * `pushto` users unwrap+verify+merge the manifest's versions; `pullfrom` users
 * delete exactly the manifest's versions (and purge the scope when nothing
 * remains). Title/comment/usernames are stored under the `<field>_encrypted`
 * convention with the tenant `default` key, so the sync server cannot read them;
 * only the hashes + wrapped material stay `$publicinfos`-readable.
 */
export interface KeyDistributionDoc {
  form: typeof ACCESS_CONTROL_FORM;
  type: typeof KEY_DISTRIBUTION_TYPE;
  keyId: string;
  /** Manifest of distributed versions. fingerprint = SHA-256 hex of raw key bytes. */
  keyVersions: KeyVersionRef[];
  title_encrypted: string;
  title_encrypted_key: string; // "default"
  comment_encrypted?: string;
  comment_encrypted_key?: string;
  /** The key-holder's signing public key that wrapped the material (audit trail). */
  preparedByPublicKey: string;
  /** Users whose KeyBags receive the key. */
  pushto_users_hashes: string[];
  /**
   * Display aid: ONE encrypted JSON array of usernames, index-aligned with
   * `pushto_users_hashes`. Single blob so views can read it via
   * `v.decryptJson("pushto_users_encrypted")` with no view-language extension;
   * hashes stay authoritative for enforcement, alignment drift is cosmetic.
   */
  pushto_users_encrypted?: string;
  pushto_users_encrypted_key?: string; // "default"
  /**
   * Wrapped material: `"<userhash>|<deviceEncKeyFingerprint>"` -> { versionFingerprint -> wrappedKey (b64 RSA-OAEP) }.
   * One entry per active device of each pushto user; every entry covers ALL manifest versions.
   */
  pushto_users_keys: Record<string, DeviceWrappedVersions>;
  /** Users whose KeyBags must NOT hold the manifest's versions (no device keys needed). */
  pullfrom_users_hashes: string[];
  pullfrom_users_encrypted?: string;
  pullfrom_users_encrypted_key?: string;
}

/**
 * One `pushto` recipient inside a {@link KeyDistributionRequest}: the plaintext
 * username (display only, the URI travels out-of-band) plus the wrapped material
 * for each of the recipient's active devices.
 */
export interface KeyDistributionPushRecipient {
  username: string;
  username_hash: string;
  /** deviceEncKeyFingerprint -> { versionFingerprint -> wrappedKey (b64) }. */
  devices: Record<string, DeviceWrappedVersions>;
}

/**
 * The full unsigned content of one key's distribution, carried by an
 * `mdb://key-distribution/...` request URI so a key-holder without admin rights
 * can hand a ready-to-sign request to an admin. The admin maps it to a
 * {@link KeyDistributionDoc} on save (encrypting title/comment/usernames and
 * folding `devices` into `pushto_users_keys`).
 */
export interface KeyDistributionRequest {
  v: 1;
  tenantId?: string;
  keyId: string;
  keyVersions: KeyVersionRef[];
  /** Plaintext in the URI (sent out-of-band); the admin encrypts it on save. */
  title: string;
  comment?: string;
  preparedByPublicKey: string;
  pushto: KeyDistributionPushRecipient[];
  pullfrom: Array<{ username: string; username_hash: string }>;
}

/**
 * Read-side projection of a {@link KeyDistributionDoc} for list/edit UIs. Raw
 * hashes + wrapped material are surfaced so an editor can preserve devices it
 * cannot re-wrap; `*Usernames` are the decrypted display arrays (null when the
 * tenant default key is not held, i.e. the blob is unreadable).
 */
export interface KeyDistributionView {
  keyId: string;
  title: string | null;
  comment: string | null;
  keyVersions: KeyVersionRef[];
  preparedByPublicKey: string;
  pushto_users_hashes: string[];
  pushto_users_keys: Record<string, DeviceWrappedVersions>;
  pullfrom_users_hashes: string[];
  pushtoUsernames: string[] | null;
  pullfromUsernames: string[] | null;
}

/** Document id prefix for the per-key distribution documents. */
export const ACL_KEY_DISTRIBUTION_PREFIX = "acl_keydistribution_";

/**
 * Document id for a key distribution — a SINGLETON per key id, so there is one
 * authoritative document governing each key's distribution and publish is always
 * an upsert. The key id is encoded so arbitrary key ids stay valid doc-id
 * components.
 */
export function aclKeyDistributionDocId(keyId: string): string {
  return assertValidDocId(ACL_KEY_DISTRIBUTION_PREFIX + encodeAclIdComponent(keyId));
}

/** True when `docId` is a key-distribution document id. */
export function isKeyDistributionDocId(docId: string): boolean {
  return docId.startsWith(ACL_KEY_DISTRIBUTION_PREFIX);
}

/**
 * Validate the structural invariants of a key distribution before publish
 * (docs/accesscontrol.md §13). Throws on the first violation:
 *
 *  - `keyId` is non-empty and not a protected id (`default` / `$publicinfos`);
 *  - `pushto` and `pullfrom` user-hash sets are disjoint;
 *  - every `pushto` device entry covers EXACTLY the manifest's version
 *    fingerprints (full coverage, no extras), so every recipient can decrypt
 *    documents encrypted under any distributed version.
 *
 * Grant existence / active-device coverage are enforced by the directory at
 * publish time (they need directory state), not here.
 */
export function validateKeyDistribution(input: {
  keyId: string;
  keyVersions: KeyVersionRef[];
  pushto_users_hashes: string[];
  pullfrom_users_hashes: string[];
  pushto_users_keys: Record<string, DeviceWrappedVersions>;
}): void {
  if (typeof input.keyId !== "string" || input.keyId.length === 0) {
    throw new Error("key distribution requires a non-empty `keyId`");
  }
  if (PROTECTED_DISTRIBUTION_KEY_IDS.includes(input.keyId)) {
    throw new Error(`key distribution cannot govern the protected key id "${input.keyId}"`);
  }
  if (!Array.isArray(input.keyVersions) || input.keyVersions.length === 0) {
    throw new Error("key distribution requires a non-empty `keyVersions` manifest");
  }
  const manifestFingerprints = input.keyVersions.map((v) => v.fingerprint);
  if (manifestFingerprints.some((fp) => typeof fp !== "string" || fp.length === 0)) {
    throw new Error("key distribution `keyVersions` entries require a non-empty `fingerprint`");
  }
  const manifestSet = new Set(manifestFingerprints);
  if (manifestSet.size !== manifestFingerprints.length) {
    throw new Error("key distribution `keyVersions` contains duplicate fingerprints");
  }

  const pushSet = new Set(input.pushto_users_hashes);
  for (const hash of input.pullfrom_users_hashes) {
    if (pushSet.has(hash)) {
      throw new Error("key distribution `pushto` and `pullfrom` user sets must be disjoint");
    }
  }

  // Every device entry must cover exactly the manifest's version fingerprints.
  for (const [deviceKey, wrapped] of Object.entries(input.pushto_users_keys)) {
    const covered = Object.keys(wrapped);
    if (covered.length !== manifestSet.size || covered.some((fp) => !manifestSet.has(fp))) {
      throw new Error(
        `key distribution device entry "${deviceKey}" must cover exactly the manifest versions ` +
          `(${manifestSet.size} fingerprint(s)); got ${covered.length}`,
      );
    }
  }
}

