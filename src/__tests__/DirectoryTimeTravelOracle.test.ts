import {
  DirectoryTimeTravelIndex,
  ProjectRevisionFn,
  StoredDirectoryRevision,
} from "../core/accesscontrol/DirectoryTimeTravelIndex";
import { projectDirectoryRevision } from "../core/accesscontrol/directoryProjection";
import {
  ACCESS_CONTROL_FORM,
  ACL_DEFAULT_POLICY_DOC_ID,
  RULE_TYPES,
  RuleType,
  aclDbPolicyDocId,
  decodeAclIdComponent,
} from "../core/accesscontrol/types";
import { extractSigningPublicKeys } from "../core/accesscontrol/grantKeys";
import type { DirectoryStateNode } from "../core/accesscontrol/DirectoryStateNode";

/**
 * Property / fuzz time-travel oracle for the directory state chain
 * (docs/accesscontrol.md §8; plan "Correctness and tests").
 *
 * Random directory histories — every projection type, concurrent / duplicate
 * trusted times, out-of-(trusted-time)-order arrival, and supersession of an
 * entry id (re-stamp) — are fed through the production rebuild path
 * ({@link DirectoryTimeTravelIndex.upsertRevision} + {@link DirectoryTimeTravelIndex.rebuild}),
 * which sorts by `(trustedTime, entryId)` and replays via {@link projectDirectoryRevision}.
 *
 * The reference is an INDEPENDENT brute-force fold: for a sampled trusted time
 * `T`, the expected state of each "slot" (default/db policy, rule by id, trusted
 * witness, grant by user, group doc) is the latest revision with
 * `trustedTime <= T` for that slot (last-writer wins by `(trustedTime, entryId)`),
 * composed from first principles rather than by replaying the builder. We assert
 * the index's `getStateAt(T)` matches the oracle at many sampled `T`, that the
 * upsert (arrival) order is irrelevant, and that an incremental rebuild equals a
 * from-scratch one.
 */

// Deterministic PRNG (mulberry32) so failures are reproducible per seed.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const normalizeGroupName = (name: string) => name.toLowerCase();

const project: ProjectRevisionFn = (builder, rev) =>
  projectDirectoryRevision(builder, {
    docId: rev.docId,
    data: rev.data,
    deleted: rev.deleted,
    trustedTime: rev.trustedTime,
    normalizeGroupName,
  });

type Kind = "defaultPolicy" | "dbPolicy" | "rule" | "witness" | "grant" | "group";

/** Stable identity of a slot's underlying document, fixed across supersessions. */
interface Identity {
  kind: Kind;
  docId: string;
  // Kind-specific fixed fields:
  dbid?: string;
  ruleId?: string;
  ruleType?: RuleType;
  witnessKey?: string;
  usernameHash?: string;
  userSigningKey?: string;
  groupName?: string;
  memberHashes?: string[];
}

const RULE_IDS = ["ruleA", "ruleB", "ruleC"];
const DB_IDS = ["alpha", "beta"];
const WITNESS_KEYS = ["witness-1", "witness-2", "witness-3"];
const USER_HASHES = ["userA", "userB", "userC"];
const GROUP_DOCS = [
  { docId: "group-doc-1", name: "Engineers", members: ["m1", "m2"] },
  { docId: "group-doc-2", name: "engineers", members: ["m2", "m3"] }, // same name (case-folded), union
  { docId: "group-doc-3", name: "Sales", members: ["s1"] },
];

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function makeIdentity(rng: () => number): Identity {
  const kind = pick<Kind>(rng, [
    "defaultPolicy",
    "dbPolicy",
    "rule",
    "witness",
    "grant",
    "group",
  ]);
  switch (kind) {
    case "defaultPolicy":
      return { kind, docId: ACL_DEFAULT_POLICY_DOC_ID };
    case "dbPolicy": {
      const dbid = pick(rng, DB_IDS);
      return { kind, docId: aclDbPolicyDocId(dbid), dbid };
    }
    case "rule": {
      const ruleId = pick(rng, RULE_IDS);
      const ruleType = pick(rng, RULE_TYPES);
      return { kind, docId: `rule-doc-${ruleType}-${ruleId}`, ruleId, ruleType };
    }
    case "witness": {
      const witnessKey = pick(rng, WITNESS_KEYS);
      return { kind, docId: `witness-doc-${witnessKey}`, witnessKey };
    }
    case "grant": {
      const usernameHash = pick(rng, USER_HASHES);
      return {
        kind,
        docId: `grant-doc-${usernameHash}`,
        usernameHash,
        userSigningKey: `sign-${usernameHash}`,
      };
    }
    case "group": {
      const g = pick(rng, GROUP_DOCS);
      return { kind, docId: g.docId, groupName: g.name, memberHashes: g.members };
    }
  }
}

/** Build the variable `data` payload + deleted flag for one revision of a slot. */
function makeRevisionContent(
  rng: () => number,
  id: Identity,
): { data: Record<string, unknown>; deleted: boolean } {
  switch (id.kind) {
    case "defaultPolicy":
      return {
        data: {
          form: ACCESS_CONTROL_FORM,
          type: "defaultpolicy",
          denyDocChange: rng() < 0.5,
          // Master switch: access control deactivated/reactivated over time.
          disableAllAccessChecksAndPolicies: rng() < 0.5,
        },
        // A deleted default-policy revision is a no-op in projection; include it
        // occasionally to exercise that the oracle and builder both ignore it.
        deleted: rng() < 0.1,
      };
    case "dbPolicy":
      return {
        data: {
          form: ACCESS_CONTROL_FORM,
          type: "defaultpolicy",
          denyDocChange: rng() < 0.5,
          // Master switch: access control deactivated/reactivated over time.
          disableAllAccessChecksAndPolicies: rng() < 0.5,
        },
        deleted: rng() < 0.1,
      };
    case "rule":
      return {
        data: {
          form: ACCESS_CONTROL_FORM,
          type: id.ruleType,
          ruleId: id.ruleId,
          dbid: rng() < 0.5 ? "*" : "db1",
          action: rng() < 0.5 ? "allow" : "deny",
          users_hashes: ["$everyone"],
        },
        deleted: rng() < 0.35,
      };
    case "witness":
      return {
        data: {
          form: ACCESS_CONTROL_FORM,
          type: "trustedwitness",
          witnessPublicKey: id.witnessKey,
        },
        deleted: rng() < 0.35,
      };
    case "grant": {
      // active grant carries the user's signing key; a revoke carries none.
      const revoked = rng() < 0.4;
      return {
        data: {
          form: "useroperation",
          type: "grantaccess",
          username_hash: id.usernameHash,
          userKeyPairs: revoked
            ? []
            : [{ signingPublicKey: id.userSigningKey, encryptionPublicKey: `enc-${id.usernameHash}` }],
        },
        deleted: false,
      };
    }
    case "group":
      return {
        data: {
          form: "group",
          type: "group",
          groupName: id.groupName,
          members_hashes: id.memberHashes,
        },
        deleted: rng() < 0.3,
      };
  }
}

interface GenOp {
  rev: StoredDirectoryRevision;
  cursor: { receiptOrder: number; id: string };
}

/** Generate a random history: a sequence of upserts (with supersessions). */
function generateHistory(rng: () => number, count: number): GenOp[] {
  const ops: GenOp[] = [];
  const known = new Map<string, Identity>();
  let nextId = 1;

  for (let i = 0; i < count; i++) {
    let entryId: string;
    let id: Identity;
    if (known.size > 0 && rng() < 0.25) {
      // Supersede an existing entry id (re-stamp / re-emit): same identity, new
      // trusted time + content.
      const ids = [...known.keys()];
      entryId = ids[Math.floor(rng() * ids.length)];
      id = known.get(entryId)!;
    } else {
      entryId = `e${nextId++}`;
      id = makeIdentity(rng);
      known.set(entryId, id);
    }
    const { data, deleted } = makeRevisionContent(rng, id);
    const trustedTime = 1 + Math.floor(rng() * 50) * 10; // many collisions / out-of-order
    const witnessed = rng() < 0.7;
    ops.push({
      rev: { entryId, docId: id.docId, data, deleted, trustedTime, witnessed },
      cursor: { receiptOrder: i + 1, id: entryId },
    });
  }
  return ops;
}

/** Resolve the final revision per entry id (last upsert wins), as the index does. */
function resolveFinal(ops: GenOp[]): StoredDirectoryRevision[] {
  const byId = new Map<string, StoredDirectoryRevision>();
  for (const op of ops) {
    byId.set(op.rev.entryId, op.rev);
  }
  return [...byId.values()];
}

/** Greater of two revisions by the chain's order key `(trustedTime, entryId)`. */
function laterKey(a: StoredDirectoryRevision, b: StoredDirectoryRevision): StoredDirectoryRevision {
  if (a.trustedTime !== b.trustedTime) return a.trustedTime > b.trustedTime ? a : b;
  return a.entryId > b.entryId ? a : b;
}

/** A comparable, order-independent summary of directory state. */
interface StateSummary {
  defaultPolicy: string;
  dbPolicies: string[];
  rules: string[];
  witnesses: string[];
  signingKeys: string[];
  groups: string[];
}

function summarizeNode(node: DirectoryStateNode): StateSummary {
  const rules: string[] = [];
  for (const [type, arr] of node.rulesByType) {
    for (const r of arr) {
      rules.push(`${type}:${r.ruleId}:${r.action}:${r.dbid}`);
    }
  }
  const dbPolicies: string[] = [];
  for (const [dbid, p] of node.dbPolicies) {
    dbPolicies.push(`${dbid}:${p.denyDocChange}/${p.disableAllAccessChecksAndPolicies}`);
  }
  const groups: string[] = [];
  for (const g of node.groupsByName.values()) {
    groups.push(`${g.name}=${[...g.memberHashes].sort().join(",")}`);
  }
  return {
    defaultPolicy: node.defaultPolicy
      ? `${node.defaultPolicy.denyDocChange}/${node.defaultPolicy.disableAllAccessChecksAndPolicies}`
      : "none",
    dbPolicies: dbPolicies.sort(),
    rules: rules.sort(),
    witnesses: [...node.trustedWitnessKeys.keys()].sort(),
    signingKeys: [...node.bySigningKey.keys()].sort(),
    groups: groups.sort(),
  };
}

/** Independent brute-force oracle: state of every slot at trusted time `T`. */
function summarizeOracle(finalRevs: StoredDirectoryRevision[], T: number): StateSummary {
  const live = finalRevs.filter((r) => r.trustedTime <= T);
  const latestPerSlot = (slotKey: (r: StoredDirectoryRevision) => string | null) => {
    const winners = new Map<string, StoredDirectoryRevision>();
    for (const r of live) {
      const key = slotKey(r);
      if (key === null) continue;
      const existing = winners.get(key);
      winners.set(key, existing ? laterKey(existing, r) : r);
    }
    return winners;
  };

  // Default policy: latest NON-deleted revision of the default-policy doc.
  let defaultPolicy = "none";
  {
    const candidates = live.filter(
      (r) => r.docId === ACL_DEFAULT_POLICY_DOC_ID && r.data.type === "defaultpolicy" && !r.deleted,
    );
    if (candidates.length > 0) {
      const w = candidates.reduce(laterKey);
      defaultPolicy = `${w.data.denyDocChange}/${w.data.disableAllAccessChecksAndPolicies}`;
    }
  }

  // DB policies: latest non-deleted per db-policy doc id.
  const dbPolicies: string[] = [];
  {
    const winners = latestPerSlot((r) =>
      r.docId.startsWith("acl_dbpolicy_") && r.data.type === "defaultpolicy" && !r.deleted ? r.docId : null,
    );
    const DB_PREFIX = "acl_dbpolicy_";
    for (const w of winners.values()) {
      // The chain keys db policies by the decoded dbid, exactly as the projection does.
      const dbid = decodeAclIdComponent(w.docId.slice(DB_PREFIX.length));
      dbPolicies.push(`${dbid}:${w.data.denyDocChange}/${w.data.disableAllAccessChecksAndPolicies}`);
    }
  }

  // Rules: latest per (type, ruleId); deleted => absent.
  const rules: string[] = [];
  {
    const winners = latestPerSlot((r) =>
      (RULE_TYPES as readonly string[]).includes(r.data.type as string) && typeof r.data.ruleId === "string"
        ? `${r.data.type}:${r.data.ruleId}`
        : null,
    );
    for (const w of winners.values()) {
      if (w.deleted) continue;
      const action = w.data.action === "deny" ? "deny" : "allow";
      const dbid = typeof w.data.dbid === "string" ? w.data.dbid : "*";
      rules.push(`${w.data.type}:${w.data.ruleId}:${action}:${dbid}`);
    }
  }

  // Trusted witnesses: latest per key; deleted => absent.
  const witnesses: string[] = [];
  {
    const winners = latestPerSlot((r) =>
      r.data.type === "trustedwitness" && typeof r.data.witnessPublicKey === "string"
        ? (r.data.witnessPublicKey as string)
        : null,
    );
    for (const [key, w] of winners) {
      if (!w.deleted) witnesses.push(key);
    }
  }

  // Grants: latest per username hash; active when it carries >=1 signing key.
  const signingKeys = new Set<string>();
  {
    const winners = latestPerSlot((r) =>
      r.data.form === "useroperation" && r.data.type === "grantaccess" && typeof r.data.username_hash === "string"
        ? (r.data.username_hash as string)
        : null,
    );
    for (const w of winners.values()) {
      for (const k of extractSigningPublicKeys(w.data)) signingKeys.add(k);
    }
  }

  // Groups: latest per group doc; union member hashes by (normalized) name.
  const byName = new Map<string, Set<string>>();
  {
    const winners = latestPerSlot((r) =>
      r.data.form === "group" && r.data.type === "group" && typeof r.data.groupName === "string"
        ? r.docId
        : null,
    );
    for (const w of winners.values()) {
      if (w.deleted) continue;
      const name = normalizeGroupName(w.data.groupName as string);
      const members = Array.isArray(w.data.members_hashes)
        ? (w.data.members_hashes as unknown[]).filter((h): h is string => typeof h === "string")
        : [];
      const set = byName.get(name) ?? new Set<string>();
      for (const m of members) set.add(m);
      byName.set(name, set);
    }
  }
  const groups: string[] = [];
  for (const [name, set] of byName) {
    groups.push(`${name}=${[...set].sort().join(",")}`);
  }

  return {
    defaultPolicy,
    dbPolicies: dbPolicies.sort(),
    rules: rules.sort(),
    witnesses: witnesses.sort(),
    signingKeys: [...signingKeys].sort(),
    groups: groups.sort(),
  };
}

function buildIndex(ops: GenOp[]): DirectoryTimeTravelIndex {
  const idx = new DirectoryTimeTravelIndex("oracle/directory");
  for (const op of ops) {
    idx.upsertRevision(op.rev, op.cursor);
  }
  idx.rebuild(project);
  return idx;
}

function sampleTimes(finalRevs: StoredDirectoryRevision[], rng: () => number): number[] {
  const times = new Set<number>();
  for (const r of finalRevs) {
    times.add(r.trustedTime);
    times.add(r.trustedTime - 1);
    times.add(r.trustedTime + 1);
  }
  times.add(0);
  times.add(100000);
  for (let i = 0; i < 5; i++) times.add(Math.floor(rng() * 600));
  return [...times];
}

describe("directory time-travel property oracle", () => {
  it("getStateAt(T) matches an independent brute-force fold across random histories", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rng = mulberry32(seed);
      const count = 15 + Math.floor(rng() * 40);
      const ops = generateHistory(rng, count);
      const finalRevs = resolveFinal(ops);
      const idx = buildIndex(ops);

      for (const T of sampleTimes(finalRevs, rng)) {
        const actual = summarizeNode(idx.getStateAt(T));
        const expected = summarizeOracle(finalRevs, T);
        expect({ seed, T, ...actual }).toEqual({ seed, T, ...expected });
      }
    }
  });

  it("arrival (upsert) order is irrelevant: shuffled order yields identical time-travel", () => {
    for (let seed = 100; seed <= 140; seed++) {
      const rng = mulberry32(seed);
      const ops = generateHistory(rng, 30);
      const finalRevs = resolveFinal(ops);

      // Shuffle the upsert order (out-of-order arrival) but keep last-writer
      // semantics intact by re-sequencing supersessions stably: a Fisher–Yates
      // shuffle of the op list, then a stable de-dup keeps the LAST occurrence.
      const shuffled = [...ops];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      // Preserve which revision is "final" per entry id regardless of shuffle by
      // upserting the resolved finals (each exactly once) in shuffled order.
      const finalOps: GenOp[] = finalRevs.map((rev, i) => ({
        rev,
        cursor: { receiptOrder: i + 1, id: rev.entryId },
      }));
      for (let i = finalOps.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [finalOps[i], finalOps[j]] = [finalOps[j], finalOps[i]];
      }

      const inOrder = buildIndex(ops);
      const shuffledIdx = buildIndex(finalOps);

      for (const T of sampleTimes(finalRevs, rng)) {
        expect(summarizeNode(shuffledIdx.getStateAt(T))).toEqual(summarizeNode(inOrder.getStateAt(T)));
      }
    }
  });

  it("incremental rebuilds equal a single from-scratch rebuild", () => {
    for (let seed = 200; seed <= 230; seed++) {
      const rng = mulberry32(seed);
      const ops = generateHistory(rng, 25);
      const finalRevs = resolveFinal(ops);

      // From scratch: all upserts, one rebuild.
      const fromScratch = buildIndex(ops);

      // Incremental: rebuild after every upsert (simulating repeated feed advances).
      const incremental = new DirectoryTimeTravelIndex("oracle/directory");
      for (const op of ops) {
        incremental.upsertRevision(op.rev, op.cursor);
        incremental.rebuild(project);
      }

      for (const T of sampleTimes(finalRevs, rng)) {
        expect(summarizeNode(incremental.getStateAt(T))).toEqual(summarizeNode(fromScratch.getStateAt(T)));
      }
    }
  });
});
