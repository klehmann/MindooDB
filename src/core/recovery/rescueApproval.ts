/**
 * Rescue devices without device self-grant (docs/userkeys.md §12.9).
 *
 * Without self-grant the person cannot certify a rescue device. Instead the
 * administrator puts it on the person's grant, exactly like approving an
 * additional device (scenario C, §4.4): the person's device hands over a join
 * request for the rescue device's keys, and the admin grants it under the
 * person's name.
 *
 * A device on the grant normally waits for the person to approve it (§4.7),
 * because the admin could have planted it. A rescue device is approved
 * without a dialog, but only when its `rcv_`/`rpp_` document carries an
 * attestation: a signature over the rescue device's keys with the generation
 * signing key of the person's User-Key. Only a holder of the User-Key can make
 * that signature, so a device the admin planted — which can write personal
 * documents under the person's name but cannot open the User-Key — gains
 * nothing from it.
 *
 * Recovery then runs the other way round: the new device joins with a normal
 * join request, the admin approves it, and the rescue device (opened from the
 * packages or the sheet) wraps the User-Key to it. The admin removes the used
 * rescue device from the grant afterwards.
 */
import type { JoinRequest } from "../types";
import { encodeJoinRequestUri } from "../uri/joinRequestUri";
import { normalizePublicKeyPem } from "../userkeys/fingerprint";

/** How a rescue device was admitted. Absent in older documents: `certificate`. */
export type RescueDeviceApproval = "certificate" | "admin";

export interface RescueDeviceAttestation {
  /** User-Key generation whose signing key made the signature. */
  epoch: string;
  /** Base64 Ed25519 signature over {@link rescueAttestationMessage}. */
  signature: string;
}

const ATTESTATION_TAG = "mindoodb-rescue-device-attestation-v1";

export function rescueAttestationMessage(input: {
  usernameHash: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      ATTESTATION_TAG,
      input.usernameHash,
      normalizePublicKeyPem(input.signingPublicKey),
      normalizePublicKeyPem(input.encryptionPublicKey),
    ]),
  );
}

/**
 * The join request the person hands to the admin for a rescue device. It
 * names no user (the admin picks the existing person, §6.5) and carries no
 * User-Key: the rescue device gets the person's key by wrap.
 */
export function rescueDeviceJoinRequestUri(device: {
  signingPublicKey: string;
  encryptionPublicKey: string;
  label: string;
}): string {
  const request: JoinRequest = {
    v: 2,
    signingPublicKey: device.signingPublicKey,
    encryptionPublicKey: device.encryptionPublicKey,
    label: device.label,
  };
  return encodeJoinRequestUri(request);
}

/** The public half of a rescue device as `rcv_` and `rpp_` documents store it. */
export interface RescueDeviceRef {
  signingPublicKey: string;
  encryptionPublicKey: string;
  signingKeyFingerprint: string;
  /** The `dcert_` document that certifies it (`approval: "certificate"`). */
  certificateDocId?: string;
  /** Absent in documents written before admin approval existed: `certificate`. */
  approval?: RescueDeviceApproval;
  /** Required for `approval: "admin"` (see the module comment). */
  attestation?: RescueDeviceAttestation;
}

/** Shape check of a stored {@link RescueDeviceRef}. */
export function isRescueDeviceRef(value: unknown): value is RescueDeviceRef {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  for (const key of ["signingPublicKey", "encryptionPublicKey", "signingKeyFingerprint"]) {
    if (typeof r[key] !== "string" || !(r[key] as string)) return false;
  }
  if (r.approval === "admin") {
    const a = r.attestation as Record<string, unknown> | undefined;
    return !!a && typeof a.epoch === "string" && typeof a.signature === "string";
  }
  if (r.approval !== undefined && r.approval !== "certificate") return false;
  return typeof r.certificateDocId === "string" && !!r.certificateDocId;
}

export function rescueApprovalOf(ref: Pick<RescueDeviceRef, "approval">): RescueDeviceApproval {
  return ref.approval === "admin" ? "admin" : "certificate";
}
