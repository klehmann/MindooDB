import {
  analyzeExpressionRequirements,
  collectDecryptRequests,
  createViewLanguage,
  evaluateExpression,
  getReferencedFields,
  getReferencedParentFields,
} from "../core/expressions";

describe("expression evaluation", () => {
  const v = createViewLanguage<{
    employee: string;
    hours: number;
    rate: number;
    workDate: string;
    note?: string;
    _attachments?: Array<{ fileName?: string; size?: number }>;
  }>();

  const documents = [
    {
      id: "doc-1",
      createdAt: "2026-04-01T09:00:00.000Z",
      decryptionKeyId: "default",
      data: {
        employee: "Ada",
        hours: 8,
        rate: 10,
        workDate: "2026-04-01",
        note: "Planning",
        _attachments: [
          { fileName: "timesheet.pdf", size: 12 },
          { fileName: "receipt.png", size: 34 },
        ],
      },
    },
    {
      id: "doc-2",
      createdAt: "2026-04-02T09:00:00.000Z",
      decryptionKeyId: null,
      data: { employee: "Ada", hours: 4, rate: 11, workDate: "2026-04-02" },
    },
    { id: "doc-3", data: { employee: "Bob", hours: 0, rate: 12, workDate: "2026-04-03" } },
  ];

  it("evaluates lets, branching and arithmetic", () => {
    const amount = v.let(
      {
        hours: v.toNumber(v.field("hours")),
        rate: v.toNumber(v.field("rate")),
      },
      ({ hours, rate }) => v.mul(v.coalesce(hours, v.number(0)), v.coalesce(rate, v.number(0))),
    );
    expect(evaluateExpression(amount, {
      doc: documents[0]!.data,
      values: {},
      origin: "tenant/db",
      variables: {},
    })).toBe(80);

    const label = v.ifElse(
      v.exists(v.field("note")),
      v.concat(v.field("employee"), v.string(": "), v.field("note")),
      v.field("employee"),
    );
    expect(evaluateExpression(label, {
      doc: documents[0]!.data,
      values: {},
      origin: "tenant/db",
      variables: {},
    })).toBe("Ada: Planning");
    expect(evaluateExpression(label, {
      doc: documents[1]!.data,
      values: {},
      origin: "tenant/db",
      variables: {},
    })).toBe("Ada");
  });

  it("evaluates left and right string helpers with delimiters and counts", () => {
    const base = { doc: {}, values: {}, origin: "tenant/db", variables: {} };
    expect(evaluateExpression(v.left("xyz_d", "_d"), base)).toBe("xyz");
    expect(evaluateExpression(v.left("xyz_d_aaxd", "d"), base)).toBe("xyz_");
    expect(evaluateExpression(v.left("xyz_d", 2), base)).toBe("xy");
    expect(evaluateExpression(v.right("xyz_d", "_"), base)).toBe("d");
    expect(evaluateExpression(v.right("xyz_d", 2), base)).toBe("_d");
  });

  it("evaluates document metadata and attachment helpers", () => {
    expect(evaluateExpression(v.createdAt(), {
      doc: documents[0]!.data,
      values: {},
      origin: "tenant/db",
      createdAt: documents[0]!.createdAt,
      variables: {},
    })).toBe("2026-04-01T09:00:00.000Z");
    expect(evaluateExpression(v.lastModifiedAt(), {
      doc: documents[0]!.data,
      values: {},
      origin: "tenant/db",
      lastModifiedAt: "2026-04-03T15:30:00.000Z",
      variables: {},
    })).toBe("2026-04-03T15:30:00.000Z");
    expect(evaluateExpression(v.decryptionKeyId(), {
      doc: documents[0]!.data,
      values: {},
      origin: "tenant/db",
      decryptionKeyId: documents[0]!.decryptionKeyId,
      variables: {},
    })).toBe("default");
    expect(evaluateExpression(v.attachmentNames(), {
      doc: documents[0]!.data,
      values: {},
      origin: "tenant/db",
      variables: {},
    })).toEqual(["timesheet.pdf", "receipt.png"]);
    expect(evaluateExpression(v.attachmentLengths(), {
      doc: documents[0]!.data,
      values: {},
      origin: "tenant/db",
      variables: {},
    })).toEqual([12, 34]);
    expect(evaluateExpression(v.attachmentCount(), {
      doc: documents[0]!.data,
      values: {},
      origin: "tenant/db",
      variables: {},
    })).toBe(2);
    expect(evaluateExpression(v.decryptionKeyId(), {
      doc: documents[1]!.data,
      values: {},
      origin: "tenant/db",
      decryptionKeyId: documents[1]!.decryptionKeyId,
      variables: {},
    })).toBeNull();
    expect(evaluateExpression(v.createdAt(), {
      doc: documents[2]!.data,
      values: {},
      origin: "tenant/db",
      variables: {},
    })).toBeNull();
    expect(evaluateExpression(v.lastModifiedAt(), {
      doc: documents[2]!.data,
      values: {},
      origin: "tenant/db",
      variables: {},
    })).toBeNull();
  });

  it("evaluates view row count helpers from the row count context", () => {
    const context = {
      doc: {},
      values: {},
      origin: "tenant/db",
      counts: {
        childCount: 3,
        childCategoryCount: 1,
        childDocumentCount: 2,
        descendantCount: 8,
        descendantCategoryCount: 2,
        descendantDocumentCount: 6,
      },
      variables: {},
    };

    expect(evaluateExpression(v.childCount(), context)).toBe(3);
    expect(evaluateExpression(v.childCategoryCount(), context)).toBe(1);
    expect(evaluateExpression(v.childDocumentCount(), context)).toBe(2);
    expect(evaluateExpression(v.descendantCount(), context)).toBe(8);
    expect(evaluateExpression(v.descendantCategoryCount(), context)).toBe(2);
    expect(evaluateExpression(v.descendantDocumentCount(), context)).toBe(6);
  });

  it("evaluates isWitnessed/isAwaitingWitness for the three document states", () => {
    const base = { doc: {}, values: {}, origin: "tenant/db", variables: {} };

    // Legacy (no store entryVersion): both false. Defaults stand in for a host
    // that supplies neither flag.
    expect(evaluateExpression(v.isWitnessed(), base)).toBe(false);
    expect(evaluateExpression(v.isAwaitingWitness(), base)).toBe(false);

    // New, versioned, not yet synced: awaiting witness, not witnessed.
    const unsynced = { ...base, witnessed: false, awaitingWitness: true };
    expect(evaluateExpression(v.isWitnessed(), unsynced)).toBe(false);
    expect(evaluateExpression(v.isAwaitingWitness(), unsynced)).toBe(true);

    // Synced/witnessed: witnessed, no longer awaiting.
    const synced = { ...base, witnessed: true, awaitingWitness: false };
    expect(evaluateExpression(v.isWitnessed(), synced)).toBe(true);
    expect(evaluateExpression(v.isAwaitingWitness(), synced)).toBe(false);
  });
});

describe("decrypt and json evaluation", () => {
  const v = createViewLanguage<{
    user_details_encrypted: string;
    user_details_encrypted_key: string;
    profile: string | Record<string, unknown>;
  }>();

  const userDetails = { username: "Ada", address: { city: "London" } };
  const base = {
    doc: { profile: JSON.stringify(userDetails) },
    values: {},
    origin: "tenant/db",
    variables: {},
    decrypted: { user_details_encrypted: JSON.stringify(userDetails) },
  };

  it("returns the raw plaintext for decryptField", () => {
    expect(evaluateExpression(v.decryptField("user_details_encrypted"), base)).toBe(
      JSON.stringify(userDetails),
    );
  });

  it("parses and extracts paths for decryptJson", () => {
    expect(evaluateExpression(v.decryptJson("user_details_encrypted"), base)).toEqual(userDetails);
    expect(evaluateExpression(v.decryptJson("user_details_encrypted", "username"), base)).toBe("Ada");
    expect(evaluateExpression(v.decryptJson("user_details_encrypted", "address.city"), base)).toBe("London");
  });

  it("returns null when no plaintext was pre-resolved", () => {
    const noDecrypt = { ...base, decrypted: undefined };
    expect(evaluateExpression(v.decryptField("user_details_encrypted"), noDecrypt)).toBeNull();
    expect(evaluateExpression(v.decryptJson("user_details_encrypted", "username"), noDecrypt)).toBeNull();
  });

  it("parses JSON strings and passes objects through for json", () => {
    expect(evaluateExpression(v.json("profile", "address.city"), base)).toBe("London");
    const objectDoc = { ...base, doc: { profile: userDetails } };
    expect(evaluateExpression(v.json("profile"), objectDoc)).toEqual(userDetails);
    expect(evaluateExpression(v.json("profile", "username"), objectDoc)).toBe("Ada");
  });

  it("returns null for invalid JSON in json/decryptJson", () => {
    const invalid = {
      ...base,
      doc: { profile: "{not json" },
      decrypted: { user_details_encrypted: "{not json" },
    };
    expect(evaluateExpression(v.json("profile"), invalid)).toBeNull();
    expect(evaluateExpression(v.decryptJson("user_details_encrypted"), invalid)).toBeNull();
  });

  it("collects decrypt requests but ignores json nodes", () => {
    const expression = v.concat(
      v.decryptJson("user_details_encrypted", "username"),
      v.json("profile", "username"),
      v.decryptField("user_details_encrypted", v.field("user_details_encrypted_key")),
    );

    const requests = collectDecryptRequests(expression);
    expect(requests).toEqual([
      { field: "user_details_encrypted", key: undefined },
      { field: "user_details_encrypted", key: { kind: "field", path: "user_details_encrypted_key" } },
    ]);
  });
});

describe("expression analysis helpers", () => {
  const v = createViewLanguage<{
    status: string;
    hours: number;
    meta: { owner: string };
    secret_encrypted: string;
    profile: string;
  }>();

  it("collects referenced field paths including json fields", () => {
    const expression = v.and(
      v.eq(v.field("status"), v.string("open")),
      v.gt(v.toNumber(v.field("hours")), v.number(2)),
      v.exists(v.field("meta.owner")),
      v.exists(v.json("profile", "address.city")),
    );
    expect(getReferencedFields(expression).sort()).toEqual([
      "hours",
      "meta.owner",
      "profile",
      "status",
    ]);
  });

  it("detects decryption and view-context requirements", () => {
    const plain = v.eq(v.field("status"), v.string("open"));
    expect(analyzeExpressionRequirements(plain)).toEqual({
      needsDecryption: false,
      needsViewContext: false,
      viewContextOperations: [],
      needsParentContext: false,
    });

    const withDecrypt = v.exists(v.decryptField("secret_encrypted"));
    expect(analyzeExpressionRequirements(withDecrypt).needsDecryption).toBe(true);

    const withCounts = v.gt(v.childCount(), v.number(0));
    const analysis = analyzeExpressionRequirements(withCounts);
    expect(analysis.needsViewContext).toBe(true);
    expect(analysis.viewContextOperations).toEqual(["childCount"]);
  });

  it("detects the parent-context requirement of include filters", () => {
    expect(analyzeExpressionRequirements(v.eq(v.field("status"), "open")).needsParentContext).toBe(false);
    expect(
      analyzeExpressionRequirements(v.eq(v.field("status"), v.parent("status"))).needsParentContext
    ).toBe(true);
    // parentDocId() reaches the parent row just as parent() does, so it has
    // to raise the same flag — otherwise the guardrails would let it through
    // in a root filter, where there is no parent at all.
    expect(
      analyzeExpressionRequirements(v.eq(v.field("invoiceId"), v.parentDocId())).needsParentContext
    ).toBe(true);
    expect(analyzeExpressionRequirements(v.docId()).needsParentContext).toBe(false);
  });

  it("separates parent field paths from document field paths", () => {
    const expression = v.and(
      v.eq(v.field("invoiceId"), v.parentDocId()),
      v.eq(v.field("status"), v.parent("meta.owner")),
    );
    // `field` paths are checked against the child summary, `parent` paths
    // against the parent's — so they must never end up in the same bucket.
    expect(getReferencedFields(expression).sort()).toEqual(["invoiceId", "status"]);
    // An id is not a summary field, so neither helper is a coverage subject.
    expect(getReferencedParentFields(expression)).toEqual(["meta.owner"]);
    expect(getReferencedFields(v.docId())).toEqual([]);
  });
});

describe("parent expressions", () => {
  const v = createViewLanguage<{ invoiceId: string; amount: number }>();

  const base = {
    doc: { invoiceId: "inv_1", amount: 80 },
    values: {},
    origin: "tenant/db",
    variables: {},
  };

  it("reads the parent row id and parent fields", () => {
    const context = {
      ...base,
      parent: {
        docId: "inv_1",
        doc: { customerId: "c_9", meta: { owner: "ada" }, _lastModified: 1710000000000 },
      },
    };

    expect(evaluateExpression(v.parentDocId(), context)).toBe("inv_1");
    // The id is metadata, so the "docId" PATH is an ordinary field lookup
    // that finds nothing — the two must not be confused.
    expect(evaluateExpression(v.parent("docId"), context)).toBeUndefined();
    expect(evaluateExpression(v.parent("customerId"), context)).toBe("c_9");
    expect(evaluateExpression(v.parent("meta.owner"), context)).toBe("ada");
    // No special case needed for the timestamp: the evaluation doc mirrors it.
    expect(evaluateExpression(v.parent("_lastModified"), context)).toBe(1710000000000);
    expect(evaluateExpression(v.parent("missing"), context)).toBeUndefined();
  });

  it("evaluates to undefined without a parent context", () => {
    expect(evaluateExpression(v.parentDocId(), base)).toBeNull();
    expect(evaluateExpression(v.parent("customerId"), base)).toBeUndefined();
  });

  it("reads the current document id only through docId()", () => {
    // The evaluation doc holds summary FIELDS; the id travels beside it.
    const context = { ...base, docId: "line_a" };
    expect(evaluateExpression(v.docId(), context)).toBe("line_a");
    expect(evaluateExpression(v.field("docId" as never), context)).toBeUndefined();
    // Hosts that never populate the id yield null rather than a stale value.
    expect(evaluateExpression(v.docId(), base)).toBeNull();
  });

  it("does not read the current document", () => {
    // `invoiceId` exists on the evaluated document, but parent() must not
    // fall back to it — silently joining a document to itself would be the
    // worst possible failure mode.
    const context = { ...base, parent: { docId: "inv_2", doc: {} } };
    expect(evaluateExpression(v.parent("invoiceId"), context)).toBeUndefined();
    expect(evaluateExpression(v.field("invoiceId"), context)).toBe("inv_1");
  });
});
