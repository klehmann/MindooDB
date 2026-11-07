import { createsFirst } from "../core/appendonlystores/syncStores";

/** Purge requests go last in a sync page (docs/accesscontrol.md §6.11). */
describe("createsFirst", () => {
  it("keeps creates first and puts purge requests in a last phase of their own", () => {
    const entries = [
      { id: "a_d_1", entryType: "doc_create" },
      { id: "a_d_2", entryType: "doc_delete" },
      { id: "purgereq_x_d_0", entryType: "doc_create" },
      { id: "b_d_1", entryType: "doc_create" },
    ];
    expect(createsFirst(entries, entries.map((e) => e.id))).toEqual([["a_d_1", "b_d_1"], ["a_d_2"], ["purgereq_x_d_0"]]);
  });

  it("is unchanged without purge requests", () => {
    const entries = [
      { id: "a_d_1", entryType: "doc_create" },
      { id: "a_d_2", entryType: "doc_change" },
    ];
    expect(createsFirst(entries, ["a_d_1", "a_d_2"])).toEqual([["a_d_1"], ["a_d_2"]]);
    expect(createsFirst([{ id: "c", entryType: "doc_change" }], ["c"])).toEqual([["c"]]);
  });
});
