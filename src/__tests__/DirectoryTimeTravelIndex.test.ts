import {
  DirectoryTimeTravelIndex,
  DIR_TT_CACHE_TYPE,
  ProjectRevisionFn,
  StoredDirectoryRevision,
} from "../core/accesscontrol/DirectoryTimeTravelIndex";
import { projectDirectoryRevision } from "../core/accesscontrol/directoryProjection";
import { ACL_DEFAULT_POLICY_DOC_ID } from "../core/accesscontrol/types";
import { InMemoryLocalCacheStore } from "../core/cache/LocalCacheStore";

/**
 * Disk-cache round-trip and revision-keyed rebuild for the directory
 * time-travel index (docs/accesscontrol.md §8): flushing the stored revisions
 * and restoring + replaying them must reproduce identical time-travel answers (a
 * warm start equals a cold rebuild), out-of-order / superseding revisions must be
 * absorbed by re-sorting on rebuild, and the version guard must invalidate stale
 * layouts.
 */
const project: ProjectRevisionFn = (builder, rev) =>
  projectDirectoryRevision(builder, {
    docId: rev.docId,
    data: rev.data,
    deleted: rev.deleted,
    trustedTime: rev.trustedTime,
    normalizeGroupName: (name) => name.toLowerCase(),
  });

function policyRevision(
  entryId: string,
  denyDocChange: boolean,
  trustedTime: number,
  witnessed = true,
): StoredDirectoryRevision {
  return {
    entryId,
    docId: ACL_DEFAULT_POLICY_DOC_ID,
    data: { form: "accesscontrol", type: "defaultpolicy", denyDocChange },
    deleted: false,
    trustedTime,
    witnessed,
  };
}

function buildIndex(prefix = "tenant/directory"): DirectoryTimeTravelIndex {
  const idx = new DirectoryTimeTravelIndex(prefix);
  idx.upsertRevision(policyRevision("e1", false, 100), { receiptOrder: 1, id: "e1" });
  idx.upsertRevision(policyRevision("e2", true, 200), { receiptOrder: 2, id: "e2" });
  idx.recordChangeSeq(2);
  idx.rebuild(project);
  return idx;
}

describe("DirectoryTimeTravelIndex disk cache", () => {
  it("flush + restore + replay reproduces identical getStateAt answers, cursor, and changeSeq", async () => {
    const store = new InMemoryLocalCacheStore();
    const original = buildIndex();
    expect(original.hasDirtyState()).toBe(true);

    const written = await original.flushToCache(store);
    expect(written).toBe(1);
    original.clearDirty();
    expect(original.hasDirtyState()).toBe(false);

    const restored = new DirectoryTimeTravelIndex("tenant/directory");
    const ok = await restored.restoreFromCache(store);
    expect(ok).toBe(true);
    restored.rebuild(project);

    expect(restored.cursor).toEqual(original.cursor);
    expect(restored.lastChangeSeq).toBe(2);
    expect(restored.hasUnwitnessed()).toBe(false);
    for (const T of [50, 100, 150, 200, 300]) {
      expect(restored.getStateAt(T).defaultPolicy).toEqual(original.getStateAt(T).defaultPolicy);
    }
    // Sanity: time-travel actually distinguishes the two revisions.
    expect(restored.getStateAt(50).defaultPolicy).toBeNull();
    expect(restored.getStateAt(150).defaultPolicy?.denyDocChange).toBe(false);
    expect(restored.getStateAt(300).defaultPolicy?.denyDocChange).toBe(true);
  });

  it("restore reports a miss when nothing was flushed", async () => {
    const store = new InMemoryLocalCacheStore();
    const idx = new DirectoryTimeTravelIndex("tenant/directory");
    expect(await idx.restoreFromCache(store)).toBe(false);
  });

  it("restore rejects a version mismatch (forces a full rebuild)", async () => {
    const store = new InMemoryLocalCacheStore();
    await store.put(
      DIR_TT_CACHE_TYPE,
      "tenant/directory",
      new TextEncoder().encode(
        JSON.stringify({ version: 999, cursor: null, unwitnessedIds: [], revisions: [], lastChangeSeq: null }),
      ),
    );
    const idx = new DirectoryTimeTravelIndex("tenant/directory");
    expect(await idx.restoreFromCache(store)).toBe(false);
  });

  it("absorbs an out-of-trusted-time-order insert by re-sorting on rebuild", () => {
    const idx = buildIndex();
    // A late-arriving revision with an earlier trusted time inserts mid-history.
    idx.upsertRevision(policyRevision("e3", true, 150), { receiptOrder: 3, id: "e3" });
    idx.rebuild(project);

    // Before e1: nothing. [100,150): e1 (false). [150,200): e3 (true). >=200: e2 (true).
    expect(idx.getStateAt(50).defaultPolicy).toBeNull();
    expect(idx.getStateAt(120).defaultPolicy?.denyDocChange).toBe(false);
    expect(idx.getStateAt(150).defaultPolicy?.denyDocChange).toBe(true);
    expect(idx.getStateAt(300).defaultPolicy?.denyDocChange).toBe(true);
  });

  it("supersedes a revision in place when re-emitted for the same entry id", () => {
    const idx = buildIndex();
    // Re-emit e1 with new content + a later (re-stamped) trusted time.
    idx.upsertRevision(policyRevision("e1", true, 250), { receiptOrder: 4, id: "e1" });
    idx.rebuild(project);

    // e1 no longer sits at 100; only e2 (200) remains before 250, then e1 (250).
    expect(idx.getStateAt(120).defaultPolicy).toBeNull();
    expect(idx.getStateAt(200).defaultPolicy?.denyDocChange).toBe(true);
    expect(idx.getStateAt(250).defaultPolicy?.denyDocChange).toBe(true);
  });

  it("tracks un-witnessed revisions and clears them on witness or reset", () => {
    const idx = new DirectoryTimeTravelIndex("tenant/directory");
    idx.upsertRevision(policyRevision("local1", false, 100, false), { receiptOrder: 0, id: "local1" });
    expect(idx.hasUnwitnessed()).toBe(true);

    // A later witnessed record of the same id clears the un-witnessed flag.
    idx.upsertRevision(policyRevision("local1", false, 150, true), { receiptOrder: 1, id: "local1" });
    expect(idx.hasUnwitnessed()).toBe(false);

    // reset() clears all state for a from-scratch rebuild.
    idx.upsertRevision(policyRevision("local2", false, 100, false), { receiptOrder: 2, id: "local2" });
    expect(idx.hasUnwitnessed()).toBe(true);
    idx.reset();
    expect(idx.hasUnwitnessed()).toBe(false);
    expect(idx.cursor).toBeNull();
    expect(idx.lastChangeSeq).toBeNull();
  });
});
