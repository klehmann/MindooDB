import { DirectoryStateChainBuilder, DirectoryStateNode } from "../core/accesscontrol/DirectoryStateNode";
import { parsePolicyDoc } from "../core/accesscontrol/directoryProjection";
import { IdentitySet, evaluateAccess, evaluateDocReadAll } from "../core/accesscontrol/evaluate";
import {
  AclRuleDoc,
  DefaultAccessPolicyDoc,
  effectivePolicy,
  validateAccessPolicy,
  validateAclRule,
} from "../core/accesscontrol/types";

/** Policy side of the author-scoped read (docs/accesscontrol.md §6.12). */
function policy(overrides: Partial<DefaultAccessPolicyDoc>): DefaultAccessPolicyDoc {
  return { form: "accesscontrol", type: "defaultpolicy", ...overrides };
}

function rule(overrides: Partial<AclRuleDoc> & { ruleId: string }): AclRuleDoc {
  return {
    form: "accesscontrol",
    type: "doc_read_all",
    dbid: "inbox",
    users_hashes: ["hashAlice"],
    users_encrypted: "",
    action: "allow",
    ...overrides,
  };
}

function identity(hashes: string[] = ["hashAlice", "$everyone"]): IdentitySet {
  return { username: "cn=alice/o=acme", usernames: ["cn=alice/o=acme"], groups: [], hashes: new Set(hashes) };
}

function nodeWith(build: (b: DirectoryStateChainBuilder) => void): DirectoryStateNode {
  const b = new DirectoryStateChainBuilder();
  build(b);
  return b.getHead();
}

describe("docReadScope / doc_read_all", () => {
  it("defaults to all and layers per database", () => {
    expect(effectivePolicy(policy({}), null).docReadScope).toBe("all");
    expect(effectivePolicy(policy({}), policy({ docReadScope: "own" })).docReadScope).toBe("own");
    expect(effectivePolicy(policy({ docReadScope: "own" }), policy({ docReadScope: "all" })).docReadScope).toBe("all");
  });

  it("parses and validates the field", () => {
    expect(parsePolicyDoc({ docReadScope: "own" }).docReadScope).toBe("own");
    expect(parsePolicyDoc({ docReadScope: "nonsense" }).docReadScope).toBeUndefined();
    expect(() => validateAccessPolicy({ docReadScope: "mine" as never })).toThrow(/docReadScope/);
    expect(() => validateAccessPolicy({ docReadScope: "own" })).not.toThrow();
  });

  it("refuses withfields on doc_read_all rules", () => {
    expect(() =>
      validateAclRule({
        type: "doc_read_all",
        dbid: "inbox",
        action: "allow",
        users_hashes: ["h"],
        withfields: [{ field: "x", operator: "exists" } as never],
      }),
    ).toThrow(/doc_read_all/);
  });

  it("scope own: only an allow rule opens everything, deny overrides", () => {
    const own = (extra: (b: DirectoryStateChainBuilder) => void = () => {}) =>
      nodeWith((b) => {
        b.applyDefaultPolicy(policy({ disableAllAccessChecksAndPolicies: false }), 1);
        b.applyDbPolicy("inbox", policy({ docReadScope: "own" }), 2);
        extra(b);
      });
    expect(evaluateDocReadAll({ dbid: "inbox", identity: identity(), node: own() }).allowed).toBe(false);
    const withReader = own((b) => b.applyRule(rule({ ruleId: "r" }), 3));
    expect(evaluateDocReadAll({ dbid: "inbox", identity: identity(), node: withReader }).allowed).toBe(true);
    expect(evaluateAccess({ op: "doc_read_all", dbid: "inbox", identity: identity(), node: withReader }).allowed).toBe(true);
    // Another database is not covered by the rule, but has scope all.
    expect(evaluateDocReadAll({ dbid: "main", identity: identity(), node: withReader }).allowed).toBe(true);
    // Someone else is not a reader.
    expect(evaluateDocReadAll({ dbid: "inbox", identity: identity(["hashBob"]), node: withReader }).allowed).toBe(false);
    const denied = own((b) => {
      b.applyRule(rule({ ruleId: "r", users_hashes: ["$everyone"] }), 3);
      b.applyRule(rule({ ruleId: "d", action: "deny" }), 4);
    });
    expect(evaluateDocReadAll({ dbid: "inbox", identity: identity(), node: denied }).allowed).toBe(false);
  });

  it("no policy or the master switch: everyone reads everything", () => {
    expect(evaluateDocReadAll({ dbid: "inbox", identity: identity(), node: nodeWith(() => {}) }).allowed).toBe(true);
    const off = nodeWith((b) => {
      b.applyDefaultPolicy(policy({ disableAllAccessChecksAndPolicies: true }), 1);
      b.applyDbPolicy("inbox", policy({ docReadScope: "own" }), 2);
    });
    expect(evaluateDocReadAll({ dbid: "inbox", identity: identity(), node: off }).allowed).toBe(true);
  });
});
