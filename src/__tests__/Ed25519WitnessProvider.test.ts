import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import type { WitnessSigner } from "../core/crypto/WitnessReceipt";
import { Ed25519WitnessProvider } from "../core/accesscontrol/timestamp/Ed25519WitnessProvider";
import { ED25519_WITNESS_SCHEME } from "../core/accesscontrol/timestamp/TimestampProvider";
import type { StoreEntryMetadata } from "../core/types";

/**
 * Unit tests for the v1 {@link Ed25519WitnessProvider}: the issue side (stamp),
 * the verify side (createVerifier), the receipt-scheme discriminator, and the
 * verify-only configuration (docs/accesscontrol.md §5, §13).
 */
describe("Ed25519WitnessProvider", () => {
  const subtle = new NodeCryptoAdapter().getSubtle();
  const dbid = "crm";

  async function generateSigner(): Promise<WitnessSigner> {
    const pair = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const spki = await subtle.exportKey("spki", pair.publicKey);
    const base64 = Buffer.from(new Uint8Array(spki)).toString("base64");
    const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${base64}\n-----END PUBLIC KEY-----`;
    return { publicKeyPem, signingPrivateKey: pair.privateKey, subtle };
  }

  function entryMeta(overrides: Partial<StoreEntryMetadata> = {}): StoreEntryMetadata {
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
      ...overrides,
    } as StoreEntryMetadata;
  }

  it("stamps a receipt that round-trips through its own verifier", async () => {
    const signer = await generateSigner();
    const provider = new Ed25519WitnessProvider({ signer, subtle: signer.subtle });

    const base = entryMeta();
    const stamp = await provider.stamp(base, { dbid, receivedAt: Date.now() });
    expect(stamp.receivedByPublicKey).toBe(signer.publicKeyPem);
    expect(stamp.receivedAt).toBeGreaterThan(0);
    expect(stamp.receiptScheme).toBe(ED25519_WITNESS_SCHEME);

    const stamped: StoreEntryMetadata = { ...base, ...stamp };
    const verifier = provider.createVerifier();
    const result = await verifier.validate(stamped, {
      dbid,
      trustedWitnessKeys: new Set([signer.publicKeyPem]),
      nowMs: Date.now(),
    });
    expect(result.ok).toBe(true);
    expect(result.noReceipt).toBeFalsy();
  });

  it("verifies a legacy entry that carries no receiptScheme", async () => {
    const signer = await generateSigner();
    const provider = new Ed25519WitnessProvider({ signer, subtle: signer.subtle });
    const base = entryMeta();
    const stamp = await provider.stamp(base, { dbid, receivedAt: Date.now() });

    // Drop the scheme tag to emulate an entry stamped before the field existed.
    const legacy: StoreEntryMetadata = { ...base, ...stamp };
    delete (legacy as { receiptScheme?: string }).receiptScheme;

    const result = await provider.createVerifier().validate(legacy, {
      dbid,
      trustedWitnessKeys: new Set([signer.publicKeyPem]),
      nowMs: Date.now(),
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a receipt declaring an unknown scheme", async () => {
    const signer = await generateSigner();
    const provider = new Ed25519WitnessProvider({ signer, subtle: signer.subtle });
    const base = entryMeta();
    const stamp = await provider.stamp(base, { dbid, receivedAt: Date.now() });

    const foreign: StoreEntryMetadata = { ...base, ...stamp, receiptScheme: "rfc3161-tsa" };
    const result = await provider.createVerifier().validate(foreign, {
      dbid,
      trustedWitnessKeys: new Set([signer.publicKeyPem]),
      nowMs: Date.now(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("unsupported receipt scheme");
  });

  it("rejects a receipt from an untrusted witness key", async () => {
    const signer = await generateSigner();
    const provider = new Ed25519WitnessProvider({ signer, subtle: signer.subtle });
    const base = entryMeta();
    const stamp = await provider.stamp(base, { dbid, receivedAt: Date.now() });
    const stamped: StoreEntryMetadata = { ...base, ...stamp };

    const result = await provider.createVerifier().validate(stamped, {
      dbid,
      trustedWitnessKeys: new Set<string>(), // nobody trusted
      nowMs: Date.now(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("untrusted witness");
  });

  it("exposes the issuer public key and can stamp when a signer is configured", async () => {
    const signer = await generateSigner();
    const provider = new Ed25519WitnessProvider({ signer, subtle: signer.subtle });
    expect(provider.kind).toBe(ED25519_WITNESS_SCHEME);
    expect(provider.canStamp).toBe(true);
    expect(provider.issuerPublicKey).toBe(signer.publicKeyPem);
  });

  it("is verify-only (no stamping) when constructed without a signer", async () => {
    const provider = new Ed25519WitnessProvider({ subtle });
    expect(provider.canStamp).toBe(false);
    expect(provider.issuerPublicKey).toBeUndefined();
    await expect(provider.stamp(entryMeta(), { dbid, receivedAt: Date.now() })).rejects.toThrow(
      /verify-only provider/,
    );
  });
});
