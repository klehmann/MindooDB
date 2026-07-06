import {
  computeAcceptedSet,
  sortForEvaluation,
  QuarantineCandidate,
  EntryVerdict,
} from "../core/accesscontrol/quarantine";

/**
 * Tests for the deterministic cascade-quarantine engine
 * (docs/accesscontrol.md §10): causal closure of the accepted set and
 * cross-replica determinism.
 */
describe("quarantine cascade", () => {
  function entry(id: string, deps: string[], trustedTime: number): QuarantineCandidate {
    return { id, docId: "doc1", dependencyIds: deps, entryType: "doc_change", trustedTime };
  }

  // Reject a fixed set of ids; everything else accepted.
  function rejectIds(reject: Set<string>): (e: QuarantineCandidate) => EntryVerdict {
    return (e) => (reject.has(e.id) ? { accepted: false } : { accepted: true });
  }

  it("accepts everything when no entry is rejected", () => {
    const entries = [entry("a", [], 1), entry("b", ["a"], 2), entry("c", ["b"], 3)];
    const r = computeAcceptedSet(entries, rejectIds(new Set()), 0);
    expect(r.acceptedIds.sort()).toEqual(["a", "b", "c"]);
    expect(r.quarantinedIds).toHaveLength(0);
  });

  it("cascades quarantine to transitive dependents", () => {
    const entries = [
      entry("a", [], 1),
      entry("b", ["a"], 2), // rejected
      entry("c", ["b"], 3), // cascades
      entry("d", ["c"], 4), // cascades
      entry("e", ["a"], 5), // independent of b -> stays accepted
    ];
    const r = computeAcceptedSet(entries, rejectIds(new Set(["b"])), 100);
    expect(r.acceptedIds.sort()).toEqual(["a", "e"]);
    expect(r.quarantinedIds.sort()).toEqual(["b", "c", "d"]);

    // Cascade records point back to the root cause "b".
    const cRecord = r.records.find((rec) => rec.entryId === "c")!;
    expect(cRecord.reason).toBe("cascade_dependent");
    expect(cRecord.causedByEntryId).toBe("b");
    const dRecord = r.records.find((rec) => rec.entryId === "d")!;
    expect(dRecord.causedByEntryId).toBe("b");
  });

  it("keeps the accepted set causally closed", () => {
    const entries = [
      entry("a", [], 1),
      entry("b", ["a"], 2),
      entry("c", ["a"], 3), // rejected
      entry("d", ["b", "c"], 4), // depends on rejected c -> cascades
    ];
    const r = computeAcceptedSet(entries, rejectIds(new Set(["c"])), 0);
    const accepted = new Set(r.acceptedIds);
    // Every accepted entry's deps are also accepted (causal closure).
    for (const e of entries) {
      if (accepted.has(e.id)) {
        for (const dep of e.dependencyIds) {
          expect(accepted.has(dep)).toBe(true);
        }
      }
    }
    expect(accepted.has("d")).toBe(false);
  });

  it("is deterministic regardless of input order (replica convergence)", () => {
    const base = [
      entry("a", [], 1),
      entry("b", ["a"], 2),
      entry("c", ["b"], 3),
      entry("d", ["a"], 4),
      entry("e", ["d"], 5),
    ];
    const reject = new Set(["b"]);

    const r1 = computeAcceptedSet(base, rejectIds(reject), 0);
    const shuffled = [base[3], base[0], base[4], base[2], base[1]];
    const r2 = computeAcceptedSet(shuffled, rejectIds(reject), 0);

    expect(r1.acceptedIds).toEqual(r2.acceptedIds);
    expect(r1.quarantinedIds.sort()).toEqual(r2.quarantinedIds.sort());
  });

  it("sortForEvaluation orders by trusted time then id", () => {
    const sorted = sortForEvaluation([
      entry("z", [], 5),
      entry("a", [], 5),
      entry("m", [], 1),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(["m", "a", "z"]);
  });

  it("preserves the verdict's audit record for direct violations", () => {
    const entries = [entry("a", [], 1)];
    const verdict = (): EntryVerdict => ({
      accepted: false,
      record: {
        entryId: "a",
        docId: "doc1",
        dbid: "crm",
        entryType: "doc_change",
        reason: "op_type_mismatch",
        detail: "signed doc_change but derived doc_delete",
        trustedTime: 1,
      },
    });
    const r = computeAcceptedSet(entries, verdict, 999);
    expect(r.records[0].reason).toBe("op_type_mismatch");
    expect(r.records[0].recordedAt).toBe(999);
  });
});
