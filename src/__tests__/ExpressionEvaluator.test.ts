import {
  analyzeExpressionRequirements,
  collectDecryptRequests,
  createViewLanguage,
  evaluateExpression,
  getReferencedFields,
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
    });

    const withDecrypt = v.exists(v.decryptField("secret_encrypted"));
    expect(analyzeExpressionRequirements(withDecrypt).needsDecryption).toBe(true);

    const withCounts = v.gt(v.childCount(), v.number(0));
    const analysis = analyzeExpressionRequirements(withCounts);
    expect(analysis.needsViewContext).toBe(true);
    expect(analysis.viewContextOperations).toEqual(["childCount"]);
  });
});
