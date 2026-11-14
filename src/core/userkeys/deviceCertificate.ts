import type { CryptoAdapter } from "../crypto/CryptoAdapter";
import { normalizePublicKeyPem } from "./fingerprint";
import { signEd25519, verifyEd25519 } from "./generationSignature";
import { USERKEY_FORM } from "./types";

/**
 * Device certificates (docs/userkeys.md §9.6).
 *
 * A person whose grant carries `deviceSelfGrant` may vouch for further devices
 * of their own: a device that already holds the person's self-grant key
 * writes a personal `userdirectory` document `dcert_<fingerprint>` naming the
 * new device's keys, signed with the self-grant key. Clients and the server
 * then treat the certified device like a device on the grant
 * (`resolveSignerToGrant`), as long as the grant still names that self-grant
 * key, the certificate predates its `revokedAt`, and the device is not in the
 * grant's `revokedUserKeyPairs`.
 *
 * Certificates are encrypted with `$publicinfos`, so the sync server can read
 * and verify them, like the user key documents. Only the `doc_create` counts:
 * readers take the certificate from it and never from later changes. The
 * person withdraws a certificate by deleting the document; it stops counting
 * at the delete's trusted time, and an undelete does not bring it back.
 */

export const DEVICE_CERT_DOC_ID_PREFIX = "dcert_";
export const DEVICE_CERT_TYPE = "devicecert";
export const DEVICE_CERT_SCHEMA_VERSION = 1;
const DEVICE_CERT_MESSAGE_TAG = "mindoodb-device-cert-v1";

export interface DeviceCertificatePayload {
  form: typeof USERKEY_FORM;
  type: typeof DEVICE_CERT_TYPE;
  schemaVersion: number;
  /** The person, as on their grant. */
  username_hash: string;
  deviceSigningPublicKey: string;
  deviceEncryptionPublicKey: string;
  label?: string;
  issuedAt: number;
  /** Signing key of the device that issued the certificate. */
  issuedBySigningPublicKey: string;
  /** The person's self-grant key that signed it (must match the grant). */
  selfGrantPublicKey: string;
  /** Base64 Ed25519 signature over {@link deviceCertificateMessage}. */
  signature: string;
}

export function deviceCertificateDocId(deviceSigningKeyFingerprint: string): string {
  return `${DEVICE_CERT_DOC_ID_PREFIX}${deviceSigningKeyFingerprint.replace(/[^a-f0-9]/gi, "").toLowerCase()}`;
}

export function deviceCertificateMessage(
  cert: Pick<
    DeviceCertificatePayload,
    | "username_hash"
    | "deviceSigningPublicKey"
    | "deviceEncryptionPublicKey"
    | "label"
    | "issuedAt"
    | "issuedBySigningPublicKey"
    | "selfGrantPublicKey"
  >,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      DEVICE_CERT_MESSAGE_TAG,
      cert.username_hash,
      normalizePublicKeyPem(cert.deviceSigningPublicKey),
      normalizePublicKeyPem(cert.deviceEncryptionPublicKey),
      cert.label ?? "",
      cert.issuedAt,
      normalizePublicKeyPem(cert.issuedBySigningPublicKey),
      normalizePublicKeyPem(cert.selfGrantPublicKey),
    ]),
  );
}

export function asDeviceCertificate(data: unknown): DeviceCertificatePayload | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.form !== USERKEY_FORM || d.type !== DEVICE_CERT_TYPE) return null;
  for (const key of [
    "username_hash",
    "deviceSigningPublicKey",
    "deviceEncryptionPublicKey",
    "issuedBySigningPublicKey",
    "selfGrantPublicKey",
    "signature",
  ]) {
    if (typeof d[key] !== "string" || !(d[key] as string)) return null;
  }
  if (typeof d.issuedAt !== "number" || !Number.isFinite(d.issuedAt)) return null;
  return d as unknown as DeviceCertificatePayload;
}

export async function signDeviceCertificate(
  crypto: CryptoAdapter,
  selfGrantPrivateKey: CryptoKey,
  cert: Omit<DeviceCertificatePayload, "signature" | "form" | "type" | "schemaVersion">,
): Promise<DeviceCertificatePayload> {
  const signature = await signEd25519(crypto, selfGrantPrivateKey, deviceCertificateMessage(cert));
  const { label, ...rest } = cert;
  // Automerge rejects `undefined`, so an absent label stays absent.
  return {
    form: USERKEY_FORM,
    type: DEVICE_CERT_TYPE,
    schemaVersion: DEVICE_CERT_SCHEMA_VERSION,
    ...rest,
    ...(label ? { label } : {}),
    signature,
  };
}

export async function verifyDeviceCertificate(
  crypto: CryptoAdapter,
  cert: DeviceCertificatePayload,
): Promise<boolean> {
  return verifyEd25519(crypto, cert.selfGrantPublicKey, cert.signature, deviceCertificateMessage(cert));
}
