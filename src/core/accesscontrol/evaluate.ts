import {
  AccessDecision,
  AclRuleDoc,
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
    doc_purge: eff.denyDocPurge,
    doc_read: eff.denyDocRead,
  }[op];
  const baselineDenied = denyField === true;

  // Step 4: collect rules of this type whose dbid matches and whose users_hashes
  // intersect the identity set.
  const candidateRules = (node.rulesByType.get(op) ?? []).filter(
    (r) => (r.dbid === dbid || r.dbid === "*") && intersects(r.users_hashes, identity.hashes)
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
    const when = clause.when ?? defaultWhenForOp(input.op);
    const doc = when === "after" ? input.afterDoc : input.beforeDoc;
    if (!evaluateClause(clause, doc ?? null, input.identity)) {
      return false;
    }
  }
  return true;
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
