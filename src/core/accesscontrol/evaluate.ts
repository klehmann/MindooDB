import {
  AccessDecision,
  AclRuleDoc,
  FIELD_GROUP_TEMPLATE_TOKEN,
  Operator,
  PSEUDO_TOKEN_ADMIN,
  PSEUDO_TOKEN_AUTHOR,
  PSEUDO_TOKEN_EVERYONE,
  Placeholder,
  RuleType,
  WithFieldClause,
  WithFieldWhen,
  effectivePolicy,
  isPlaceholder,
  normalizeAclGroupName,
  ruleMatchesDbid,
} from "./types";
import { DirectoryStateNode } from "./DirectoryStateNode";

/**
 * The pure access-control evaluation engine (docs/accesscontrol.md §7).
 *
 * `evaluateAccess` is a **pure, deterministic function** of its inputs: the
 * operation, the acting user's identity set, the directory-state node covering
 * the entry's trusted time, and the before/after document states. This purity
 * is what makes "quarantine on receipt" compatible with eventual consistency —
 * every honest replica that has synced to the same point computes the identical
 * verdict (§10). There is deliberately no wall-clock input.
 */

/**
 * The acting user's resolved identity, used for rule matching and placeholder
 * resolution (§7 step 3). The caller (directory) resolves these from grants,
 * groups, and the username-hash scheme; the engine only consumes them.
 */
export interface IdentitySet {
  /** Canonical username, for `${user.username}`. */
  username: string;
  /** Canonical + wildcard variants + groups, for `${user.usernames}`. */
  usernames: string[];
  /** Group names the user belongs to (incl. nested), for `${user.groups}`. */
  groups: string[];
  /**
   * All hashes/tokens the user's identity matches against `users_hashes`:
   * the username hash (v1 + v2), every group hash (incl. nested), and the
   * applicable pseudo-tokens — always `$everyone`; `$admin` if the user is the
   * tenant admin; `$author` if the user authored the document being modified.
   */
  hashes: Set<string>;
}

/** Inputs to {@link evaluateAccess}. */
export interface EvaluateAccessInput {
  /** The operation being attempted. */
  op: RuleType;
  /** Target database id. */
  dbid: string;
  /** The acting user's identity set. */
  identity: IdentitySet;
  /** Directory-state node covering the entry's trusted time (§8). */
  node: DirectoryStateNode;
  /**
   * The document as it currently exists, before the candidate change
   * (the "before" state). Required to evaluate `when: "before"` clauses.
   */
  beforeDoc?: Record<string, unknown> | null;
  /**
   * The document with the candidate change applied (the "after" state).
   * Required to evaluate `when: "after"` clauses, including all `doc_create`
   * clauses. The caller computes this (e.g. via `Automerge.clone()` + apply).
   */
  afterDoc?: Record<string, unknown> | null;
  /**
   * When true, the evaluator runs in **server/Tier 1 mode**: it cannot read
   * encrypted document content, so it ignores Tier 2 rules (those with
   * `withfields`) for the purpose of *denying*, and treats an entry as
   * Tier 1-allowed whenever the only thing that could deny/allow it is a Tier 2
   * rule — leaving that check to clients (§7, §10).
   */
  isServer?: boolean;
}

/** The default `when` for a clause, given the operation (§6.3). */
export function defaultWhenForOp(op: RuleType): WithFieldWhen {
  return op === "doc_create" ? "after" : "before";
}

function allow(reason: string, tier: "tier1" | "tier2", matchedRuleId?: string): AccessDecision {
  return { allowed: true, reason, tier, matchedRuleId };
}

function deny(reason: string, tier: "tier1" | "tier2", matchedRuleId?: string): AccessDecision {
  return { allowed: false, reason, tier, matchedRuleId };
}

/**
 * Evaluate access for an operation (§7). The result is fully determined by the
 * inputs; see {@link EvaluateAccessInput}.
 */
export function evaluateAccess(input: EvaluateAccessInput): AccessDecision {
  const { op, dbid, identity, node, isServer } = input;

  // `llm_use` is tenant-wide and follows its own baseline (§6.9).
  if (op === "llm_use") {
    return evaluateLlmUse({ identity, node });
  }
  // `doc_read_all` only matters in a `docReadScope: "own"` database (§6.12).
  if (op === "doc_read_all") {
    return evaluateDocReadAll({ dbid, identity, node });
  }

  // No policy document has ever existed -> access control was never enabled ->
  // everything is allowed (§6.1, the "no acl_defaultpolicy" state).
  if (node.defaultPolicy === null) {
    return allow("access control not enabled (no default policy)", "tier1");
  }

  const dbPolicy = node.dbPolicies.get(dbid) ?? null;
  const eff = effectivePolicy(node.defaultPolicy, dbPolicy);

  // Step 0: master switch short-circuits everything, including standalone deny
  // rules (§7 step 0).
  if (eff.disableAllAccessChecksAndPolicies) {
    return allow("access control disabled by master switch", "tier1");
  }

  // Step 2: baseline from the effective deny<Op> flag.
  const denyField = {
    doc_create: eff.denyDocCreate,
    doc_change: eff.denyDocChange,
    doc_delete: eff.denyDocDelete,
    doc_undelete: eff.denyDocUndelete,
    doc_snapshot: eff.denyDocSnapshot,
    doc_read: eff.denyDocRead,
    // No baseline flag: only an explicit allow rule grants deposit (§6.10).
    doc_deposit: true,
  }[op];
  const baselineDenied = denyField === true;

  // Step 4: collect rules of this type whose dbid matches and whose users_hashes
  // intersect the identity set.
  const candidateRules = (node.rulesByType.get(op) ?? []).filter(
    (r) => ruleMatchesDbid(r.dbid, dbid) && intersects(r.users_hashes, identity.hashes)
  );

  // Partition into Tier 1 (no withfields) and Tier 2 (withfields) rules.
  let denyMatched: { rule: AclRuleDoc; tier: "tier1" | "tier2" } | null = null;
  let allowMatched: { rule: AclRuleDoc; tier: "tier1" | "tier2" } | null = null;
  // Tracks whether a Tier 2 rule *could* allow (used by the server to defer).
  let tier2AllowDeferred = false;
  let tier2DenyDeferred = false;

  for (const rule of candidateRules) {
    const isTier2 = (rule.withfields?.length ?? 0) > 0;
    if (isTier2 && isServer) {
      // The server cannot evaluate content; remember that a Tier 2 rule of this
      // action exists so it can defer to the client rather than over-deny/allow.
      if (rule.action === "allow") tier2AllowDeferred = true;
      else tier2DenyDeferred = true;
      continue;
    }
    const matches = isTier2 ? withFieldsPass(rule, input) : true;
    if (!matches) continue;
    const tier: "tier1" | "tier2" = isTier2 ? "tier2" : "tier1";
    if (rule.action === "deny" && !denyMatched) denyMatched = { rule, tier };
    if (rule.action === "allow" && !allowMatched) allowMatched = { rule, tier };
  }

  // Step 5: deny-overrides-allow (set-based, order-independent).
  if (denyMatched) {
    return deny(
      `denied by rule ${denyMatched.rule.ruleId}`,
      denyMatched.tier,
      denyMatched.rule.ruleId
    );
  }
  if (allowMatched) {
    return allow(
      `allowed by rule ${allowMatched.rule.ruleId}`,
      allowMatched.tier,
      allowMatched.rule.ruleId
    );
  }

  // No conclusive rule matched. On the server, defer to the client when the
  // only thing that could change the verdict is a Tier 2 rule (§7).
  if (isServer && baselineDenied && tier2AllowDeferred) {
    return allow("baseline deny may be overridden by a Tier 2 allow (deferred to client)", "tier1");
  }
  if (isServer && !baselineDenied && tier2DenyDeferred) {
    // A Tier 2 deny might apply, but only the client can check it.
    return allow("baseline allow; Tier 2 deny deferred to client", "tier1");
  }

  return baselineDenied
    ? deny(`denied by baseline policy for ${op}`, "tier1")
    : allow(`allowed by baseline policy for ${op}`, "tier1");
}

/**
 * Whether the acting user may use a client's AI assistant with this tenant's
 * data (`llm_use`, docs/accesscontrol.md §6.9).
 *
 * Same shape as §7 (baseline, then deny-overrides-allow over the matching
 * rules), with two differences: the baseline is `llm.denyUse` of the tenant
 * default policy, and the master switch does not apply. Like the rest of the
 * `llm` block, the setting stays in force while access checks are switched off,
 * because new tenants are created with that switch on. Rules apply even when no
 * default policy exists, so a deny rule alone is enough.
 */
export function evaluateLlmUse(input: { identity: IdentitySet; node: DirectoryStateNode }): AccessDecision {
  const { identity, node } = input;
  const rules = (node.rulesByType.get("llm_use") ?? []).filter(
    (r) => r.dbid === "*" && (r.withfields?.length ?? 0) === 0 && intersects(r.users_hashes, identity.hashes)
  );
  const denyRule = rules.find((r) => r.action === "deny");
  if (denyRule) {
    return deny(`denied by rule ${denyRule.ruleId}`, "tier1", denyRule.ruleId);
  }
  const allowRule = rules.find((r) => r.action === "allow");
  if (allowRule) {
    return allow(`allowed by rule ${allowRule.ruleId}`, "tier1", allowRule.ruleId);
  }
  return node.defaultPolicy?.llm?.denyUse === true
    ? deny("denied by baseline policy for llm_use", "tier1")
    : allow("allowed by baseline policy for llm_use", "tier1");
}

/**
 * Whether the acting user reads every document of a database whose
 * `docReadScope` is `"own"` (`doc_read_all`, docs/accesscontrol.md §6.12).
 *
 * Baseline is deny (only the own documents); a matching allow rule for this
 * database (or `"*"`) opens all documents, deny overrides allow. The master
 * switch turns the whole scope off (everyone reads everything), as it does
 * every other check. The tenant admin is handled by the caller.
 */
export function evaluateDocReadAll(input: {
  dbid: string;
  identity: IdentitySet;
  node: DirectoryStateNode;
}): AccessDecision {
  const { dbid, identity, node } = input;
  if (node.defaultPolicy === null) {
    return allow("access control not enabled (no default policy)", "tier1");
  }
  const eff = effectivePolicy(node.defaultPolicy, node.dbPolicies.get(dbid) ?? null);
  if (eff.disableAllAccessChecksAndPolicies) {
    return allow("access control disabled by master switch", "tier1");
  }
  if (eff.docReadScope !== "own") {
    return allow(`docReadScope of ${dbid} is "all"`, "tier1");
  }
  const rules = (node.rulesByType.get("doc_read_all") ?? []).filter(
    (r) =>
      (r.dbid === dbid || r.dbid === "*") &&
      (r.withfields?.length ?? 0) === 0 &&
      intersects(r.users_hashes, identity.hashes)
  );
  const denyRule = rules.find((r) => r.action === "deny");
  if (denyRule) {
    return deny(`denied by rule ${denyRule.ruleId}`, "tier1", denyRule.ruleId);
  }
  const allowRule = rules.find((r) => r.action === "allow");
  if (allowRule) {
    return allow(`allowed by rule ${allowRule.ruleId}`, "tier1", allowRule.ruleId);
  }
  return deny(`docReadScope of ${dbid} is "own"`, "tier1");
}

/** Returns true if any element of `hashes` is in `set`. */
function intersects(hashes: string[], set: Set<string>): boolean {
  for (const h of hashes) {
    if (set.has(h)) return true;
  }
  return false;
}

/**
 * Evaluate every `withfields` clause of a Tier 2 rule against the document
 * state selected by each clause's `when` (§6.3). All clauses must pass.
 */
function withFieldsPass(rule: AclRuleDoc, input: EvaluateAccessInput): boolean {
  for (const clause of rule.withfields ?? []) {
    if (clause.op === "unchanged") {
      if (!fieldUnchanged(clause.key, input)) return false;
      continue;
    }
    const when = clause.when ?? defaultWhenForOp(input.op);
    const doc = when === "after" ? input.afterDoc : input.beforeDoc;
    if (!evaluateClause(clause, doc ?? null, input.identity)) {
      return false;
    }
  }
  return true;
}

/**
 * `unchanged` (§6.3): the value at `key` is deep-equal in the before and the
 * after state; missing on both sides counts as equal. For `doc_create` there is
 * no before state, so the clause passes only when the field is absent after.
 * Fails closed when a state the comparison needs was not supplied (`null`):
 * an unknown state must never count as "unchanged".
 */
function fieldUnchanged(key: string, input: EvaluateAccessInput): boolean {
  const after = input.afterDoc ?? null;
  if (after === null) return false;
  if (input.op === "doc_create") {
    return readPath(after, key) === undefined;
  }
  const before = input.beforeDoc ?? null;
  if (before === null) return false;
  return deepEqual(readPath(before, key), readPath(after, key));
}

/**
 * Deterministic structural equality for JSON-like document values: arrays are
 * order-sensitive, objects compare by key set regardless of key order, and an
 * object key holding `undefined` counts as absent. `Date` and typed arrays
 * compare by value.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return false;
    if (a.constructor !== b.constructor) return false;
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) {
      if (x[i] !== y[i]) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bKeys = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k) || !deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/**
 * `memberOfFieldGroup` (§6.3): build a group name from the template by putting
 * each string value of the field in place of `{value}`, and pass if the acting
 * user is a member of any resulting group. Names are compared in the
 * directory's normalized form (NFKC + lowercase). A missing, empty or
 * non-string field (or array element) never matches.
 */
function memberOfFieldGroup(
  template: WithFieldClause["value"],
  docValue: unknown,
  identity: IdentitySet
): boolean {
  if (typeof template !== "string" || isPlaceholder(template)) return false;
  const parts = template.split(FIELD_GROUP_TEMPLATE_TOKEN);
  if (parts.length !== 2) return false;
  const values = Array.isArray(docValue) ? docValue : [docValue];
  const fieldValues = values.filter((v): v is string => typeof v === "string" && v.length > 0);
  if (fieldValues.length === 0 || identity.groups.length === 0) return false;
  const groups = new Set(identity.groups.map(normalizeAclGroupName));
  return fieldValues.some((v) => groups.has(normalizeAclGroupName(parts[0] + v + parts[1])));
}

/** Resolve a clause value, expanding placeholders against the identity set. */
function resolveValue(
  value: WithFieldClause["value"],
  identity: IdentitySet
): { scalar?: string | number | boolean; list?: string[] } {
  if (isPlaceholder(value)) {
    switch (value as Placeholder) {
      case "${user.username}":
        return { scalar: identity.username, list: [identity.username] };
      case "${user.usernames}":
        return { list: identity.usernames };
      case "${user.groups}":
        return { list: identity.groups };
    }
  }
  if (Array.isArray(value)) {
    return { list: value };
  }
  return { scalar: value };
}

/** Read a dot-path from a document object. */
function readPath(doc: Record<string, unknown> | null, key: string): unknown {
  if (!doc) return undefined;
  const parts = key.split(".");
  let cur: unknown = doc;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Evaluate a single clause against a document state. */
function evaluateClause(
  clause: WithFieldClause,
  doc: Record<string, unknown> | null,
  identity: IdentitySet
): boolean {
  const op: Operator = clause.op;
  const docValue = readPath(doc, clause.key);

  // Existence operators don't need the value.
  if (op === "exists") return docValue !== undefined;
  if (op === "notExists") return docValue === undefined;
  if (op === "memberOfFieldGroup") return memberOfFieldGroup(clause.value, docValue, identity);

  const resolved = resolveValue(clause.value, identity);

  switch (op) {
    case "equals":
      return resolved.scalar !== undefined && docValue === resolved.scalar;
    case "notEquals":
      return resolved.scalar === undefined || docValue !== resolved.scalar;
    case "contains": {
      // docValue is an array or string; check it contains the scalar value.
      const needle = resolved.scalar;
      if (needle === undefined) return false;
      if (Array.isArray(docValue)) return docValue.includes(needle);
      if (typeof docValue === "string" && typeof needle === "string") return docValue.includes(needle);
      return false;
    }
    case "containsAny": {
      const list = resolved.list ?? (resolved.scalar !== undefined ? [resolved.scalar as string] : []);
      if (!Array.isArray(docValue)) return false;
      return list.some((v) => (docValue as unknown[]).includes(v));
    }
    case "containsAll": {
      const list = resolved.list ?? (resolved.scalar !== undefined ? [resolved.scalar as string] : []);
      if (!Array.isArray(docValue)) return false;
      return list.every((v) => (docValue as unknown[]).includes(v));
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (typeof docValue !== "number" || typeof resolved.scalar !== "number") return false;
      const a = docValue;
      const b = resolved.scalar;
      return op === "gt" ? a > b : op === "gte" ? a >= b : op === "lt" ? a < b : a <= b;
    }
    default:
      return false;
  }
}

/**
 * Convenience: the set of reserved pseudo-tokens an identity always/optionally
 * carries. `$everyone` is always present for registered users; `$admin` and
 * `$author` are added by the caller when applicable.
 */
export const ALWAYS_PRESENT_PSEUDO_TOKENS: readonly string[] = [PSEUDO_TOKEN_EVERYONE];
export { PSEUDO_TOKEN_ADMIN, PSEUDO_TOKEN_AUTHOR };
