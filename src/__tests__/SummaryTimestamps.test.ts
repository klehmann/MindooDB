import { getFieldValue } from "../core/expressions/evaluateExpression";
import { extractSummaryFields } from "../core/indexing/summary/extractSummaryFields";
import { computeSummaryConfigFingerprint } from "../core/indexing/summary/types";

const baseConfig = {
  autoInclude: true,
  maxValueBytes: 1024,
  include: [] as string[],
  exclude: [] as string[],
  includeAttachments: false,
  includeRecipients: false,
};

describe("timestamps in the summary buffer", () => {
  it("auto-includes top-level timestamps as ISO strings", () => {
    const fields = extractSummaryFields(
      {
        title: "x",
        dueAt: new Date(Date.UTC(2026, 9, 1, 12)),
        history: [new Date(0), new Date(1000)],
        broken: new Date(Number.NaN),
      },
      baseConfig as any,
    );
    expect(fields).toEqual({
      title: "x",
      dueAt: "2026-10-01T12:00:00.000Z",
      history: ["1970-01-01T00:00:00.000Z", "1970-01-01T00:00:01.000Z"],
      broken: null,
    });
  });

  it("converts timestamps inside explicitly included values", () => {
    const fields = extractSummaryFields(
      { meta: { at: new Date(0), tags: ["a"] } },
      { ...baseConfig, autoInclude: false, include: ["meta", "meta.at"] } as any,
    );
    expect(fields).toEqual({
      meta: { at: "1970-01-01T00:00:00.000Z", tags: ["a"] },
      "meta.at": "1970-01-01T00:00:00.000Z",
    });
  });

  it("reads timestamps as ISO strings on the full-document path too", () => {
    expect(getFieldValue({ meta: { at: new Date(0) } }, "meta.at")).toBe("1970-01-01T00:00:00.000Z");
    expect(getFieldValue({ n: 1 }, "n")).toBe(1);
  });

  it("changes the config fingerprint so older persisted buffers are rebuilt", () => {
    expect(JSON.parse(computeSummaryConfigFingerprint(baseConfig as any)).extractionVersion).toBe(2);
  });
});
