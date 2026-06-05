import { StoreEntryMetadata } from "../../types";
import type { WitnessSigner } from "../../crypto/WitnessReceipt";
import { stampEntryReceipt } from "../../crypto/WitnessReceipt";
import { WitnessReceiptValidator } from "../receiptValidation";
import type { ReceiptValidationContext, ReceiptValidationResult } from "../receiptValidation";
import {
  ED25519_WITNESS_SCHEME,
  StampedReceipt,
  TimestampProvider,
  TimestampStampContext,
  TimestampVerifier,
  TimestampableEntry,
} from "./TimestampProvider";

/**
 * The v1 {@link TimestampProvider}: an Ed25519 receipt stamped by a trusted sync
 * server ("witness", docs/accesscontrol.md §5). This is a thin facade over the
 * existing primitives — {@link stampEntryReceipt} on the issue side and
 * {@link WitnessReceiptValidator} on the verify side — so behavior is identical
 * to the pre-abstraction code; the seam exists only so other schemes (e.g. an
 * RFC 3161 TSA) can be added later without touching call sites.
 */
export class Ed25519WitnessProvider implements TimestampProvider {
  readonly kind = ED25519_WITNESS_SCHEME;

  /** The witness signing identity; undefined for a verify-only provider (clients). */
  private readonly signer?: WitnessSigner;
  private readonly subtle: SubtleCrypto;

  /**
   * @param opts.signer The witness identity used to stamp receipts. Omit on
   *   clients that only verify.
   * @param opts.subtle WebCrypto used for signing/verifying. When a signer is
   *   provided this is typically `signer.subtle`.
   */
  constructor(opts: { signer?: WitnessSigner; subtle: SubtleCrypto }) {
    this.signer = opts.signer;
    this.subtle = opts.subtle;
  }

  get issuerPublicKey(): string | undefined {
    return this.signer?.publicKeyPem;
  }

  get canStamp(): boolean {
    return this.signer !== undefined;
  }

  async stamp(entry: TimestampableEntry, ctx: TimestampStampContext): Promise<StampedReceipt> {
    if (!this.signer) {
      throw new Error("Ed25519WitnessProvider.stamp called on a verify-only provider (no signer configured)");
    }
    const stamp = await stampEntryReceipt(entry, ctx, this.signer);
    return { ...stamp, receiptScheme: this.kind };
  }

  createVerifier(initialLastSeen?: Map<string, number>): TimestampVerifier {
    return new Ed25519WitnessVerifier(this.subtle, initialLastSeen);
  }
}

/**
 * Verifier adapter for {@link Ed25519WitnessProvider}. Wraps a
 * {@link WitnessReceiptValidator} (which carries the per-witness `receivedAt`
 * monotonicity state, §5.4) and first guards on the receipt scheme tag: with no
 * router yet, a receipt declaring any other scheme is cleanly rejected rather
 * than misinterpreted as Ed25519.
 */
class Ed25519WitnessVerifier implements TimestampVerifier {
  private readonly inner: WitnessReceiptValidator;

  constructor(private readonly subtle: SubtleCrypto, initialLastSeen?: Map<string, number>) {
    this.inner = new WitnessReceiptValidator(initialLastSeen);
  }

  async validate(entry: StoreEntryMetadata, ctx: ReceiptValidationContext): Promise<ReceiptValidationResult> {
    // Absence means the default Ed25519 witness scheme (legacy entries predate
    // the tag). Any explicit, non-Ed25519 scheme cannot be verified here.
    if (entry.receiptScheme !== undefined && entry.receiptScheme !== ED25519_WITNESS_SCHEME) {
      return { ok: false, reason: `unsupported receipt scheme: ${entry.receiptScheme}` };
    }
    return this.inner.validate(entry, ctx, this.subtle);
  }
}
