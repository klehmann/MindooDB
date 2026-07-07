import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { ServerNetworkContentAddressedStore } from "../appendonlystores/network/ServerNetworkContentAddressedStore";
import type { StoreEntry, MindooTenantDirectory } from "../core/types";
import { CURRENT_STORE_ENTRY_VERSION, StoreKind } from "../core/types";
import type { AuthenticationService } from "../core/appendonlystores/network/AuthenticationService";
import { NetworkError, NetworkErrorType } from "../core/appendonlystores/network/types";
import { computeContentHash } from "../core/utils/idGeneration";
import {
  buildEntrySigningBytes,
  entrySignatureFieldsFromEntry,
  verifyEntrySignatureCrypto,
} from "../core/crypto/EntrySignature";
import { validateAccessPolicy } from "../core/accesscontrol/types";
import { parsePolicyDoc } from "../core/accesscontrol/directoryProjection";

/**
 * Tests for the storage-format floor (`requireMetadataSignatureSince`): the
 * tenant-level cutoff that forces store entries to carry the v2 metadata-binding
 * author signature from a given trusted time onward, while grandfathering
 * genuine older (v1) history. Covers the policy field, the version-aware
 * verifier option, and the authoritative server push gate.
 */
describe("v2 storage-format floor (requireMetadataSignatureSince)", () => {
  const cryptoAdapter = new NodeCryptoAdapter();
  const subtle = cryptoAdapter.getSubtle();
  const dbid = "crm";

  async function generateAuthor(): Promise<{ signingKey: CryptoKey; publicKeyPem: string }> {
    const pair = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const spki = await subtle.exportKey("spki", pair.publicKey);
    const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(new Uint8Array(spki)).toString("base64")}\n-----END PUBLIC KEY-----`;
    return { signingKey: pair.privateKey, publicKeyPem };
  }

  /**
   * Build a cryptographically valid entry. By default it is a v2 entry (carries
   * `metadataSignature`); pass `{ metadataSignature: undefined, entryVersion:
   * undefined }` in overrides to emulate a genuine legacy v1 entry.
   */
  async function makeEntry(
    author: { signingKey: CryptoKey; publicKeyPem: string },
    overrides: Partial<StoreEntry> = {},
  ): Promise<StoreEntry> {
    const encryptedData = (overrides.encryptedData as Uint8Array) ?? new Uint8Array([1, 2, 3, 4]);
    const contentHash = overrides.contentHash ?? (await computeContentHash(encryptedData, subtle));
    const base: StoreEntry = {
      entryType: "doc_change",
      id: `doc1_d_0_${Math.random().toString(36).slice(2)}`,
      contentHash,
      docId: "doc1",
      dependencyIds: [],
      createdAt: 1_700_000_000_000,
      createdByPublicKey: author.publicKeyPem,
      decryptionKeyId: "default",
      originalSize: encryptedData.length,
      encryptedSize: encryptedData.length,
      signature: new Uint8Array(),
      encryptedData,
      entryVersion: CURRENT_STORE_ENTRY_VERSION,
      ...overrides,
    } as StoreEntry;

    base.signature = new Uint8Array(
      await subtle.sign({ name: "Ed25519" }, author.signingKey, base.encryptedData.buffer as ArrayBuffer),
    );
    if (!("metadataSignature" in overrides)) {
      const metaBytes = buildEntrySigningBytes(entrySignatureFieldsFromEntry(base));
      base.metadataSignature = new Uint8Array(
        await subtle.sign({ name: "Ed25519" }, author.signingKey, metaBytes.buffer as ArrayBuffer),
      );
    }
    return base;
  }

  function fakeAuth(): AuthenticationService {
    return {
      validateToken: async () => ({ sub: "CN=alice", iat: 0, exp: 0, tenantId: "t" }),
    } as unknown as AuthenticationService;
  }

  function fakeDirectory(cutoff?: number): MindooTenantDirectory {
    return {
      validatePublicSigningKey: async () => true,
      getRequireMetadataSignatureSince: async () => cutoff,
    } as unknown as MindooTenantDirectory;
  }

  function plainServer(localStore: InMemoryContentAddressedStore, cutoff?: number, witnessDbid = dbid) {
    return new ServerNetworkContentAddressedStore(
      localStore,
      fakeDirectory(cutoff),
      fakeAuth(),
      cryptoAdapter,
      undefined,
      { witnessDbid },
    );
  }

  describe("policy field", () => {
    it("accepts a valid epoch-millisecond cutoff and round-trips through the parser", () => {
      const now = Date.now();
      expect(() => validateAccessPolicy({ requireMetadataSignatureSince: now })).not.toThrow();
      const parsed = parsePolicyDoc({
        form: "accesscontrol",
        type: "defaultpolicy",
        requireMetadataSignatureSince: now,
      });
      expect(parsed.requireMetadataSignatureSince).toBe(now);
    });

    it("rejects non-numeric / negative cutoffs", () => {
      expect(() => validateAccessPolicy({ requireMetadataSignatureSince: -1 })).toThrow();
      expect(() =>
        validateAccessPolicy({ requireMetadataSignatureSince: Number.NaN }),
      ).toThrow();
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        validateAccessPolicy({ requireMetadataSignatureSince: "soon" as any }),
      ).toThrow();
    });

    it("treats a malformed cutoff as absent when parsing", () => {
      const parsed = parsePolicyDoc({ requireMetadataSignatureSince: "soon" });
      expect(parsed.requireMetadataSignatureSince).toBeUndefined();
    });
  });

  describe("version-aware verifier option", () => {
    it("rejects a legacy v1 entry when requireMetadataSignature is set", async () => {
      const author = await generateAuthor();
      const v1 = await makeEntry(author, { entryVersion: undefined, metadataSignature: undefined });
      // Without the floor, the legacy ciphertext signature still verifies.
      await expect(
        verifyEntrySignatureCrypto(v1, v1.encryptedData, author.publicKeyPem, subtle),
      ).resolves.toBe(true);
      // With the floor, the weaker fallback is refused.
      await expect(
        verifyEntrySignatureCrypto(v1, v1.encryptedData, author.publicKeyPem, subtle, {
          requireMetadataSignature: true,
        }),
      ).resolves.toBe(false);
    });

    it("accepts a v2 entry regardless of the floor", async () => {
      const author = await generateAuthor();
      const v2 = await makeEntry(author);
      await expect(
        verifyEntrySignatureCrypto(v2, v2.encryptedData, author.publicKeyPem, subtle, {
          requireMetadataSignature: true,
        }),
      ).resolves.toBe(true);
    });
  });

  describe("server push gate", () => {
    it("rejects a v1 entry once the cutoff has passed (server clock)", async () => {
      const author = await generateAuthor();
      const localStore = new InMemoryContentAddressedStore(dbid, StoreKind.docs);
      const server = plainServer(localStore, Date.now() - 1000); // cutoff in the past
      const v1 = await makeEntry(author, { entryVersion: undefined, metadataSignature: undefined });
      // Signature-class failure: rejected per entry (sync-v5), not stored.
      const ack = await server.handlePutEntries("token", [v1]);
      expect(ack.receipts).toHaveLength(0);
      expect(ack.rejected).toEqual([
        { id: v1.id, reason: expect.stringContaining("v2 metadata signature") },
      ]);
      expect(await localStore.getAllIds()).toHaveLength(0);
    });

    it("accepts a v2 entry after the cutoff", async () => {
      const author = await generateAuthor();
      const localStore = new InMemoryContentAddressedStore(dbid, StoreKind.docs);
      const server = plainServer(localStore, Date.now() - 1000);
      const v2 = await makeEntry(author);
      await expect(server.handlePutEntries("token", [v2])).resolves.toMatchObject({
        receipts: [expect.objectContaining({ id: v2.id })],
        rejected: [],
      });
      expect((await localStore.getEntries([v2.id]))[0]).toBeDefined();
    });

    it("grandfathers a v1 entry when the cutoff is still in the future", async () => {
      const author = await generateAuthor();
      const localStore = new InMemoryContentAddressedStore(dbid, StoreKind.docs);
      const server = plainServer(localStore, Date.now() + 60_000); // cutoff in the future
      const v1 = await makeEntry(author, { entryVersion: undefined, metadataSignature: undefined });
      await expect(server.handlePutEntries("token", [v1])).resolves.toMatchObject({
        receipts: [expect.objectContaining({ id: v1.id })],
        rejected: [],
      });
    });

    it("cannot be bypassed by backdating a forged v1 entry's createdAt", async () => {
      const author = await generateAuthor();
      const localStore = new InMemoryContentAddressedStore(dbid, StoreKind.docs);
      const server = plainServer(localStore, Date.now() - 1000);
      // Attacker sets createdAt far in the past to claim "pre-cutoff" status; the
      // server ignores it and uses its own ingest clock, so the entry is rejected.
      const backdated = await makeEntry(author, {
        entryVersion: undefined,
        metadataSignature: undefined,
        createdAt: 1_000_000_000_000,
      });
      const ack = await server.handlePutEntries("token", [backdated]);
      expect(ack.receipts).toHaveLength(0);
      expect(ack.rejected).toEqual([
        { id: backdated.id, reason: expect.stringContaining("v2 metadata signature") },
      ]);
      expect(await localStore.getAllIds()).toHaveLength(0);
    });

    it("exempts the directory store from the floor", async () => {
      const author = await generateAuthor();
      const localStore = new InMemoryContentAddressedStore("directory", StoreKind.docs);
      const server = plainServer(localStore, Date.now() - 1000, "directory");
      const v1 = await makeEntry(author, {
        entryVersion: undefined,
        metadataSignature: undefined,
        docId: "directory",
        id: `directory_d_0_${Math.random().toString(36).slice(2)}`,
      });
      await expect(server.handlePutEntries("token", [v1])).resolves.toMatchObject({
        receipts: [expect.objectContaining({ id: v1.id })],
        rejected: [],
      });
    });

    it("imposes no floor when the directory reports no cutoff", async () => {
      const author = await generateAuthor();
      const localStore = new InMemoryContentAddressedStore(dbid, StoreKind.docs);
      const server = plainServer(localStore, undefined);
      const v1 = await makeEntry(author, { entryVersion: undefined, metadataSignature: undefined });
      await expect(server.handlePutEntries("token", [v1])).resolves.toMatchObject({
        receipts: [expect.objectContaining({ id: v1.id })],
        rejected: [],
      });
    });
  });
});
