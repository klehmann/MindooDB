import { createViewLanguage } from "../core/expressions";

describe("createViewLanguage", () => {
  it("builds declarative expressions with lets and branching", () => {
    const v = createViewLanguage<{
      hours: number;
      rate: number;
      status: string;
      employee: { firstName: string; lastName: string };
    }>();

    const expression = v.let(
      {
        hours: v.toNumber(v.field("hours")),
        rate: v.toNumber(v.field("rate")),
      },
      ({ hours, rate }) => v.ifElse(
        v.eq(v.field("status"), "approved"),
        v.mul(v.coalesce(hours, 0), v.coalesce(rate, 0)),
        0,
      ),
    );

    expect(expression).toEqual({
      kind: "let",
      bindings: {
        hours: { kind: "operation", op: "number", args: [{ kind: "field", path: "hours" }] },
        rate: { kind: "operation", op: "number", args: [{ kind: "field", path: "rate" }] },
      },
      result: {
        kind: "if",
        condition: {
          kind: "operation",
          op: "eq",
          args: [
            { kind: "field", path: "status" },
            { kind: "literal", value: "approved" },
          ],
        },
        whenTrue: {
          kind: "operation",
          op: "mul",
          args: [
            {
              kind: "operation",
              op: "coalesce",
              args: [
                { kind: "variable", name: "hours" },
                { kind: "literal", value: 0 },
              ],
            },
            {
              kind: "operation",
              op: "coalesce",
              args: [
                { kind: "variable", name: "rate" },
                { kind: "literal", value: 0 },
              ],
            },
          ],
        },
        whenFalse: { kind: "literal", value: 0 },
      },
    });
  });

  it("accepts literal shorthand for helper arguments, branches, and let bindings", () => {
    const v = createViewLanguage<{
      status: string;
      note?: string;
    }>();

    const expression = v.let(
      {
        defaults: { tags: ["review"], active: true },
        fallback: null,
      },
      ({ defaults, fallback }) => v.ifElse(
        v.and(
          v.eq(v.field("status"), "approved"),
          true,
        ),
        v.concat(v.field("note"), " / ", defaults),
        fallback,
      ),
    );

    expect(expression).toEqual({
      kind: "let",
      bindings: {
        defaults: { kind: "literal", value: { tags: ["review"], active: true } },
        fallback: { kind: "literal", value: null },
      },
      result: {
        kind: "if",
        condition: {
          kind: "operation",
          op: "and",
          args: [
            {
              kind: "operation",
              op: "eq",
              args: [
                { kind: "field", path: "status" },
                { kind: "literal", value: "approved" },
              ],
            },
            { kind: "literal", value: true },
          ],
        },
        whenTrue: {
          kind: "operation",
          op: "concat",
          args: [
            { kind: "field", path: "note" },
            { kind: "literal", value: " / " },
            { kind: "variable", name: "defaults" },
          ],
        },
        whenFalse: { kind: "variable", name: "fallback" },
      },
    });
  });

  it("builds left and right string helper expressions", () => {
    const v = createViewLanguage<{ code: string }>();

    expect(v.left(v.field("code"), "_d")).toEqual({
      kind: "operation",
      op: "left",
      args: [
        { kind: "field", path: "code" },
        { kind: "literal", value: "_d" },
      ],
    });

    expect(v.right(v.field("code"), 2)).toEqual({
      kind: "operation",
      op: "right",
      args: [
        { kind: "field", path: "code" },
        { kind: "literal", value: 2 },
      ],
    });
  });

  it("builds document metadata and attachment helper expressions", () => {
    const v = createViewLanguage<{ _attachments?: Array<{ fileName: string; size: number }> }>();

    expect(v.decryptionKeyId()).toEqual({
      kind: "operation",
      op: "decryptionKeyId",
      args: [],
    });

    expect(v.attachmentNames()).toEqual({
      kind: "operation",
      op: "attachmentNames",
      args: [],
    });

    expect(v.attachmentLengths()).toEqual({
      kind: "operation",
      op: "attachmentLengths",
      args: [],
    });

    expect(v.attachmentCount()).toEqual({
      kind: "operation",
      op: "attachmentCount",
      args: [],
    });

    expect(v.childCount()).toEqual({
      kind: "operation",
      op: "childCount",
      args: [],
    });

    expect(v.childCategoryCount()).toEqual({
      kind: "operation",
      op: "childCategoryCount",
      args: [],
    });

    expect(v.childDocumentCount()).toEqual({
      kind: "operation",
      op: "childDocumentCount",
      args: [],
    });

    expect(v.descendantCount()).toEqual({
      kind: "operation",
      op: "descendantCount",
      args: [],
    });

    expect(v.descendantCategoryCount()).toEqual({
      kind: "operation",
      op: "descendantCategoryCount",
      args: [],
    });

    expect(v.descendantDocumentCount()).toEqual({
      kind: "operation",
      op: "descendantDocumentCount",
      args: [],
    });

    expect(v.siblingCount()).toEqual({
      kind: "operation",
      op: "siblingCount",
      args: [],
    });
  });

  it("builds decrypt and json helper expressions", () => {
    const v = createViewLanguage<{
      user_details_encrypted: string;
      contact_encrypted: string;
      contact_encrypted_key: string;
      profile: string;
    }>();

    expect(v.decryptField("user_details_encrypted")).toEqual({
      kind: "decrypt",
      field: "user_details_encrypted",
      key: undefined,
    });

    expect(v.decryptField("contact_encrypted", v.field("contact_encrypted_key"))).toEqual({
      kind: "decrypt",
      field: "contact_encrypted",
      key: { kind: "field", path: "contact_encrypted_key" },
    });

    expect(v.decryptJson("user_details_encrypted", "address.city")).toEqual({
      kind: "decrypt",
      field: "user_details_encrypted",
      json: true,
      path: "address.city",
      key: undefined,
    });

    expect(v.decryptJson("contact_encrypted", "email", v.field("contact_encrypted_key"))).toEqual({
      kind: "decrypt",
      field: "contact_encrypted",
      json: true,
      path: "email",
      key: { kind: "field", path: "contact_encrypted_key" },
    });

    expect(v.json("profile")).toEqual({
      kind: "json",
      field: "profile",
      path: undefined,
    });

    expect(v.json("profile", "address.city")).toEqual({
      kind: "json",
      field: "profile",
      path: "address.city",
    });
  });
});
