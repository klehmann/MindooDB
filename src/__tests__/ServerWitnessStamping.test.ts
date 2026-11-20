import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { ServerNetworkContentAddressedStore, ServerTier1Evaluator } from "../appendonlystores/network/ServerNetworkContentAddressedStore";
import type { WitnessSigner } from "../core/crypto/WitnessReceipt";
import { WitnessReceiptValidator } from "../core/accesscontrol/receiptValidation";
import { Ed25519WitnessProvider } from "../core/accesscontrol/timestamp/Ed25519WitnessProvider";
import type { StoreEntry, MindooTenantDirectory } from "../core/types";
import { CURRENT_STORE_ENTRY_VERSION, StoreKind } from "../core/types";
import type { AuthenticationService } from "../core/appendonlystores/network/AuthenticationService";
import { NetworkError } from "../core/appendonlystores/network/types";
import type { AccessDecision } from "../core/accesscontrol/types";
import { computeContentHash } from "../core/utils/idGeneration";
import { buildEntrySigningBytes, entrySignatureFieldsFromEntry } from "../core/crypto/EntrySignature";
import {
  deserializeStoreEntry,
  serializeStoreEntry,
} from "../core/appendonlystores/network/entryWireCodec";

/**
 * Server-store integration tests for the witness protocol and Tier 1
 * enforcement (docs/accesscontrol.md §5.3, §7). These exercise
 * `handlePutEntries` with a real {@link ServerNetworkContentAddressedStore},
 * an in-memory local store, and small stubs for the directory and auth service.
 */
describe("ServerNetworkContentAddressedStore witness + Tier 1", () => {
  const subtle = new NodeCryptoAdapter().getSubtle();
  const cryptoAdapter = new NodeCryptoAdapter();
  const dbid = "crm";

  async function generateSigner(): Promise<WitnessSigner> {
    const pair = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const spki = await subtle.exportKey("spki", pair.publicKey);
    const base64 = Buffer.from(new Uint8Array(spki)).toString("base64");
    const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${base64}\n-----END PUBLIC KEY-----`;
    return { publicKeyPem, signingPrivateKey: pair.privateKey, subtle };
  }

  function fakeAuth(): AuthenticationService {
    return {
      validateToken: async () => ({ sub: "CN=alice", iat: 0, exp: 0, tenantId: "t" }),
    } as unknown as AuthenticationService;
  }

  function fakeDirectory(trusted = true): MindooTenantDirectory {
    return {
      validatePublicSigningKey: async () => trusted,
    } as unknown as MindooTenantDirectory;
  }

  /**
   * Build a cryptographically valid entry: real contentHash over the payload,
   * a real legacy signature over the ciphertext, and a real metadata-binding
   * `metadataSignature` (audit findings #1/#5). The server now verifies all of
   * these on push, so fixtures must be authentic. Pass `opts` to sign as a
   * specific author (e.g. the witness itself).
   */
  async function makeEntry(
    overrides: Partial<StoreEntry> = {},
    opts?: { signingKey?: CryptoKey; publicKeyPem?: string },
  ): Promise<StoreEntry> {
    let signingKey = opts?.signingKey;
    let publicKeyPem = opts?.publicKeyPem;
    if (!signingKey || !publicKeyPem) {
      const pair = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
      const spki = await subtle.exportKey("spki", pair.publicKey);
      publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(new Uint8Array(spki)).toString("base64")}\n-----END PUBLIC KEY-----`;
      signingKey = pair.privateKey;
    }

    const encryptedData = (overrides.encryptedData as Uint8Array) ?? new Uint8Array([9, 9, 9]);
    const contentHash = overrides.contentHash ?? (await computeContentHash(encryptedData, subtle));

    const base: StoreEntry = {
      entryType: "doc_change",
      id: `doc7_d_0_${Math.random().toString(36).slice(2)}`,
      contentHash,
      docId: "doc7",
      dependencyIds: [],
      createdAt: 1_700_000_000_000,
      createdByPublicKey: publicKeyPem,
      decryptionKeyId: "default",
      originalSize: encryptedData.length,
      encryptedSize: encryptedData.length,
      signature: new Uint8Array(),
      encryptedData,
      // Witness-era writer by default: only versioned entries are eligible for
      // a receipt. Legacy entries omit this (see the legacy test below).
      entryVersion: CURRENT_STORE_ENTRY_VERSION,
      ...overrides,
    } as StoreEntry;

    // Legacy author signature over the ciphertext.
    base.signature = new Uint8Array(
      await subtle.sign({ name: "Ed25519" }, signingKey, base.encryptedData.buffer as ArrayBuffer),
    );
    // Metadata-binding author signature (unless the caller emulates a true
    // legacy entry by overriding metadataSignature to undefined).
    if (!("metadataSignature" in overrides)) {
      const metaBytes = buildEntrySigningBytes(entrySignatureFieldsFromEntry(base));
      base.metadataSignature = new Uint8Array(
        await subtle.sign({ name: "Ed25519" }, signingKey, metaBytes.buffer as ArrayBuffer),
      );
    }
    return base;
  }

  it("stamps a verifiable witness receipt on accepted entries", async () => {
    const localStore = new InMemoryContentAddressedStore(dbid, StoreKind.docs);
    const signer = await generateSigner();
    const server = new ServerNetworkContentAddressedStore(
      localStore,
      fakeDirectory(),
      fakeAuth(),
      cryptoAdapter,
      undefined,
      { timestampProvider: new Ed25519WitnessProvider({ signer, subtle: signer.subtle }), witnessDbid: dbid },
    );

    const e = await makeEntry();
    const { receipts, rejected } = await server.handlePutEntries("token", [e]);

    // The receipt round-trips through the validator as a trusted, valid receipt.
    expect(rejected).toHaveLength(0);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].receivedByPublicKey).toBe(signer.publicKeyPem);
    expect(receipts[0].receivedAt).toBeGreaterThan(0);

    const validator = new WitnessReceiptValidator();
    const stored = (await localStore.getEntries([e.id]))[0];
    const result = await validator.validate(stored, {
      dbid,
      trustedWitnessKeys: new Set([signer.publicKeyPem]),
      nowMs: Date.now(),
    }, subtle);
    expect(result.ok).toBe(true);
    expect(result.noReceipt).toBeFalsy();
  });

  it("acknowledges a re-pushed duplicate with the STORED receipt instead of re-stamping", async () => {
    const localStore = new InMemoryContentAddressedStore(dbid, StoreKind.docs);
    const signer = await generateSigner();
    const server = new ServerNetworkContentAddressedStore(
      localStore,
      fakeDirectory(),
      fakeAuth(),
      cryptoAdapter,
      undefined,
      { timestampProvider: new Ed25519WitnessProvider({ signer, subtle: signer.subtle }), witnessDbid: dbid },
    );

    const e = await makeEntry();
    const first = await server.handlePutEntries("token", [e]);
    expect(first.receipts).toHaveLength(1);
    const firstReceivedAt = first.receipts[0].receivedAt;
    expect(firstReceivedAt).toBeGreaterThan(0);

    // Re-push the same entry later (e.g. the client's sync scan re-discovered
    // it after applyWitnessReceipts re-anchored it). A fresh receivedAt here
    // would differ from the receipt the client already applied, causing it to
    // re-anchor again — the first-sync infinite loop.
    const nowSpy = jest
      .spyOn(Date, "now")
      .mockReturnValue((firstReceivedAt ?? 0) + 60_000);
    try {
      const second = await server.handlePutEntries("token", [e]);
      expect(second.rejected).toHaveLength(0);
      expect(second.receipts).toHaveLength(1);
      expect(second.receipts[0].id).toBe(e.id);
      expect(second.receipts[0].receivedAt).toBe(firstReceivedAt);
      expect(second.receipts[0].receivedDateSignature).toEqual(
        first.receipts[0].receivedDateSignature,
      );
    } finally {
      nowSpy.mockRestore();
    }

    // The stored copy kept its original receipt as well.
    const stored = (await localStore.getEntries([e.id]))[0];
    expect(stored.receivedAt).toBe(firstReceivedAt);
  });

  it("does not self-witness entries authored by the witness itself", async () => {
    const localStore = new InMemoryContentAddressedStore(dbid, StoreKind.docs);
    const signer = await generateSigner();
    const server = new ServerNetworkContentAddressedStore(
      localStore,
      fakeDirectory(),
      fakeAuth(),
      cryptoAdapter,
      undefined,
      { timestampProvider: new Ed25519WitnessProvider({ signer, subtle: signer.subtle }), witnessDbid: dbid },
    );

    const e = await makeEntry({}, { signingKey: signer.signingPrivateKey, publicKeyPem: signer.publicKeyPem });
    const { receipts } = await server.handlePutEntries("token", [e]);
    expect(receipts[0].receivedDateSignature).toBeUndefined();
  });

  it("does not witness legacy entries that carry no entryVersion", async () => {
    const localStore = new InMemoryContentAddressedStore(dbid, StoreKind.docs);
    const signer = await generateSigner();
    const server = new ServerNetworkContentAddressedStore(
      localStore,
      fakeDirectory(),
      fakeAuth(),
      cryptoAdapter,
      undefined,
      { timestampProvider: new Ed25519WitnessProvider({ signer, subtle: signer.subtle }), witnessDbid: dbid },
    );

    // An old local DB syncing for the first time: its entries predate the
    // witness era and have no entryVersion. Stamping a receivedAt = now here
    // would collapse every old doc onto "today"; the server must leave them
    // un-witnessed so they keep resolving to their stable createdAt.
    const legacy = await makeEntry({ entryVersion: undefined, metadataSignature: undefined });
    const { receipts } = await server.handlePutEntries("token", [legacy]);

    expect(receipts).toHaveLength(1);
    expect(receipts[0].receivedAt).toBeUndefined();
    expect(receipts[0].receivedByPublicKey).toBeUndefined();
    expect(receipts[0].receivedDateSignature).toBeUndefined();

    // And nothing was witnessed in the persisted copy either.
    const stored = (await localStore.getEntries([legacy.id]))[0];
    expect(stored.receivedAt).toBeUndefined();
    expect(stored.receivedDateSignature).toBeUndefined();
  });

  it("rejects a push denied by the Tier 1 evaluator as a policy rejection", async () => {
    const localStore = new InMemoryContentAddressedStore(dbid, StoreKind.docs);
    const signer = await generateSigner();
    const denyEvaluator: ServerTier1Evaluator = async (): Promise<AccessDecision> => ({
      allowed: false,
      reason: "no doc_change rule grants this user",
      tier: "tier1",
    });
    const server = new ServerNetworkContentAddressedStore(
      localStore,
      fakeDirectory(),
      fakeAuth(),
      cryptoAdapter,
      undefined,
      { timestampProvider: new Ed25519WitnessProvider({ signer, subtle: signer.subtle }), witnessDbid: dbid, tier1Evaluator: denyEvaluator },
    );

    // A Tier 1 denial is reported per entry rather than by failing the batch:
    // the entry is intact and was legitimate when written, so the pushing side
    // has to be able to keep it and offer it again if the right returns —
    // and one such entry must not stall the database's whole push sync.
    const entry = await makeEntry();
    const ack = await server.handlePutEntries("token", [entry]);
    expect(ack.receipts).toHaveLength(0);
    expect(ack.rejected).toEqual([
      {
        id: entry.id,
        reason: expect.stringContaining("denied by Tier 1 policy"),
        rejectionClass: "policy",
      },
    ]);
    // Nothing should have been persisted.
    expect(await localStore.getAllIds()).toHaveLength(0);
  });

  it("keeps pushing the rest of a batch when Tier 1 denies one entry", async () => {
    const localStore = new InMemoryContentAddressedStore(dbid, StoreKind.docs);
    const signer = await generateSigner();
    const denied = await makeEntry();
    const allowed = await makeEntry();
    const denyOne: ServerTier1Evaluator = async (entry): Promise<AccessDecision> =>
      entry.id === denied.id
        ? { allowed: false, reason: "no doc_change rule grants this user", tier: "tier1" }
        : { allowed: true, tier: "tier1" };
    const server = new ServerNetworkContentAddressedStore(
      localStore,
      fakeDirectory(),
      fakeAuth(),
      cryptoAdapter,
      undefined,
      {
        timestampProvider: new Ed25519WitnessProvider({ signer, subtle: signer.subtle }),
        witnessDbid: dbid,
        tier1Evaluator: denyOne,
      },
    );

    const ack = await server.handlePutEntries("token", [denied, allowed]);
    expect(ack.rejected.map((r) => r.id)).toEqual([denied.id]);
    expect(ack.receipts.map((r) => r.id)).toEqual([allowed.id]);
    expect(await localStore.getAllIds()).toEqual([allowed.id]);
  });

  it("advertises serverTime and supportsAccessControlV1 when a witness signer is present", async () => {
    const localStore = new InMemoryContentAddressedStore(dbid, StoreKind.docs);
    const signer = await generateSigner();
    const server = new ServerNetworkContentAddressedStore(
      localStore,
      fakeDirectory(),
      fakeAuth(),
      cryptoAdapter,
      undefined,
      { timestampProvider: new Ed25519WitnessProvider({ signer, subtle: signer.subtle }), witnessDbid: dbid },
    );
    const caps = await server.handleGetCapabilities("token");
    expect(caps.supportsAccessControlV1).toBe(true);
    expect(typeof caps.serverTime).toBe("number");
  });

  it("leaves entries unstamped and flags no access control without a witness signer", async () => {
    const localStore = new InMemoryContentAddressedStore(dbid, StoreKind.docs);
    const server = new ServerNetworkContentAddressedStore(
      localStore,
      fakeDirectory(),
      fakeAuth(),
      cryptoAdapter,
    );
    const e = await makeEntry();
    const { receipts } = await server.handlePutEntries("token", [e]);
    expect(receipts[0].receivedDateSignature).toBeUndefined();
    const caps = await server.handleGetCapabilities("token");
    expect(caps.supportsAccessControlV1).toBe(false);
  });

  // Directory-restricted database policy: the dbAccessEvaluator gates every
  // authenticated sync operation (reads and writes) by database id.
  describe("database-open gate (directory-restricted policy)", () => {
    const ADMIN_KEY = "-----BEGIN PUBLIC KEY-----ADMIN-----END PUBLIC KEY-----";
    const allowedDbIds = ["main"];

    function authWithDeviceKey(deviceSigningKey?: string): AuthenticationService {
      return {
        validateToken: async () => ({
          sub: "CN=alice",
          iat: 0,
          exp: 0,
          tenantId: "t",
          deviceSigningKey,
        }),
      } as unknown as AuthenticationService;
    }

    // Mirrors TenantManager.buildDbAccessEvaluator -> evaluateDbAccessForSigningKey.
    const dbAccessEvaluator = async (
      principal: { signingKey?: string },
      dbidArg: string,
    ): Promise<boolean> => {
      if (dbidArg === "directory") return true;
      if (allowedDbIds.includes(dbidArg)) return true;
      return principal.signingKey === ADMIN_KEY;
    };

    it("rejects a push for a non-allowed database with ACCESS_DENIED", async () => {
      const localStore = new InMemoryContentAddressedStore(dbid, StoreKind.docs);
      const server = new ServerNetworkContentAddressedStore(
        localStore,
        fakeDirectory(),
        authWithDeviceKey("device-key"),
        cryptoAdapter,
        undefined,
        { witnessDbid: dbid, dbAccessEvaluator },
      );

      await expect(server.handlePutEntries("token", [await makeEntry()])).rejects.toBeInstanceOf(NetworkError);
      expect(await localStore.getAllIds()).toHaveLength(0);
    });

    it("rejects a read route for a non-allowed database", async () => {
      const localStore = new InMemoryContentAddressedStore(dbid, StoreKind.docs);
      const server = new ServerNetworkContentAddressedStore(
        localStore,
        fakeDirectory(),
        authWithDeviceKey("device-key"),
        cryptoAdapter,
        undefined,
        { witnessDbid: dbid, dbAccessEvaluator },
      );

      await expect(server.handleFindNewEntries("token", [])).rejects.toBeInstanceOf(NetworkError);
    });

    it("allows sync for a listed database", async () => {
      const localStore = new InMemoryContentAddressedStore("main", StoreKind.docs);
      const server = new ServerNetworkContentAddressedStore(
        localStore,
        fakeDirectory(),
        authWithDeviceKey("device-key"),
        cryptoAdapter,
        undefined,
        { witnessDbid: "main", dbAccessEvaluator },
      );

      const e = await makeEntry();
      await expect(server.handlePutEntries("token", [e])).resolves.toMatchObject({
        receipts: [expect.objectContaining({ id: e.id })],
        rejected: [],
      });
      expect(await localStore.getAllIds()).toContain(e.id);
      await expect(server.handleFindNewEntries("token", [])).resolves.toBeDefined();
    });

    it("bypasses the gate for the tenant admin token", async () => {
      const localStore = new InMemoryContentAddressedStore(dbid, StoreKind.docs);
      const server = new ServerNetworkContentAddressedStore(
        localStore,
        fakeDirectory(),
        authWithDeviceKey(ADMIN_KEY),
        cryptoAdapter,
        undefined,
        { witnessDbid: dbid, dbAccessEvaluator },
      );

      const e = await makeEntry();
      // "crm" is not in allowedDbIds, but the admin signing key bypasses.
      await expect(server.handlePutEntries("token", [e])).resolves.toMatchObject({
        receipts: [expect.objectContaining({ id: e.id })],
        rejected: [],
      });
      expect(await localStore.getAllIds()).toContain(e.id);
    });
  });

  // Server-side cryptographic verification on push (audit findings #1 / #5):
  // the server must refuse forged/tampered entries before stamping them, even
  // when the author key is "trusted" by the directory. These failures are
  // rejected PER ENTRY (reported in the ack) instead of failing the whole
  // batch, so one poisoned entry cannot block a database's push sync. Each
  // rejection carries the class that decides what the pushing side may do with
  // it — see PutRejectionClass.
  describe("push-time signature + contentHash verification", () => {
    function plainServer(localStore: InMemoryContentAddressedStore, trusted = true) {
      return new ServerNetworkContentAddressedStore(
        localStore,
        fakeDirectory(trusted),
        fakeAuth(),
        cryptoAdapter,
      );
    }

    it("rejects an entry whose contentHash does not match the payload", async () => {
      const localStore = new InMemoryContentAddressedStore(dbid, StoreKind.docs);
      const server = plainServer(localStore);
      // Valid signatures, but a contentHash that lies about the ciphertext.
      const e = await makeEntry({ contentHash: "deadbeef".repeat(8) });
      const ack = await server.handlePutEntries("token", [e]);
      expect(ack.receipts).toHaveLength(0);
      expect(ack.rejected).toEqual([
        {
          id: e.id,
          reason: expect.stringContaining("content hash"),
          rejectionClass: "signature",
        },
      ]);
      expect(await localStore.getAllIds()).toHaveLength(0);
    });

    it("rejects an entry whose metadata was tampered after signing", async () => {
      const localStore = new InMemoryContentAddressedStore(dbid, StoreKind.docs);
      const server = plainServer(localStore);
      const e = await makeEntry();
      // Relabel the op type without re-signing: the metadataSignature no longer
      // matches, so the server must refuse it.
      const tampered = { ...e, entryType: "doc_delete" } as StoreEntry;
      const ack = await server.handlePutEntries("token", [tampered]);
      expect(ack.receipts).toHaveLength(0);
      expect(ack.rejected).toEqual([
        {
          id: e.id,
          reason: expect.stringContaining("invalid author signature"),
          rejectionClass: "signature",
        },
      ]);
      expect(await localStore.getAllIds()).toHaveLength(0);
    });

    // An untrusted key is the one rejection that is expected to fix itself: the
    // key is usually a live grant the target has not replicated yet. It is
    // therefore classified apart from the corruption cases, because it is the
    // only class a cursor may be held for.
    it("rejects an entry signed by an untrusted key as self-resolving", async () => {
      const localStore = new InMemoryContentAddressedStore(dbid, StoreKind.docs);
      const server = plainServer(localStore, /* trusted */ false);
      const e = await makeEntry();
      const ack = await server.handlePutEntries("token", [e]);
      expect(ack.receipts).toHaveLength(0);
      expect(ack.rejected).toEqual([
        {
          id: e.id,
          reason: expect.stringContaining("not signed by a trusted user"),
          rejectionClass: "untrusted-key",
        },
      ]);
      expect(await localStore.getAllIds()).toHaveLength(0);
    });

    it("stores the healthy remainder of a batch containing one poisoned entry", async () => {
      const localStore = new InMemoryContentAddressedStore(dbid, StoreKind.docs);
      const server = plainServer(localStore);
      const good = await makeEntry();
      const bad = await makeEntry({ contentHash: "deadbeef".repeat(8) });
      const good2 = await makeEntry();
      const ack = await server.handlePutEntries("token", [good, bad, good2]);
      expect(ack.receipts.map((r) => r.id).sort()).toEqual([good.id, good2.id].sort());
      expect(ack.rejected).toEqual([
        {
          id: bad.id,
          reason: expect.stringContaining("content hash"),
          rejectionClass: "signature",
        },
      ]);
      const storedIds = await localStore.getAllIds();
      expect(storedIds).toContain(good.id);
      expect(storedIds).toContain(good2.id);
      expect(storedIds).not.toContain(bad.id);
    });

    it("accepts a valid legacy entry (ciphertext-only signature, no metadataSignature)", async () => {
      const localStore = new InMemoryContentAddressedStore(dbid, StoreKind.docs);
      const server = plainServer(localStore);
      const legacy = await makeEntry({ entryVersion: undefined, metadataSignature: undefined });
      await expect(server.handlePutEntries("token", [legacy])).resolves.toMatchObject({
        receipts: [expect.objectContaining({ id: legacy.id })],
        rejected: [],
      });
      expect(await localStore.getAllIds()).toContain(legacy.id);
    });

    it("accepts and stores an attachment-bearing entry whose attachmentRefs are bound", async () => {
      const localStore = new InMemoryContentAddressedStore(dbid, StoreKind.docs);
      const server = plainServer(localStore);
      const e = await makeEntry({
        attachmentRefs: [
          { attachmentId: "att-1", lastChunkId: "doc7_a_f_c1", size: 100 },
          { attachmentId: "att-2", lastChunkId: "doc7_a_g_c2", size: 200 },
        ],
      });
      await expect(server.handlePutEntries("token", [e])).resolves.toMatchObject({
        receipts: [expect.objectContaining({ id: e.id })],
        rejected: [],
      });
      const [stored] = await localStore.getEntries([e.id]);
      // The signed attachment snapshot survives the server storage path.
      expect(stored.attachmentRefs).toEqual(e.attachmentRefs);
    });

    it("rejects an entry whose attachmentRefs were tampered after signing", async () => {
      const localStore = new InMemoryContentAddressedStore(dbid, StoreKind.docs);
      const server = plainServer(localStore);
      const e = await makeEntry({
        attachmentRefs: [{ attachmentId: "att-1", lastChunkId: "doc7_a_f_c1", size: 100 }],
      });
      // Rewrite a referenced chunk without re-signing: metadataSignature no longer matches.
      const tampered = {
        ...e,
        attachmentRefs: [{ attachmentId: "att-1", lastChunkId: "doc7_a_f_evil", size: 100 }],
      } as StoreEntry;
      const ack = await server.handlePutEntries("token", [tampered]);
      expect(ack.receipts).toHaveLength(0);
      expect(ack.rejected).toEqual([
        {
          id: e.id,
          reason: expect.stringContaining("invalid author signature"),
          rejectionClass: "signature",
        },
      ]);
      expect(await localStore.getAllIds()).toHaveLength(0);
    });

    it("accepts a sealed-recipient entry after a JSON wire round-trip", async () => {
      const localStore = new InMemoryContentAddressedStore(dbid, StoreKind.docs);
      const server = plainServer(localStore);
      const e = await makeEntry({
        decryptionKeyId: "$sealed:doc7",
        recipients: {
          epoch: 1,
          bundle: "bundle-b64",
          wraps: [{ kind: "user", keyFingerprint: "fp-alice", wrapped: "wrap-alice" }],
        },
      });
      const roundTripped = deserializeStoreEntry(
        JSON.parse(JSON.stringify(serializeStoreEntry(e))),
      );
      await expect(server.handlePutEntries("token", [roundTripped])).resolves.toMatchObject({
        receipts: [expect.objectContaining({ id: e.id })],
        rejected: [],
      });
      const [stored] = await localStore.getEntries([e.id]);
      expect(stored.recipients).toEqual(e.recipients);
    });

    it("rejects a sealed-recipient entry whose recipients were dropped on the wire", async () => {
      const localStore = new InMemoryContentAddressedStore(dbid, StoreKind.docs);
      const server = plainServer(localStore);
      const e = await makeEntry({
        decryptionKeyId: "$sealed:doc7",
        recipients: {
          epoch: 1,
          bundle: "bundle-b64",
          wraps: [{ kind: "user", keyFingerprint: "fp-alice", wrapped: "wrap-alice" }],
        },
      });
      const serialized = serializeStoreEntry(e);
      delete serialized.recipients;
      const dropped = deserializeStoreEntry(serialized);
      const ack = await server.handlePutEntries("token", [dropped]);
      expect(ack.receipts).toHaveLength(0);
      expect(ack.rejected).toEqual([
        {
          id: e.id,
          reason: expect.stringContaining("invalid author signature"),
          rejectionClass: "signature",
        },
      ]);
      expect(await localStore.getAllIds()).toHaveLength(0);
    });
  });

  /**
   * First trusted receipt wins, for client pushes too (§5.3, convergence
   * invariant 2): a client that synced an entry with server A and then pushes
   * it to server B must not get a second, different receipt from B.
   */
  describe("client push of an entry that already carries another server's receipt", () => {
    function makeServer(
      signer: WitnessSigner,
      opts: {
        trusts?: string[];
        store?: InMemoryContentAddressedStore;
        db?: string;
        peer?: boolean;
        directoryAdminCheck?: { rootAdminKey: string; isAdminAt: (k: string, T: number) => Promise<boolean> };
      } = {},
    ) {
      const db = opts.db ?? dbid;
      const store = opts.store ?? new InMemoryContentAddressedStore(db, StoreKind.docs);
      const auth = opts.peer
        ? ({ validateToken: async () => null } as unknown as AuthenticationService)
        : fakeAuth();
      const server = new ServerNetworkContentAddressedStore(store, fakeDirectory(), auth, cryptoAdapter, undefined, {
        timestampProvider: new Ed25519WitnessProvider({ signer, subtle: signer.subtle }),
        witnessDbid: db,
        trustedWitnessResolver: (key) => (opts.trusts ?? []).includes(key),
        peerTokenResolver: opts.peer
          ? async () => ({ name: "CN=peer-a", signingPublicKey: "peer-sign", encryptionPublicKey: "peer-enc" })
          : undefined,
        directoryAdminCheck: opts.directoryAdminCheck,
      });
      return { server, store };
    }

    /** Run `fn` with `Date.now()` pinned to `at`. */
    async function at<T>(atMs: number, fn: () => Promise<T>): Promise<T> {
      const spy = jest.spyOn(Date, "now").mockReturnValue(atMs);
      try {
        return await fn();
      } finally {
        spy.mockRestore();
      }
    }

    const T_A = 1_800_000_000_000;
    const T_B = T_A + 3_600_000;

    /** The client writes an entry locally and syncs it with server A. */
    async function clientSyncedWithA(signerA: WitnessSigner) {
      const { server: serverA } = makeServer(signerA);
      const client = new InMemoryContentAddressedStore(dbid, StoreKind.docs);
      const e = await makeEntry();
      await client.putEntries([e]);
      const ackA = await at(T_A, () => serverA.handlePutEntries("token", [e]));
      expect(ackA.rejected).toHaveLength(0);
      await client.applyWitnessReceipts(ackA.receipts);
      const local = (await client.getEntries([e.id]))[0];
      expect(local.receivedAt).toBe(T_A);
      expect(local.receivedByPublicKey).toBe(signerA.publicKeyPem);
      return { client, local };
    }

    it("keeps A's receipt when B trusts A, and the client's metadata stays unchanged", async () => {
      const signerA = await generateSigner();
      const signerB = await generateSigner();
      const { client, local } = await clientSyncedWithA(signerA);
      const metaBefore = await client.getEntryMetadata(local.id);

      const { server: serverB, store: storeB } = makeServer(signerB, { trusts: [signerA.publicKeyPem] });
      const ackB = await at(T_B, () => serverB.handlePutEntries("token", [local]));

      expect(ackB.rejected).toHaveLength(0);
      expect(ackB.receipts).toHaveLength(1);
      expect(ackB.receipts[0].receivedAt).toBe(T_A);
      expect(ackB.receipts[0].receivedByPublicKey).toBe(signerA.publicKeyPem);
      expect(ackB.receipts[0].receivedDateSignature).toEqual(local.receivedDateSignature);

      const storedB = (await storeB.getEntries([local.id]))[0];
      expect(storedB.receivedAt).toBe(T_A);
      expect(storedB.receivedByPublicKey).toBe(signerA.publicKeyPem);

      // Applying B's ack is a no-op on the client: same receipt, same
      // receiptOrder, so the entry is not re-anchored or re-pushed.
      await client.applyWitnessReceipts(ackB.receipts);
      expect(await client.getEntryMetadata(local.id)).toEqual(metaBefore);

      // The kept receipt still validates against A's key.
      const result = await new WitnessReceiptValidator().validate(
        storedB,
        { dbid, trustedWitnessKeys: new Set([signerA.publicKeyPem]), nowMs: T_B },
        subtle,
      );
      expect(result.ok).toBe(true);
      expect(result.noReceipt).toBeFalsy();
    });

    it("keeps its own receipt on a client push (own witness key)", async () => {
      const signerA = await generateSigner();
      const { local } = await clientSyncedWithA(signerA);
      // A fresh store under the same witness key (e.g. A after a restore).
      const { server } = makeServer(signerA);
      const ack = await at(T_B, () => server.handlePutEntries("token", [local]));
      expect(ack.receipts[0].receivedAt).toBe(T_A);
    });

    it("re-stamps when B does not trust A (old behaviour)", async () => {
      const signerA = await generateSigner();
      const signerB = await generateSigner();
      const { local } = await clientSyncedWithA(signerA);

      const { server: serverB, store: storeB } = makeServer(signerB);
      const ackB = await at(T_B, () => serverB.handlePutEntries("token", [local]));

      expect(ackB.rejected).toHaveLength(0);
      expect(ackB.receipts[0].receivedAt).toBe(T_B);
      expect(ackB.receipts[0].receivedByPublicKey).toBe(signerB.publicKeyPem);
      const storedB = (await storeB.getEntries([local.id]))[0];
      expect(storedB.receivedByPublicKey).toBe(signerB.publicKeyPem);
      const result = await new WitnessReceiptValidator().validate(
        storedB,
        { dbid, trustedWitnessKeys: new Set([signerB.publicKeyPem]), nowMs: T_B },
        subtle,
      );
      expect(result.ok).toBe(true);
    });

    it("re-stamps a client-pushed receipt with a broken signature instead of storing it", async () => {
      const signerA = await generateSigner();
      const signerB = await generateSigner();
      const { local } = await clientSyncedWithA(signerA);
      const forged: StoreEntry = { ...local, receivedAt: T_A - 86_400_000 };

      const { server: serverB, store: storeB } = makeServer(signerB, { trusts: [signerA.publicKeyPem] });
      const ackB = await at(T_B, () => serverB.handlePutEntries("token", [forged]));

      expect(ackB.rejected).toHaveLength(0);
      expect(ackB.receipts[0].receivedAt).toBe(T_B);
      expect(ackB.receipts[0].receivedByPublicKey).toBe(signerB.publicKeyPem);
      const storedB = (await storeB.getEntries([local.id]))[0];
      expect(storedB.receivedAt).toBe(T_B);
      expect(storedB.receivedByPublicKey).toBe(signerB.publicKeyPem);
    });

    it("judges a kept client receipt at its receivedAt, an unverifiable one at the server's clock", async () => {
      const signerA = await generateSigner();
      const signerB = await generateSigner();
      const author = await generateSigner();
      const seenAt: number[] = [];
      const directoryAdminCheck = {
        rootAdminKey: "root-key",
        isAdminAt: async (_key: string, T: number) => {
          seenAt.push(T);
          return true;
        },
      };
      const db = "directory";
      const { server: serverA } = makeServer(signerA, { db, directoryAdminCheck });
      const e = await makeEntry({}, { signingKey: author.signingPrivateKey, publicKeyPem: author.publicKeyPem });
      const ackA = await at(T_A, () => serverA.handlePutEntries("token", [e]));
      const withReceipt: StoreEntry = { ...e, ...ackA.receipts[0], encryptedData: e.encryptedData };

      seenAt.length = 0;
      const { server: trusting } = makeServer(signerB, { db, directoryAdminCheck, trusts: [signerA.publicKeyPem] });
      const kept = await at(T_B, () => trusting.handlePutEntries("token", [withReceipt]));
      expect(kept.receipts[0].receivedAt).toBe(T_A);
      expect(seenAt).toEqual([T_A]);

      seenAt.length = 0;
      const { server: stranger } = makeServer(signerB, { db, directoryAdminCheck });
      const restamped = await at(T_B, () => stranger.handlePutEntries("token", [withReceipt]));
      expect(restamped.receipts[0].receivedAt).toBe(T_B);
      expect(seenAt).toEqual([T_B]);
    });

    it("leaves the peer path unchanged: trusted receipt kept, unverifiable receipt rejected", async () => {
      const signerA = await generateSigner();
      const signerB = await generateSigner();
      const { local } = await clientSyncedWithA(signerA);

      const { server: trusting } = makeServer(signerB, { peer: true, trusts: [signerA.publicKeyPem] });
      const kept = await at(T_B, () => trusting.handlePutEntries("peer-token", [local]));
      expect(kept.rejected).toHaveLength(0);
      expect(kept.receipts[0].receivedAt).toBe(T_A);
      expect(kept.receipts[0].receivedByPublicKey).toBe(signerA.publicKeyPem);

      const { server: stranger, store } = makeServer(signerB, { peer: true });
      const refused = await at(T_B, () => stranger.handlePutEntries("peer-token", [local]));
      expect(refused.receipts).toHaveLength(0);
      expect(refused.rejected).toEqual([
        { id: local.id, reason: expect.stringContaining("not verifiable"), rejectionClass: "signature" },
      ]);
      expect(await store.getAllIds()).toHaveLength(0);
    });
  });
});
