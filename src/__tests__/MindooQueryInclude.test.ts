import type { MindooDB } from "../core/types";
import { createViewLanguage } from "../core/expressions";
import type { MindooDBAppBooleanExpression } from "../core/expressions/types";
import { MindooQueryError, type MindooQueryResult, type MindooQueryRow } from "../core/query/types";
import { extractJoinKey } from "../core/query/executeQueryInclude";
import { createWitnessingTenant } from "./_helpers/witnessingTenant";

const v = createViewLanguage<Record<string, unknown>>();

/** Let the coalescing change-event timer fire. */
async function flushChangeEvents(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Reads a `cardinality: "one"` slot. */
function one(row: MindooQueryRow, slot: string): MindooQueryRow | null {
  return (row.includes?.[slot] ?? null) as MindooQueryRow | null;
}

/** Reads a `cardinality: "many"` slot. */
function many(row: MindooQueryRow, slot: string): MindooQueryRow[] {
  return (row.includes?.[slot] ?? []) as MindooQueryRow[];
}

function rowById(result: MindooQueryResult, docId: string): MindooQueryRow {
  const row = result.rows.find((candidate) => candidate.docId === docId);
  if (!row) {
    throw new Error(`Expected a row for "${docId}", got ${result.rows.map((r) => r.docId).join(", ")}`);
  }
  return row;
}

/**
 * Coverage for nested lookups (`MindooQuery.include`): the join planner,
 * cardinality handling, cross-database and cross-tenant joins, the
 * guardrails that keep a slot at one scan, and live queries over several
 * databases.
 */
describe("MindooQuery include (nested lookups)", () => {
  let invoicesDb: MindooDB;
  let customersDb: MindooDB;
  let catalogDb: MindooDB;

  async function create(db: MindooDB, id: string, data: Record<string, unknown>): Promise<void> {
    const doc = await db.createDocument({ id });
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), data);
    });
  }

  beforeEach(async () => {
    const ctx = await createWitnessingTenant("test-tenant-include");
    invoicesDb = await ctx.tenant.openDB("invoices-db");
    customersDb = await ctx.tenant.openDB("customers-db");
    catalogDb = await ctx.tenant.openDB("catalog-db");

    // Document ids are caller-provided so the joins are stable. Note
    // CUSTOM_DOC_ID_REGEX forbids hyphens: "inv_1", never "inv-1".
    await create(invoicesDb, "inv_1", { type: "invoice", total: 120, customerId: "c_9", secret: "s1" });
    await create(invoicesDb, "inv_2", { type: "invoice", total: 50, customerId: "c_9", secret: "s2" });
    await create(invoicesDb, "inv_3", { type: "invoice", total: 70, customerId: "c_gone", secret: "s3" });
    await create(invoicesDb, "inv_4", { type: "invoice", total: 10, customerId: "c_8", secret: "s4" });

    await create(invoicesDb, "line_a", { type: "line", invoiceId: "inv_1", amount: 80, status: "open", productId: "p_1" });
    await create(invoicesDb, "line_b", { type: "line", invoiceId: "inv_1", amount: 40, status: "draft", productId: "p_2" });
    await create(invoicesDb, "line_c", { type: "line", invoiceId: "inv_2", amount: 50, status: "open", productId: "p_1" });

    await create(invoicesDb, "ord_1", { type: "order", memberIds: ["c_9", "c_8"] });

    await create(customersDb, "c_9", { type: "customer", name: "Acme", active: true, addressId: "a_1" });
    await create(customersDb, "c_8", { type: "customer", name: "Beta", active: false });
    await create(customersDb, "a_1", { type: "address", city: "Berlin" });

    await create(catalogDb, "p_1", { type: "product", title: "Widget" });
    await create(catalogDb, "p_2", { type: "product", title: "Gadget" });
  }, 30000);

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------

  it("joins children of the same database via a v.parent() filter", async () => {
    const result = await invoicesDb.query!({
      filter: v.eq(v.field("type"), "invoice"),
      fields: ["total"],
      include: {
        lines: {
          cardinality: "many",
          filter: v.and(
            v.eq(v.field("type"), "line"),
            v.eq(v.field("invoiceId"), v.parentDocId()),
          ),
          fields: ["amount"],
          sortBy: [{ field: "amount", direction: "descending" }],
        },
      },
    });

    expect(result.total).toBe(4);
    expect(many(rowById(result, "inv_1"), "lines").map((line) => line.fields.amount)).toEqual([80, 40]);
    expect(many(rowById(result, "inv_2"), "lines").map((line) => line.docId)).toEqual(["line_c"]);
    // A parent without any related document gets an empty array, never null.
    expect(rowById(result, "inv_4").includes!.lines).toEqual([]);
    // Related rows are ordinary rows with the include's own projection.
    expect(many(rowById(result, "inv_1"), "lines")[0]).toMatchObject({
      docId: "line_a",
      fields: { amount: 80 },
    });
    expect(many(rowById(result, "inv_1"), "lines")[0].fields.status).toBeUndefined();
  }, 30000);

  it("joins a single related document from another database via localKey", async () => {
    const result = await invoicesDb.query!({
      filter: v.eq(v.field("type"), "invoice"),
      fields: ["total", "customerId"],
      include: {
        customer: {
          db: customersDb,
          cardinality: "one",
          localKey: "customerId",
          fields: ["name"],
        },
      },
    });

    expect(one(rowById(result, "inv_1"), "customer")).toEqual({
      docId: "c_9",
      fields: { name: "Acme" },
      lastModified: expect.any(Number),
    });
    // A dangling reference resolves to null rather than failing the query.
    expect(one(rowById(result, "inv_3"), "customer")).toBeNull();
  }, 30000);

  it("joins on document ids through docId(), not a field path", async () => {
    // The explicit form localKey desugars to.
    const explicit = await invoicesDb.query!({
      filter: v.eq(v.field("type"), "invoice"),
      include: {
        customer: {
          db: customersDb,
          cardinality: "one",
          filter: v.eq(v.docId(), v.parent("customerId")),
          fields: ["name"],
        },
      },
    });
    const viaLocalKey = await invoicesDb.query!({
      filter: v.eq(v.field("type"), "invoice"),
      include: {
        customer: { db: customersDb, cardinality: "one", localKey: "customerId", fields: ["name"] },
      },
    });
    expect(one(rowById(explicit, "inv_1"), "customer")).toEqual(
      one(rowById(viaLocalKey, "inv_1"), "customer")
    );

    // The "docId" PATH is an ordinary field lookup: the summary stores
    // fields, not ids, so it finds nothing.
    const byPath = await invoicesDb.query!({ filter: v.eq(v.field("docId"), "inv_1") });
    expect(byPath.total).toBe(0);
    // ...while docId() resolves against the row being evaluated.
    const byHelper = await invoicesDb.query!({ filter: v.eq(v.docId(), "inv_1") });
    expect(byHelper.total).toBe(1);
    expect(byHelper.rows[0]!.docId).toBe("inv_1");
  }, 30000);

  it("sorts and filters related documents by their own id", async () => {
    const sorted = await invoicesDb.query!({
      filter: v.eq(v.docId(), "inv_1"),
      include: {
        lines: {
          cardinality: "many",
          filter: v.eq(v.field("invoiceId"), v.parentDocId()),
          sortBy: [{ expression: v.docId(), direction: "descending" }],
        },
      },
    });
    expect(many(rowById(sorted, "inv_1"), "lines").map((line) => line.docId)).toEqual([
      "line_b",
      "line_a",
    ]);

    // In a residual condition docId() addresses the CHILD being scanned,
    // while parentDocId() stays bound to the invoice.
    const narrowed = await invoicesDb.query!({
      filter: v.eq(v.docId(), "inv_1"),
      include: {
        lines: {
          cardinality: "many",
          filter: v.and(v.eq(v.field("invoiceId"), v.parentDocId()), v.neq(v.docId(), "line_b")),
        },
      },
    });
    expect(many(rowById(narrowed, "inv_1"), "lines").map((line) => line.docId)).toEqual(["line_a"]);
  }, 30000);

  it("joins every element of an array localKey", async () => {
    const result = await invoicesDb.query!({
      filter: v.eq(v.field("type"), "order"),
      include: {
        members: {
          db: customersDb,
          cardinality: "many",
          localKey: "memberIds",
          fields: ["name"],
          sortBy: [{ field: "name", direction: "ascending" }],
        },
      },
    });

    expect(many(rowById(result, "ord_1"), "members").map((member) => member.fields.name)).toEqual([
      "Acme",
      "Beta",
    ]);
  }, 30000);

  it("narrows a localKey join with an additional filter", async () => {
    const result = await invoicesDb.query!({
      filter: v.eq(v.field("type"), "invoice"),
      include: {
        activeCustomer: {
          db: customersDb,
          cardinality: "one",
          localKey: "customerId",
          filter: v.eq(v.field("active"), true),
          fields: ["name"],
        },
      },
    });

    expect(one(rowById(result, "inv_1"), "activeCustomer")!.fields.name).toBe("Acme");
    // c_8 exists but is inactive: the extra condition filters it out.
    expect(one(rowById(result, "inv_4"), "activeCustomer")).toBeNull();
  }, 30000);

  it("nests one-to-one lookups across databases", async () => {
    const nested = await invoicesDb.query!({
      filter: v.eq(v.field("type"), "invoice"),
      include: {
        customer: {
          db: customersDb,
          cardinality: "one",
          localKey: "customerId",
          fields: ["name"],
          include: {
            address: {
              cardinality: "one",
              localKey: "addressId",
              fields: ["city"],
            },
          },
        },
      },
    });

    const customer = one(rowById(nested, "inv_1"), "customer")!;
    // One recursive rule: an included row carries its own `includes`.
    expect(one(customer, "address")!.fields.city).toBe("Berlin");
    // c_8 has no addressId at all.
    expect(one(one(rowById(nested, "inv_4"), "customer")!, "address")).toBeNull();
  }, 30000);

  it("nests a one-lookup on another database below a many-lookup", async () => {
    const nested = await invoicesDb.query!({
      filter: v.eq(v.field("type"), "invoice"),
      include: {
        lines: {
          cardinality: "many",
          filter: v.eq(v.field("invoiceId"), v.parentDocId()),
          sortBy: [{ field: "amount", direction: "descending" }],
          include: {
            product: {
              db: catalogDb,
              cardinality: "one",
              localKey: "productId",
              fields: ["title"],
            },
          },
        },
      },
    });

    const lines = many(rowById(nested, "inv_1"), "lines");
    expect(lines.map((line) => one(line, "product")!.fields.title)).toEqual(["Widget", "Gadget"]);
  }, 30000);

  it("applies sortBy and limit per parent, not across the result", async () => {
    const result = await invoicesDb.query!({
      filter: v.eq(v.field("type"), "invoice"),
      include: {
        lines: {
          cardinality: "many",
          filter: v.eq(v.field("invoiceId"), v.parentDocId()),
          sortBy: [{ field: "amount", direction: "ascending" }],
          limit: 1,
          fields: ["amount"],
        },
      },
    });

    // inv_1 has two lines and keeps the cheapest; inv_2 keeps its only one.
    expect(many(rowById(result, "inv_1"), "lines").map((line) => line.fields.amount)).toEqual([40]);
    expect(many(rowById(result, "inv_2"), "lines").map((line) => line.fields.amount)).toEqual([50]);
  }, 30000);

  it("hydrates only the paged rows and leaves total untouched", async () => {
    const result = await invoicesDb.query!({
      filter: v.eq(v.field("type"), "invoice"),
      sortBy: [{ field: "total", direction: "descending" }],
      limit: 1,
      include: {
        lines: {
          cardinality: "many",
          filter: v.eq(v.field("invoiceId"), v.parentDocId()),
        },
      },
    });

    expect(result.total).toBe(4);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].docId).toBe("inv_1");
    expect(many(result.rows[0], "lines")).toHaveLength(2);
  }, 30000);

  it("joins on a field the root projection left out", async () => {
    const result = await invoicesDb.query!({
      filter: v.eq(v.field("type"), "invoice"),
      // `customerId` is deliberately not projected: the join reads the
      // summary entry, not the row we hand back.
      fields: ["total"],
      include: {
        customer: {
          db: customersDb,
          cardinality: "one",
          localKey: "customerId",
          fields: ["name"],
        },
      },
    });

    expect(rowById(result, "inv_1").fields).toEqual({ total: 120 });
    expect(one(rowById(result, "inv_1"), "customer")!.fields.name).toBe("Acme");
  }, 30000);

  it("accepts an include filter as formula source text", async () => {
    const result = await invoicesDb.query!({
      filter: 'v.eq(v.field("type"), "invoice")',
      include: {
        lines: {
          cardinality: "many",
          filter: 'v.eq(v.field("invoiceId"), v.parentDocId())',
          fields: ["amount"],
        },
      },
    });

    expect(many(rowById(result, "inv_1"), "lines")).toHaveLength(2);
  }, 30000);

  it("embeds a shared related document once per parent", async () => {
    const result = await invoicesDb.query!({
      filter: v.eq(v.field("type"), "invoice"),
      include: {
        customer: { db: customersDb, cardinality: "one", localKey: "customerId", fields: ["name"] },
      },
    });

    const first = one(rowById(result, "inv_1"), "customer")!;
    const second = one(rowById(result, "inv_2"), "customer")!;
    expect(first).toEqual(second);
    // Separate objects: nested hydration writes into them, so sharing one
    // instance would leak one parent's nested slots onto another.
    expect(first).not.toBe(second);
  }, 30000);

  it("leaves results of queries without include exactly as they were", async () => {
    const result = await invoicesDb.query!({ filter: v.eq(v.field("type"), "invoice") });

    expect(result.rows[0].includes).toBeUndefined();
    expect(Object.keys(result.rows[0]).sort()).toEqual(["docId", "fields", "lastModified"]);
  }, 30000);

  it("allows slot names that collide with row properties", async () => {
    // Slots live in their own object, so there is no reserved-name list.
    const result = await invoicesDb.query!({
      filter: v.eq(v.field("type"), "invoice"),
      fields: ["total"],
      include: {
        fields: { cardinality: "one", db: customersDb, localKey: "customerId", fields: ["name"] },
        docId: { cardinality: "many", filter: v.eq(v.field("invoiceId"), v.parentDocId()) },
      },
    });

    const row = rowById(result, "inv_1");
    expect(row.fields).toEqual({ total: 120 });
    expect(row.docId).toBe("inv_1");
    expect(one(row, "fields")!.fields.name).toBe("Acme");
    expect(many(row, "docId")).toHaveLength(2);
  }, 30000);

  it("drops deleted children from the parent's list", async () => {
    const query = {
      filter: v.eq(v.field("type"), "invoice"),
      include: {
        lines: {
          cardinality: "many" as const,
          filter: v.eq(v.field("invoiceId"), v.parentDocId()),
        },
      },
    };

    expect(many(rowById(await invoicesDb.query!(query), "inv_1"), "lines")).toHaveLength(2);

    await invoicesDb.deleteDocument("line_b");

    expect(many(rowById(await invoicesDb.query!(query), "inv_1"), "lines").map((l) => l.docId)).toEqual([
      "line_a",
    ]);
  }, 30000);

  it("joins a database of another tenant", async () => {
    const otherCtx = await createWitnessingTenant("test-tenant-include-other");
    const otherDb = await otherCtx.tenant.openDB("external-customers");
    await create(otherDb, "c_9", { type: "customer", name: "External Acme" });

    const result = await invoicesDb.query!({
      filter: v.eq(v.field("type"), "invoice"),
      include: {
        customer: { db: otherDb, cardinality: "one", localKey: "customerId", fields: ["name"] },
      },
    });

    expect(one(rowById(result, "inv_1"), "customer")!.fields.name).toBe("External Acme");
  }, 30000);

  it("reports full coverage when every involved summary is current", async () => {
    const result = await invoicesDb.query!({
      filter: v.eq(v.field("type"), "invoice"),
      include: {
        customer: { db: customersDb, cardinality: "one", localKey: "customerId" },
      },
    });

    expect(result.coverage).toBe("full");
  }, 30000);

  it("propagates a rebuilding child summary to the root result", async () => {
    // A stub is the only deterministic way to observe a half-built child
    // summary; the real one finishes its backfill inside update().
    const rebuildingDb = {
      getTenant: () => ({ getId: () => "stub-tenant" }),
      getStore: () => ({ getId: () => "stub-store" }),
      getSummaryStore: () => ({
        update: async () => undefined,
        getCoverage: () => "rebuilding" as const,
        isFieldCovered: () => true,
        getAllEntries: () => [][Symbol.iterator](),
      }),
    } as unknown as MindooDB;

    const result = await invoicesDb.query!({
      filter: v.eq(v.field("type"), "invoice"),
      include: {
        customer: { db: rebuildingDb, cardinality: "one", localKey: "customerId" },
      },
    });

    expect(result.coverage).toBe("rebuilding");
    expect(one(rowById(result, "inv_1"), "customer")).toBeNull();
  }, 30000);

  // ---------------------------------------------------------------------------
  // Cardinality and validation
  // ---------------------------------------------------------------------------

  it("rejects an include without a cardinality", async () => {
    await expect(
      invoicesDb.query!({
        include: { customer: { localKey: "customerId" } as never },
      })
    ).rejects.toThrow(/cardinality/);
  }, 30000);

  it("rejects an include that relates to nothing", async () => {
    await expect(
      invoicesDb.query!({
        include: { customer: { cardinality: "one" } },
      })
    ).rejects.toThrow(/localKey or a filter/);
  }, 30000);

  it("rejects an empty slot name", async () => {
    await expect(
      invoicesDb.query!({
        include: { "  ": { cardinality: "one", localKey: "customerId" } },
      })
    ).rejects.toThrow(/must not be empty/);
  }, 30000);

  it('fails a "one" include that matches several documents', async () => {
    const promise = invoicesDb.query!({
      filter: v.eq(v.field("type"), "invoice"),
      include: {
        line: {
          cardinality: "one",
          filter: v.eq(v.field("invoiceId"), v.parentDocId()),
        },
      },
    });

    await expect(promise).rejects.toThrow(MindooQueryError);
    // The message has to name both the slot and the offending parent.
    await expect(promise).rejects.toThrow(/"line"/);
    await expect(promise).rejects.toThrow(/inv_1/);
  }, 30000);

  it('rejects sortBy and limit on a "one" include', async () => {
    await expect(
      invoicesDb.query!({
        include: {
          customer: {
            cardinality: "one",
            localKey: "customerId",
            sortBy: [{ field: "name" }],
          },
        },
      })
    ).rejects.toThrow(/sortBy is meaningless/);

    await expect(
      invoicesDb.query!({
        include: { customer: { cardinality: "one", localKey: "customerId", limit: 5 } },
      })
    ).rejects.toThrow(/limit is meaningless/);
  }, 30000);

  it("rejects textScore sorting on an include", async () => {
    await expect(
      invoicesDb.query!({
        include: {
          lines: {
            cardinality: "many",
            localKey: "customerId",
            sortBy: [{ special: "textScore", direction: "descending" }],
          },
        },
      })
    ).rejects.toThrow(/textScore/);
  }, 30000);

  it("rejects sorting an include by a parent expression", async () => {
    await expect(
      invoicesDb.query!({
        include: {
          lines: {
            cardinality: "many",
            localKey: "customerId",
            sortBy: [{ expression: v.parent("total"), direction: "ascending" }],
          },
        },
      })
    ).rejects.toThrow(/related documents only/);
  }, 30000);

  it("rejects a target database without a summary buffer", async () => {
    const noSummaryDb = { getTenant: () => ({ getId: () => "x" }) } as unknown as MindooDB;

    await expect(
      invoicesDb.query!({
        include: { customer: { db: noSummaryDb, cardinality: "one", localKey: "customerId" } },
      })
    ).rejects.toThrow(MindooQueryError);
    await expect(
      invoicesDb.query!({
        include: { customer: { db: noSummaryDb, cardinality: "one", localKey: "customerId" } },
      })
    ).rejects.toThrow(/without a summary buffer/);
  }, 30000);

  it("rejects v.parent() outside an include filter", async () => {
    await expect(
      invoicesDb.query!({ filter: v.eq(v.field("customerId"), v.parentDocId()) })
    ).rejects.toThrow(/v\.parent\(\)/);

    await expect(
      invoicesDb.query!({ sortBy: [{ expression: v.parent("total"), direction: "ascending" }] })
    ).rejects.toThrow(/v\.parent\(\)/);
  }, 30000);

  it("rejects an unknown expression node in an include filter", async () => {
    const typo = { kind: "feild", path: "invoiceId" } as unknown as MindooDBAppBooleanExpression;

    await expect(
      invoicesDb.query!({
        include: { lines: { cardinality: "many", filter: typo } },
      })
    ).rejects.toThrow(/feild/);
  }, 30000);

  it("rejects include filters that are not reducible to a join key", async () => {
    const nonJoinable: MindooDBAppBooleanExpression[] = [
      // Range comparison against a parent value.
      v.gt(v.field("amount"), v.parent("total")),
      // Parent terms spread across an or.
      v.or(
        v.eq(v.field("invoiceId"), v.parentDocId()),
        v.eq(v.field("customerId"), v.parent("customerId")),
      ),
      // Two independent parent equalities.
      v.and(
        v.eq(v.field("invoiceId"), v.parentDocId()),
        v.eq(v.field("customerId"), v.parent("customerId")),
      ),
      // No parent reference at all: nothing ties the children to a parent.
      v.eq(v.field("type"), "line"),
    ];

    for (const filter of nonJoinable) {
      const promise = invoicesDb.query!({
        filter: v.eq(v.field("type"), "invoice"),
        include: { lines: { cardinality: "many", filter } },
      });
      await expect(promise).rejects.toThrow(MindooQueryError);
      await expect(promise).rejects.toThrow(/"lines"/);
    }
  }, 30000);

  it("accepts the joinable filter shapes", async () => {
    const swapped = await invoicesDb.query!({
      filter: v.eq(v.field("type"), "invoice"),
      include: {
        lines: { cardinality: "many", filter: v.eq(v.parentDocId(), v.field("invoiceId")) },
      },
    });
    expect(many(rowById(swapped, "inv_1"), "lines")).toHaveLength(2);

    const withResidual = await invoicesDb.query!({
      filter: v.eq(v.field("type"), "invoice"),
      include: {
        lines: {
          cardinality: "many",
          filter: v.and(
            v.eq(v.field("invoiceId"), v.parentDocId()),
            v.eq(v.field("status"), "open"),
          ),
        },
      },
    });
    expect(many(rowById(withResidual, "inv_1"), "lines").map((l) => l.docId)).toEqual(["line_a"]);
  }, 30000);

  it("rejects combining localKey with a second parent condition", async () => {
    await expect(
      invoicesDb.query!({
        include: {
          customer: {
            db: customersDb,
            cardinality: "one",
            localKey: "customerId",
            filter: v.eq(v.field("name"), v.parent("customerName")),
          },
        },
      })
    ).rejects.toThrow(/localKey/);
  }, 30000);

  it("rejects include fields outside the child summary coverage", async () => {
    customersDb.getSummaryStore!({ exclude: ["active"] });

    await expect(
      invoicesDb.query!({
        filter: v.eq(v.field("type"), "invoice"),
        include: {
          customer: {
            db: customersDb,
            cardinality: "one",
            localKey: "customerId",
            filter: v.eq(v.field("active"), true),
          },
        },
      })
    ).rejects.toThrow(/"active"/);
  }, 30000);

  it("rejects parent fields outside the parent summary coverage", async () => {
    invoicesDb.getSummaryStore!({ exclude: ["secret"] });

    await expect(
      invoicesDb.query!({
        filter: v.eq(v.field("type"), "invoice"),
        include: {
          lines: {
            cardinality: "many",
            filter: v.eq(v.field("invoiceId"), v.parent("secret")),
          },
        },
      })
    ).rejects.toThrow(/parent field "secret"/);
  }, 30000);

  it("accepts three nesting levels and rejects the fourth", async () => {
    const threeLevels = await invoicesDb.query!({
      filter: v.eq(v.field("type"), "invoice"),
      include: {
        lines: {
          cardinality: "many",
          filter: v.eq(v.field("invoiceId"), v.parentDocId()),
          include: {
            product: {
              db: catalogDb,
              cardinality: "one",
              localKey: "productId",
              include: {
                // An id-to-id self join: localKey cannot express this, as it
                // names a parent FIELD holding the child's id.
                self: {
                  cardinality: "one",
                  filter: v.eq(v.docId(), v.parentDocId()),
                  fields: ["title"],
                },
              },
            },
          },
        },
      },
    });
    const product = one(many(rowById(threeLevels, "inv_1"), "lines")[0], "product")!;
    expect(one(product, "self")!.fields.title).toBe("Widget");

    await expect(
      invoicesDb.query!({
        include: {
          lines: {
            cardinality: "many",
            filter: v.eq(v.field("invoiceId"), v.parentDocId()),
            include: {
              product: {
                db: catalogDb,
                cardinality: "one",
                localKey: "productId",
                include: {
                  self: {
                    cardinality: "one",
                    localKey: "docId",
                    include: {
                      deeper: { cardinality: "one", localKey: "docId" },
                    },
                  },
                },
              },
            },
          },
        },
      })
    ).rejects.toThrow(/maximum of 3/);
  }, 30000);

  it("rejects combining allowFullScan with includes", async () => {
    await expect(
      invoicesDb.query!(
        {
          filter: v.eq(v.field("type"), "invoice"),
          include: { customer: { db: customersDb, cardinality: "one", localKey: "customerId" } },
        },
        { allowFullScan: true }
      )
    ).rejects.toThrow(/allowFullScan/);
  }, 30000);

  // ---------------------------------------------------------------------------
  // Live queries
  // ---------------------------------------------------------------------------

  describe("queryLive with includes", () => {
    it("re-fires for changes in every joined database", async () => {
      const results: MindooQueryResult[] = [];
      const subscription = invoicesDb.queryLive!(
        {
          filter: v.eq(v.field("type"), "invoice"),
          include: {
            customer: { db: customersDb, cardinality: "one", localKey: "customerId", fields: ["name"] },
            lines: {
              cardinality: "many",
              filter: v.eq(v.field("invoiceId"), v.parentDocId()),
              fields: ["amount"],
            },
          },
        },
        (result) => {
          results.push(result);
        }
      );

      await waitFor(() => results.length === 1);
      expect(one(rowById(results[0], "inv_1"), "customer")!.fields.name).toBe("Acme");
      expect(many(rowById(results[0], "inv_1"), "lines")).toHaveLength(2);

      // Editing a child of the SAME database: the invoice's own
      // lastModified does not move, so only the nested fingerprint can
      // detect this.
      const line = await invoicesDb.getDocument("line_a");
      await invoicesDb.changeDoc(line, (d) => {
        d.getData().amount = 95;
      });
      await waitFor(() => results.length === 2);
      expect(many(rowById(results[1], "inv_1"), "lines").map((l) => l.fields.amount).sort()).toEqual([
        40, 95,
      ]);

      // Editing a customer on the OTHER database: only reachable through
      // the additional change listener.
      const customer = await customersDb.getDocument("c_9");
      await customersDb.changeDoc(customer, (d) => {
        d.getData().name = "Acme Inc.";
      });
      await waitFor(() => results.length === 3);
      expect(one(rowById(results[2], "inv_1"), "customer")!.fields.name).toBe("Acme Inc.");

      subscription.unsubscribe();
    }, 30000);

    it("stays quiet for children outside the result and stops on unsubscribe", async () => {
      const results: MindooQueryResult[] = [];
      const subscription = invoicesDb.queryLive!(
        {
          filter: v.eq(v.field("type"), "nothing-matches-this"),
          include: {
            lines: { cardinality: "many", filter: v.eq(v.field("invoiceId"), v.parentDocId()) },
          },
        },
        (result) => {
          results.push(result);
        }
      );
      await waitFor(() => results.length === 1);
      expect(results[0].total).toBe(0);

      // A line of an invoice that is not in the result must not push.
      const line = await invoicesDb.getDocument("line_c");
      await invoicesDb.changeDoc(line, (d) => {
        d.getData().amount = 55;
      });
      await flushChangeEvents();
      await flushChangeEvents();
      expect(results).toHaveLength(1);

      subscription.unsubscribe();

      const customer = await customersDb.getDocument("c_9");
      await customersDb.changeDoc(customer, (d) => {
        d.getData().name = "After unsubscribe";
      });
      await flushChangeEvents();
      await flushChangeEvents();
      expect(results).toHaveLength(1);
    }, 30000);
  });
});

/**
 * The rule that keeps an include slot at one scan, in isolation: which
 * filters reduce to a join key and which do not.
 */
describe("extractJoinKey", () => {
  const v = createViewLanguage<Record<string, unknown>>();

  it("extracts the join key in both operand orders", () => {
    const direct = extractJoinKey(v.eq(v.field("invoiceId"), v.parentDocId()));
    expect(direct).toEqual({
      ok: true,
      plan: {
        child: { kind: "field", path: "invoiceId" },
        parent: { kind: "docId" },
        residualFilter: null,
      },
    });

    const swapped = extractJoinKey(v.eq(v.parentDocId(), v.field("invoiceId")));
    expect(swapped.ok && swapped.plan).toMatchObject({
      child: { kind: "field", path: "invoiceId" },
      parent: { kind: "docId" },
    });
  });

  it("extracts an id-to-id join from docId() and parentDocId()", () => {
    // What localKey desugars to when the parent stores the child's id.
    expect(extractJoinKey(v.eq(v.docId(), v.parent("customerId")))).toEqual({
      ok: true,
      plan: {
        child: { kind: "docId" },
        parent: { kind: "field", path: "customerId" },
        residualFilter: null,
      },
    });
  });

  it("keeps parent-free conditions as a residual predicate", () => {
    const extraction = extractJoinKey(
      v.and(
        v.eq(v.field("status"), "open"),
        v.eq(v.field("invoiceId"), v.parentDocId()),
        v.eq(v.field("type"), "line"),
      )
    );

    expect(extraction.ok).toBe(true);
    if (!extraction.ok) {
      return;
    }
    expect(extraction.plan.child).toEqual({ kind: "field", path: "invoiceId" });
    // Both parent-free conjuncts survive, ANDed back together.
    expect(extraction.plan.residualFilter).toEqual({
      kind: "operation",
      op: "and",
      args: [
        { kind: "operation", op: "eq", args: [{ kind: "field", path: "status" }, { kind: "literal", value: "open" }] },
        { kind: "operation", op: "eq", args: [{ kind: "field", path: "type" }, { kind: "literal", value: "line" }] },
      ],
    });
  });

  it("flattens nested and nodes before looking for the join key", () => {
    const extraction = extractJoinKey(
      v.and(
        v.and(v.eq(v.field("invoiceId"), v.parentDocId()), v.eq(v.field("type"), "line")),
        v.eq(v.field("status"), "open"),
      )
    );
    expect(extraction.ok && extraction.plan.parent).toEqual({ kind: "docId" });
  });

  it("refuses everything that is not a single parent equality", () => {
    const missing = extractJoinKey(v.eq(v.field("type"), "line"));
    expect(missing).toMatchObject({ ok: false });
    expect(!missing.ok && missing.reason).toMatch(/does not reference the parent/);

    const twice = extractJoinKey(
      v.and(
        v.eq(v.field("invoiceId"), v.parentDocId()),
        v.eq(v.field("customerId"), v.parent("customerId")),
      )
    );
    expect(!twice.ok && twice.reason).toMatch(/2 separate conditions/);

    const range = extractJoinKey(v.gt(v.field("amount"), v.parent("total")));
    expect(!range.ok && range.reason).toMatch(/not an equality/);

    const disjunction = extractJoinKey(
      v.or(v.eq(v.field("invoiceId"), v.parentDocId()), v.eq(v.field("type"), "line"))
    );
    expect(!disjunction.ok && disjunction.reason).toMatch(/not an equality/);

    const twoParents = extractJoinKey(v.eq(v.parentDocId(), v.parent("customerId")));
    expect(!twoParents.ok && twoParents.reason).toMatch(/One side must read the related document/);
  });
});
