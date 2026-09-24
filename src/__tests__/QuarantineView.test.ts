/**
 * The two quarantine stores are shaped differently on purpose — inbound is one
 * record per entry, outbound one per document — so the fold that brings them
 * into one list is where that difference has to be resolved rather than papered
 * over.
 */

import {
  inboundQuarantineView,
  mergeQuarantineViews,
  outboundQuarantineView,
} from "../core/quarantine/QuarantineView";
import { MAX_QUARANTINED_ENTRY_IDS } from "../core/quarantine/QuarantineDocument";
import type { QuarantineRecord } from "../core/accesscontrol/materializationGuard";
import type { QuarantineRecordDoc } from "../core/quarantine/QuarantineDocument";

function inbound(overrides: Partial<QuarantineRecord> = {}): QuarantineRecord {
  return {
    entryId: "proj_alpha_d_0_h1",
    docId: "proj_alpha",
    dbid: "projects",
    entryType: "doc_change",
    reason: "tier2_denied",
    detail: "denied by rule crm-no-edit-archived",
    trustedTime: 1000,
    recordedAt: 2000,
    ...overrides,
  };
}

function outbound(overrides: Partial<QuarantineRecordDoc> = {}): QuarantineRecordDoc {
  return {
    docId: "qtn_deadbeef",
    signingPublicKey: "-----BEGIN PUBLIC KEY-----\nAAA\n-----END PUBLIC KEY-----",
    signingKeyFingerprint: "ab:cd",
    dbid: "projects",
    quarantinedDocId: "proj_beta",
    rejectionClass: "policy",
    reason: "denied by Tier 1 policy",
    entryIds: ["proj_beta_d_0_h9"],
    omittedEntryCount: 0,
    firstSeenAt: 3000,
    updatedAt: 4000,
    ...overrides,
  };
}

describe("the unified quarantine view", () => {
  it("folds every entry of one document and reason into a single row", () => {
    const rows = inboundQuarantineView([
      inbound({ entryId: "e1", recordedAt: 2000 }),
      inbound({ entryId: "e2", recordedAt: 2500 }),
      inbound({ entryId: "e3", recordedAt: 1500 }),
    ]);

    // One refused entry usually taints its dependents, so this is the common
    // case: fifty records about one problem should read as one problem.
    expect(rows).toHaveLength(1);
    expect(rows[0].entryIds).toEqual(["e1", "e2", "e3"]);
    expect(rows[0].firstSeenAt).toBe(1500);
    expect(rows[0].updatedAt).toBe(2500);
  });

  it("keeps rows apart when the document or the reason differs", () => {
    const rows = inboundQuarantineView([
      inbound({ entryId: "e1" }),
      inbound({ entryId: "e2", reason: "cascade_dependent" }),
      inbound({ entryId: "e3", docId: "proj_gamma" }),
      inbound({ entryId: "e4", dbid: "other" }),
    ]);
    expect(rows).toHaveLength(4);
  });

  it("caps the entry ids it carries and counts the rest", () => {
    const many = Array.from({ length: MAX_QUARANTINED_ENTRY_IDS + 17 }, (_, i) =>
      inbound({ entryId: `e${i}` }),
    );
    const [row] = inboundQuarantineView(many);

    // The list is for finding the entries again, and this row travels into a UI;
    // an unbounded one buys nothing.
    expect(row.entryIds).toHaveLength(MAX_QUARANTINED_ENTRY_IDS);
    expect(row.omittedEntryCount).toBe(17);
  });

  it("carries the fields only an outbound record has", () => {
    const [row] = outboundQuarantineView([outbound()]);
    expect(row.direction).toBe("outbound");
    expect(row.documentId).toBe("proj_beta");
    expect(row.detail).toBe("denied by Tier 1 policy");
    if (row.direction !== "outbound") throw new Error("unreachable");
    // The record document id is what lets a caller withdraw the record, and the
    // fingerprint is whose push was refused — neither exists inbound.
    expect(row.recordDocId).toBe("qtn_deadbeef");
    expect(row.signingKeyFingerprint).toBe("ab:cd");
  });

  it("does not let an outbound record's own id stand in for the document it is about", () => {
    const [row] = outboundQuarantineView([outbound()]);
    // Confusing the two would point the audit view at the record instead of the
    // missing document.
    expect(row.documentId).not.toBe("qtn_deadbeef");
  });

  it("puts the most recent problem first across both directions", () => {
    const merged = mergeQuarantineViews(
      inboundQuarantineView([inbound({ recordedAt: 5000 })]),
      outboundQuarantineView([
        outbound({ quarantinedDocId: "proj_old", updatedAt: 1000 }),
        outbound({ quarantinedDocId: "proj_new", updatedAt: 9000 }),
      ]),
    );

    // The list is read when a change has gone missing, and that is nearly always
    // the last change someone made.
    expect(merged.map((row) => row.documentId)).toEqual([
      "proj_new",
      "proj_alpha",
      "proj_old",
    ]);
  });

  it("orders deterministically when two rows share a timestamp", () => {
    const merged = mergeQuarantineViews(
      outboundQuarantineView([
        outbound({ quarantinedDocId: "b", updatedAt: 1000 }),
        outbound({ quarantinedDocId: "a", updatedAt: 1000 }),
      ]),
    );
    // Two refusals in the same millisecond is ordinary, and a list that
    // reshuffles itself between reads is a UI that jumps under the cursor.
    expect(merged.map((row) => row.documentId)).toEqual(["a", "b"]);
  });

  it("returns nothing for an empty log", () => {
    expect(mergeQuarantineViews(inboundQuarantineView([]), outboundQuarantineView([]))).toEqual([]);
  });
});
