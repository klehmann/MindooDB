import { evaluateExpression } from "../core/expressions";
import {
  formatMindooDBFormulaExpression,
  isMindooDBFormulaLikelyBoolean,
  MindooDBFormulaSyntaxError,
  parseMindooDBFormulaBooleanExpression,
  parseMindooDBFormulaExpression,
} from "../core/expressions";

describe("formulaSource", () => {
  it("parses and formats complex builder-call expressions", () => {
    const source = `v.let(
  {
    hours: v.toNumber(v.field("hours")),
    rate: v.toNumber(v.field("rate")),
  },
  ({ hours, rate }) => v.ifElse(
    v.gt(hours, v.number(0)),
    v.mul(hours, rate),
    v.number(0),
  ),
)`;

    const expression = parseMindooDBFormulaExpression(source);
    const formatted = formatMindooDBFormulaExpression(expression);

    expect(evaluateExpression(expression, {
      doc: { hours: "2", rate: "50" },
      values: {},
      origin: "local:replica-1:main",
      variables: {},
    })).toBe(100);
    expect(formatted).toContain("v.let(");
    expect(formatted).toContain("hours: v.toNumber(v.field(\"hours\"))");
    expect(formatted).toContain("v.ifElse(");
  });

  it("supports literal objects and arrays in formula source", () => {
    const expression = parseMindooDBFormulaExpression(
      'v.literal({ status: "draft", totals: [1, 2], nested: { active: true } })',
    );

    expect(expression).toEqual({
      kind: "literal",
      value: {
        status: "draft",
        totals: [1, 2],
        nested: { active: true },
      },
    });
  });

  it("formats literal shorthand without wrapper helpers", () => {
    expect(formatMindooDBFormulaExpression(parseMindooDBFormulaExpression('"open"'))).toBe('"open"');
    expect(formatMindooDBFormulaExpression(parseMindooDBFormulaExpression("123"))).toBe("123");
    expect(formatMindooDBFormulaExpression(parseMindooDBFormulaExpression("true"))).toBe("true");
    expect(
      formatMindooDBFormulaExpression(
        parseMindooDBFormulaExpression('v.eq(v.field("status"), "open")'),
      ),
    ).toBe('v.eq(v.field("status"), "open")');
  });

  it("parses, formats, and evaluates v.origin()", () => {
    const expression = parseMindooDBFormulaExpression("v.origin()");

    expect(expression).toEqual({ kind: "origin" });
    expect(formatMindooDBFormulaExpression(expression)).toBe("v.origin()");
    expect(evaluateExpression(expression, {
      doc: {},
      values: {},
      origin: "remote:replica-1:sales",
      variables: {},
    })).toBe("remote:replica-1:sales");
  });

  it("parses, formats, and evaluates metadata and attachment helpers", () => {
    const createdAtExpression = parseMindooDBFormulaExpression("v.createdAt()");
    const decryptionKeyExpression = parseMindooDBFormulaExpression("v.decryptionKeyId()");
    const attachmentNamesExpression = parseMindooDBFormulaExpression("v.attachmentNames()");
    const attachmentLengthsExpression = parseMindooDBFormulaExpression("v.attachmentLengths()");
    const attachmentCountExpression = parseMindooDBFormulaExpression("v.attachmentCount()");
    const context = {
      doc: {
        _attachments: [
          { fileName: "a.txt", size: 10 },
          { fileName: "b.png", size: 25 },
        ],
      },
      values: {},
      origin: "remote:replica-1:sales",
      createdAt: "2026-04-01T09:00:00.000Z",
      decryptionKeyId: "default",
      variables: {},
    };

    expect(createdAtExpression).toEqual({ kind: "operation", op: "createdAt", args: [] });
    expect(decryptionKeyExpression).toEqual({ kind: "operation", op: "decryptionKeyId", args: [] });
    expect(attachmentNamesExpression).toEqual({ kind: "operation", op: "attachmentNames", args: [] });
    expect(attachmentLengthsExpression).toEqual({ kind: "operation", op: "attachmentLengths", args: [] });
    expect(attachmentCountExpression).toEqual({ kind: "operation", op: "attachmentCount", args: [] });
    expect(formatMindooDBFormulaExpression(createdAtExpression)).toBe("v.createdAt()");
    expect(formatMindooDBFormulaExpression(decryptionKeyExpression)).toBe("v.decryptionKeyId()");
    expect(formatMindooDBFormulaExpression(attachmentNamesExpression)).toBe("v.attachmentNames()");
    expect(formatMindooDBFormulaExpression(attachmentLengthsExpression)).toBe("v.attachmentLengths()");
    expect(formatMindooDBFormulaExpression(attachmentCountExpression)).toBe("v.attachmentCount()");
    expect(evaluateExpression(createdAtExpression, context)).toBe("2026-04-01T09:00:00.000Z");
    expect(evaluateExpression(decryptionKeyExpression, context)).toBe("default");
    expect(evaluateExpression(attachmentNamesExpression, context)).toEqual(["a.txt", "b.png"]);
    expect(evaluateExpression(attachmentLengthsExpression, context)).toEqual([10, 25]);
    expect(evaluateExpression(attachmentCountExpression, context)).toBe(2);
  });

  it("parses, formats, and evaluates view row count helpers", () => {
    const childCount = parseMindooDBFormulaExpression("v.childCount()");
    const childCategoryCount = parseMindooDBFormulaExpression("v.childCategoryCount()");
    const childDocumentCount = parseMindooDBFormulaExpression("v.childDocumentCount()");
    const descendantCount = parseMindooDBFormulaExpression("v.descendantCount()");
    const descendantCategoryCount = parseMindooDBFormulaExpression("v.descendantCategoryCount()");
    const descendantDocumentCount = parseMindooDBFormulaExpression("v.descendantDocumentCount()");
    const siblingCount = parseMindooDBFormulaExpression("v.siblingCount()");
    const context = {
      doc: {},
      values: {},
      origin: "remote:replica-1:sales",
      counts: {
        childCount: 3,
        childCategoryCount: 1,
        childDocumentCount: 2,
        descendantCount: 9,
        descendantCategoryCount: 4,
        descendantDocumentCount: 5,
        siblingCount: 7,
      },
      variables: {},
    };

    expect(childCount).toEqual({ kind: "operation", op: "childCount", args: [] });
    expect(childCategoryCount).toEqual({ kind: "operation", op: "childCategoryCount", args: [] });
    expect(childDocumentCount).toEqual({ kind: "operation", op: "childDocumentCount", args: [] });
    expect(descendantCount).toEqual({ kind: "operation", op: "descendantCount", args: [] });
    expect(descendantCategoryCount).toEqual({ kind: "operation", op: "descendantCategoryCount", args: [] });
    expect(descendantDocumentCount).toEqual({ kind: "operation", op: "descendantDocumentCount", args: [] });
    expect(siblingCount).toEqual({ kind: "operation", op: "siblingCount", args: [] });
    expect(formatMindooDBFormulaExpression(childCount)).toBe("v.childCount()");
    expect(formatMindooDBFormulaExpression(descendantDocumentCount)).toBe("v.descendantDocumentCount()");
    expect(formatMindooDBFormulaExpression(siblingCount)).toBe("v.siblingCount()");
    expect(evaluateExpression(childCount, context)).toBe(3);
    expect(evaluateExpression(childCategoryCount, context)).toBe(1);
    expect(evaluateExpression(childDocumentCount, context)).toBe(2);
    expect(evaluateExpression(descendantCount, context)).toBe(9);
    expect(evaluateExpression(descendantCategoryCount, context)).toBe(4);
    expect(evaluateExpression(descendantDocumentCount, context)).toBe(5);
    expect(evaluateExpression(siblingCount, context)).toBe(7);
  });

  it("flags likely boolean formulas and rejects unknown let references", () => {
    const filterExpression = parseMindooDBFormulaBooleanExpression(
      'v.and(v.exists(v.field("status")), v.eq(v.field("status"), v.string("open")))',
    );

    expect(isMindooDBFormulaLikelyBoolean(filterExpression)).toBe(true);
    expect(() =>
      parseMindooDBFormulaExpression('v.let({ status: v.field("status") }, ({ missing }) => missing)'),
    ).toThrowError(MindooDBFormulaSyntaxError);
  });

  it("formats nested multi-argument boolean wrappers across lines", () => {
    const expression = parseMindooDBFormulaBooleanExpression(
      'v.and(v.eq(v.field("type"), v.number(123)), v.eq(v.field("type"), v.number(456)))',
    );

    expect(formatMindooDBFormulaExpression(expression)).toBe(`v.and(
  v.eq(v.field("type"), 123),
  v.eq(v.field("type"), 456),
)`);
  });

  it("parses and formats left/right string helpers", () => {
    const left = parseMindooDBFormulaExpression('v.left(v.field("code"), "_d")');
    const right = parseMindooDBFormulaExpression('v.right(v.field("code"), 2)');

    expect(left).toEqual({
      kind: "operation",
      op: "left",
      args: [
        { kind: "field", path: "code" },
        { kind: "literal", value: "_d" },
      ],
    });
    expect(formatMindooDBFormulaExpression(left)).toBe('v.left(v.field("code"), "_d")');
    expect(formatMindooDBFormulaExpression(right)).toBe('v.right(v.field("code"), 2)');
  });

  it("parses and round-trips decryptField, decryptJson, and json helpers", () => {
    const cases: Array<[string, unknown]> = [
      ['v.decryptField("user_details_encrypted")', {
        kind: "decrypt",
        field: "user_details_encrypted",
        key: undefined,
      }],
      ['v.decryptField("contact_encrypted", v.field("contact_encrypted_key"))', {
        kind: "decrypt",
        field: "contact_encrypted",
        key: { kind: "field", path: "contact_encrypted_key" },
      }],
      ['v.decryptJson("user_details_encrypted")', {
        kind: "decrypt",
        field: "user_details_encrypted",
        json: true,
        path: undefined,
        key: undefined,
      }],
      ['v.decryptJson("user_details_encrypted", "address.city")', {
        kind: "decrypt",
        field: "user_details_encrypted",
        json: true,
        path: "address.city",
        key: undefined,
      }],
      ['v.decryptJson("contact_encrypted", "email", v.field("contact_encrypted_key"))', {
        kind: "decrypt",
        field: "contact_encrypted",
        json: true,
        path: "email",
        key: { kind: "field", path: "contact_encrypted_key" },
      }],
      ['v.json("profile")', { kind: "json", field: "profile", path: undefined }],
      ['v.json("profile", "address.city")', { kind: "json", field: "profile", path: "address.city" }],
    ];

    for (const [source, expected] of cases) {
      const parsed = parseMindooDBFormulaExpression(source);
      expect(parsed).toEqual(expected);
      expect(formatMindooDBFormulaExpression(parsed)).toBe(source);
    }
  });

  it("round-trips a decryptJson with a key but no path via an empty path argument", () => {
    const parsed = parseMindooDBFormulaExpression(
      'v.decryptJson("contact_encrypted", "", v.field("contact_encrypted_key"))',
    );
    expect(parsed).toEqual({
      kind: "decrypt",
      field: "contact_encrypted",
      json: true,
      path: undefined,
      key: { kind: "field", path: "contact_encrypted_key" },
    });
    expect(formatMindooDBFormulaExpression(parsed)).toBe(
      'v.decryptJson("contact_encrypted", "", v.field("contact_encrypted_key"))',
    );
  });
});
