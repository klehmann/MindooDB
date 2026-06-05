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

  function entry(overrides: Partial<StoreEntry> = {}): StoreEntry {
    return {
      entryType: "doc_change",
      id: `doc7_d_0_${Math.random().toString(36).slice(2)}`,
      contentHash: "abc123",
      docId: "doc7",
      dependencyIds: [],
      createdAt: 1_700_000_000_000,
      createdByPublicKey: "-----BEGIN PUBLIC KEY-----AUTHOR-----END PUBLIC KEY-----",
      decryptionKeyId: "default",
      originalSize: 3,
      encryptedSize: 3,
      signature: new Uint8Array([1, 2, 3]),
      encryptedData: new Uint8Array([9, 9, 9]),
      // Witness-era writer by default: only versioned entries are eligible for
      // a receipt. Legacy entries omit this (see the legacy test below).
      entryVersion: CURRENT_STORE_ENTRY_VERSION,
      ...overrides,
    } as StoreEntry;
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

    const e = entry();
    const receipts = await server.handlePutEntries("token", [e]);

    // The receipt round-trips through the validator as a trusted, valid receipt.
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

    const e = entry({ createdByPublicKey: signer.publicKeyPem });
    const receipts = await server.handlePutEntries("token", [e]);
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
    const legacy = entry({ entryVersion: undefined });
    const receipts = await server.handlePutEntries("token", [legacy]);

    expect(receipts).toHaveLength(1);
    expect(receipts[0].receivedAt).toBeUndefined();
    expect(receipts[0].receivedByPublicKey).toBeUndefined();
    expect(receipts[0].receivedDateSignature).toBeUndefined();

    // And nothing was witnessed in the persisted copy either.
    const stored = (await localStore.getEntries([legacy.id]))[0];
    expect(stored.receivedAt).toBeUndefined();
    expect(stored.receivedDateSignature).toBeUndefined();
  });

  it("rejects a push denied by the Tier 1 evaluator with ACCESS_DENIED", async () => {
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

    await expect(server.handlePutEntries("token", [entry()])).rejects.toBeInstanceOf(NetworkError);
    // Nothing should have been persisted.
    expect(await localStore.getAllIds()).toHaveLength(0);
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
    const e = entry();
    const receipts = await server.handlePutEntries("token", [e]);
    expect(receipts[0].receivedDateSignature).toBeUndefined();
    const caps = await server.handleGetCapabilities("token");
    expect(caps.supportsAccessControlV1).toBe(false);
  });
});
