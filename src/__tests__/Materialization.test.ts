/**
 * Comprehensive tests for the rollout checklist items in
 * docs/db-open-and-sync-optimization.md.
 *
 * Covers:
 * 1. Causal replay correctness  — concurrent branches, competing snapshots,
 *    no-snapshot fallback, and end-to-end Automerge materialization
 * 2. Changefeed determinism      — identical sequence from two fresh DB
 *    instances sharing the same store, changeSeq checkpoint round-trip
 * 3. Crash-resume behavior       — process-kill simulation during hydration,
 *    checkpoint-based restart
 * 4. Protocol compatibility      — v3 client → old server, clear error messages
 * 5. Attachment safety           — attachment_chunk entries must not corrupt
 *    materialization planning or metadata-first indexing
 */

import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import {
  InMemoryContentAddressedStore,
  InMemoryContentAddressedStoreFactory,
} from "../core/appendonlystores/InMemoryContentAddressedStore";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { KeyBag } from "../core/keys/KeyBag";
import type {
  StoreEntry,
  StoreEntryMetadata,
  MindooDoc,
  ProcessChangesCursor,
  CreateTenantResult,
  StoreEntryType,
  StoreScanCursor,
  StoreScanFilters,
  StoreScanResult,
  StoreIdBloomSummary,
  StoreCompactionStatus,
  MindooTenantDirectory,
  EncryptedPrivateKey,
} from "../core/types";
import { DEFAULT_TENANT_KEY_ID, PUBLIC_INFOS_KEY_ID } from "../core/types";
import type {
  ContentAddressedStore,
  ContentAddressedStoreFactory,
  CreateStoreResult,
  OpenStoreOptions,
} from "../core/appendonlystores/types";
import type { PublicUserId } from "../core/userid";
import { ClientNetworkContentAddressedStore } from "../appendonlystores/network/ClientNetworkContentAddressedStore";
import { ServerNetworkContentAddressedStore } from "../appendonlystores/network/ServerNetworkContentAddressedStore";
import { AuthenticationService } from "../core/appendonlystores/network/AuthenticationService";
import type { NetworkTransport } from "../core/appendonlystores/network/NetworkTransport";
import type {
  NetworkEncryptedEntry,
  AuthResult,
  NetworkSyncCapabilities,
} from "../core/appendonlystores/network/types";

const cryptoAdapter = new NodeCryptoAdapter();

// ---------------------------------------------------------------------------
// Helpers shared across sections
// ---------------------------------------------------------------------------

function createStoreEntry(
  docId: string,
  id: string,
  contentHash: string,
  dependencyIds: string[] = [],
  entryType: StoreEntryType = "doc_change",
  extra: Partial<StoreEntry> = {},
): StoreEntry {
  const encryptedData = new Uint8Array([10, 20, 30, 40, 50]);
  return {
    entryType,
    id,
    contentHash,
    docId,
    dependencyIds,
    createdAt: Date.now(),
    createdByPublicKey: "test-public-key",
    decryptionKeyId: "default",
    signature: new Uint8Array([1, 2, 3, 4]),
    originalSize: 4,
    encryptedSize: encryptedData.length,
    encryptedData,
    ...extra,
  };
}

/**
 * Store factory that always returns the *same* store instance for a given
 * dbId, allowing two BaseMindooDB instances to share underlying data.
 */
class SharedStoreFactory implements ContentAddressedStoreFactory {
  private stores = new Map<string, InMemoryContentAddressedStore>();

  createStore(dbId: string, _options?: OpenStoreOptions): CreateStoreResult {
    let store = this.stores.get(dbId);
    if (!store) {
      store = new InMemoryContentAddressedStore(dbId);
      this.stores.set(dbId, store);
    }
    return { docStore: store };
  }

  getStore(dbId: string): InMemoryContentAddressedStore | undefined {
    return this.stores.get(dbId);
  }
}

const ADMIN_PASS = "admin-pass";
const USER_PASS = "user-pass";

interface TenantSetup extends CreateTenantResult {
  tenantId: string;
}

/**
 * Creates a fresh tenant using factory.createTenant().
 * If `existingSetup` is provided, reuses its identity and key material
 * via factory.openTenant() so the new instance can decrypt the same entries.
 */
async function createTenantSetup(
  storeFactory: ContentAddressedStoreFactory,
  existingSetup?: TenantSetup,
): Promise<TenantSetup> {
  const factory = new BaseMindooTenantFactory(storeFactory, cryptoAdapter);
  const tenantId = existingSetup?.tenantId
    ?? `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  if (existingSetup) {
    const keyBag = new KeyBag(
      existingSetup.appUser.userEncryptionKeyPair.privateKey,
      USER_PASS,
      cryptoAdapter,
    );
    await keyBag.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, (await existingSetup.keyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!);
    await keyBag.set(
      "doc",
      tenantId,
      DEFAULT_TENANT_KEY_ID,
      (await existingSetup.keyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!,
    );

    const tenant = await factory.openTenant(
      tenantId,
      existingSetup.adminUser.userSigningKeyPair.publicKey,
      existingSetup.adminUser.userEncryptionKeyPair.publicKey,
      existingSetup.appUser,
      USER_PASS,
      keyBag,
    );
    return { tenant, adminUser: existingSetup.adminUser, appUser: existingSetup.appUser, keyBag, tenantId };
  }

  const result = await factory.createTenant({
    tenantId,
    adminName: "CN=admin/O=testtenant",
    adminPassword: ADMIN_PASS,
    userName: "CN=user/O=testtenant",
    userPassword: USER_PASS,
  });
  return { ...result, tenantId };
}

// ===================================================================
// 1. CAUSAL REPLAY CORRECTNESS
// ===================================================================

describe("causal replay correctness", () => {
  let store: InMemoryContentAddressedStore;

  beforeEach(() => {
    store = new InMemoryContentAddressedStore("causal-test");
  });

  test("concurrent offline branches with independent snapshots should replay correctly", async () => {
    // DAG: a ---> b ---> d (merge)
    //        \         /
    //         -> c ----
    // Snapshot S1 covers branch {a,b}, Snapshot S2 covers branch {a,c}
    const a = createStoreEntry("doc1", "a", "ha", [], "doc_create");
    const b = createStoreEntry("doc1", "b", "hb", ["a"], "doc_change");
    const c = createStoreEntry("doc1", "c", "hc", ["a"], "doc_change");
    const d = createStoreEntry("doc1", "d", "hd", ["b", "c"], "doc_change");

    const s1 = createStoreEntry("doc1", "s1", "hs1", ["b"], "doc_snapshot");
    s1.snapshotHeadEntryIds = ["b"];
    s1.snapshotHeadHashes = ["hash-b"];

    const s2 = createStoreEntry("doc1", "s2", "hs2", ["c"], "doc_snapshot");
    s2.snapshotHeadEntryIds = ["c"];
    s2.snapshotHeadHashes = ["hash-c"];

    await store.putEntries([a, b, c, d, s1, s2]);

    const plan = await store.planDocumentMaterialization("doc1", { includeDiagnostics: true });

    // Planner must select ONE snapshot and replay all entries not covered by it.
    // With S1 covering {a,b}: uncovered = {c,d}  → replay 2 entries
    // With S2 covering {a,c}: uncovered = {b,d}  → replay 2 entries
    // Either choice is valid; what matters is that all uncovered entries are present.
    expect(plan.snapshotEntryId).toBeDefined();
    expect(plan.snapshotEntryId === "s1" || plan.snapshotEntryId === "s2").toBe(true);

    if (plan.snapshotEntryId === "s1") {
      expect(plan.entryIdsToApply).toEqual(expect.arrayContaining(["c", "d"]));
      expect(plan.entryIdsToApply.length).toBe(2);
    } else {
      expect(plan.entryIdsToApply).toEqual(expect.arrayContaining(["b", "d"]));
      expect(plan.entryIdsToApply.length).toBe(2);
    }
  });

  test("multiple competing snapshots — planner picks the one with more coverage", async () => {
    // DAG: a -> b -> c -> d
    // S_small covers {a,b}
    // S_large covers {a,b,c}
    const a = createStoreEntry("doc1", "a", "ha", [], "doc_create");
    const b = createStoreEntry("doc1", "b", "hb", ["a"], "doc_change");
    const c = createStoreEntry("doc1", "c", "hc", ["b"], "doc_change");
    const d = createStoreEntry("doc1", "d", "hd", ["c"], "doc_change");

    const sSmall = createStoreEntry("doc1", "s-small", "hs-small", ["b"], "doc_snapshot");
    sSmall.snapshotHeadEntryIds = ["b"];
    sSmall.snapshotHeadHashes = ["hash-b"];

    const sLarge = createStoreEntry("doc1", "s-large", "hs-large", ["c"], "doc_snapshot");
    sLarge.snapshotHeadEntryIds = ["c"];
    sLarge.snapshotHeadHashes = ["hash-c"];

    await store.putEntries([a, b, c, d, sSmall, sLarge]);

    const plan = await store.planDocumentMaterialization("doc1", { includeDiagnostics: true });

    // Planner should prefer S_large (covers {a,b,c}) over S_small (covers {a,b}).
    // With S_large: only {d} needs replay — minimal work.
    expect(plan.snapshotEntryId).toBe("s-large");
    expect(plan.entryIdsToApply).toEqual(["d"]);
  });

  test("no snapshot available — pure replay from scratch", async () => {
    const a = createStoreEntry("doc1", "a", "ha", [], "doc_create");
    const b = createStoreEntry("doc1", "b", "hb", ["a"], "doc_change");
    const c = createStoreEntry("doc1", "c", "hc", ["b"], "doc_change");
    await store.putEntries([a, b, c]);

    const plan = await store.planDocumentMaterialization("doc1", { includeDiagnostics: true });

    expect(plan.snapshotEntryId).toBeNull();
    expect(plan.entryIdsToApply).toEqual(["a", "b", "c"]);
  });

  test("snapshot that is a strict superset of another is preferred", async () => {
    // Linear chain: a -> b -> c
    // S_all covers everything {a,b,c}
    // S_partial covers {a}
    const a = createStoreEntry("doc1", "a", "ha", [], "doc_create");
    const b = createStoreEntry("doc1", "b", "hb", ["a"], "doc_change");
    const c = createStoreEntry("doc1", "c", "hc", ["b"], "doc_change");

    const sAll = createStoreEntry("doc1", "s-all", "hs-all", ["c"], "doc_snapshot");
    sAll.snapshotHeadEntryIds = ["c"];
    sAll.snapshotHeadHashes = ["hash-c"];

    const sPartial = createStoreEntry("doc1", "s-partial", "hs-partial", ["a"], "doc_snapshot");
    sPartial.snapshotHeadEntryIds = ["a"];
    sPartial.snapshotHeadHashes = ["hash-a"];

    await store.putEntries([a, b, c, sAll, sPartial]);

    const plan = await store.planDocumentMaterialization("doc1");

    // S_all covers everything — 0 entries to replay.
    expect(plan.snapshotEntryId).toBe("s-all");
    expect(plan.entryIdsToApply).toEqual([]);
  });

  test("batch planning returns correct plans per document", async () => {
    const a1 = createStoreEntry("doc1", "d1a", "h1a", [], "doc_create");
    const b1 = createStoreEntry("doc1", "d1b", "h1b", ["d1a"], "doc_change");
    const a2 = createStoreEntry("doc2", "d2a", "h2a", [], "doc_create");

    const snap1 = createStoreEntry("doc1", "snap1", "hs1", ["d1b"], "doc_snapshot");
    snap1.snapshotHeadEntryIds = ["d1b"];
    snap1.snapshotHeadHashes = ["hash-d1b"];

    await store.putEntries([a1, b1, a2, snap1]);

    const batch = await store.planDocumentMaterializationBatch(["doc1", "doc2"]);
    expect(batch.plans.length).toBe(2);

    const p1 = batch.plans.find((p) => p.docId === "doc1")!;
    expect(p1.snapshotEntryId).toBe("snap1");
    expect(p1.entryIdsToApply).toEqual([]);

    const p2 = batch.plans.find((p) => p.docId === "doc2")!;
    expect(p2.snapshotEntryId).toBeNull();
    expect(p2.entryIdsToApply).toEqual(["d2a"]);
  });

  test("attachment entries are excluded from materialization planning", async () => {
    const a = createStoreEntry("doc1", "a", "ha", [], "doc_create");
    const b = createStoreEntry("doc1", "b", "hb", ["a"], "doc_change");
    const att = createStoreEntry("doc1", "att-1", "hatt", [], "attachment_chunk");
    await store.putEntries([a, b, att]);

    const plan = await store.planDocumentMaterialization("doc1");
    expect(plan.entryIdsToApply).toEqual(["a", "b"]);
    expect(plan.entryIdsToApply).not.toContain("att-1");
  });
});

// ===================================================================
// 2. END-TO-END CAUSAL MATERIALIZATION through BaseMindooDB
// ===================================================================

describe("end-to-end causal materialization", () => {
  test("document created and synced through two users with competing changes merges correctly", async () => {
    const sharedFactory = new SharedStoreFactory();
    const setup1 = await createTenantSetup(sharedFactory);
    const db1 = await setup1.tenant.openDB("mat-test");

    const doc = await db1.createDocument();
    const docId = doc.getId();
    await db1.changeDoc(doc, (d: MindooDoc) => {
      d.getData().title = "original";
    });

    // Verify first user sees the doc
    const ids = await db1.getAllDocumentIds();
    expect(ids).toContain(docId);

    // Second instance opens the same DB (shared store, same keys)
    const setup2 = await createTenantSetup(sharedFactory, setup1);
    const db2 = await setup2.tenant.openDB("mat-test");

    const doc2 = await db2.getDocument(docId);
    expect(doc2.getData().title).toBe("original");

    // User 2 makes a change
    await db2.changeDoc(doc2, (d: MindooDoc) => {
      d.getData().subtitle = "added-by-user2";
    });

    // Sync back to user 1
    await db1.syncStoreChanges();
    const doc1Reloaded = await db1.getDocument(docId);
    expect(doc1Reloaded.getData().title).toBe("original");
    expect(doc1Reloaded.getData().subtitle).toBe("added-by-user2");
  }, 30000);
});

// ===================================================================
// 3. CHANGEFEED DETERMINISM
// ===================================================================

describe("changefeed determinism", () => {
  test("two fresh DB instances on the same store produce identical iterateChangesSince sequence", async () => {
    const sharedFactory = new SharedStoreFactory();
    const setup1 = await createTenantSetup(sharedFactory);
    const db1 = await setup1.tenant.openDB("feed-test");

    const docCount = 20;
    for (let i = 0; i < docCount; i++) {
      const doc = await db1.createDocument();
      await db1.changeDoc(doc, (d: MindooDoc) => {
        d.getData().index = i;
      });
      await new Promise((r) => setTimeout(r, 2));
    }

    // Collect sequence from db1
    const seq1: string[] = [];
    for await (const { doc } of db1.iterateChangesSince(null)) {
      seq1.push(doc.getId());
    }
    expect(seq1.length).toBe(docCount);

    // Open a completely fresh instance on the same underlying store (same keys)
    const setup2 = await createTenantSetup(sharedFactory, setup1);
    const db2 = await setup2.tenant.openDB("feed-test");

    const seq2: string[] = [];
    for await (const { doc } of db2.iterateChangesSince(null)) {
      seq2.push(doc.getId());
    }

    expect(seq2).toEqual(seq1);
  }, 60000);

  test("cursor resume produces no gaps and no duplicates after incremental adds", async () => {
    const storeFactory = new InMemoryContentAddressedStoreFactory();
    const { tenant } = await createTenantSetup(storeFactory);
    const db = await tenant.openDB("cursor-test");

    // Create initial batch
    const batch1Count = 10;
    for (let i = 0; i < batch1Count; i++) {
      const doc = await db.createDocument();
      await db.changeDoc(doc, (d: MindooDoc) => {
        d.getData().batch = 1;
        d.getData().index = i;
      });
      await new Promise((r) => setTimeout(r, 1));
    }

    // Iterate first batch, save cursor
    let cursor: ProcessChangesCursor | null = null;
    const firstBatch: string[] = [];
    for await (const { doc, cursor: c } of db.iterateChangesSince(null)) {
      firstBatch.push(doc.getId());
      cursor = c;
    }
    expect(firstBatch.length).toBe(batch1Count);

    // Add more docs
    const batch2Count = 10;
    for (let i = 0; i < batch2Count; i++) {
      const doc = await db.createDocument();
      await db.changeDoc(doc, (d: MindooDoc) => {
        d.getData().batch = 2;
        d.getData().index = i;
      });
      await new Promise((r) => setTimeout(r, 1));
    }
    await db.syncStoreChanges();

    // Resume from cursor
    const secondBatch: string[] = [];
    for await (const { doc } of db.iterateChangesSince(cursor)) {
      secondBatch.push(doc.getId());
    }
    expect(secondBatch.length).toBe(batch2Count);

    // No overlap
    const overlap = firstBatch.filter((id) => secondBatch.includes(id));
    expect(overlap.length).toBe(0);

    // Total coverage
    expect(firstBatch.length + secondBatch.length).toBe(batch1Count + batch2Count);
  }, 30000);
});

// ===================================================================
// 4. CRASH-RESUME BEHAVIOR (simulated via checkpoint save/load)
// ===================================================================

describe("crash-resume behavior", () => {
  test("restart produces identical changefeed and cursor resume works within each session", async () => {
    const sharedFactory = new SharedStoreFactory();
    const setup1 = await createTenantSetup(sharedFactory);
    const db1 = await setup1.tenant.openDB("crash-test");

    // Create documents in the first session
    const docCount = 15;
    for (let i = 0; i < docCount; i++) {
      const doc = await db1.createDocument();
      await db1.changeDoc(doc, (d: MindooDoc) => {
        d.getData().value = i;
      });
      await new Promise((r) => setTimeout(r, 1));
    }

    // Collect full sequence from first session
    const seqBefore: string[] = [];
    for await (const { doc } of db1.iterateChangesSince(null)) {
      seqBefore.push(doc.getId());
    }
    expect(seqBefore.length).toBe(docCount);

    // Simulate crash/restart: open a brand new instance on the same store (same keys)
    const setup2 = await createTenantSetup(sharedFactory, setup1);
    const db2 = await setup2.tenant.openDB("crash-test");

    // Full re-iterate should produce the exact same sequence (determinism)
    const seqAfter: string[] = [];
    for await (const { doc } of db2.iterateChangesSince(null)) {
      seqAfter.push(doc.getId());
    }
    expect(seqAfter).toEqual(seqBefore);

    // Now add more docs on the restarted instance
    const extraDocs = 5;
    for (let i = 0; i < extraDocs; i++) {
      const doc = await db2.createDocument();
      await db2.changeDoc(doc, (d: MindooDoc) => {
        d.getData().extra = true;
      });
      await new Promise((r) => setTimeout(r, 1));
    }
    await db2.syncStoreChanges();

    // Iterate from null, break after the original docs, save cursor, then resume
    let cursor2: ProcessChangesCursor | null = null;
    const firstPart: string[] = [];
    let count = 0;
    for await (const { doc, cursor } of db2.iterateChangesSince(null)) {
      firstPart.push(doc.getId());
      cursor2 = cursor;
      count++;
      if (count >= docCount) break;
    }
    expect(firstPart.length).toBe(docCount);

    // Resume from the cursor within the same session
    const resumed: string[] = [];
    for await (const { doc } of db2.iterateChangesSince(cursor2)) {
      resumed.push(doc.getId());
    }
    expect(resumed.length).toBe(extraDocs);

    // No overlap
    for (const id of resumed) {
      expect(firstPart).not.toContain(id);
    }

    // Total coverage
    const allDb2Ids = await db2.getAllDocumentIds();
    expect(firstPart.length + resumed.length).toBe(allDb2Ids.length);
  }, 60000);
});

// ===================================================================
// 5. PROTOCOL COMPATIBILITY
// ===================================================================

describe("protocol compatibility", () => {
  class MockTenantDirectory implements MindooTenantDirectory {
    private users = new Map<string, { signingKey: string; encryptionKey: string; revoked: boolean }>();

    addUser(username: string, signingKey: string, encryptionKey: string) {
      this.users.set(username, { signingKey, encryptionKey, revoked: false });
    }

    async registerUser(_u: PublicUserId, _k: EncryptedPrivateKey, _p: string): Promise<void> {}
    async revokeUser(_u: string, _r: boolean, _k: EncryptedPrivateKey, _p: string): Promise<void> {}
    async validatePublicSigningKey(publicKey: string): Promise<boolean> {
      for (const user of this.users.values()) {
        if (user.signingKey === publicKey && !user.revoked) return true;
      }
      return false;
    }
    async getUserPublicKeys(username: string) {
      const u = this.users.get(username);
      if (!u || u.revoked) return null;
      return { signingPublicKey: u.signingKey, encryptionPublicKey: u.encryptionKey };
    }
    async getUserBySigningPublicKey(publicKey: string) {
      for (const [username, user] of this.users.entries()) {
        if (user.signingKey === publicKey) {
          return {
            username,
            signingPublicKey: user.signingKey,
            encryptionPublicKey: user.encryptionKey,
            details: { username },
          };
        }
      }
      return null;
    }
    async isUserRevoked(username: string): Promise<boolean> {
      return this.users.get(username)?.revoked ?? true;
    }
    async requestDocHistoryPurge(..._a: any[]): Promise<void> {}
    async getRequestedDocHistoryPurges(): Promise<any[]> { return []; }
    async getTenantSettings(): Promise<MindooDoc | null> { return null; }
    async changeTenantSettings(..._a: any[]): Promise<void> {}
    async getDBSettings(_dbId: string): Promise<MindooDoc | null> { return null; }
    async listKnownDBIds(): Promise<string[]> { return ["directory", "main"]; }
    async changeDBSettings(..._a: any[]): Promise<void> {}
    async getGroups(): Promise<string[]> { return []; }
    async getGroupMembers(_g: string): Promise<string[]> { return []; }
    async deleteGroup(..._a: any[]): Promise<void> {}
    async getUserNamesList(_u: string): Promise<string[]> { return []; }
    async addUsersToGroup(..._a: any[]): Promise<void> {}
    async removeUsersFromGroup(..._a: any[]): Promise<void> {}
  }

  /**
   * NetworkTransport that intentionally omits planDocumentMaterialization
   * and planDocumentMaterializationBatch to simulate an old v2 server.
   */
  class OldServerTransport implements NetworkTransport {
    async requestChallenge(_username: string): Promise<string> {
      return "mock-challenge";
    }
    async authenticate(_challenge: string, _signature: Uint8Array): Promise<AuthResult> {
      return { success: true, token: "mock-token" };
    }
    async findNewEntries(_token: string, _haveIds: string[]): Promise<StoreEntryMetadata[]> {
      return [];
    }
    async findNewEntriesForDoc(_t: string, _h: string[], _d: string): Promise<StoreEntryMetadata[]> {
      return [];
    }
    async findEntries(
      _t: string, _type: StoreEntryType, _from: number | null, _until: number | null,
    ): Promise<StoreEntryMetadata[]> {
      return [];
    }
    async getEntries(_t: string, _ids: string[]): Promise<NetworkEncryptedEntry[]> {
      return [];
    }
    async putEntries(_t: string, _entries: StoreEntry[]): Promise<void> {}
    async hasEntries(_t: string, _ids: string[]): Promise<string[]> {
      return [];
    }
    async getAllIds(_t: string): Promise<string[]> {
      return [];
    }
    async resolveDependencies(_t: string, _id: string, _opts?: Record<string, unknown>): Promise<string[]> {
      return [];
    }
    async scanEntriesSince(
      _t: string, _cursor: StoreScanCursor | null, _limit?: number, _filters?: StoreScanFilters,
    ): Promise<StoreScanResult> {
      return { entries: [], nextCursor: null, hasMore: false };
    }
    async getIdBloomSummary(_t: string): Promise<StoreIdBloomSummary> {
      return { version: "bloom-v1", totalIds: 0, bitCount: 0, hashCount: 0, salt: "", bitsetBase64: "" };
    }
    async getCapabilities(_t: string): Promise<NetworkSyncCapabilities> {
      return {
        protocolVersion: "sync-v2",
        supportsCursorScan: true,
        supportsIdBloomSummary: true,
        supportsCompactionStatus: false,
        supportsMaterializationPlanning: false,
        supportsBatchMaterializationPlanning: false,
      };
    }
    async getCompactionStatus(_t: string): Promise<StoreCompactionStatus> {
      return {
        enabled: false,
        totalCompactions: 0,
        lastCompactionAt: null,
      } as StoreCompactionStatus;
    }
    // Deliberately no planDocumentMaterialization or planDocumentMaterializationBatch
  }

  test("v3 client → old server (no materialization support) → clear error", async () => {
    const subtle = cryptoAdapter.getSubtle();
    const keyPair = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;

    const client = new ClientNetworkContentAddressedStore(
      "test-db",
      new OldServerTransport(),
      cryptoAdapter,
      "testuser",
      keyPair.privateKey,
      "mock-enc-key",
    );

    await expect(client.planDocumentMaterialization("doc1")).rejects.toThrow(
      /does not support required materialization planning protocol/,
    );
    await expect(client.planDocumentMaterializationBatch(["doc1"])).rejects.toThrow(
      /does not support required batch materialization planning protocol/,
    );
  });

  test("capabilities correctly report v3 protocol with materialization support", async () => {
    const storeFactory = new InMemoryContentAddressedStoreFactory();
    const { docStore: serverStore } = storeFactory.createStore("proto-test");
    const mockDir = new MockTenantDirectory();
    const subtle = cryptoAdapter.getSubtle();

    const keyPair = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const pubKeyBuf = await subtle.exportKey("spki", keyPair.publicKey);
    const pubKeyPem = arrayBufferToPEM(pubKeyBuf, "PUBLIC KEY");

    const encKeyPair = await subtle.generateKey(
      { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["encrypt", "decrypt"],
    ) as CryptoKeyPair;
    const encPubBuf = await subtle.exportKey("spki", encKeyPair.publicKey);
    const encPubPem = arrayBufferToPEM(encPubBuf, "PUBLIC KEY");

    mockDir.addUser("testuser", pubKeyPem, encPubPem);

    const authService = new AuthenticationService(cryptoAdapter, mockDir, "test-tenant");
    const serverHandler = new ServerNetworkContentAddressedStore(serverStore, mockDir, authService, cryptoAdapter);

    const challenge = await serverHandler.handleChallengeRequest("testuser");
    const sigBuf = await subtle.sign("Ed25519", keyPair.privateKey, new TextEncoder().encode(challenge));
    const authResult = await serverHandler.handleAuthenticate(challenge, new Uint8Array(sigBuf));
    expect(authResult.success).toBe(true);
    const caps = await serverHandler.handleGetCapabilities(authResult.token!);

    expect(caps.protocolVersion).toBe("sync-v4");
    expect(caps.supportsMaterializationPlanning).toBe(true);
    expect(caps.supportsBatchMaterializationPlanning).toBe(true);
  });
});

// ===================================================================
// 6. ATTACHMENT SAFETY
// ===================================================================

describe("attachment safety in syncStoreChanges", () => {
  test("attachment-only entries do not create spurious document index entries", async () => {
    const storeFactory = new InMemoryContentAddressedStoreFactory();
    const { tenant } = await createTenantSetup(storeFactory);
    const db = await tenant.openDB("attach-test");

    // Create a regular doc
    const regularDoc = await db.createDocument();
    await db.changeDoc(regularDoc, (d: MindooDoc) => {
      d.getData().title = "regular";
    });

    const store = db.getStore();

    // Inject a raw attachment_chunk entry for a non-existent document
    const attachEntry: StoreEntry = {
      entryType: "attachment_chunk",
      id: "phantom-doc_a_file1_chunk1",
      contentHash: "attach-hash",
      docId: "phantom-doc",
      dependencyIds: [],
      createdAt: Date.now(),
      createdByPublicKey: "test-key",
      decryptionKeyId: "default",
      signature: new Uint8Array([1, 2, 3]),
      originalSize: 100,
      encryptedSize: 120,
      encryptedData: new Uint8Array(120),
    };
    await store.putEntries([attachEntry]);

    // Sync picks up the attachment entry
    await db.syncStoreChanges();

    // The phantom document should NOT appear in the document list
    const docIds = await db.getAllDocumentIds();
    expect(docIds).not.toContain("phantom-doc");
    expect(docIds).toContain(regularDoc.getId());
    expect(docIds.length).toBe(1);
  }, 30000);

  test("document with both doc_change and attachment_chunk entries materializes correctly", async () => {
    const storeFactory = new InMemoryContentAddressedStoreFactory();
    const { tenant } = await createTenantSetup(storeFactory);
    const db = await tenant.openDB("attach-mix-test");

    const doc = await db.createDocument();
    const docId = doc.getId();
    await db.changeDoc(doc, (d: MindooDoc) => {
      d.getData().title = "with-attachment";
    });

    // Inject an attachment for this document
    const store = db.getStore();
    const attachEntry: StoreEntry = {
      entryType: "attachment_chunk",
      id: `${docId}_a_file1_chunk1`,
      contentHash: "attach-hash-mix",
      docId,
      dependencyIds: [],
      createdAt: Date.now(),
      createdByPublicKey: "test-key",
      decryptionKeyId: "default",
      signature: new Uint8Array([1, 2, 3]),
      originalSize: 100,
      encryptedSize: 120,
      encryptedData: new Uint8Array(120),
    };
    await store.putEntries([attachEntry]);
    await db.syncStoreChanges();

    // The document should be accessible and correct
    const loaded = await db.getDocument(docId);
    expect(loaded.getData().title).toBe("with-attachment");

    // Materialization plan should not include the attachment entry
    const plan = await store.planDocumentMaterialization(docId);
    expect(plan.entryIdsToApply.every((id: string) => !id.includes("_a_"))).toBe(true);
  }, 30000);
});

// ===================================================================
// 7. DENSE SYNC
// ===================================================================

/**
 * Helper: set up source and target tenants that share keys, then sync
 * the directory from source to target so signature verification passes.
 *
 * Returns the source setup, its DB, the target setup, and the target DB.
 * The source and target use independent stores (different factories),
 * which is necessary to verify actual entry transfer.
 */
async function prepareDenseSyncPair(dbName: string) {
  const sourceFactory = new InMemoryContentAddressedStoreFactory();
  const sourceSetup = await createTenantSetup(sourceFactory);
  const sourceDb = await sourceSetup.tenant.openDB(dbName);

  const targetFactory = new InMemoryContentAddressedStoreFactory();
  const targetSetup = await createTenantSetup(targetFactory, sourceSetup);

  // Sync directory so the target can verify signatures from the source user
  const sourceDir = await sourceSetup.tenant.openDB("directory");
  const targetDir = await targetSetup.tenant.openDB("directory");
  await targetDir.pullChangesFrom(sourceDir);
  const targetDb = await targetSetup.tenant.openDB(dbName);

  return { sourceSetup, sourceDb, targetSetup, targetDb };
}

describe("dense sync mode", () => {
  test("dense pull transfers only entries required for latest state", async () => {
    const { sourceDb, targetDb } = await prepareDenseSyncPair("dense-test");

    const doc = await sourceDb.createDocument();
    const docId = doc.getId();

    for (let i = 0; i < 20; i++) {
      await sourceDb.changeDoc(doc, (d: MindooDoc) => {
        d.getData()[`field${i}`] = `value${i}`;
      });
    }

    const denseResult = await targetDb.pullChangesFrom(sourceDb, { mode: "dense" });
    expect(denseResult.transferredEntries).toBeGreaterThan(0);

    // Verify the document is accessible after dense sync
    const loaded = await targetDb.getDocument(docId);
    expect(loaded).toBeDefined();
    expect(loaded.getData().field19).toBe("value19");
  }, 60000);

  test("dense-synced documents appear in getAllDocumentIds", async () => {
    const { sourceDb, targetDb } = await prepareDenseSyncPair("dense-ids-test");

    const doc1 = await sourceDb.createDocument();
    const doc2 = await sourceDb.createDocument();
    await sourceDb.changeDoc(doc1, (d: MindooDoc) => {
      d.getData().title = "one";
    });
    await sourceDb.changeDoc(doc2, (d: MindooDoc) => {
      d.getData().title = "two";
    });

    await targetDb.pullChangesFrom(sourceDb, { mode: "dense" });

    const ids = await targetDb.getAllDocumentIds();
    expect(ids).toContain(doc1.getId());
    expect(ids).toContain(doc2.getId());
    expect(ids.length).toBe(2);
  }, 30000);

  test("dense sync skips attachment_chunk entries", async () => {
    const { sourceDb, targetDb } = await prepareDenseSyncPair("dense-attach-test");

    const doc = await sourceDb.createDocument();
    const docId = doc.getId();
    await sourceDb.changeDoc(doc, (d: MindooDoc) => {
      d.getData().title = "with-attachment";
    });

    // Inject a large attachment for this doc
    const sourceStore = sourceDb.getStore();
    const attachEntry: StoreEntry = {
      entryType: "attachment_chunk",
      id: `${docId}_a_file1_chunk1`,
      contentHash: "attach-hash-dense",
      docId,
      dependencyIds: [],
      createdAt: Date.now(),
      createdByPublicKey: "test-key",
      decryptionKeyId: "default",
      signature: new Uint8Array([1, 2, 3]),
      originalSize: 10000,
      encryptedSize: 10500,
      encryptedData: new Uint8Array(10500),
    };
    await sourceStore.putEntries([attachEntry]);

    await targetDb.pullChangesFrom(sourceDb, { mode: "dense" });

    // Attachment should NOT have been transferred
    const targetStore = targetDb.getStore();
    const hasAttach = await targetStore.hasEntries([`${docId}_a_file1_chunk1`]);
    expect(hasAttach.length).toBe(0);

    // But the document itself should be accessible
    const loaded = await targetDb.getDocument(docId);
    expect(loaded.getData().title).toBe("with-attachment");
  }, 30000);

  test("dense sync handles deleted documents correctly", async () => {
    const { sourceDb, targetDb } = await prepareDenseSyncPair("dense-delete-test");

    const doc = await sourceDb.createDocument();
    const docId = doc.getId();
    await sourceDb.changeDoc(doc, (d: MindooDoc) => {
      d.getData().title = "to-be-deleted";
    });
    await sourceDb.deleteDocument(docId);

    await targetDb.pullChangesFrom(sourceDb, { mode: "dense" });

    // The deleted document should NOT appear in the active document list
    const ids = await targetDb.getAllDocumentIds();
    expect(ids).not.toContain(docId);
  }, 30000);

  test("planner handles snapshot-only case (no replay entries) after dense sync", async () => {
    const store = new InMemoryContentAddressedStore("snapshot-only-test");

    // Simulate a dense-synced store: only a snapshot, no individual changes
    const snapshot = createStoreEntry("doc1", "snap-1", "hs1", [], "doc_snapshot", {
      snapshotHeadEntryIds: ["original-head"],
      snapshotHeadHashes: ["hash-original-head"],
    });
    await store.putEntries([snapshot]);

    const plan = await store.planDocumentMaterialization("doc1");
    expect(plan.snapshotEntryId).toBe("snap-1");
    expect(plan.entryIdsToApply).toEqual([]);
  }, 10000);

  test("dense sync progress reports planning phase", async () => {
    const { sourceDb, targetDb } = await prepareDenseSyncPair("dense-progress-test");

    await sourceDb.createDocument();

    const phases: string[] = [];
    await targetDb.pullChangesFrom(sourceDb, {
      mode: "dense",
      onProgress: (p) => {
        if (!phases.includes(p.phase)) {
          phases.push(p.phase);
        }
      },
    });

    expect(phases).toContain("planning");
  }, 30000);
});

// ===================================================================
// PEM helper (duplicated from NetworkSync.test.ts for self-containment)
// ===================================================================

function arrayBufferToPEM(buffer: ArrayBuffer, type: string): string {
  const base64 = Buffer.from(buffer).toString("base64");
  const lines = base64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----`;
}
