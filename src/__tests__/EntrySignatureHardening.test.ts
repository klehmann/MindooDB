/**
 * Regression tests for the security-hardening crypto primitives:
 *  - cross-version author signatures (legacy ciphertext-only vs. v2
 *    metadata-binding) and tamper rejection (audit #5);
 *  - the PBKDF2 stored-iteration floor (audit #3).
 */

import { webcrypto } from "crypto";
import {
  buildEntrySigningBytes,
  entrySignatureFieldsFromEntry,
  signEntryMetadata,
  verifyEntrySignatureCrypto,
} from "../core/crypto/EntrySignature";
import {
  resolveStoredIterations,
  MIN_PBKDF2_ITERATIONS,
  DEFAULT_PBKDF2_ITERATIONS,
} from "../core/crypto/pbkdf2Iterations";
import type { StoreEntryMetadata } from "../core/types";

const subtle = webcrypto.subtle as unknown as SubtleCrypto;

async function generateEd25519(): Promise<{ privateKey: CryptoKey; publicKeyPem: string }> {
  const pair = (await subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(await subtle.exportKey("spki", pair.publicKey));
  let bin = "";
  for (const b of spki) bin += String.fromCharCode(b);
  const b64 = Buffer.from(bin, "binary").toString("base64");
  const pem = `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----`;
  return { privateKey: pair.privateKey, publicKeyPem: pem };
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await subtle.digest("SHA-256", data.buffer as ArrayBuffer));
  return Array.from(digest)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("entry author signatures (audit #5)", () => {
  const encryptedData = new Uint8Array([1, 2, 3, 4, 5]);

  async function baseMeta(publicKeyPem: string): Promise<StoreEntryMetadata> {
    return {
      entryType: "doc_change",
      id: "entry-1",
      contentHash: await sha256Hex(encryptedData),
      docId: "doc-1",
      dependencyIds: ["dep-a", "dep-b"],
      createdAt: 1_700_000_000_000,
      createdByPublicKey: publicKeyPem,
      decryptionKeyId: "default",
      signature: new Uint8Array(),
      originalSize: 5,
      encryptedSize: encryptedData.length,
    } as StoreEntryMetadata;
  }

  test("v2 metadata-binding signature round-trips and verifies", async () => {
    const { privateKey, publicKeyPem } = await generateEd25519();
    const meta = await baseMeta(publicKeyPem);
    meta.metadataSignature = await signEntryMetadata(
      entrySignatureFieldsFromEntry(meta),
      privateKey,
      subtle,
    );

    expect(await verifyEntrySignatureCrypto(meta, encryptedData, publicKeyPem, subtle)).toBe(true);
  });

  test("tampering any bound metadata field invalidates the v2 signature", async () => {
    const { privateKey, publicKeyPem } = await generateEd25519();
    const meta = await baseMeta(publicKeyPem);
    meta.metadataSignature = await signEntryMetadata(
      entrySignatureFieldsFromEntry(meta),
      privateKey,
      subtle,
    );

    // Relabel the operation type — exactly the metadata-tweak attack #5 closes.
    const tampered = { ...meta, entryType: "doc_delete" } as StoreEntryMetadata & {
      metadataSignature?: Uint8Array;
    };
    expect(
      await verifyEntrySignatureCrypto(tampered, encryptedData, publicKeyPem, subtle),
    ).toBe(false);

    // Tampering docId is likewise rejected.
    const tampered2 = { ...meta, docId: "doc-evil" } as StoreEntryMetadata & {
      metadataSignature?: Uint8Array;
    };
    expect(
      await verifyEntrySignatureCrypto(tampered2, encryptedData, publicKeyPem, subtle),
    ).toBe(false);
  });

  test("legacy entries (no metadataSignature) verify via the ciphertext signature", async () => {
    const { privateKey, publicKeyPem } = await generateEd25519();
    const meta = await baseMeta(publicKeyPem);
    // Legacy: sign only the encrypted payload, no metadataSignature present.
    meta.signature = new Uint8Array(
      await subtle.sign({ name: "Ed25519" }, privateKey, encryptedData.buffer as ArrayBuffer),
    );

    expect(meta.metadataSignature).toBeUndefined();
    expect(await verifyEntrySignatureCrypto(meta, encryptedData, publicKeyPem, subtle)).toBe(true);

    // A wrong ciphertext fails the legacy check.
    expect(
      await verifyEntrySignatureCrypto(meta, new Uint8Array([9, 9, 9]), publicKeyPem, subtle),
    ).toBe(false);
  });

  test("buildEntrySigningBytes is deterministic and order-sensitive on deps", () => {
    const fields = entrySignatureFieldsFromEntry({
      entryType: "doc_change",
      id: "e",
      docId: "d",
      decryptionKeyId: "default",
      createdAt: 1,
      dependencyIds: ["a", "b"],
      contentHash: "h",
      createdByPublicKey: "k",
    });
    const toHex = (u: Uint8Array) =>
      Array.from(u).map((x) => x.toString(16).padStart(2, "0")).join("");
    const a = toHex(buildEntrySigningBytes(fields));
    const b = toHex(buildEntrySigningBytes(fields));
    expect(a).toEqual(b);

    const swapped = toHex(buildEntrySigningBytes({ ...fields, dependencyIds: ["b", "a"] }));
    expect(a).not.toEqual(swapped);
  });
});

describe("attachmentRefs signed trailing block (backward-compatible extension)", () => {
  const encryptedData = new Uint8Array([7, 7, 7]);
  const toHex = (u: Uint8Array) =>
    Array.from(u).map((x) => x.toString(16).padStart(2, "0")).join("");

  async function baseFields(): Promise<
    Pick<
      StoreEntryMetadata,
      | "entryType"
      | "id"
      | "docId"
      | "decryptionKeyId"
      | "createdAt"
      | "dependencyIds"
      | "contentHash"
      | "createdByPublicKey"
    >
  > {
    return {
      entryType: "doc_change",
      id: "entry-1",
      docId: "doc-1",
      decryptionKeyId: "default",
      createdAt: 1_700_000_000_000,
      dependencyIds: ["dep-a"],
      contentHash: await sha256Hex(encryptedData),
      createdByPublicKey: "k",
    };
  }

  test("empty, undefined, and absent attachmentRefs all produce identical (legacy) bytes", async () => {
    const fields = await baseFields();
    const absent = toHex(buildEntrySigningBytes(entrySignatureFieldsFromEntry({ ...fields })));
    const emptyArr = toHex(
      buildEntrySigningBytes(entrySignatureFieldsFromEntry({ ...fields, attachmentRefs: [] })),
    );
    const undef = toHex(
      buildEntrySigningBytes(
        entrySignatureFieldsFromEntry({ ...fields, attachmentRefs: undefined }),
      ),
    );
    expect(emptyArr).toEqual(absent);
    expect(undef).toEqual(absent);
  });

  test("non-empty attachmentRefs change the signed bytes (the block is bound)", async () => {
    const fields = await baseFields();
    const without = toHex(buildEntrySigningBytes(entrySignatureFieldsFromEntry({ ...fields })));
    const withRefs = toHex(
      buildEntrySigningBytes(
        entrySignatureFieldsFromEntry({
          ...fields,
          attachmentRefs: [{ attachmentId: "att-1", lastChunkId: "chunk-1", size: 42 }],
        }),
      ),
    );
    expect(withRefs).not.toEqual(without);
  });

  test("ref order, ids, and size are all order/content sensitive", async () => {
    const fields = await baseFields();
    const a = { attachmentId: "att-a", lastChunkId: "chunk-a", size: 10 };
    const b = { attachmentId: "att-b", lastChunkId: "chunk-b", size: 20 };
    const ab = toHex(
      buildEntrySigningBytes(entrySignatureFieldsFromEntry({ ...fields, attachmentRefs: [a, b] })),
    );
    const ba = toHex(
      buildEntrySigningBytes(entrySignatureFieldsFromEntry({ ...fields, attachmentRefs: [b, a] })),
    );
    expect(ab).not.toEqual(ba);

    const sizeChanged = toHex(
      buildEntrySigningBytes(
        entrySignatureFieldsFromEntry({
          ...fields,
          attachmentRefs: [{ ...a, size: 11 }, b],
        }),
      ),
    );
    expect(sizeChanged).not.toEqual(ab);

    const chunkChanged = toHex(
      buildEntrySigningBytes(
        entrySignatureFieldsFromEntry({
          ...fields,
          attachmentRefs: [{ ...a, lastChunkId: "chunk-evil" }, b],
        }),
      ),
    );
    expect(chunkChanged).not.toEqual(ab);
  });

  test("a signed attachment-bearing entry verifies; tampering or stripping refs fails", async () => {
    const { privateKey, publicKeyPem } = await generateEd25519();
    const fields = await baseFields();
    const meta = {
      ...fields,
      createdByPublicKey: publicKeyPem,
      signature: new Uint8Array(),
      originalSize: 3,
      encryptedSize: encryptedData.length,
      attachmentRefs: [{ attachmentId: "att-1", lastChunkId: "chunk-1", size: 42 }],
    } as unknown as StoreEntryMetadata;
    meta.metadataSignature = await signEntryMetadata(
      entrySignatureFieldsFromEntry(meta),
      privateKey,
      subtle,
    );

    expect(await verifyEntrySignatureCrypto(meta, encryptedData, publicKeyPem, subtle)).toBe(true);

    // Tamper a ref's lastChunkId.
    const tampered = {
      ...meta,
      attachmentRefs: [{ attachmentId: "att-1", lastChunkId: "chunk-evil", size: 42 }],
    } as StoreEntryMetadata;
    expect(
      await verifyEntrySignatureCrypto(tampered, encryptedData, publicKeyPem, subtle),
    ).toBe(false);

    // Strip the refs entirely (relay claims the doc references nothing).
    const stripped = { ...meta, attachmentRefs: undefined } as StoreEntryMetadata;
    expect(
      await verifyEntrySignatureCrypto(stripped, encryptedData, publicKeyPem, subtle),
    ).toBe(false);
  });

  test("a legacy entry (no attachmentRefs) still verifies after the layout extension", async () => {
    const { privateKey, publicKeyPem } = await generateEd25519();
    const fields = await baseFields();
    const meta = {
      ...fields,
      createdByPublicKey: publicKeyPem,
      signature: new Uint8Array(),
      originalSize: 3,
      encryptedSize: encryptedData.length,
    } as unknown as StoreEntryMetadata;
    meta.metadataSignature = await signEntryMetadata(
      entrySignatureFieldsFromEntry(meta),
      privateKey,
      subtle,
    );
    expect(await verifyEntrySignatureCrypto(meta, encryptedData, publicKeyPem, subtle)).toBe(true);
  });
});

describe("PBKDF2 stored-iteration floor (audit #3)", () => {
  test("floors an attacker-lowered iteration count to the minimum", () => {
    expect(resolveStoredIterations(1)).toBe(MIN_PBKDF2_ITERATIONS);
    expect(resolveStoredIterations(0)).toBe(MIN_PBKDF2_ITERATIONS);
    expect(resolveStoredIterations(-5)).toBe(MIN_PBKDF2_ITERATIONS);
  });

  test("preserves a legitimate (>= floor) iteration count", () => {
    expect(resolveStoredIterations(DEFAULT_PBKDF2_ITERATIONS)).toBe(DEFAULT_PBKDF2_ITERATIONS);
    expect(resolveStoredIterations(MIN_PBKDF2_ITERATIONS + 1)).toBe(MIN_PBKDF2_ITERATIONS + 1);
  });

  test("falls back for missing / non-finite values", () => {
    expect(resolveStoredIterations(undefined)).toBeGreaterThanOrEqual(MIN_PBKDF2_ITERATIONS);
    expect(resolveStoredIterations(null)).toBeGreaterThanOrEqual(MIN_PBKDF2_ITERATIONS);
    expect(resolveStoredIterations(Number.NaN)).toBeGreaterThanOrEqual(MIN_PBKDF2_ITERATIONS);
  });
});
