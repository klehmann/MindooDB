import {
  DirectoryStateChainBuilder,
  createGenesisNode,
  nodeCovering,
} from "../core/accesscontrol/DirectoryStateNode";
import { AclRuleDoc, DefaultAccessPolicyDoc, TrustedWitnessDoc } from "../core/accesscontrol/types";

/**
 * Unit tests for the copy-on-write time-travel chain (docs/accesscontrol.md §8).
 *
 * Asserts: time-travel reads (state at T differs from head), structural sharing
 * by pointer for unchanged collections, rule add/remove, and grant + revoke with
 * the reverse signing-key index.
 */
function policy(overrides: Partial<DefaultAccessPolicyDoc>): DefaultAccessPolicyDoc {
  return { form: "accesscontrol", type: "defaultpolicy", ...overrides };
}

function rule(ruleId: string, overrides: Partial<AclRuleDoc> = {}): AclRuleDoc {
  return {
    form: "accesscontrol",
    type: "doc_change",
    ruleId,
    dbid: "*",
    users_hashes: ["$everyone"],
    users_encrypted: "",
    action: "allow",
    ...overrides,
  };
}

describe("DirectoryStateNode chain", () => {
  it("starts as an empty genesis node", () => {
    const node = createGenesisNode();
    expect(node.defaultPolicy).toBeNull();
    expect(node.rulesByType.size).toBe(0);
    expect(node.prev).toBeNull();
    expect(node.trustedTimeUpperBound).toBe(Number.NEGATIVE_INFINITY);
  });

  it("supports time travel: state at an earlier T differs from head", () => {
    const b = new DirectoryStateChainBuilder();
    b.applyDefaultPolicy(policy({ denyDocChange: false }), 100);
    b.applyDefaultPolicy(policy({ denyDocChange: true }), 200);

    expect(b.getHead().defaultPolicy?.denyDocChange).toBe(true);
    // At T=150, only the first policy revision applies.
    expect(b.getStateAt(150).defaultPolicy?.denyDocChange).toBe(false);
    // At T=50, no policy existed yet.
    expect(b.getStateAt(50).defaultPolicy).toBeNull();
  });

  it("shares unchanged collections by pointer (copy-on-write)", () => {
    const b = new DirectoryStateChainBuilder();
    b.applyDefaultPolicy(policy({}), 100);
    const afterPolicy = b.getHead();
    b.applyRule(rule("r1"), 200);
    const afterRule = b.getHead();

    // The rule push must NOT clone the (untouched) dbPolicies map.
    expect(afterRule.dbPolicies).toBe(afterPolicy.dbPolicies);
    // But rulesByType is a fresh map.
    expect(afterRule.rulesByType).not.toBe(afterPolicy.rulesByType);
    expect(afterRule.prev).toBe(afterPolicy);
  });

  it("adds and removes rules, replacing same-id rules", () => {
    const b = new DirectoryStateChainBuilder();
    b.applyRule(rule("r1", { action: "allow" }), 100);
    b.applyRule(rule("r1", { action: "deny" }), 200); // replace same id
    expect(b.getHead().rulesByType.get("doc_change")).toHaveLength(1);
    expect(b.getHead().rulesByType.get("doc_change")![0].action).toBe("deny");

    b.removeRule("r1", "doc_change", 300);
    expect(b.getHead().rulesByType.get("doc_change")).toHaveLength(0);
    // Time travel still sees the rule before removal.
    expect(b.getStateAt(250).rulesByType.get("doc_change")).toHaveLength(1);
  });

  it("tracks grants with a reverse signing-key index and supports revocation", () => {
    const b = new DirectoryStateChainBuilder();
    b.applyGrant(
      {
        usernameHash: "hashA",
        signingKeys: ["signA1", "signA2"],
        encryptionKeys: ["encA"],
        wipeRequestedSigningKeys: [],
        active: true,
      },
      100,
    );
    expect(b.getHead().bySigningKey.get("signA1")?.usernameHash).toBe("hashA");
    expect(b.getHead().bySigningKey.get("signA2")?.usernameHash).toBe("hashA");

    b.revokeBySigningKey("signA1", 200);
    // Revoking deactivates the grant; reverse index drops inactive grants.
    expect(b.getHead().usersByHash.get("hashA")?.active).toBe(false);
    expect(b.getHead().bySigningKey.has("signA1")).toBe(false);
    // History still shows it active before revocation.
    expect(b.getStateAt(150).usersByHash.get("hashA")?.active).toBe(true);
  });

  it("applies and removes trusted witnesses", () => {
    const b = new DirectoryStateChainBuilder();
    const witness: TrustedWitnessDoc = {
      form: "accesscontrol",
      type: "trustedwitness",
      witnessPublicKey: "WPUB",
    };
    b.applyTrustedWitness(witness, 100);
    expect(b.getHead().trustedWitnessKeys.has("WPUB")).toBe(true);
    b.removeTrustedWitness("WPUB", 200);
    expect(b.getHead().trustedWitnessKeys.has("WPUB")).toBe(false);
  });

  it("nodeCovering returns an empty node for times before any state", () => {
    const b = new DirectoryStateChainBuilder();
    b.applyDefaultPolicy(policy({}), 100);
    const covering = nodeCovering(b.getHead(), -1);
    expect(covering.defaultPolicy).toBeNull();
  });
});

/**
 * Per-revision group membership (docs/accesscontrol.md §8.1): group documents
 * sharing a name union their member hashes, tracked per document id so a
 * revision or deletion of one document updates only its contribution.
 */
describe("DirectoryStateNode group-doc merge", () => {
  it("unions members across documents sharing a name, by trusted time", () => {
    const b = new DirectoryStateChainBuilder();
    b.applyGroupDoc("gdoc1", "team", ["x"], 100);
    b.applyGroupDoc("gdoc2", "team", ["y"], 200);

    // At T=150 only the first document contributed.
    expect(b.getStateAt(150).groupsByName.get("team")?.memberHashes).toEqual(["x"]);
    // At head, both documents' members are unioned.
    const head = b.getHead().groupsByName.get("team")!;
    expect(new Set(head.memberHashes)).toEqual(new Set(["x", "y"]));
  });

  it("removes a document's contribution and recomputes the union", () => {
    const b = new DirectoryStateChainBuilder();
    b.applyGroupDoc("gdoc1", "team", ["x"], 100);
    b.applyGroupDoc("gdoc2", "team", ["y"], 200);
    b.removeGroupDoc("gdoc2", 300);

    expect(b.getHead().groupsByName.get("team")?.memberHashes).toEqual(["x"]);
    // History before the removal still sees both members.
    expect(new Set(b.getStateAt(250).groupsByName.get("team")!.memberHashes)).toEqual(
      new Set(["x", "y"]),
    );
  });

  it("drops the group entirely when its last document is removed", () => {
    const b = new DirectoryStateChainBuilder();
    b.applyGroupDoc("gdoc1", "team", ["x"], 100);
    b.removeGroupDoc("gdoc1", 200);
    expect(b.getHead().groupsByName.has("team")).toBe(false);
  });
});

/**
 * Delta-log serialization (the on-disk representation of the chain): replaying
 * the exported log through the same builder reproduces an identical chain,
 * including time-travel answers at every trusted time.
 */
describe("DirectoryStateNode delta-log round-trip", () => {
  function buildRepresentativeChain(): DirectoryStateChainBuilder {
    const b = new DirectoryStateChainBuilder();
    b.applyDefaultPolicy(policy({ denyDocChange: false }), 100);
    b.applyRule(rule("r1", { action: "allow" }), 150);
    b.applyGrant(
      {
        usernameHash: "hashA",
        signingKeys: ["signA"],
        encryptionKeys: ["encA"],
        wipeRequestedSigningKeys: [],
        active: true,
      },
      175,
    );
    b.applyGroupDoc("gdoc1", "team", ["x"], 180);
    b.applyDefaultPolicy(policy({ denyDocChange: true }), 200);
    b.applyRule(rule("r1", { action: "deny" }), 250);
    b.applyGroupDoc("gdoc2", "team", ["y"], 275);
    b.revokeBySigningKey("signA", 300);
    b.removeRule("r1", "doc_change", 350);
    return b;
  }

  it("reproduces identical getStateAt answers across many trusted times", () => {
    const original = buildRepresentativeChain();
    const restored = new DirectoryStateChainBuilder();
    // Serialize through JSON to prove the log is plain-data serializable.
    const log = JSON.parse(JSON.stringify(original.exportDeltaLog()));
    restored.importDeltaLog(log);

    for (const T of [50, 100, 125, 160, 180, 199, 200, 260, 280, 310, 360]) {
      const a = original.getStateAt(T);
      const c = restored.getStateAt(T);
      expect(c.defaultPolicy).toEqual(a.defaultPolicy);
      expect(c.rulesByType.get("doc_change")?.map((r) => r.ruleId + r.action)).toEqual(
        a.rulesByType.get("doc_change")?.map((r) => r.ruleId + r.action),
      );
      expect(c.usersByHash.get("hashA")?.active).toEqual(a.usersByHash.get("hashA")?.active);
      expect(c.bySigningKey.has("signA")).toEqual(a.bySigningKey.has("signA"));
      expect(
        new Set(c.groupsByName.get("team")?.memberHashes ?? []),
      ).toEqual(new Set(a.groupsByName.get("team")?.memberHashes ?? []));
    }
  });

  it("re-exports a log equal to the imported one (stable representation)", () => {
    const original = buildRepresentativeChain();
    const restored = new DirectoryStateChainBuilder();
    restored.importDeltaLog(original.exportDeltaLog());
    expect(restored.exportDeltaLog()).toEqual(original.exportDeltaLog());
  });
});
