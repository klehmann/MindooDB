import {
  AclRuleDoc,
  DefaultAccessPolicyDoc,
  RuleType,
  TrustedWitnessDoc,
} from "./types";

/**
 * Time-travel directory state (docs/accesscontrol.md §8).
 *
 * We keep an in-memory, copy-on-write chain of directory snapshots keyed by the
 * **trusted time** of directory changes, so we can answer "what was allowed at
 * time `T`?" quickly — including while materializing a database from scratch.
 *
 * The chain is built incrementally from the directory's change iteration. Each
 * applied directory document yields a NEW node that shares, by pointer, every
 * map that did not change (so memory stays compact), and replaces only the map
 * it touched. Reads at the head answer "now"; reads at an earlier node answer a
 * historic question.
 *
 * Trusted time of an entry follows the version-aware rule (see
 * `core/storeEntryTime.ts` `entryTrustedTime`): it is the entry's `receivedAt`
 * when witnessed; for an un-witnessed entry it is the wall-clock `now` if the
 * entry is versioned (written in the witness era — provisional, "waiting to be
 * pushed") or its stable `createdAt` if it is legacy (pre-witness, already
 * synced and never to be witnessed). This chain consumes the trusted time the
 * changefeed already computed via that rule, so it needs no separate fallback.
 */

/** A user's grant as projected into a directory-state node (§6.5, §8). */
export interface UserGrantSnapshot {
  /** `username_hash` the grant is keyed by (the value written on the doc). */
  usernameHash: string;
  /** All currently-granted signing public keys (array or legacy scalar). */
  signingKeys: string[];
  /** All currently-granted encryption public keys. */
  encryptionKeys: string[];
  /** Signing keys whose device must wipe the local tenant (`wipeRequestedForSigningKeys`). */
  wipeRequestedSigningKeys: string[];
  /** Whether the grant is active (not revoked, has at least one signing key). */
  active: boolean;
}

/** A group as projected into a node, mirroring the directory's offline merge (§8.1). */
export interface GroupSnapshot {
  /** Normalized (lowercase) group name. */
  name: string;
  /** Member hashes (union across same-named docs). */
  memberHashes: string[];
}

/**
 * A single immutable snapshot of directory state covering every directory entry
 * whose trusted time is `<= trustedTimeUpperBound`. Unchanged collections are
 * shared with {@link prev} by reference.
 */
export interface DirectoryStateNode {
  /** Covers all directory entries whose trusted time ≤ this bound. */
  trustedTimeUpperBound: number;

  defaultPolicy: DefaultAccessPolicyDoc | null;
  dbPolicies: Map<string, DefaultAccessPolicyDoc>;
  rulesByType: Map<RuleType, AclRuleDoc[]>;
  groupsByName: Map<string, GroupSnapshot>;
  /** Keyed by `username_hash`. */
  usersByHash: Map<string, UserGrantSnapshot>;
  /** Reverse index: signing public key -> grant. */
  bySigningKey: Map<string, UserGrantSnapshot>;
  /** Trusted witness public keys -> witness doc. */
  trustedWitnessKeys: Map<string, TrustedWitnessDoc>;

  /** Previous node in the chain, or null for the genesis node. */
  prev: DirectoryStateNode | null;
}

/** The empty genesis node: access control not yet configured. */
export function createGenesisNode(): DirectoryStateNode {
  return {
    trustedTimeUpperBound: Number.NEGATIVE_INFINITY,
    defaultPolicy: null,
    dbPolicies: new Map(),
    rulesByType: new Map(),
    groupsByName: new Map(),
    usersByHash: new Map(),
    bySigningKey: new Map(),
    trustedWitnessKeys: new Map(),
    prev: null,
  };
}

/**
 * Walk a chain backwards to find the node that covers trusted time `T` — i.e.
 * the most recent node whose `trustedTimeUpperBound <= T`. Returns the genesis
 * node's predecessor semantics (an all-empty node) if `T` precedes everything.
 */
export function nodeCovering(head: DirectoryStateNode, T: number): DirectoryStateNode {
  let node: DirectoryStateNode | null = head;
  while (node && node.trustedTimeUpperBound > T) {
    node = node.prev;
  }
  return node ?? createGenesisNode();
}

/** Rebuild a reverse signing-key index from a `usersByHash` map. */
function buildBySigningKey(
  usersByHash: Map<string, UserGrantSnapshot>
): Map<string, UserGrantSnapshot> {
  const bySigningKey = new Map<string, UserGrantSnapshot>();
  for (const grant of usersByHash.values()) {
    if (!grant.active) continue;
    for (const key of grant.signingKeys) {
      bySigningKey.set(key, grant);
    }
  }
  return bySigningKey;
}

/**
 * A single recorded mutation of the {@link DirectoryStateChainBuilder}, in the
 * trusted-time order it was applied. The ordered list of deltas is the compact,
 * serialization-friendly representation of the whole chain: replaying it through
 * the same `apply*` methods rebuilds an identical chain (including its
 * copy-on-write structural sharing) without any decryption or Automerge replay.
 *
 * Payloads are plain JSON-serializable objects, so the log round-trips through
 * `JSON.stringify`/`parse` (unlike the `Map`-based node fields themselves).
 */
export type DirectoryRevisionDelta =
  | { op: "defaultPolicy"; t: number; policy: DefaultAccessPolicyDoc }
  | { op: "dbPolicy"; t: number; dbid: string; policy: DefaultAccessPolicyDoc }
  | { op: "rule"; t: number; rule: AclRuleDoc }
  | { op: "removeRule"; t: number; ruleId: string; ruleType: RuleType }
  | { op: "trustedWitness"; t: number; witness: TrustedWitnessDoc }
  | { op: "removeTrustedWitness"; t: number; witnessPublicKey: string }
  | { op: "grant"; t: number; grant: UserGrantSnapshot }
  | { op: "revokeBySigningKey"; t: number; signingKey: string }
  | { op: "groupDoc"; t: number; docId: string; name: string; memberHashes: string[] }
  | { op: "removeGroupDoc"; t: number; docId: string }
  | { op: "setGroups"; t: number; groups: GroupSnapshot[] };

/**
 * Incrementally builds a {@link DirectoryStateNode} chain as directory
 * documents are observed in trusted-time (iteration) order.
 *
 * The directory is responsible for decrypting documents and passing already
 * structured inputs (e.g. decoded grant key arrays, merged group member
 * hashes); this builder owns only the copy-on-write chain mechanics so it stays
 * pure and unit-testable.
 */
export class DirectoryStateChainBuilder {
  private head: DirectoryStateNode = createGenesisNode();

  /**
   * Ordered log of every mutation, used to serialize/rebuild the chain (see
   * {@link exportDeltaLog} / {@link importDeltaLog}).
   */
  private deltaLog: DirectoryRevisionDelta[] = [];

  /**
   * Per-group-document member contributions, keyed by group document id, used
   * to recompute the union-by-name {@link GroupSnapshot} map incrementally as
   * individual group documents are revised (§8.1). Not part of the chain nodes;
   * rebuilt deterministically when {@link importDeltaLog} replays the log.
   */
  private groupContributions = new Map<string, { name: string; memberHashes: string[] }>();

  /** The current head node ("now"). */
  getHead(): DirectoryStateNode {
    return this.head;
  }

  /** The node covering trusted time `T`. */
  getStateAt(T: number): DirectoryStateNode {
    return nodeCovering(this.head, T);
  }

  /** Reset to the empty genesis node (used on a full rebuild). */
  reset(): void {
    this.head = createGenesisNode();
    this.deltaLog = [];
    this.groupContributions.clear();
  }

  /**
   * The ordered mutation log. This is the compact on-disk representation of the
   * chain; persist it and rebuild later with {@link importDeltaLog}.
   */
  exportDeltaLog(): DirectoryRevisionDelta[] {
    return this.deltaLog;
  }

  /**
   * Rebuild the chain by replaying a previously {@link exportDeltaLog}-ed log
   * through the same `apply*` methods. Pure in-memory: no decryption, no
   * Automerge — and it reconstructs the copy-on-write structural sharing.
   */
  importDeltaLog(deltas: DirectoryRevisionDelta[]): void {
    this.reset();
    for (const d of deltas) {
      switch (d.op) {
        case "defaultPolicy":
          this.applyDefaultPolicy(d.policy, d.t);
          break;
        case "dbPolicy":
          this.applyDbPolicy(d.dbid, d.policy, d.t);
          break;
        case "rule":
          this.applyRule(d.rule, d.t);
          break;
        case "removeRule":
          this.removeRule(d.ruleId, d.ruleType, d.t);
          break;
        case "trustedWitness":
          this.applyTrustedWitness(d.witness, d.t);
          break;
        case "removeTrustedWitness":
          this.removeTrustedWitness(d.witnessPublicKey, d.t);
          break;
        case "grant":
          this.applyGrant(d.grant, d.t);
          break;
        case "revokeBySigningKey":
          this.revokeBySigningKey(d.signingKey, d.t);
          break;
        case "groupDoc":
          this.applyGroupDoc(d.docId, d.name, d.memberHashes, d.t);
          break;
        case "removeGroupDoc":
          this.removeGroupDoc(d.docId, d.t);
          break;
        case "setGroups":
          this.setGroups(
            new Map(d.groups.map((g) => [g.name, g])),
            d.t
          );
          break;
      }
    }
  }

  /**
   * Push a new node derived from the current head, replacing exactly one
   * collection (`mutate` receives a working copy of the head to mutate in
   * place) and sharing the rest by reference. `trustedTime` becomes the node's
   * upper bound; it must be monotonically non-decreasing across calls.
   */
  private push(trustedTime: number, mutate: (next: DirectoryStateNode) => void): void {
    const bound = Math.max(trustedTime, this.head.trustedTimeUpperBound);
    const next: DirectoryStateNode = {
      trustedTimeUpperBound: bound,
      defaultPolicy: this.head.defaultPolicy,
      dbPolicies: this.head.dbPolicies,
      rulesByType: this.head.rulesByType,
      groupsByName: this.head.groupsByName,
      usersByHash: this.head.usersByHash,
      bySigningKey: this.head.bySigningKey,
      trustedWitnessKeys: this.head.trustedWitnessKeys,
      prev: this.head,
    };
    mutate(next);
    this.head = next;
  }

  /** Apply the tenant default policy document. */
  applyDefaultPolicy(policy: DefaultAccessPolicyDoc, trustedTime: number): void {
    this.deltaLog.push({ op: "defaultPolicy", t: trustedTime, policy });
    this.push(trustedTime, (next) => {
      next.defaultPolicy = policy;
    });
  }

  /** Apply a per-database policy document. */
  applyDbPolicy(dbid: string, policy: DefaultAccessPolicyDoc, trustedTime: number): void {
    this.deltaLog.push({ op: "dbPolicy", t: trustedTime, dbid, policy });
    this.push(trustedTime, (next) => {
      next.dbPolicies = new Map(this.head.dbPolicies);
      next.dbPolicies.set(dbid, policy);
    });
  }

  /** Apply an access-control rule document (replaces any rule with the same id). */
  applyRule(rule: AclRuleDoc, trustedTime: number): void {
    this.deltaLog.push({ op: "rule", t: trustedTime, rule });
    this.push(trustedTime, (next) => {
      next.rulesByType = new Map(this.head.rulesByType);
      const existing = next.rulesByType.get(rule.type) ?? [];
      const replaced = existing.filter((r) => r.ruleId !== rule.ruleId);
      replaced.push(rule);
      next.rulesByType.set(rule.type, replaced);
    });
  }

  /** Remove a rule (e.g. its document was deleted). */
  removeRule(ruleId: string, ruleType: RuleType, trustedTime: number): void {
    this.deltaLog.push({ op: "removeRule", t: trustedTime, ruleId, ruleType });
    this.push(trustedTime, (next) => {
      next.rulesByType = new Map(this.head.rulesByType);
      const existing = next.rulesByType.get(ruleType) ?? [];
      next.rulesByType.set(
        ruleType,
        existing.filter((r) => r.ruleId !== ruleId)
      );
    });
  }

  /** Apply a trusted-witness document, keyed by its public key. */
  applyTrustedWitness(witness: TrustedWitnessDoc, trustedTime: number): void {
    this.deltaLog.push({ op: "trustedWitness", t: trustedTime, witness });
    this.push(trustedTime, (next) => {
      next.trustedWitnessKeys = new Map(this.head.trustedWitnessKeys);
      next.trustedWitnessKeys.set(witness.witnessPublicKey, witness);
    });
  }

  /** Remove a trusted witness (rotation: drop the old doc). */
  removeTrustedWitness(witnessPublicKey: string, trustedTime: number): void {
    this.deltaLog.push({ op: "removeTrustedWitness", t: trustedTime, witnessPublicKey });
    this.push(trustedTime, (next) => {
      next.trustedWitnessKeys = new Map(this.head.trustedWitnessKeys);
      next.trustedWitnessKeys.delete(witnessPublicKey);
    });
  }

  /** Apply (insert or replace) a user grant, keyed by `username_hash`. */
  applyGrant(grant: UserGrantSnapshot, trustedTime: number): void {
    this.deltaLog.push({ op: "grant", t: trustedTime, grant });
    this.push(trustedTime, (next) => {
      next.usersByHash = new Map(this.head.usersByHash);
      next.usersByHash.set(grant.usernameHash, grant);
      next.bySigningKey = buildBySigningKey(next.usersByHash);
    });
  }

  /**
   * Mark a grant revoked by signing key (legacy standalone `revokeaccess`
   * compatibility, §8.1). If the key belongs to a known grant, the grant is
   * deactivated.
   */
  revokeBySigningKey(signingKey: string, trustedTime: number): void {
    const grant = this.head.bySigningKey.get(signingKey);
    if (!grant) return;
    this.deltaLog.push({ op: "revokeBySigningKey", t: trustedTime, signingKey });
    this.push(trustedTime, (next) => {
      next.usersByHash = new Map(this.head.usersByHash);
      const deactivated: UserGrantSnapshot = { ...grant, active: false };
      next.usersByHash.set(deactivated.usernameHash, deactivated);
      next.bySigningKey = buildBySigningKey(next.usersByHash);
    });
  }

  /**
   * Apply (insert or replace) a single group document's contribution, keyed by
   * its document id, at trusted time `T`. Because several documents may share a
   * group name (offline merge, §8.1), the resulting `groupsByName[name]` is the
   * union of member hashes across every contributing document seen so far.
   */
  applyGroupDoc(
    docId: string,
    name: string,
    memberHashes: string[],
    trustedTime: number
  ): void {
    this.deltaLog.push({ op: "groupDoc", t: trustedTime, docId, name, memberHashes });
    this.groupContributions.set(docId, { name, memberHashes: [...memberHashes] });
    this.recomputeGroup(name, trustedTime);
  }

  /** Drop a group document's contribution (e.g. it was deleted), at time `T`. */
  removeGroupDoc(docId: string, trustedTime: number): void {
    const existing = this.groupContributions.get(docId);
    if (!existing) return;
    this.deltaLog.push({ op: "removeGroupDoc", t: trustedTime, docId });
    this.groupContributions.delete(docId);
    this.recomputeGroup(existing.name, trustedTime);
  }

  /**
   * Recompute the union-by-name {@link GroupSnapshot} for `name` from the
   * current per-document contributions and push a node at trusted time `T`.
   * Removes the entry when no contributing document remains.
   */
  private recomputeGroup(name: string, trustedTime: number): void {
    const memberHashes = new Set<string>();
    let hasContribution = false;
    for (const contribution of this.groupContributions.values()) {
      if (contribution.name !== name) continue;
      hasContribution = true;
      for (const hash of contribution.memberHashes) {
        memberHashes.add(hash);
      }
    }
    this.push(trustedTime, (next) => {
      next.groupsByName = new Map(this.head.groupsByName);
      if (hasContribution) {
        next.groupsByName.set(name, { name, memberHashes: [...memberHashes] });
      } else {
        next.groupsByName.delete(name);
      }
    });
  }

  /**
   * Replace the full set of groups (mirrors the directory's post-merge result).
   * Retained for direct/unit use; the directory feed prefers the per-revision
   * {@link applyGroupDoc} / {@link removeGroupDoc}.
   */
  setGroups(groups: Map<string, GroupSnapshot>, trustedTime: number): void {
    this.deltaLog.push({
      op: "setGroups",
      t: trustedTime,
      groups: [...groups.values()].map((g) => ({ name: g.name, memberHashes: [...g.memberHashes] })),
    });
    this.push(trustedTime, (next) => {
      next.groupsByName = new Map(groups);
    });
  }
}
