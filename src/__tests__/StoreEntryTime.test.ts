import { entryTrustedTime, isProvisional } from "../core/storeEntryTime";
import { CURRENT_STORE_ENTRY_VERSION, StoreEntryMetadata } from "../core/types";

/**
 * Unit coverage for the shared version-aware trusted-time helpers
 * (docs/accesscontrol.md §8). These are the single source of truth used by the
 * changefeed, document materialization, and the access-control judgment site,
 * so the three-way rule (witnessed / versioned-unwitnessed / legacy-unwitnessed)
 * is pinned down here once.
 */

function meta(overrides: Partial<StoreEntryMetadata>): StoreEntryMetadata {
  return {
    entryType: "doc_create",
    id: "doc1_d_x_y",
    contentHash: "hash",
    docId: "doc1",
    dependencyIds: [],
    createdAt: 1_000,
    createdByPublicKey: "pk",
    decryptionKeyId: "default",
    signature: new Uint8Array(),
    originalSize: 0,
    encryptedSize: 0,
    ...overrides,
  };
}

describe("isProvisional", () => {
  it("is false for a witnessed entry (receivedAt present), versioned or not", () => {
    expect(isProvisional(meta({ receivedAt: 500, entryVersion: CURRENT_STORE_ENTRY_VERSION }))).toBe(false);
    expect(isProvisional(meta({ receivedAt: 500, entryVersion: undefined }))).toBe(false);
  });

  it("is false for a legacy un-witnessed entry (no entryVersion)", () => {
    expect(isProvisional(meta({ receivedAt: undefined, entryVersion: undefined }))).toBe(false);
  });

  it("is true for a versioned un-witnessed entry (waiting to be pushed)", () => {
    expect(isProvisional(meta({ receivedAt: undefined, entryVersion: CURRENT_STORE_ENTRY_VERSION }))).toBe(true);
  });
});

describe("entryTrustedTime", () => {
  const now = 9_000;

  it("uses receivedAt for a witnessed entry, ignoring now and createdAt", () => {
    expect(entryTrustedTime(meta({ receivedAt: 500, createdAt: 1_000 }), now)).toBe(500);
    expect(
      entryTrustedTime(meta({ receivedAt: 500, createdAt: 1_000, entryVersion: CURRENT_STORE_ENTRY_VERSION }), now),
    ).toBe(500);
  });

  it("uses createdAt for a legacy un-witnessed entry (stable historical slot)", () => {
    expect(entryTrustedTime(meta({ receivedAt: undefined, entryVersion: undefined, createdAt: 1_000 }), now)).toBe(
      1_000,
    );
  });

  it("uses now for a versioned un-witnessed entry (provisional head)", () => {
    expect(
      entryTrustedTime(meta({ receivedAt: undefined, entryVersion: CURRENT_STORE_ENTRY_VERSION, createdAt: 1_000 }), now),
    ).toBe(now);
  });
});
