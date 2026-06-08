import { DirectoryStateChainBuilder, DirectoryStateNode } from "../core/accesscontrol/DirectoryStateNode";
import {
  IdentitySet,
  evaluateAccess,
  defaultWhenForOp,
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

    it("snapshot and purge are denied by default", () => {
      const node = nodeWith((b) => b.applyDefaultPolicy(policy({}), 1));
      expect(evaluateAccess({ op: "doc_snapshot", dbid: "db", identity: identity(), node }).allowed).toBe(false);
      expect(evaluateAccess({ op: "doc_purge", dbid: "db", identity: identity(), node }).allowed).toBe(false);
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

  // Create-key allowlist (docs/accesscontrol.md §6.6). A Tier 1 gate on
  // doc_create: only listed decryptionKeyIds may be used. Hard deny that
  // overrides allow rules; metadata-only so server and client agree.
  describe("create-key allowlist (allowedCreateKeyIds)", () => {
    const createKeyNode = (allowedCreateKeyIds: string[] | undefined) =>
      nodeWith((b) => b.applyDefaultPolicy(policy({ allowedCreateKeyIds }), 1));

    it("denies a doc_create whose key is not in the allowlist", () => {
      const node = createKeyNode(["projkey"]);
      const d = evaluateAccess({
        op: "doc_create",
        dbid: "db",
        identity: identity(),
        node,
        decryptionKeyId: "default",
      });
      expect(d.allowed).toBe(false);
      expect(d.tier).toBe("tier1");
    });

    it("allows a doc_create whose key is in the allowlist", () => {
      const node = createKeyNode(["projkey"]);
      const d = evaluateAccess({
        op: "doc_create",
        dbid: "db",
        identity: identity(),
        node,
        decryptionKeyId: "projkey",
      });
      expect(d.allowed).toBe(true);
    });

    it("denies when no decryptionKeyId is supplied but an allowlist is set", () => {
      const node = createKeyNode(["projkey"]);
      const d = evaluateAccess({ op: "doc_create", dbid: "db", identity: identity(), node });
      expect(d.allowed).toBe(false);
    });

    it("is unconstrained when the allowlist is empty or undefined", () => {
      for (const allow of [undefined, [] as string[]]) {
        const node = createKeyNode(allow);
        const d = evaluateAccess({
          op: "doc_create",
          dbid: "db",
          identity: identity(),
          node,
          decryptionKeyId: "anything",
        });
        expect(d.allowed).toBe(true);
      }
    });

    it("forbids the default key by simply omitting it", () => {
      const node = createKeyNode(["named-key"]);
      expect(
        evaluateAccess({ op: "doc_create", dbid: "db", identity: identity(), node, decryptionKeyId: "default" }).allowed,
      ).toBe(false);
      expect(
        evaluateAccess({ op: "doc_create", dbid: "db", identity: identity(), node, decryptionKeyId: "named-key" }).allowed,
      ).toBe(true);
    });

    it("only gates doc_create; other ops with the same key are unaffected", () => {
      const node = createKeyNode(["projkey"]);
      for (const op of ["doc_change", "doc_delete", "doc_undelete"] as RuleType[]) {
        const d = evaluateAccess({ op, dbid: "db", identity: identity(), node, decryptionKeyId: "default" });
        expect(d.allowed).toBe(true);
      }
    });

    it("is a hard gate: an allow rule cannot rescue a disallowed key", () => {
      const node = nodeWith((b) => {
        b.applyDefaultPolicy(policy({ denyDocCreate: true, allowedCreateKeyIds: ["projkey"] }), 1);
        b.applyRule(rule({ ruleId: "a", type: "doc_create", action: "allow", users_hashes: ["hashAlice"] }), 2);
      });
      // The allow rule would otherwise permit the create, but the wrong key
      // is a hard Tier 1 deny.
      expect(
        evaluateAccess({ op: "doc_create", dbid: "db", identity: identity(), node, decryptionKeyId: "default" }).allowed,
      ).toBe(false);
      // With the allowed key, the allow rule applies and the create succeeds.
      expect(
        evaluateAccess({ op: "doc_create", dbid: "db", identity: identity(), node, decryptionKeyId: "projkey" }).allowed,
      ).toBe(true);
    });

    it("a per-db allowlist overrides the tenant default", () => {
      const node = nodeWith((b) => {
        b.applyDefaultPolicy(policy({ allowedCreateKeyIds: ["tenantkey"] }), 1);
        b.applyDbPolicy("db", policy({ allowedCreateKeyIds: ["dbkey"] }), 2);
      });
      // In "db", only dbkey is allowed (tenant default does not union in).
      expect(
        evaluateAccess({ op: "doc_create", dbid: "db", identity: identity(), node, decryptionKeyId: "tenantkey" }).allowed,
      ).toBe(false);
      expect(
        evaluateAccess({ op: "doc_create", dbid: "db", identity: identity(), node, decryptionKeyId: "dbkey" }).allowed,
      ).toBe(true);
      // A different db falls back to the tenant default allowlist.
      expect(
        evaluateAccess({ op: "doc_create", dbid: "other", identity: identity(), node, decryptionKeyId: "tenantkey" }).allowed,
      ).toBe(true);
    });

    it("enforces identically in server mode (metadata-only Tier 1)", () => {
      const node = createKeyNode(["projkey"]);
      const denied = evaluateAccess({
        op: "doc_create",
        dbid: "db",
        identity: identity(),
        node,
        decryptionKeyId: "default",
        isServer: true,
      });
      expect(denied.allowed).toBe(false);
      expect(denied.tier).toBe("tier1");
    });

    it("time-travel: rotation by policy revision changes the verdict per trusted-time window", () => {
      // t=10 require projkey; t=20 rotate to projkey2.
      const b = new DirectoryStateChainBuilder();
      b.applyDefaultPolicy(policy({ allowedCreateKeyIds: ["projkey"] }), 10);
      b.applyDefaultPolicy(policy({ allowedCreateKeyIds: ["projkey2"] }), 20);
      const decideAt = (T: number, keyId: string) =>
        evaluateAccess({
          op: "doc_create",
          dbid: "db",
          identity: identity(),
          node: b.getStateAt(T),
          decryptionKeyId: keyId,
        }).allowed;
      // A doc created at t=15 with projkey was valid then, and replaying at its
      // own trusted time stays valid even after the t=20 rotation.
      expect(decideAt(15, "projkey")).toBe(true);
      expect(decideAt(15, "projkey2")).toBe(false);
      // New creates after the rotation must use projkey2.
      expect(decideAt(25, "projkey")).toBe(false);
      expect(decideAt(25, "projkey2")).toBe(true);
    });
  });
});
