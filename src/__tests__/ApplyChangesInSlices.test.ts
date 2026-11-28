import * as Automerge from "@automerge/automerge";

import { applyChangesInSlices, planChangeSlices } from "../core/applyChangesInSlices";

type Workspace = { apps: Record<string, { profile: string; updatedAt: string }> };

/** `count` changes that each replace the same text with `size` new characters. */
function bigRewrites(size: number, count: number) {
  const base = Automerge.change(Automerge.init<Workspace>(), (doc) => {
    doc.apps = { app: { profile: "", updatedAt: "0" } };
  });
  let doc = Automerge.clone(base);
  for (let i = 0; i < count; i += 1) {
    doc = Automerge.change(doc, (draft) => {
      const text = draft.apps.app.profile;
      Automerge.splice(draft, ["apps", "app", "profile"], 0, text.length, String.fromCharCode(97 + i).repeat(size));
      draft.apps.app.updatedAt = String(i + 1);
    });
  }
  return { base, doc, changes: Automerge.getChanges(base, doc) };
}

// The 16 MB case takes about three minutes under Jest: MINDOODB_HEAVY_TESTS=1 runs it.
const heavy = process.env.MINDOODB_HEAVY_TESTS === "1" ? it : it.skip;

describe("applyChangesInSlices", () => {
  it("bounds a slice by operations as well as by bytes", () => {
    const { base, doc, changes } = bigRewrites(1000, 12);
    // Large byte budget, 2,500 operations: each rewrite (about 2,000 ops) gets its own slice.
    expect(planChangeSlices(changes, 64 * 1024 * 1024, 2500)).toHaveLength(12);
    expect(planChangeSlices(changes, 64 * 1024 * 1024, 100_000)).toHaveLength(1);
    const applied = applyChangesInSlices(Automerge.clone(base), changes, 64 * 1024 * 1024, 2500);
    expect(applied.apps.app.profile).toBe(doc.apps.app.profile);
  });

  it("applies small batches in one go and gives the same document", () => {
    const { base, doc, changes } = bigRewrites(100, 5);
    const applied = applyChangesInSlices(Automerge.clone(base), changes);
    expect(applied.apps.app.profile).toBe(doc.apps.app.profile);
    expect(Automerge.getHeads(applied).sort()).toEqual(Automerge.getHeads(doc).sort());
  });

  it("converges when the changes arrive out of causal order across slices", () => {
    const { base, doc, changes } = bigRewrites(1000, 12);
    const shuffled = [...changes].reverse();
    // 2.5 KB slices: every slice holds about two changes, most without their deps.
    const applied = applyChangesInSlices(Automerge.clone(base), shuffled, 2500);
    expect(applied.apps.app.profile).toBe(doc.apps.app.profile);
    expect(applied.apps.app.updatedAt).toBe("12");
  });

  // Sixteen changes that each rewrite about a megabyte: as one applyChanges
  // batch, Automerge 3.5 panics ("capacity overflow" in Node, out of memory in
  // WebKit) and the module is dead afterwards. Sliced, they load.
  heavy("loads sixteen one-megabyte rewrites that kill a single batch", () => {
    const { base, doc, changes } = bigRewrites(1_000_000, 16);
    const applied = applyChangesInSlices(Automerge.clone(base), changes);
    expect(applied.apps.app.updatedAt).toBe("16");
    expect(applied.apps.app.profile.length).toBe(1_000_000);
    expect(applied.apps.app.profile).toBe(doc.apps.app.profile);
  }, 180_000);
});
