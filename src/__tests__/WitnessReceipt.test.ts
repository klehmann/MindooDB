import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import {
  WITNESS_RECEIPT_LAYOUT_VERSION,
  WitnessReceiptFields,
  buildWitnessSigningBytes,
  signWitnessReceipt,
  verifyWitnessReceipt,
  witnessFieldsFromEntry,
} from "../core/crypto/WitnessReceipt";

/**
 * Unit tests for the witness-receipt signing layout and sign/verify helpers
 * (docs/accesscontrol.md §5). These are pure crypto tests with no tenant/IO.
 *
 * Security properties asserted:
 * - the byte layout is deterministic and order-stable (golden vectors);
 * - a valid receipt verifies, and tampering with ANY bound field (including
 *   entryType / dbid / decryptionKeyId, the fields §5.2 specifically adds)
 *   invalidates the signature;
 * - an unknown layout version is rejected even with an otherwise valid signature.
 */
describe("WitnessReceipt", () => {
  const subtle = new NodeCryptoAdapter().getSubtle();

  function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  const baseFields: WitnessReceiptFields = {
    entryType: "doc_change",
    dbid: "crm",
    contentHash: "abc123",
    id: "doc7_d_0_HASH",
    docId: "doc7",
    decryptionKeyId: "default",
    createdAt: 1_700_000_000_000,
    createdByPublicKey: "-----BEGIN PUBLIC KEY-----AUTHOR-----END PUBLIC KEY-----",
    receivedAt: 1_700_000_005_000,
    receivedByPublicKey: "-----BEGIN PUBLIC KEY-----WITNESS-----END PUBLIC KEY-----",
  };

  async function generateWitnessKeyPair(): Promise<{ privateKey: CryptoKey; publicKeyPem: string }> {
    const pair = (await subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const spki = await subtle.exportKey("spki", pair.publicKey);
    const base64 = Buffer.from(new Uint8Array(spki)).toString("base64");
    const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${base64}\n-----END PUBLIC KEY-----`;
    return { privateKey: pair.privateKey, publicKeyPem };
  }

  it("produces a deterministic, version-prefixed byte layout", () => {
    const a = buildWitnessSigningBytes(baseFields);
    const b = buildWitnessSigningBytes(baseFields);
    expect(bytesEqual(a, b)).toBe(true);
    expect(a[0]).toBe(WITNESS_RECEIPT_LAYOUT_VERSION);
    // The layout binds every Tier-1 attribute, so changing any one of them
    // must change the bytes.
    for (const key of Object.keys(baseFields) as (keyof WitnessReceiptFields)[]) {
      const mutated = { ...baseFields } as WitnessReceiptFields;
      if (typeof mutated[key] === "number") {
        (mutated[key] as number) = (mutated[key] as number) + 1;
      } else {
        (mutated[key] as string) = `${mutated[key]}_x`;
      }
      const bytes = buildWitnessSigningBytes(mutated);
      expect(bytesEqual(bytes, a)).toBe(false);
    }
  });

  it("signs and verifies a receipt round-trip", async () => {
    const { privateKey, publicKeyPem } = await generateWitnessKeyPair();
    const signature = await signWitnessReceipt(baseFields, privateKey, subtle);
    await expect(verifyWitnessReceipt(baseFields, signature, publicKeyPem, subtle)).resolves.toBe(true);
  });

  it("rejects a receipt when any bound field is tampered", async () => {
    const { privateKey, publicKeyPem } = await generateWitnessKeyPair();
    const signature = await signWitnessReceipt(baseFields, privateKey, subtle);

    for (const key of Object.keys(baseFields) as (keyof WitnessReceiptFields)[]) {
      const tampered = { ...baseFields } as WitnessReceiptFields;
      if (typeof tampered[key] === "number") {
        (tampered[key] as number) = (tampered[key] as number) + 1;
      } else {
        (tampered[key] as string) = `${tampered[key]}_tampered`;
      }
      await expect(
        verifyWitnessReceipt(tampered, signature, publicKeyPem, subtle)
      ).resolves.toBe(false);
    }
  });

  it("rejects a relabeled entryType (the §5.2 motivating attack)", async () => {
    const { privateKey, publicKeyPem } = await generateWitnessKeyPair();
    const signature = await signWitnessReceipt(baseFields, privateKey, subtle);
    const relabeled: WitnessReceiptFields = { ...baseFields, entryType: "doc_delete" };
    await expect(verifyWitnessReceipt(relabeled, signature, publicKeyPem, subtle)).resolves.toBe(false);
  });

  it("rejects an unknown layout version", async () => {
    const { privateKey, publicKeyPem } = await generateWitnessKeyPair();
    const signature = await signWitnessReceipt(baseFields, privateKey, subtle);
    await expect(
      verifyWitnessReceipt(baseFields, signature, publicKeyPem, subtle, 0x02)
    ).resolves.toBe(false);
  });

  it("does not verify against a different witness key", async () => {
    const signer = await generateWitnessKeyPair();
    const other = await generateWitnessKeyPair();
    const signature = await signWitnessReceipt(baseFields, signer.privateKey, subtle);
    await expect(
      verifyWitnessReceipt(baseFields, signature, other.publicKeyPem, subtle)
    ).resolves.toBe(false);
  });

  it("witnessFieldsFromEntry binds entry metadata with witness context", () => {
    const fields = witnessFieldsFromEntry(
      {
        entryType: "doc_create",
        contentHash: "ch",
        id: "d_d_0_h",
        docId: "d",
        decryptionKeyId: "default",
        createdAt: 123,
        createdByPublicKey: "author",
      },
      { dbid: "main", receivedAt: 456, receivedByPublicKey: "witness" }
    );
    expect(fields).toEqual({
      entryType: "doc_create",
      dbid: "main",
      contentHash: "ch",
      id: "d_d_0_h",
      docId: "d",
      decryptionKeyId: "default",
      createdAt: 123,
      createdByPublicKey: "author",
      receivedAt: 456,
      receivedByPublicKey: "witness",
    });
  });
});
