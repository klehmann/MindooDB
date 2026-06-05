import { CUSTOM_DOC_ID_REGEX } from "../core/types";
import {
  ACL_DEFAULT_POLICY_DOC_ID,
  aclDbPolicyDocId,
  aclRuleDocId,
  aclTrustedWitnessDocId,
  encodeAclIdComponent,
  decodeAclIdComponent,
  validateAclRule,
  validateWithFieldClause,
  effectivePolicy,
  DEFAULT_POLICY_DEFAULTS,
  DefaultAccessPolicyDoc,
} from "../core/accesscontrol/types";
import {
  extractSigningPublicKeys,
  extractEncryptionPublicKeys,
  extractWipeRequestedSigningKeys,
  extractKeyPairs,
  applyKeyPairFields,
  mergeKeyPairs,
  primarySigningPublicKey,
} from "../core/accesscontrol/grantKeys";

/**
 * Phase 1 schema tests (docs/accesscontrol.md §6, §7):
 * - fixed ACL document ids satisfy CUSTOM_DOC_ID_REGEX for arbitrary inputs;
 * - the closed operator/placeholder/type set rejects unknown values;
 * - grant key-array extraction honors both the new array and legacy scalar forms;
 * - policy layering/defaults are correct.
 */
describe("access-control schema", () => {
  describe("fixed document ids", () => {
    it("default policy id is a valid custom doc id", () => {
      expect(ACL_DEFAULT_POLICY_DOC_ID).toBe("acl_defaultpolicy");
      expect(CUSTOM_DOC_ID_REGEX.test(ACL_DEFAULT_POLICY_DOC_ID)).toBe(true);
    });

    it.each([
      "directory",
      "test-db",
      "a.b/c",
      "weird id with spaces",
      "0190-uuid-7-style",
      "under_score",
      "ünïcode",
    ])("produces regex-valid, reversible ids for component %j", (component) => {
      const dbId = aclDbPolicyDocId(component);
      const ruleId = aclRuleDocId(component);
      const witnessId = aclTrustedWitnessDocId(component);
      for (const id of [dbId, ruleId, witnessId]) {
        expect(CUSTOM_DOC_ID_REGEX.test(id)).toBe(true);
      }
      // encode/decode round-trips so the component can be recovered.
      expect(decodeAclIdComponent(encodeAclIdComponent(component))).toBe(component);
    });

    it("encodes distinct components to distinct ids (injective)", () => {
      // The classic collision risk: "a_b" vs "a-b". Both must encode distinctly.
      expect(aclDbPolicyDocId("a_b")).not.toBe(aclDbPolicyDocId("a-b"));
      expect(aclDbPolicyDocId("a_b")).not.toBe(aclDbPolicyDocId("ab"));
    });
  });

  describe("rule validation (closed sets)", () => {
    it("accepts a well-formed allow rule", () => {
      expect(() =>
        validateAclRule({
          type: "doc_change",
          dbid: "*",
          action: "allow",
          users_hashes: ["$everyone"],
          withfields: [{ key: "myeditors", op: "containsAny", value: "${user.usernames}" }],
        }),
      ).not.toThrow();
    });

    it("rejects an unknown operator", () => {
      expect(() =>
        validateWithFieldClause(
          { key: "x", op: "matches" as unknown as never, value: "y" },
          "doc_change",
        ),
      ).toThrow(/unknown operator/i);
    });

    it("rejects an unknown placeholder", () => {
      expect(() =>
        validateWithFieldClause(
          { key: "x", op: "equals", value: "${user.unknown}" },
          "doc_change",
        ),
      ).toThrow(/unknown placeholder/i);
    });

    it("rejects an unknown rule type", () => {
      expect(() =>
        validateAclRule({
          type: "doc_frobnicate" as unknown as never,
          dbid: "*",
          action: "allow",
          users_hashes: ["$everyone"],
        }),
      ).toThrow(/unknown type/i);
    });

    it("rejects when:before on doc_create (no before state exists)", () => {
      expect(() =>
        validateWithFieldClause({ key: "myeditors", op: "containsAny", value: "${user.usernames}", when: "before" }, "doc_create"),
      ).toThrow(/before/i);
    });

    it("rejects an invalid action and empty users_hashes", () => {
      expect(() =>
        validateAclRule({ type: "doc_change", dbid: "*", action: "maybe" as unknown as never, users_hashes: ["$everyone"] }),
      ).toThrow(/invalid action/i);
      expect(() =>
        validateAclRule({ type: "doc_change", dbid: "*", action: "allow", users_hashes: [] }),
      ).toThrow(/users_hashes/i);
    });
  });

  describe("policy defaults and layering", () => {
    it("defaults snapshot/purge to denied and the rest to allowed", () => {
      const eff = effectivePolicy({ form: "accesscontrol", type: "defaultpolicy" }, null);
      expect(eff.denyDocCreate).toBe(false);
      expect(eff.denyDocSnapshot).toBe(DEFAULT_POLICY_DEFAULTS.denyDocSnapshot);
      expect(eff.denyDocSnapshot).toBe(true);
      expect(eff.denyDocPurge).toBe(true);
      expect(eff.disableAllAccessChecksAndPolicies).toBe(false);
    });

    it("lets a DB policy override the tenant default", () => {
      const tenant: DefaultAccessPolicyDoc = {
        form: "accesscontrol",
        type: "defaultpolicy",
        denyDocChange: true,
      };
      const db: DefaultAccessPolicyDoc = {
        form: "accesscontrol",
        type: "defaultpolicy",
        denyDocChange: false,
      };
      expect(effectivePolicy(tenant, db).denyDocChange).toBe(false);
      expect(effectivePolicy(tenant, null).denyDocChange).toBe(true);
    });

    it("propagates the master switch from either layer", () => {
      const on: DefaultAccessPolicyDoc = {
        form: "accesscontrol",
        type: "defaultpolicy",
        disableAllAccessChecksAndPolicies: true,
      };
      expect(effectivePolicy(on, null).disableAllAccessChecksAndPolicies).toBe(true);
      expect(effectivePolicy(null, on).disableAllAccessChecksAndPolicies).toBe(true);
    });
  });

  describe("grant key extraction (new + legacy)", () => {
    it("reads the array form when present", () => {
      const data = {
        userSigningPublicKeys: ["sign1", "sign2"],
        userEncryptionPublicKeys: ["enc1"],
      };
      expect(extractSigningPublicKeys(data)).toEqual(["sign1", "sign2"]);
      expect(extractEncryptionPublicKeys(data)).toEqual(["enc1"]);
      expect(primarySigningPublicKey(data)).toBe("sign1");
    });

    it("falls back to the legacy scalar form", () => {
      const data = {
        userSigningPublicKey: "legacySign",
        userEncryptionPublicKey: "legacyEnc",
      };
      expect(extractSigningPublicKeys(data)).toEqual(["legacySign"]);
      expect(extractEncryptionPublicKeys(data)).toEqual(["legacyEnc"]);
    });

    it("prefers the array form over the scalar form", () => {
      const data = {
        userSigningPublicKeys: ["arraySign"],
        userSigningPublicKey: "scalarSign",
      };
      expect(extractSigningPublicKeys(data)).toEqual(["arraySign"]);
    });

    it("returns empty when all keys are removed (fully revoked)", () => {
      expect(extractSigningPublicKeys({ userSigningPublicKeys: [] })).toEqual([]);
      expect(extractSigningPublicKeys({})).toEqual([]);
    });

    it("does not resurrect access from a stale scalar after revocation", () => {
      // registerUser writes both the array and the legacy scalar; revocation
      // empties only the array. The empty array must win so the user is revoked.
      const revoked = {
        userSigningPublicKeys: [],
        userSigningPublicKey: "scalarSign",
        userEncryptionPublicKeys: [],
        userEncryptionPublicKey: "scalarEnc",
      };
      expect(extractSigningPublicKeys(revoked)).toEqual([]);
      expect(extractEncryptionPublicKeys(revoked)).toEqual([]);
      expect(primarySigningPublicKey(revoked)).toBeNull();
    });

    it("extracts wipe-requested signing keys", () => {
      expect(
        extractWipeRequestedSigningKeys({ wipeRequestedForSigningKeys: ["k1", "k2", "k1"] }),
      ).toEqual(["k1", "k2"]);
      expect(extractWipeRequestedSigningKeys({})).toEqual([]);
    });
  });

  describe("key-pair object form (userKeyPairs)", () => {
    it("reads paired keys and labels from userKeyPairs", () => {
      const data = {
        userKeyPairs: [
          { signingPublicKey: "sign1", encryptionPublicKey: "enc1", label: "Phone" },
          { signingPublicKey: "sign2", encryptionPublicKey: "enc2" },
        ],
      };
      expect(extractKeyPairs(data)).toEqual([
        { signingPublicKey: "sign1", encryptionPublicKey: "enc1", label: "Phone" },
        { signingPublicKey: "sign2", encryptionPublicKey: "enc2" },
      ]);
      expect(extractSigningPublicKeys(data)).toEqual(["sign1", "sign2"]);
      expect(extractEncryptionPublicKeys(data)).toEqual(["enc1", "enc2"]);
    });

    it("treats userKeyPairs as authoritative over legacy fields, even when empty", () => {
      const revoked = {
        userKeyPairs: [],
        userSigningPublicKeys: ["stale"],
        userSigningPublicKey: "scalarSign",
        userEncryptionPublicKeys: ["staleEnc"],
        userEncryptionPublicKey: "scalarEnc",
      };
      expect(extractKeyPairs(revoked)).toEqual([]);
      expect(extractSigningPublicKeys(revoked)).toEqual([]);
      expect(extractEncryptionPublicKeys(revoked)).toEqual([]);
    });

    it("reconstructs pairs from legacy parallel arrays by index", () => {
      const data = {
        userSigningPublicKeys: ["sign1", "sign2"],
        userEncryptionPublicKeys: ["enc1", "enc2"],
      };
      expect(extractKeyPairs(data)).toEqual([
        { signingPublicKey: "sign1", encryptionPublicKey: "enc1" },
        { signingPublicKey: "sign2", encryptionPublicKey: "enc2" },
      ]);
    });

    it("applyKeyPairFields mirrors all three representations", () => {
      const data: Record<string, unknown> = {};
      applyKeyPairFields(data, [
        { signingPublicKey: "sign1", encryptionPublicKey: "enc1", label: "Phone" },
        { signingPublicKey: "sign2", encryptionPublicKey: "enc2" },
      ]);
      expect(data.userKeyPairs).toEqual([
        { signingPublicKey: "sign1", encryptionPublicKey: "enc1", label: "Phone" },
        { signingPublicKey: "sign2", encryptionPublicKey: "enc2" },
      ]);
      expect(data.userSigningPublicKeys).toEqual(["sign1", "sign2"]);
      expect(data.userEncryptionPublicKeys).toEqual(["enc1", "enc2"]);
      // Legacy scalars point at the primary (first) pair.
      expect(data.userSigningPublicKey).toBe("sign1");
      expect(data.userEncryptionPublicKey).toBe("enc1");
    });

    it("applyKeyPairFields writes empty arrays for a fully-revoked grant", () => {
      const data: Record<string, unknown> = {};
      applyKeyPairFields(data, []);
      expect(data.userKeyPairs).toEqual([]);
      expect(data.userSigningPublicKeys).toEqual([]);
      expect(extractSigningPublicKeys(data)).toEqual([]);
    });

    it("mergeKeyPairs updates an existing pair by signing key", () => {
      const existing = [{ signingPublicKey: "sign1", encryptionPublicKey: "enc1" }];
      const merged = mergeKeyPairs(existing, [
        { signingPublicKey: "sign1", encryptionPublicKey: "enc1", label: "Relabeled" },
        { signingPublicKey: "sign2", encryptionPublicKey: "enc2" },
      ]);
      expect(merged).toEqual([
        { signingPublicKey: "sign1", encryptionPublicKey: "enc1", label: "Relabeled" },
        { signingPublicKey: "sign2", encryptionPublicKey: "enc2" },
      ]);
    });
  });
});
