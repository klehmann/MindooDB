/**
 * Admin-key windows in witness time (docs/accesscontrol.md §6.13): the pure
 * rules behind `isAdminAt`, the directory-state chain projection and the
 * builtin directory invariant.
 */
import {
  adminKeySnapshotAt,
  adminKeyWindowFromDoc,
  isAdminKeySnapshotValidAt,
  isRootOnlyDirectoryDocId,
  adminKeyStatusAt,
} from "../core/accesscontrol/adminKeys";
import { DirectoryStateChainBuilder, isAdminInNode } from "../core/accesscontrol/DirectoryStateNode";
import { projectDirectoryRevision } from "../core/accesscontrol/directoryProjection";
import { evaluateBuiltinWrite, shouldSkipLoadedEntry } from "../core/builtinDbInvariants";
import { decodeAdminRequestUri, decodeAdminResponseUri, encodeAdminRequestUri } from "../core/uri/adminUri";

const ROOT = "-----BEGIN PUBLIC KEY-----\nROOT\n-----END PUBLIC KEY-----";
const JANE = "-----BEGIN PUBLIC KEY-----\nJANE\n-----END PUBLIC KEY-----";

function doc(fields: Record<string, unknown> = {}) {
  return { form: "accesscontrol", type: "adminkey", signingPublicKey: JANE, encryptionPublicKey: "enc", ...fields };
}

describe("admin-key windows", () => {
  test("a missing validFrom starts at the revision's witness time", () => {
    const snapshot = adminKeyWindowFromDoc(doc(), 1000)!;
    expect(snapshot.validFrom).toBe(1000);
    expect(isAdminKeySnapshotValidAt(snapshot, 999)).toBe(false);
    expect(isAdminKeySnapshotValidAt(snapshot, 1000)).toBe(true);
    expect(isAdminKeySnapshotValidAt(snapshot, Number.MAX_SAFE_INTEGER - 1)).toBe(true);
  });

  test("validUntil before the deactivating revision is raised to it (no retroactive effect)", () => {
    const active = adminKeyWindowFromDoc(doc(), 1000)!;
    const deactivated = adminKeyWindowFromDoc(doc({ validUntil: 500 }), 2000, active)!;
    expect(deactivated.validUntil).toBe(2000);
    // A deactivation continues the window: the start stays.
    expect(deactivated.validFrom).toBe(1000);
    // Without an active predecessor a past validFrom is clamped the same way.
    expect(adminKeyWindowFromDoc(doc({ validFrom: 100 }), 2000)!.validFrom).toBe(2000);
    // A revision after the end opens a new window (reactivation).
    expect(adminKeyWindowFromDoc(doc(), 3000, deactivated)!.validFrom).toBe(3000);
  });

  test("a future validUntil schedules the end", () => {
    const snapshot = adminKeyWindowFromDoc(doc({ validUntil: 5000 }), 1000)!;
    expect(isAdminKeySnapshotValidAt(snapshot, 4999)).toBe(true);
    expect(isAdminKeySnapshotValidAt(snapshot, 5000)).toBe(false);
    expect(adminKeyStatusAt(snapshot, 3000)).toBe("ending");
    expect(adminKeyStatusAt(snapshot, 6000)).toBe("ended");
  });

  test("the revision in effect at T decides: deactivation, gap, reactivation", () => {
    const revisions = [
      { trustedTime: 1000, data: doc() },
      { trustedTime: 3000, data: doc({ validUntil: 3000 }) },
      { trustedTime: 6000, data: doc({}) },
    ];
    const at = (T: number) => {
      const snapshot = adminKeySnapshotAt(revisions, T);
      return !!snapshot && isAdminKeySnapshotValidAt(snapshot, T);
    };
    expect(at(500)).toBe(false);
    expect(at(2000)).toBe(true);
    expect(at(3500)).toBe(false); // the gap
    expect(at(5999)).toBe(false);
    expect(at(6000)).toBe(true);
    // A deleted document ends the key as well.
    expect(adminKeySnapshotAt([...revisions, { trustedTime: 7000, data: null }], 8000)).toBeNull();
  });

  test("the directory-state chain answers isAdminAt per time", () => {
    const builder = new DirectoryStateChainBuilder();
    const project = (data: Record<string, unknown>, trustedTime: number, deleted = false) =>
      projectDirectoryRevision(builder, {
        docId: "acl_adminkey_x",
        data,
        deleted,
        trustedTime,
        normalizeGroupName: (n) => n.toLowerCase(),
      });
    project(doc(), 1000);
    project(doc({ validUntil: 2500 }), 2000);
    const isAdmin = (T: number) => isAdminInNode(builder.getStateAt(T), ROOT, JANE, T);
    expect(isAdmin(900)).toBe(false);
    expect(isAdmin(1500)).toBe(true);
    expect(isAdmin(2400)).toBe(true);
    expect(isAdmin(2600)).toBe(false);
    // Whitespace in the PEM does not matter; the root is always an admin.
    expect(isAdminInNode(builder.getHead(), ROOT, JANE.replace(/\n/g, ""), 1500)).toBe(true);
    expect(isAdminInNode(builder.getStateAt(0), ROOT, ROOT, 0)).toBe(true);

    // The delta log round-trips.
    const replay = new DirectoryStateChainBuilder();
    replay.importDeltaLog(JSON.parse(JSON.stringify(builder.exportDeltaLog())));
    expect(isAdminInNode(replay.getStateAt(1500), ROOT, JANE, 1500)).toBe(true);
    expect(isAdminInNode(replay.getStateAt(2600), ROOT, JANE, 2600)).toBe(false);
  });

  test("builtin directory invariant: delegated admins write, but not root-only documents", () => {
    const base = { dbId: "directory", op: "doc_change" as const, signerKey: JANE, adminPublicKey: ROOT };
    expect(evaluateBuiltinWrite({ ...base, docId: "acl_rule_x" }).allowed).toBe(false);
    expect(evaluateBuiltinWrite({ ...base, docId: "acl_rule_x", signerIsAdmin: true }).allowed).toBe(true);
    expect(evaluateBuiltinWrite({ ...base, docId: "acl_adminkey_y", signerIsAdmin: true }).allowed).toBe(false);
    expect(evaluateBuiltinWrite({ ...base, docId: "acl_trustedwitness_y", signerIsAdmin: true }).allowed).toBe(false);
    expect(evaluateBuiltinWrite({ ...base, signerKey: ROOT, docId: "acl_adminkey_y" }).allowed).toBe(true);
    expect(isRootOnlyDirectoryDocId("acl_adminkey_1")).toBe(true);
    expect(isRootOnlyDirectoryDocId("acl_rule_1")).toBe(false);

    const load = { dbId: "directory", entryType: "doc_change", signerKey: JANE, adminPublicKey: ROOT };
    expect(shouldSkipLoadedEntry({ ...load, docId: "acl_rule_x" })).toBe(true);
    expect(shouldSkipLoadedEntry({ ...load, docId: "acl_rule_x", signerIsAdmin: true })).toBe(false);
    expect(shouldSkipLoadedEntry({ ...load, docId: "acl_adminkey_x", signerIsAdmin: true })).toBe(true);
  });

  test("admin request and response URIs validate their payload", () => {
    const uri = encodeAdminRequestUri({ v: 1, signingPublicKey: JANE, encryptionPublicKey: "enc", name: " Jane ", tenantId: "t1" });
    expect(uri.startsWith("mdb://admin-request/")).toBe(true);
    expect(decodeAdminRequestUri(uri)).toEqual({ v: 1, signingPublicKey: JANE, encryptionPublicKey: "enc", name: "Jane", tenantId: "t1" });
    expect(() => decodeAdminRequestUri("mdb://join-request/eyJ2IjoxfQ")).toThrow();
    expect(() => decodeAdminResponseUri({ v: 1 } as never)).toThrow(/encryptedDocKeys/);
  });
});
