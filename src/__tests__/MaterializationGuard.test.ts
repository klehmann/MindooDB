import {
  snapshotHeadsMatch,
  deriveDataOpType,
  opTypeMatches,
} from "../core/accesscontrol/materializationGuard";

/**
 * Unit tests for the pure materialization defenses (docs/accesscontrol.md §10):
 * snapshot head verification and op-type re-derivation.
 */
describe("materializationGuard", () => {
  describe("snapshotHeadsMatch", () => {
    it("accepts identical head sets regardless of order", () => {
      expect(snapshotHeadsMatch(["a", "b", "c"], ["c", "a", "b"])).toBe(true);
    });

    it("rejects when the decoded snapshot has an extra head", () => {
      expect(snapshotHeadsMatch(["a", "b", "c"], ["a", "b"])).toBe(false);
    });

    it("rejects when the decoded snapshot is missing a declared head", () => {
      expect(snapshotHeadsMatch(["a", "b"], ["a", "b", "c"])).toBe(false);
    });

    it("rejects when a head differs (smuggled content)", () => {
      expect(snapshotHeadsMatch(["a", "b", "x"], ["a", "b", "c"])).toBe(false);
    });

    it("treats undefined declared heads as empty", () => {
      expect(snapshotHeadsMatch([], undefined)).toBe(true);
      expect(snapshotHeadsMatch(["a"], undefined)).toBe(false);
    });

    it("rejects malformed declared heads with duplicates", () => {
      expect(snapshotHeadsMatch(["a", "a"], ["a", "a"])).toBe(false);
    });
  });

  describe("deriveDataOpType", () => {
    it("derives doc_create for a genesis change", () => {
      expect(deriveDataOpType({ isGenesis: true, beforeDeleted: false, afterDeleted: false })).toBe("doc_create");
    });

    it("derives doc_delete on a not-deleted -> deleted transition", () => {
      expect(deriveDataOpType({ isGenesis: false, beforeDeleted: false, afterDeleted: true })).toBe("doc_delete");
    });

    it("derives doc_undelete on a deleted -> not-deleted transition", () => {
      expect(deriveDataOpType({ isGenesis: false, beforeDeleted: true, afterDeleted: false })).toBe("doc_undelete");
    });

    it("derives doc_change for an ordinary mutation", () => {
      expect(deriveDataOpType({ isGenesis: false, beforeDeleted: false, afterDeleted: false })).toBe("doc_change");
    });

    it("genesis takes precedence over lifecycle flags", () => {
      expect(deriveDataOpType({ isGenesis: true, beforeDeleted: false, afterDeleted: true })).toBe("doc_create");
    });
  });

  describe("opTypeMatches", () => {
    it("matches equal types", () => {
      expect(opTypeMatches("doc_change", "doc_change")).toBe(true);
    });

    it("rejects a delete relabeled as a change (the motivating attack)", () => {
      expect(opTypeMatches("doc_change", "doc_delete")).toBe(false);
    });

    it("rejects a change relabeled as create", () => {
      expect(opTypeMatches("doc_create", "doc_change")).toBe(false);
    });
  });
});
