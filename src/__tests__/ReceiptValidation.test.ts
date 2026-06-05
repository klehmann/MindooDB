import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import type { StoreEntry, StoreEntryMetadata } from "../core/types";
import { stampEntryReceipt, WitnessSigner } from "../core/crypto/WitnessReceipt";
import {
  WitnessReceiptValidator,
  checkClockSkew,
  trustedTimeOf,
  negotiateSync,
  DEFAULT_CLOCK_SKEW_TOLERANCE_MS,
} from "../core/accesscontrol/receiptValidation";

/**
 * Tests for the receipt-time validation and clock-skew guard
 * (docs/accesscontrol.md §4, §5.4). These cover the adversarial cases the spec
 * calls out: receipts from untrusted witnesses, forged signatures, non-monotonic
 * (backdated) `receivedAt`, and implausible wall-clock values.
 */
describe("receiptValidation", () => {
  const subtle = new NodeCryptoAdapter().getSubtle();

  async function generateSigner(): Promise<WitnessSigner> {
    const pair = (await subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const spki = await subtle.exportKey("spki", pair.publicKey);
    const base64 = Buffer.from(new Uint8Array(spki)).toString("base64");
    const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${base64}\n-----END PUBLIC KEY-----`;
    return { publicKeyPem, signingPrivateKey: pair.privateKey, subtle };
  }

  function baseEntry(overrides: Partial<StoreEntryMetadata> = {}): StoreEntry {
    return {
      entryType: "doc_change",
      id: "doc7_d_0_HASH",
      contentHash: "abc123",
      docId: "doc7",
      dependencyIds: [],
      createdAt: 1_700_000_000_000,
      createdByPublicKey: "-----BEGIN PUBLIC KEY-----AUTHOR-----END PUBLIC KEY-----",
      decryptionKeyId: "default",
      originalSize: 10,
      encryptedSize: 20,
      signature: new Uint8Array([1, 2, 3]),
      encryptedData: new Uint8Array([9, 9, 9]),
      ...overrides,
    } as StoreEntry;
  }

  describe("checkClockSkew", () => {
    it("accepts clocks within tolerance", () => {
      const r = checkClockSkew(1000, 1000 + 60_000);
      expect(r.ok).toBe(true);
      expect(r.skewMs).toBe(60_000);
    });

    it("rejects clocks beyond tolerance", () => {
      const r = checkClockSkew(1000, 1000 + DEFAULT_CLOCK_SKEW_TOLERANCE_MS + 1);
      expect(r.ok).toBe(false);
    });

    it("is symmetric (local ahead or behind)", () => {
      const ahead = checkClockSkew(1000 + 10_000, 1000);
      const behind = checkClockSkew(1000, 1000 + 10_000);
      expect(ahead.skewMs).toBe(behind.skewMs);
    });
  });

  describe("negotiateSync", () => {
    it("proceeds when clocks agree and no strict mode", () => {
      const r = negotiateSync(1000, { serverTime: 1000 + 1000, supportsAccessControlV1: true });
      expect(r.ok).toBe(true);
      expect(r.accessControlAvailable).toBe(true);
      expect(r.clockSkew?.ok).toBe(true);
    });

    it("refuses when clocks diverge beyond tolerance", () => {
      const r = negotiateSync(1000, { serverTime: 1000 + DEFAULT_CLOCK_SKEW_TOLERANCE_MS + 1 });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/clock skew/);
    });

    it("refuses in strict mode against a server without access control v1", () => {
      const r = negotiateSync(1000, { serverTime: 1000, supportsAccessControlV1: false }, { strictMode: true });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/strict mode/);
    });

    it("proceeds against a legacy server when not in strict mode", () => {
      const r = negotiateSync(1000, { serverTime: 1000, supportsAccessControlV1: false });
      expect(r.ok).toBe(true);
      expect(r.accessControlAvailable).toBe(false);
    });

    it("proceeds when the server does not report its time (no skew gate)", () => {
      const r = negotiateSync(1000, { supportsAccessControlV1: true });
      expect(r.ok).toBe(true);
      expect(r.clockSkew).toBeUndefined();
    });
  });

  describe("trustedTimeOf", () => {
    it("prefers receivedAt over createdAt", () => {
      expect(trustedTimeOf({ createdAt: 100, receivedAt: 200 })).toBe(200);
    });
    it("falls back to createdAt when no receipt", () => {
      expect(trustedTimeOf({ createdAt: 100 })).toBe(100);
    });
  });

  describe("WitnessReceiptValidator", () => {
    const dbid = "crm";

    it("treats an entry with no receipt as a local entry", async () => {
      const validator = new WitnessReceiptValidator();
      const result = await validator.validate(baseEntry(), {
        dbid,
        trustedWitnessKeys: new Set(),
        nowMs: 1_700_000_010_000,
      }, subtle);
      expect(result.ok).toBe(true);
      expect(result.noReceipt).toBe(true);
    });

    it("accepts a valid receipt from a trusted witness", async () => {
      const signer = await generateSigner();
      const entry = baseEntry();
      const stamp = await stampEntryReceipt(entry, { dbid, receivedAt: 1_700_000_005_000 }, signer);
      const witnessed = { ...entry, ...stamp };

      const validator = new WitnessReceiptValidator();
      const result = await validator.validate(witnessed, {
        dbid,
        trustedWitnessKeys: new Set([signer.publicKeyPem]),
        nowMs: 1_700_000_010_000,
      }, subtle);
      expect(result.ok).toBe(true);
    });

    it("rejects a receipt from an untrusted witness", async () => {
      const signer = await generateSigner();
      const entry = baseEntry();
      const stamp = await stampEntryReceipt(entry, { dbid, receivedAt: 1_700_000_005_000 }, signer);
      const witnessed = { ...entry, ...stamp };

      const validator = new WitnessReceiptValidator();
      const result = await validator.validate(witnessed, {
        dbid,
        trustedWitnessKeys: new Set(["-----BEGIN PUBLIC KEY-----OTHER-----END PUBLIC KEY-----"]),
        nowMs: 1_700_000_010_000,
      }, subtle);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/untrusted/);
    });

    it("rejects a forged signature", async () => {
      const signer = await generateSigner();
      const entry = baseEntry();
      const stamp = await stampEntryReceipt(entry, { dbid, receivedAt: 1_700_000_005_000 }, signer);
      // Tamper with the signature bytes.
      const forged = { ...entry, ...stamp, receivedDateSignature: new Uint8Array(stamp.receivedDateSignature.length) };

      const validator = new WitnessReceiptValidator();
      const result = await validator.validate(forged, {
        dbid,
        trustedWitnessKeys: new Set([signer.publicKeyPem]),
        nowMs: 1_700_000_010_000,
      }, subtle);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/invalid witness signature/);
    });

    it("rejects a receipt bound to a different db (replay across databases)", async () => {
      const signer = await generateSigner();
      const entry = baseEntry();
      const stamp = await stampEntryReceipt(entry, { dbid: "other-db", receivedAt: 1_700_000_005_000 }, signer);
      const witnessed = { ...entry, ...stamp };

      const validator = new WitnessReceiptValidator();
      const result = await validator.validate(witnessed, {
        dbid, // validate under "crm", but signed for "other-db"
        trustedWitnessKeys: new Set([signer.publicKeyPem]),
        nowMs: 1_700_000_010_000,
      }, subtle);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/invalid witness signature/);
    });

    it("enforces per-witness monotonic receivedAt", async () => {
      const signer = await generateSigner();
      const trustedWitnessKeys = new Set([signer.publicKeyPem]);
      const validator = new WitnessReceiptValidator();

      const e1 = baseEntry({ id: "a" });
      const s1 = await stampEntryReceipt(e1, { dbid, receivedAt: 2000 }, signer);
      const r1 = await validator.validate({ ...e1, ...s1 }, { dbid, trustedWitnessKeys, nowMs: 1_700_000_010_000 }, subtle);
      expect(r1.ok).toBe(true);

      // A later entry stamped with an EARLIER receivedAt must be rejected.
      const e2 = baseEntry({ id: "b" });
      const s2 = await stampEntryReceipt(e2, { dbid, receivedAt: 1000 }, signer);
      const r2 = await validator.validate({ ...e2, ...s2 }, { dbid, trustedWitnessKeys, nowMs: 1_700_000_010_000 }, subtle);
      expect(r2.ok).toBe(false);
      expect(r2.reason).toMatch(/non-monotonic/);
    });

    it("rejects an implausibly far-future receivedAt", async () => {
      const signer = await generateSigner();
      const entry = baseEntry();
      const farFuture = 1_700_000_005_000;
      const stamp = await stampEntryReceipt(entry, { dbid, receivedAt: farFuture }, signer);
      const witnessed = { ...entry, ...stamp };

      const validator = new WitnessReceiptValidator();
      const result = await validator.validate(witnessed, {
        dbid,
        trustedWitnessKeys: new Set([signer.publicKeyPem]),
        nowMs: farFuture - DEFAULT_CLOCK_SKEW_TOLERANCE_MS - 10_000,
      }, subtle);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/future/);
    });

    it("flags (but accepts) an implausibly old receivedAt", async () => {
      const signer = await generateSigner();
      const entry = baseEntry();
      const stamp = await stampEntryReceipt(entry, { dbid, receivedAt: 1000 }, signer);
      const witnessed = { ...entry, ...stamp };

      const validator = new WitnessReceiptValidator();
      const result = await validator.validate(witnessed, {
        dbid,
        trustedWitnessKeys: new Set([signer.publicKeyPem]),
        nowMs: 1000 + 2 * 365 * 24 * 60 * 60 * 1000,
      }, subtle);
      expect(result.ok).toBe(true);
      expect(result.flaggedImplausiblePast).toBe(true);
    });
  });
});
