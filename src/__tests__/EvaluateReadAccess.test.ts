import {
  DirectoryStateChainBuilder,
  DirectoryStateNode,
} from "../core/accesscontrol/DirectoryStateNode";
import { IdentitySet, evaluateReadAccess } from "../core/accesscontrol/evaluate";
import { DefaultReadPolicyDoc, ReadRuleDoc } from "../core/accesscontrol/types";

/**
 * Truth-matrix tests for the pure read-access evaluation engine (read-side of
 * docs/accesscontrol.md). Covers: read control not enabled, master switch,
 * default-allow vs default-deny baseline, db + decryptionKeyId scoping, identity
 * intersection, deny-overrides-allow, and time-travel (revocation by policy
 * revision rather than client-trusted dates).
 */
function readPolicy(overrides: Partial<DefaultReadPolicyDoc>): DefaultReadPolicyDoc {
  return { form: "accesscontrol", type: "readpolicy", ...overrides };
}

function readRule(overrides: Partial<ReadRuleDoc> & { ruleId: string }): ReadRuleDoc {
  return {
    form: "accesscontrol",
    type: "doc_read",
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

const READ = (node: DirectoryStateNode, dbid = "crm", decryptionKeyId = "default", id = identity()) =>
  evaluateReadAccess({ dbid, decryptionKeyId, identity: id, node });

describe("evaluateReadAccess", () => {
  it("allows reads when no read access control is configured", () => {
    const node = nodeWith(() => {});
    const d = READ(node);
    expect(d.allowed).toBe(true);
    expect(d.tier).toBe("tier1");
  });

  it("master switch allows everything, even with a deny rule present", () => {
    const node = nodeWith((b) => {
      b.applyReadPolicy(readPolicy({ defaultReadAccess: "deny", disableAllReadChecks: true }), 1);
      b.applyReadRule(readRule({ ruleId: "d", action: "deny" }), 2);
    });
    expect(READ(node).allowed).toBe(true);
  });

  it("default-deny baseline denies when no rule matches", () => {
    const node = nodeWith((b) => {
      b.applyReadPolicy(readPolicy({ defaultReadAccess: "deny" }), 1);
    });
    expect(READ(node).allowed).toBe(false);
  });

  it("default-allow baseline allows when no rule matches", () => {
    const node = nodeWith((b) => {
      b.applyReadPolicy(readPolicy({ defaultReadAccess: "allow" }), 1);
    });
    expect(READ(node).allowed).toBe(true);
  });

  it("an allow rule grants read under a default-deny baseline", () => {
    const node = nodeWith((b) => {
      b.applyReadPolicy(readPolicy({ defaultReadAccess: "deny" }), 1);
      b.applyReadRule(readRule({ ruleId: "r1", dbid: "crm", users_hashes: ["hashAlice"] }), 2);
    });
    const d = READ(node);
    expect(d.allowed).toBe(true);
    expect(d.matchedRuleId).toBe("r1");
  });

  it("does not grant when the identity does not intersect the rule", () => {
    const node = nodeWith((b) => {
      b.applyReadPolicy(readPolicy({ defaultReadAccess: "deny" }), 1);
      b.applyReadRule(readRule({ ruleId: "r1", dbid: "crm", users_hashes: ["hashBob"] }), 2);
    });
    expect(READ(node).allowed).toBe(false);
  });

  it("scopes a rule to its dbid (no match for a different db)", () => {
    const node = nodeWith((b) => {
      b.applyReadPolicy(readPolicy({ defaultReadAccess: "deny" }), 1);
      b.applyReadRule(readRule({ ruleId: "r1", dbid: "crm", users_hashes: ["hashAlice"] }), 2);
    });
    expect(READ(node, "crm").allowed).toBe(true);
    expect(READ(node, "hr").allowed).toBe(false);
  });

  it("respects an optional decryptionKeyId scope on a rule", () => {
    const node = nodeWith((b) => {
      b.applyReadPolicy(readPolicy({ defaultReadAccess: "deny" }), 1);
      b.applyReadRule(
        readRule({
          ruleId: "r1",
          dbid: "crm",
          users_hashes: ["hashAlice"],
          decryptionKeyIds: ["k1", "k2"],
        }),
        2,
      );
    });
    expect(READ(node, "crm", "k1").allowed).toBe(true);
    expect(READ(node, "crm", "k2").allowed).toBe(true);
    // A key outside the rule's scope is not covered -> baseline deny.
    expect(READ(node, "crm", "k3").allowed).toBe(false);
  });

  it("an unscoped rule applies to every key in the database", () => {
    const node = nodeWith((b) => {
      b.applyReadPolicy(readPolicy({ defaultReadAccess: "deny" }), 1);
      b.applyReadRule(readRule({ ruleId: "r1", dbid: "crm", users_hashes: ["hashAlice"] }), 2);
    });
    expect(READ(node, "crm", "anyKey").allowed).toBe(true);
  });

  it("deny overrides allow regardless of insertion order", () => {
    const node = nodeWith((b) => {
      b.applyReadPolicy(readPolicy({ defaultReadAccess: "deny" }), 1);
      b.applyReadRule(readRule({ ruleId: "allow", dbid: "crm", users_hashes: ["hashAlice"] }), 2);
      b.applyReadRule(readRule({ ruleId: "deny", dbid: "crm", users_hashes: ["hashAlice"], action: "deny" }), 3);
    });
    const d = READ(node);
    expect(d.allowed).toBe(false);
    expect(d.matchedRuleId).toBe("deny");
  });

  it("a per-db read policy overrides the tenant default baseline", () => {
    const node = nodeWith((b) => {
      b.applyReadPolicy(readPolicy({ defaultReadAccess: "allow" }), 1);
      b.applyDbReadPolicy("crm", readPolicy({ defaultReadAccess: "deny" }), 2);
    });
    expect(READ(node, "hr").allowed).toBe(true); // inherits tenant allow
    expect(READ(node, "crm").allowed).toBe(false); // db override deny
  });

  it("a `*` rule covers all databases", () => {
    const node = nodeWith((b) => {
      b.applyReadPolicy(readPolicy({ defaultReadAccess: "deny" }), 1);
      b.applyReadRule(readRule({ ruleId: "r1", dbid: "*", users_hashes: ["hashAlice"] }), 2);
    });
    expect(READ(node, "crm").allowed).toBe(true);
    expect(READ(node, "hr").allowed).toBe(true);
  });

  // Time-bound access is revocation-by-policy-revision: an admin flips the rule
  // to deny / deletes it, and the verdict at each point in time reflects the
  // policy that was provably in force then. No client clock is involved.
  describe("time-travel: grant -> revoke read access", () => {
    const readAt = (b: DirectoryStateChainBuilder, T: number): boolean =>
      evaluateReadAccess({
        dbid: "crm",
        decryptionKeyId: "default",
        identity: identity(),
        node: b.getStateAt(T),
      }).allowed;

    it("allowed while the allow rule is in force, denied after it is removed", () => {
      const b = new DirectoryStateChainBuilder();
      b.applyReadPolicy(readPolicy({ defaultReadAccess: "deny" }), 10);
      b.applyReadRule(readRule({ ruleId: "r1", dbid: "crm", users_hashes: ["hashAlice"] }), 20);
      b.removeReadRule("r1", 30);

      expect(readAt(b, 5)).toBe(true); // before any read policy -> unrestricted
      expect(readAt(b, 15)).toBe(false); // policy active, no rule yet -> deny
      expect(readAt(b, 25)).toBe(true); // allow rule in force
      expect(readAt(b, 35)).toBe(false); // rule revoked -> deny again
    });

    it("revokes by flipping the allow rule to a deny rule", () => {
      const b = new DirectoryStateChainBuilder();
      b.applyReadPolicy(readPolicy({ defaultReadAccess: "deny" }), 10);
      b.applyReadRule(readRule({ ruleId: "r1", dbid: "crm", users_hashes: ["hashAlice"] }), 20);
      b.applyReadRule(readRule({ ruleId: "r1", dbid: "crm", users_hashes: ["hashAlice"], action: "deny" }), 30);

      expect(readAt(b, 25)).toBe(true);
      expect(readAt(b, 35)).toBe(false);
    });
  });
});
