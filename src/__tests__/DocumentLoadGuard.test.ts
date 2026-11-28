import * as Automerge from "@automerge/automerge";

import {
  APPLY_CHANGES_SLICE_OPS,
  DocumentTooLargeError,
  RETAINED_BYTES_PER_CHANGE,
  RETAINED_BYTES_PER_OP,
  SNAPSHOT_BYTES_PER_OP,
  STEP_BYTES_PER_CHANGE,
  STEP_BYTES_PER_OP,
  assertDocumentLoadWithinBudget,
  countChunkOps,
  estimateDocumentLoad,
  isDocumentTooLargeError,
  setDocumentLoadBudget,
} from "../core/documentLoadGuard";

type Doc = Record<string, unknown>;

function changesOf(steps: Array<(d: Doc) => void>) {
  let doc = Automerge.init<Doc>();
  const changes: Uint8Array[] = [];
  for (const step of steps) {
    doc = Automerge.change(doc, step);
    changes.push(Automerge.getLastLocalChange(doc)!);
  }
  return { doc, changes };
}

describe("documentLoadGuard", () => {
  afterEach(() => setDocumentLoadBudget(null));

  it("counts the operations of a change exactly, without loading it", () => {
    const { changes } = changesOf([
      (d) => {
        d.title = "abc"; // makeText + 3 inserts
        d.status = new Automerge.ImmutableString("x".repeat(50_000)); // one op
        d.n = 1;
      },
      (d) => {
        d.list = [{ a: 1 }, { b: new Automerge.ImmutableString("y") }];
        d.votes = new Automerge.Counter(0);
      },
      (d) => {
        delete d.n;
        Automerge.splice(d, ["title"], 1, 1, "XYZ");
      },
    ]);
    for (const change of changes) {
      expect(countChunkOps(change)).toBe(Automerge.decodeChange(change).ops.length);
    }
  });

  it("counts the operations of a saved document", () => {
    const { doc } = changesOf([
      (d) => {
        d.body = "z".repeat(20_000);
      },
      (d) => {
        d.body = "rewritten ".repeat(500); // a full rewrite keeps the old text's ops
      },
    ]);
    expect(countChunkOps(Automerge.save(doc))).toBe(Automerge.stats(doc).numOps);
  });

  it("tells collaborative text from an atomic string of the same size", () => {
    const text = changesOf([(d) => { d.v = "t".repeat(100_000); }]).changes;
    const atomic = changesOf([(d) => { d.v = new Automerge.ImmutableString("t".repeat(100_000)); }]).changes;
    expect(estimateDocumentLoad(null, text)!.ops).toBe(100_001);
    expect(estimateDocumentLoad(null, atomic)!.ops).toBe(1);
  });

  it("weighs snapshot ops, the ops that stay and the largest step by their measured costs", () => {
    const { doc } = changesOf([(d) => { d.v = "s".repeat(1_000); }]);
    const { changes } = changesOf([(d) => { d.w = "c".repeat(2_000); }]);
    const estimate = estimateDocumentLoad(Automerge.save(doc), changes)!;
    expect(estimate.ops).toBe(1_001 + 2_001);
    expect(estimate.largestStepOps).toBe(2_001);
    expect(estimate.bytes).toBe(
      1_001 * SNAPSHOT_BYTES_PER_OP +
        2_001 * RETAINED_BYTES_PER_OP +
        RETAINED_BYTES_PER_CHANGE +
        2_001 * STEP_BYTES_PER_OP +
        STEP_BYTES_PER_CHANGE,
    );
  });

  it("charges a long history by what stays, and only its most expensive step at the step rate", () => {
    // 60 changes of 10,000 characters: 600,000 ops, applied in steps of 500,000.
    const { changes } = changesOf(
      Array.from({ length: 60 }, (_, i) => (d: Doc) => { d[`p${i}`] = "x".repeat(9_999); }),
    );
    const estimate = estimateDocumentLoad(null, changes)!;
    expect(estimate.ops).toBe(600_000);
    expect(estimate.largestStepOps).toBe(APPLY_CHANGES_SLICE_OPS);
    expect(estimate.bytes).toBe(
      600_000 * RETAINED_BYTES_PER_OP +
        60 * RETAINED_BYTES_PER_CHANGE +
        APPLY_CHANGES_SLICE_OPS * STEP_BYTES_PER_OP +
        50 * STEP_BYTES_PER_CHANGE,
    );
  });

  it("charges a single change above the step size as a step of its own", () => {
    const { changes } = changesOf([
      (d) => { d.v = "t".repeat(APPLY_CHANGES_SLICE_OPS + 10_000); },
      (d) => { d.w = "small"; },
    ]);
    const estimate = estimateDocumentLoad(null, changes)!;
    expect(estimate.largestStepOps).toBe(APPLY_CHANGES_SLICE_OPS + 10_001);
  });

  it("returns null for bytes it cannot read, so the guard does not block", () => {
    expect(countChunkOps(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(countChunkOps(new Uint8Array(64))).toBeNull();
    setDocumentLoadBudget(1);
    expect(() => assertDocumentLoadWithinBudget("doc", null, [new Uint8Array(64)])).not.toThrow();
  });

  it("throws DocumentTooLargeError above the budget and passes below it", () => {
    const { changes } = changesOf([(d) => { d.v = "t".repeat(10_000); }]);
    expect(() => assertDocumentLoadWithinBudget("doc1", null, changes)).not.toThrow(); // no budget

    setDocumentLoadBudget(
      10_001 * (RETAINED_BYTES_PER_OP + STEP_BYTES_PER_OP) + RETAINED_BYTES_PER_CHANGE + STEP_BYTES_PER_CHANGE,
    );
    expect(() => assertDocumentLoadWithinBudget("doc1", null, changes)).not.toThrow();

    setDocumentLoadBudget(1024 * 1024);
    let caught: unknown;
    try {
      assertDocumentLoadWithinBudget("doc1", null, changes);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DocumentTooLargeError);
    expect(isDocumentTooLargeError(caught)).toBe(true);
    expect((caught as DocumentTooLargeError).docId).toBe("doc1");
    expect((caught as DocumentTooLargeError).ops).toBe(10_001);
  });

  it("rejects a budget that is not a positive number", () => {
    expect(() => setDocumentLoadBudget(0)).toThrow();
    expect(() => setDocumentLoadBudget(Number.NaN)).toThrow();
  });
});

describe("documentLoadGuard on mixed, long histories", () => {
  it("reads a saved document with thousands of mixed changes", () => {
    let doc = Automerge.change(Automerge.init<Doc>(), (d) => {
      d.text = "";
      d.items = [];
    });
    for (let i = 0; i < 3000; i += 1) {
      doc = Automerge.change(doc, (d) => {
        if (i % 3 === 0) Automerge.splice(d, ["text"], 0, 0, "ab");
        else if (i % 3 === 1) (d.items as unknown[]).push({ i, s: new Automerge.ImmutableString(`v${i}`) });
        else d[`k${i % 50}`] = i;
      });
    }
    expect(countChunkOps(Automerge.save(doc))).toBe(Automerge.stats(doc).numOps);
  });
});
