import { DirectoryStateChainBuilder, DirectoryStateNode } from "../core/accesscontrol/DirectoryStateNode";
import {
  IdentitySet,
  evaluateAccess,
  defaultWhenForOp,
  deepEqual,
} from "../core/accesscontrol/evaluate";
import { AclRuleDoc, DefaultAccessPolicyDoc, RuleType } from "../core/accesscontrol/types";

/**
 * Truth-matrix tests for the pure evaluation engine (docs/accesscontrol.md §7).
 * Covers: no-policy, master switch, baseline by op/db, deny-overrides-allow
 * order-independence, every operator, every placeholder, before vs after, the
 * three pseudo-tokens, the privilege-escalation negative case, and server mode.
 */
function policy(overrides: Partial<DefaultAccessPolicyDoc>): DefaultAccessPolicyDoc {
  return { form: "accesscontrol", type: "defaultpolicy", ...overrides };
}

function rule(overrides: Partial<AclRuleDoc> & { ruleId: string }): AclRuleDoc {
  return {
    form: "accesscontrol",
    type: "doc_change",
    dbid: "*",
    users_hashes: ["$everyone"],
    users_encrypted: "",
    action: "allow",
    ...overrides,
  };
}

function identity(overrides: Partial<IdentitySet> = {}): IdentitySet {
  return {
    username: "cn=alice/o=acme",
    usernames: ["cn=alice/o=acme", "*/o=acme", "*"],
    groups: [],
    hashes: new Set(["hashAlice", "$everyone"]),
    ...overrides,
  };
}

function nodeWith(build: (b: DirectoryStateChainBuilder) => void): DirectoryStateNode {
  const b = new DirectoryStateChainBuilder();
  build(b);
  return b.getHead();
}

describe("evaluateAccess", () => {
  it("allows everything when no policy document exists", () => {
    const node = nodeWith(() => {});
    const d = evaluateAccess({ op: "doc_change", dbid: "db", identity: identity(), node });
    expect(d.allowed).toBe(true);
    expect(d.tier).toBe("tier1");
  });

  it("master switch allows everything, even with a deny rule present", () => {
    const node = nodeWith((b) => {
      b.applyDefaultPolicy(policy({ disableAllAccessChecksAndPolicies: true, denyDocChange: true }), 1);
      b.applyRule(rule({ ruleId: "d", action: "deny" }), 2);
    });
    const d = evaluateAccess({ op: "doc_change", dbid: "db", identity: identity(), node });
    expect(d.allowed).toBe(true);
  });

  // Access control is configured over time and may be turned on, off, and on
  // again. Because evaluateAccess uses `trustedTime` only to pick the directory
  // node (it is otherwise pure), judging a change at a `T` inside each window
  // reproduces the policy that was provably in force then (docs/accesscontrol.md
  // §7 step 0, §8). This covers the two ways access control is (de)activated:
  // flipping the default policy deny<->allow, and the master switch.
  describe("time-travel: activate -> deactivate -> reactivate", () => {
    const decideAt = (b: DirectoryStateChainBuilder, T: number): boolean =>
      evaluateAccess({ op: "doc_change", dbid: "db", identity: identity(), node: b.getStateAt(T) }).allowed;

    it("master switch off->on->off lets historic changes through only while deactivated", () => {
      // t=10 active+deny, t=20 master switch ON (access control deactivated),
      // t=30 master switch OFF again (re-activated, still deny).
      const b = new DirectoryStateChainBuilder();
      b.applyDefaultPolicy(policy({ denyDocChange: true }), 10);
      b.applyDefaultPolicy(policy({ disableAllAccessChecksAndPolicies: true, denyDocChange: true }), 20);
      b.applyDefaultPolicy(policy({ denyDocChange: true }), 30);

      // State chain reflects the switch in each window.
      expect(b.getStateAt(9).defaultPolicy).toBeNull();
      expect(b.getStateAt(15).defaultPolicy?.disableAllAccessChecksAndPolicies).toBeFalsy();
      expect(b.getStateAt(25).defaultPolicy?.disableAllAccessChecksAndPolicies).toBe(true);
      expect(b.getStateAt(35).defaultPolicy?.disableAllAccessChecksAndPolicies).toBeFalsy();

      // Evaluation at a change's trusted time: allowed before any policy, denied
      // while active, allowed during the deactivated window, denied again after.
      expect(decideAt(b, 9)).toBe(true);
      expect(decideAt(b, 15)).toBe(false);
      expect(decideAt(b, 25)).toBe(true);
      expect(decideAt(b, 35)).toBe(false);
    });

    it("default policy deny->allow->deny gates changes per their trusted-time window", () => {
      const b = new DirectoryStateChainBuilder();
      b.applyDefaultPolicy(policy({ denyDocChange: true }), 10);
      b.applyDefaultPolicy(policy({ denyDocChange: false }), 20);
      b.applyDefaultPolicy(policy({ denyDocChange: true }), 30);

      expect(decideAt(b, 15)).toBe(false);
      expect(decideAt(b, 25)).toBe(true);
      expect(decideAt(b, 35)).toBe(false);
    });
  });

  describe("baseline", () => {
    it("denies when deny<Op> is true and no rule matches", () => {
      const node = nodeWith((b) => b.applyDefaultPolicy(policy({ denyDocChange: true }), 1));
      expect(evaluateAccess({ op: "doc_change", dbid: "db", identity: identity(), node }).allowed).toBe(false);
    });

    it("allows when deny<Op> is false", () => {
      const node = nodeWith((b) => b.applyDefaultPolicy(policy({ denyDocChange: false }), 1));
      expect(evaluateAccess({ op: "doc_change", dbid: "db", identity: identity(), node }).allowed).toBe(true);
    });

    it("DB policy overrides the tenant default", () => {
      const node = nodeWith((b) => {
        b.applyDefaultPolicy(policy({ denyDocChange: true }), 1);
        b.applyDbPolicy("db", policy({ denyDocChange: false }), 2);
      });
      expect(evaluateAccess({ op: "doc_change", dbid: "db", identity: identity(), node }).allowed).toBe(true);
      // A different db falls back to the tenant default (denied).
      expect(evaluateAccess({ op: "doc_change", dbid: "other", identity: identity(), node }).allowed).toBe(false);
    });

    it("snapshot is denied by default", () => {
      const node = nodeWith((b) => b.applyDefaultPolicy(policy({}), 1));
      expect(evaluateAccess({ op: "doc_snapshot", dbid: "db", identity: identity(), node }).allowed).toBe(false);
    });
  });

  describe("deny-overrides-allow", () => {
    it("a matching deny beats a matching allow regardless of insertion order", () => {
      const allowFirst = nodeWith((b) => {
        b.applyDefaultPolicy(policy({ denyDocChange: true }), 1);
        b.applyRule(rule({ ruleId: "a", action: "allow" }), 2);
        b.applyRule(rule({ ruleId: "d", action: "deny" }), 3);
      });
      const denyFirst = nodeWith((b) => {
        b.applyDefaultPolicy(policy({ denyDocChange: true }), 1);
        b.applyRule(rule({ ruleId: "d", action: "deny" }), 2);
        b.applyRule(rule({ ruleId: "a", action: "allow" }), 3);
      });
      expect(evaluateAccess({ op: "doc_change", dbid: "db", identity: identity(), node: allowFirst }).allowed).toBe(false);
      expect(evaluateAccess({ op: "doc_change", dbid: "db", identity: identity(), node: denyFirst }).allowed).toBe(false);
    });

    it("an allow rule overrides a baseline deny", () => {
      const node = nodeWith((b) => {
        b.applyDefaultPolicy(policy({ denyDocChange: true }), 1);
        b.applyRule(rule({ ruleId: "a", action: "allow", users_hashes: ["hashAlice"] }), 2);
      });
      const d = evaluateAccess({ op: "doc_change", dbid: "db", identity: identity(), node });
      expect(d.allowed).toBe(true);
      expect(d.matchedRuleId).toBe("a");
    });

    it("a rule that does not match the identity set is ignored", () => {
      const node = nodeWith((b) => {
        b.applyDefaultPolicy(policy({ denyDocChange: true }), 1);
        b.applyRule(rule({ ruleId: "a", action: "allow", users_hashes: ["someoneElse"] }), 2);
      });
      expect(evaluateAccess({ op: "doc_change", dbid: "db", identity: identity(), node }).allowed).toBe(false);
    });
  });

  describe("withfields (Tier 2)", () => {
    const tier2Node = nodeWith((b) => {
      b.applyDefaultPolicy(policy({ denyDocChange: true }), 1);
      b.applyRule(
        rule({
          ruleId: "editors",
          action: "allow",
          users_hashes: ["$everyone"],
          withfields: [{ key: "myeditors", op: "containsAny", value: "${user.usernames}" }],
        }),
        2,
      );
    });

    it("allows when the before-state satisfies the clause", () => {
      const d = evaluateAccess({
        op: "doc_change",
        dbid: "db",
        identity: identity(),
        node: tier2Node,
        beforeDoc: { myeditors: ["cn=alice/o=acme"] },
        afterDoc: { myeditors: ["cn=alice/o=acme"] },
      });
      expect(d.allowed).toBe(true);
      expect(d.tier).toBe("tier2");
    });

    it("PRIVILEGE ESCALATION: self-insert in the same change is denied (before state used)", () => {
      // Bob is NOT in myeditors before, but adds himself in the candidate change.
      // doc_change defaults to evaluating the BEFORE state, so this must be denied.
      const bob = identity({ username: "cn=bob/o=acme", usernames: ["cn=bob/o=acme", "*"], hashes: new Set(["hashBob", "$everyone"]) });
      const d = evaluateAccess({
        op: "doc_change",
        dbid: "db",
        identity: bob,
        node: tier2Node,
        beforeDoc: { myeditors: ["cn=alice/o=acme"] },
        afterDoc: { myeditors: ["cn=alice/o=acme", "cn=bob/o=acme"] },
      });
      expect(d.allowed).toBe(false);
    });

    it("doc_create defaults to the after state", () => {
      expect(defaultWhenForOp("doc_create")).toBe("after");
      const node = nodeWith((b) => {
        b.applyDefaultPolicy(policy({ denyDocCreate: true }), 1);
        b.applyRule(
          rule({
            ruleId: "creator",
            type: "doc_create",
            action: "allow",
            withfields: [{ key: "myeditors", op: "containsAny", value: "${user.usernames}" }],
          }),
          2,
        );
      });
      const d = evaluateAccess({
        op: "doc_create",
        dbid: "db",
        identity: identity(),
        node,
        afterDoc: { myeditors: ["cn=alice/o=acme"] },
      });
      expect(d.allowed).toBe(true);
    });
  });

  describe("operators", () => {
    const evalClause = (op: string, value: unknown, doc: Record<string, unknown>) => {
      const node = nodeWith((b) => {
        b.applyDefaultPolicy(policy({ denyDocChange: true }), 1);
        b.applyRule(
          rule({
            ruleId: "r",
            action: "allow",
            withfields: [{ key: "f", op: op as never, value: value as never, when: "before" }],
          }),
          2,
        );
      });
      return evaluateAccess({ op: "doc_change", dbid: "db", identity: identity(), node, beforeDoc: doc }).allowed;
    };

    it("equals / notEquals", () => {
      expect(evalClause("equals", "x", { f: "x" })).toBe(true);
      expect(evalClause("equals", "x", { f: "y" })).toBe(false);
      expect(evalClause("notEquals", "x", { f: "y" })).toBe(true);
    });
    it("contains", () => {
      expect(evalClause("contains", "x", { f: ["a", "x"] })).toBe(true);
      expect(evalClause("contains", "z", { f: ["a", "x"] })).toBe(false);
    });
    it("containsAll", () => {
      expect(evalClause("containsAll", ["a", "b"], { f: ["a", "b", "c"] })).toBe(true);
      expect(evalClause("containsAll", ["a", "z"], { f: ["a", "b"] })).toBe(false);
    });
    it("exists / notExists", () => {
      expect(evalClause("exists", "ignored", { f: 1 })).toBe(true);
      expect(evalClause("exists", "ignored", {})).toBe(false);
      expect(evalClause("notExists", "ignored", {})).toBe(true);
    });
    it("gt / gte / lt / lte", () => {
      expect(evalClause("gt", 5, { f: 6 })).toBe(true);
      expect(evalClause("gt", 5, { f: 5 })).toBe(false);
      expect(evalClause("gte", 5, { f: 5 })).toBe(true);
      expect(evalClause("lt", 5, { f: 4 })).toBe(true);
      expect(evalClause("lte", 5, { f: 5 })).toBe(true);
    });
  });

  describe("unchanged", () => {
    // Room booking: the author may change the booking, but not the decision.
    const nodeFor = (op: RuleType, key = "status") =>
      nodeWith((b) => {
        b.applyDefaultPolicy(policy({ denyDocChange: true, denyDocCreate: true }), 1);
        b.applyRule(
          rule({ ruleId: "u", type: op, action: "allow", withfields: [{ key, op: "unchanged" }] }),
          2,
        );
      });
    const change = (
      beforeDoc: Record<string, unknown> | null,
      afterDoc: Record<string, unknown> | null,
      key = "status",
    ) =>
      evaluateAccess({ op: "doc_change", dbid: "db", identity: identity(), node: nodeFor("doc_change", key), beforeDoc, afterDoc })
        .allowed;

    it("passes when the field keeps its value and fails when it changes", () => {
      expect(change({ status: "pending", title: "a" }, { status: "pending", title: "b" })).toBe(true);
      expect(change({ status: "pending" }, { status: "approved" })).toBe(false);
    });

    it("treats a field missing on both sides as unchanged, but adding or removing it as a change", () => {
      expect(change({ title: "a" }, { title: "b" })).toBe(true);
      expect(change({ title: "a" }, { title: "a", status: "approved" })).toBe(false);
      expect(change({ status: "pending" }, {})).toBe(false);
    });

    it("compares nested dot paths", () => {
      expect(change({ decision: { by: "x", at: 1 } }, { decision: { by: "x", at: 1 }, t: 2 }, "decision.by")).toBe(true);
      expect(change({ decision: { by: "x" } }, { decision: { by: "y" } }, "decision.by")).toBe(false);
    });

    it("compares objects deeply regardless of key order", () => {
      expect(change({ status: { a: 1, b: [1, { c: 2 }] } }, { status: { b: [1, { c: 2 }], a: 1 } })).toBe(true);
      expect(change({ status: { a: 1, b: [1, { c: 2 }] } }, { status: { a: 1, b: [1, { c: 3 }] } })).toBe(false);
      expect(change({ status: { a: 1 } }, { status: { a: 1, b: 2 } })).toBe(false);
    });

    it("compares arrays order-sensitively", () => {
      expect(change({ status: ["a", "b"] }, { status: ["a", "b"] })).toBe(true);
      expect(change({ status: ["a", "b"] }, { status: ["b", "a"] })).toBe(false);
      expect(change({ status: ["a"] }, { status: ["a", "a"] })).toBe(false);
    });

    it("does not confuse values of different types", () => {
      expect(change({ status: 1 }, { status: "1" })).toBe(false);
      expect(change({ status: null }, {})).toBe(false);
      expect(change({ status: [] }, { status: {} })).toBe(false);
    });

    it("on doc_create passes only when the field is absent after", () => {
      const create = (afterDoc: Record<string, unknown> | null) =>
        evaluateAccess({ op: "doc_create", dbid: "db", identity: identity(), node: nodeFor("doc_create"), beforeDoc: null, afterDoc })
          .allowed;
      expect(create({ title: "a" })).toBe(true);
      expect(create({ title: "a", status: "approved" })).toBe(false);
      expect(create(null)).toBe(false);
    });

    it("fails closed when a state is not supplied", () => {
      expect(change(null, { status: "x" })).toBe(false);
      expect(change({ status: "x" }, null)).toBe(false);
      expect(change(null, null)).toBe(false);
    });

    it("combines with other clauses: author may change everything but the decision", () => {
      const node = nodeWith((b) => {
        b.applyDefaultPolicy(policy({ denyDocChange: true }), 1);
        b.applyRule(
          rule({
            ruleId: "author-edits",
            action: "allow",
            users_hashes: ["$author"],
            withfields: [
              { key: "status", op: "unchanged" },
              { key: "decidedBy", op: "unchanged" },
            ],
          }),
          2,
        );
      });
      const author = identity({ hashes: new Set(["hashAlice", "$everyone", "$author"]) });
      const run = (afterDoc: Record<string, unknown>) =>
        evaluateAccess({
          op: "doc_change",
          dbid: "db",
          identity: author,
          node,
          beforeDoc: { title: "Meeting", status: "pending" },
          afterDoc,
        }).allowed;
      expect(run({ title: "Team meeting", status: "pending" })).toBe(true);
      expect(run({ title: "Meeting", status: "approved" })).toBe(false);
      expect(run({ title: "Meeting", status: "pending", decidedBy: "cn=alice/o=acme" })).toBe(false);
    });
  });

  describe("memberOfFieldGroup", () => {
    const run = (
      doc: Record<string, unknown>,
      groups: string[],
      opts: { key?: string; template?: string; when?: "before" | "after" } = {},
    ) => {
      const node = nodeWith((b) => {
        b.applyDefaultPolicy(policy({ denyDocChange: true }), 1);
        b.applyRule(
          rule({
            ruleId: "approvers",
            action: "allow",
            withfields: [
              {
                key: opts.key ?? "roomId",
                op: "memberOfFieldGroup",
                value: opts.template ?? "roomapprovers-{value}",
                ...(opts.when ? { when: opts.when } : {}),
              },
            ],
          }),
          2,
        );
      });
      return evaluateAccess({
        op: "doc_change",
        dbid: "db",
        identity: identity({ groups }),
        node,
        beforeDoc: doc,
        afterDoc: { ...doc, roomId: "changed", rooms: ["changed"] },
      }).allowed;
    };

    it("matches a scalar field against the user's groups", () => {
      expect(run({ roomId: "r1" }, ["roomapprovers-r1"])).toBe(true);
      expect(run({ roomId: "r2" }, ["roomapprovers-r1"])).toBe(false);
      expect(run({ roomId: "r1" }, [])).toBe(false);
    });

    it("matches if any string of an array field yields a group of the user", () => {
      expect(run({ rooms: ["r3", "r1"] }, ["roomapprovers-r1"], { key: "rooms" })).toBe(true);
      expect(run({ rooms: ["r3", "r4"] }, ["roomapprovers-r1"], { key: "rooms" })).toBe(false);
      expect(run({ rooms: [1, null, "r1"] }, ["roomapprovers-r1"], { key: "rooms" })).toBe(true);
      expect(run({ rooms: [] }, ["roomapprovers-r1"], { key: "rooms" })).toBe(false);
    });

    it("works with nested group membership already resolved into identity.groups", () => {
      // The directory resolves nested groups upwards, so a member of a group
      // that is itself in roomapprovers-r1 carries both names.
      expect(run({ roomId: "r1" }, ["facility-team", "roomapprovers-r1"])).toBe(true);
    });

    it("supports the token anywhere in the template and nested field paths", () => {
      expect(run({ room: { id: "r1" } }, ["approvers-r1-rooms"], { key: "room.id", template: "approvers-{value}-rooms" })).toBe(true);
      expect(run({ room: { id: "r1" } }, ["r1"], { key: "room.id", template: "{value}" })).toBe(true);
    });

    it("compares group names case-insensitively and NFKC-normalized", () => {
      expect(run({ roomId: "R1" }, ["roomapprovers-r1"])).toBe(true);
      expect(run({ roomId: "r1" }, ["RoomApprovers-R1"])).toBe(true);
      // Fullwidth "ｒ１" NFKC-normalizes to "r1".
      expect(run({ roomId: "\uFF52\uFF11" }, ["roomapprovers-r1"])).toBe(true);
      // "ﬁ" ligature NFKC-normalizes to "fi".
      expect(run({ roomId: "of\uFB01ce" }, ["roomapprovers-office"])).toBe(true);
    });

    it("never matches a missing, empty or non-string field", () => {
      expect(run({}, ["roomapprovers-"])).toBe(false);
      expect(run({ roomId: "" }, ["roomapprovers-"])).toBe(false);
      expect(run({ roomId: 1 }, ["roomapprovers-1"])).toBe(false);
      expect(run({ roomId: { id: "r1" } }, ["roomapprovers-r1"])).toBe(false);
      expect(run({ roomId: null }, ["roomapprovers-null"])).toBe(false);
    });

    it("reads the state selected by `when` (default before for doc_change)", () => {
      // afterDoc has roomId "changed": the default (before) reads r1.
      expect(run({ roomId: "r1" }, ["roomapprovers-r1"], { when: "before" })).toBe(true);
      expect(run({ roomId: "r1" }, ["roomapprovers-r1"], { when: "after" })).toBe(false);
      expect(run({ roomId: "r1" }, ["roomapprovers-changed"], { when: "after" })).toBe(true);
    });

    it("rejects an invalid template at evaluation time (fails closed)", () => {
      expect(run({ roomId: "r1" }, ["roomapprovers-r1"], { template: "roomapprovers-r1" })).toBe(false);
      expect(run({ roomId: "r1" }, ["r1r1"], { template: "{value}{value}" })).toBe(false);
    });
  });

  describe("deepEqual", () => {
    it("is deterministic for JSON-like values", () => {
      expect(deepEqual({ a: [1, { b: 2 }], c: "x" }, { c: "x", a: [1, { b: 2 }] })).toBe(true);
      expect(deepEqual([1, 2], [2, 1])).toBe(false);
      expect(deepEqual({ a: undefined }, {})).toBe(true);
      expect(deepEqual(new Date(5), new Date(5))).toBe(true);
      expect(deepEqual(new Date(5), new Date(6))).toBe(false);
      expect(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
      expect(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
      expect(deepEqual(NaN, NaN)).toBe(true);
      expect(deepEqual(0, -0)).toBe(true);
    });
  });

  describe("pseudo-tokens", () => {
    const denyChangeAllowAdmin = (adminToken: boolean) =>
      nodeWith((b) => {
        b.applyDefaultPolicy(policy({ denyDocChange: true }), 1);
        b.applyRule(rule({ ruleId: "adminonly", action: "allow", users_hashes: ["$admin"] }), 2);
        void adminToken;
      });

    it("$admin matches only when the identity carries $admin", () => {
      const node = denyChangeAllowAdmin(true);
      const admin = identity({ hashes: new Set(["hashAdmin", "$everyone", "$admin"]) });
      const nonAdmin = identity();
      expect(evaluateAccess({ op: "doc_change", dbid: "db", identity: admin, node }).allowed).toBe(true);
      expect(evaluateAccess({ op: "doc_change", dbid: "db", identity: nonAdmin, node }).allowed).toBe(false);
    });

    it("$author matches only when the identity carries $author", () => {
      const node = nodeWith((b) => {
        b.applyDefaultPolicy(policy({ denyDocDelete: true }), 1);
        b.applyRule(rule({ ruleId: "owner", type: "doc_delete", action: "allow", users_hashes: ["$author"] }), 2);
      });
      const author = identity({ hashes: new Set(["hashAlice", "$everyone", "$author"]) });
      const other = identity();
      expect(evaluateAccess({ op: "doc_delete", dbid: "db", identity: author, node }).allowed).toBe(true);
      expect(evaluateAccess({ op: "doc_delete", dbid: "db", identity: other, node }).allowed).toBe(false);
    });
  });

  describe("server (Tier 1) mode", () => {
    it("enforces a Tier 1 deny", () => {
      const node = nodeWith((b) => {
        b.applyDefaultPolicy(policy({}), 1);
        b.applyRule(rule({ ruleId: "d", action: "deny", users_hashes: ["hashAlice"] }), 2);
      });
      expect(evaluateAccess({ op: "doc_change", dbid: "db", identity: identity(), node, isServer: true }).allowed).toBe(false);
    });

    it("defers a Tier 2 allow over a baseline deny to the client", () => {
      const node = nodeWith((b) => {
        b.applyDefaultPolicy(policy({ denyDocChange: true }), 1);
        b.applyRule(
          rule({
            ruleId: "editors",
            action: "allow",
            withfields: [{ key: "myeditors", op: "containsAny", value: "${user.usernames}" }],
          }),
          2,
        );
      });
      // Server cannot read content; it must allow and let the client enforce Tier 2.
      const d = evaluateAccess({ op: "doc_change", dbid: "db", identity: identity(), node, isServer: true });
      expect(d.allowed).toBe(true);
      expect(d.tier).toBe("tier1");
    });
  });

  // The database read/sync gate (docs/accesscontrol.md §6.6). doc_read is a
  // pure identity/db decision (no document content), so it is always Tier 1 and
  // behaves identically on server and client.
  describe("doc_read database read gate", () => {
    const decideRead = (node: DirectoryStateNode, id: IdentitySet = identity()) =>
      evaluateAccess({ op: "doc_read", dbid: "db", identity: id, node, isServer: true }).allowed;

    it("reads are open by default when a policy exists but does not deny reads", () => {
      const node = nodeWith((b) => b.applyDefaultPolicy(policy({ denyDocChange: true }), 1));
      expect(decideRead(node)).toBe(true);
    });

    it("denyDocRead blocks reads unless an allow rule matches the identity", () => {
      const node = nodeWith((b) => {
        b.applyDefaultPolicy(policy({ denyDocRead: true }), 1);
        b.applyRule(rule({ ruleId: "r", type: "doc_read", dbid: "db", action: "allow", users_hashes: ["hashAlice"] }), 2);
      });
      // Alice carries hashAlice -> allowed; a stranger with neither hash -> denied.
      expect(decideRead(node, identity())).toBe(true);
      expect(decideRead(node, identity({ hashes: new Set(["hashBob", "$everyone"]) }))).toBe(false);
    });

    it("grants read access by group membership", () => {
      const node = nodeWith((b) => {
        b.applyDefaultPolicy(policy({ denyDocRead: true }), 1);
        b.applyRule(rule({ ruleId: "g", type: "doc_read", dbid: "db", action: "allow", users_hashes: ["hashTeam"] }), 2);
      });
      const member = identity({ groups: ["team"], hashes: new Set(["hashAlice", "$everyone", "hashTeam"]) });
      expect(decideRead(node, member)).toBe(true);
      expect(decideRead(node, identity())).toBe(false);
    });

    it("a deny rule overrides an allow rule (deny-overrides-allow)", () => {
      const node = nodeWith((b) => {
        b.applyDefaultPolicy(policy({ denyDocRead: false }), 1);
        b.applyRule(rule({ ruleId: "allow-all", type: "doc_read", dbid: "db", action: "allow", users_hashes: ["$everyone"] }), 2);
        b.applyRule(rule({ ruleId: "deny-alice", type: "doc_read", dbid: "db", action: "deny", users_hashes: ["hashAlice"] }), 3);
      });
      expect(decideRead(node, identity())).toBe(false);
      expect(decideRead(node, identity({ hashes: new Set(["hashBob", "$everyone"]) }))).toBe(true);
    });

    it("a per-db read policy overrides the tenant default", () => {
      const node = nodeWith((b) => {
        b.applyDefaultPolicy(policy({ denyDocRead: true }), 1);
        b.applyDbPolicy("db", policy({ denyDocRead: false }), 2);
      });
      // "db" opens up; a different db inherits the tenant-wide read deny.
      expect(evaluateAccess({ op: "doc_read", dbid: "db", identity: identity(), node, isServer: true }).allowed).toBe(true);
      expect(evaluateAccess({ op: "doc_read", dbid: "other", identity: identity(), node, isServer: true }).allowed).toBe(false);
    });
  });

});
