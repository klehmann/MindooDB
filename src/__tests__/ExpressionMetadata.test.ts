import { createViewLanguage } from "../core/expressions";
import {
  getMindooDBViewLanguageHelper,
  mindooDBViewLanguageHelpers,
  mindooDBViewLanguageHelpersByName,
} from "../core/expressions";

describe("view language metadata", () => {
  it("covers every builder helper exactly once", () => {
    const helperNames = Object.keys(createViewLanguage<Record<string, unknown>, Record<string, unknown>>()).sort();
    const metadataNames = mindooDBViewLanguageHelpers.map((entry) => entry.name).sort();

    expect(metadataNames).toEqual(helperNames);
  });

  it("provides structured lookup metadata for editor integrations", () => {
    expect(mindooDBViewLanguageHelpersByName.field.signature).toBe("field(path)");
    expect(mindooDBViewLanguageHelpersByName.field.arguments[0]).toMatchObject({
      name: "path",
      kind: "field-path",
    });

    expect(getMindooDBViewLanguageHelper("let")).toMatchObject({
      category: "control-flow",
      returnType: "Expression<T>",
    });
    expect(getMindooDBViewLanguageHelper("left")).toMatchObject({
      category: "string",
      signature: "left(value, by)",
    });
    expect(getMindooDBViewLanguageHelper("createdAt")).toMatchObject({
      category: "context",
      signature: "createdAt()",
      returnType: "Expression<string | null>",
      examples: ["v.createdAt()"],
    });
    expect(getMindooDBViewLanguageHelper("decryptionKeyId")).toMatchObject({
      category: "context",
      signature: "decryptionKeyId()",
      returnType: "Expression<string | null>",
    });
    expect(getMindooDBViewLanguageHelper("attachmentCount")).toMatchObject({
      category: "context",
      signature: "attachmentCount()",
      returnType: "Expression<number>",
    });
    expect(getMindooDBViewLanguageHelper("descendantDocumentCount")).toMatchObject({
      category: "context",
      signature: "descendantDocumentCount()",
      returnType: "Expression<number>",
    });
  });
});
