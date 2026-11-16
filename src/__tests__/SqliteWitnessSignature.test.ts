import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { SqliteContentAddressedStore } from "../core/appendonlystores/sqlite/SqliteContentAddressedStore";
import { createMemorySqliteBackend } from "../core/appendonlystores/sqlite/SqliteDriver";
import { stampEntryReceipt, WitnessSigner } from "../core/crypto/WitnessReceipt";
import { WitnessReceiptValidator } from "../core/accesscontrol/receiptValidation";
import { StoreKind } from "../core/appendonlystores/types";
import type { StoreEntry } from "../core/types";

/**
 * A witness receipt (docs/accesscontrol.md §5) stored in the SQLite store must
 * come back as bytes that still verify. Desktop and the native apps keep all
 * entries in this store, so a receipt that does not survive the metadata JSON
 * round trip is rejected as "invalid witness signature" after a reload.
 */
describe("SqliteContentAddressedStore witness signature", () => {
  const subtle = new NodeCryptoAdapter().getSubtle();
  const DBID = "witness-db";

  async function generateSigner(): Promise<WitnessSigner> {
    const pair = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const spki = await subtle.exportKey("spki", pair.publicKey);
    const base64 = Buffer.from(new Uint8Array(spki)).toString("base64");
    return {
      publicKeyPem: `-----BEGIN PUBLIC KEY-----\n${base64}\n-----END PUBLIC KEY-----`,
      signingPrivateKey: pair.privateKey,
      subtle,
    };
  }

  function entry(): StoreEntry {
    return {
      entryType: "doc_change",
      id: "docS_d_0_HASH",
      contentHash: "contentS",
      docId: "docS",
      dependencyIds: [],
      createdAt: 1_700_000_000_000,
      createdByPublicKey: "-----BEGIN PUBLIC KEY-----AUTHOR-----END PUBLIC KEY-----",
      decryptionKeyId: "default",
      signature: new Uint8Array([1, 2, 3, 4]),
      originalSize: 3,
      encryptedSize: 3,
      encryptedData: new Uint8Array([7, 8, 9]),
    };
  }

  async function witnessed(signer: WitnessSigner): Promise<StoreEntry> {
    const base = entry();
    const stamp = await stampEntryReceipt(base, { dbid: DBID, receivedAt: 1_700_000_005_000 }, signer);
    return { ...base, ...stamp };
  }

  async function validate(store: SqliteContentAddressedStore, signer: WitnessSigner) {
    const meta = await store.getEntryMetadata("docS_d_0_HASH");
    expect(meta).toBeTruthy();
    expect(meta!.receivedDateSignature).toBeInstanceOf(Uint8Array);
    return new WitnessReceiptValidator().validate(
      meta!,
      { dbid: DBID, trustedWitnessKeys: new Set([signer.publicKeyPem]), nowMs: 1_700_000_010_000 },
      subtle,
    );
  }

  it("keeps a receipt verifiable after putEntries and reopen", async () => {
    const signer = await generateSigner();
    const backend = createMemorySqliteBackend();
    const first = new SqliteContentAddressedStore(DBID, StoreKind.docs, backend);
    const original = await witnessed(signer);
    await first.putEntries([original]);

    const reopened = new SqliteContentAddressedStore(DBID, StoreKind.docs, backend);
    expect(await validate(reopened, signer)).toMatchObject({ ok: true });
    const [full] = await reopened.getEntries(["docS_d_0_HASH"]);
    expect(Array.from(full.receivedDateSignature!)).toEqual(Array.from(original.receivedDateSignature!));
  });

  it("keeps a receipt verifiable after applyWitnessReceipts and reopen", async () => {
    const signer = await generateSigner();
    const backend = createMemorySqliteBackend();
    const first = new SqliteContentAddressedStore(DBID, StoreKind.docs, backend);
    await first.putEntries([entry()]);
    const { encryptedData: _data, ...receipt } = await witnessed(signer);
    await first.applyWitnessReceipts([receipt]);

    const reopened = new SqliteContentAddressedStore(DBID, StoreKind.docs, backend);
    expect(await validate(reopened, signer)).toMatchObject({ ok: true });
  });

  it("stores the receipt signature as base64, not as an index-keyed object", async () => {
    const signer = await generateSigner();
    const backend = createMemorySqliteBackend();
    const store = new SqliteContentAddressedStore(DBID, StoreKind.docs, backend);
    await store.putEntries([await witnessed(signer)]);
    const [json] = await backend.getAllMetadataJson();
    const parsed = JSON.parse(json);
    expect(typeof parsed.receivedDateSignature).toBe("string");
  });

  it("reads receipts written in the old index-keyed object form", async () => {
    const signer = await generateSigner();
    const backend = createMemorySqliteBackend();
    const store = new SqliteContentAddressedStore(DBID, StoreKind.docs, backend);
    const original = await witnessed(signer);
    await store.putEntries([entry()]);
    // What earlier versions wrote: JSON.stringify of a Uint8Array.
    const [json] = await backend.getAllMetadataJson();
    const legacy = { ...JSON.parse(json), ...original, encryptedData: undefined };
    const legacyJson = JSON.stringify({
      ...legacy,
      signature: Buffer.from(original.signature).toString("base64"),
    });
    expect(legacyJson).toContain('"receivedDateSignature":{"0":');
    await backend.updateEntryMeta(original.id, legacyJson, legacy.receiptOrder ?? 1);

    const reopened = new SqliteContentAddressedStore(DBID, StoreKind.docs, backend);
    expect(await validate(reopened, signer)).toMatchObject({ ok: true });
  });
});
