/**
 * Helper packages of recovery contacts (docs/userkeys.md §12).
 *
 * A contact who helps hands the person a package: their share of the
 * recovery secret plus what the new device needs to find the tenant — server,
 * tenant id, username and the encrypted rescue device. The package is
 * encrypted with a one-time password the helper's app generates and shows
 * separately, so a package that leaks on the way (chat, mail, a photo of the
 * screen) is useless without its password, and even with it one share alone
 * opens nothing.
 *
 * Text form: `mdbrescue1.` + base64url(salt(16) | iv(12) | iterations(u32) |
 * AES-256-GCM ciphertext), key = PBKDF2-SHA-256(password, salt). The
 * plaintext is JSON and stays well below what a QR code holds.
 */
import type { CryptoAdapter } from "../crypto/CryptoAdapter";
import { DEFAULT_PBKDF2_ITERATIONS, MIN_PBKDF2_ITERATIONS, resolvePbkdf2Iterations } from "../crypto/pbkdf2Iterations";
import { base64ToBytes, bytesToBase64 } from "../userkeys/fingerprint";
import { combineShares } from "./shamir";
import { openRescueDevice, type OpenedRescueDevice } from "./rescueDevice";

export const RECOVERY_PACKAGE_PREFIX = "mdbrescue1.";
const PACKAGE_AAD = new TextEncoder().encode("mindoodb-recovery-package-v1");
/** Unambiguous lower-case letters and digits (no 0/o, 1/l/i). */
const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const PASSWORD_LENGTH = 12;

/** What one contact hands over (plaintext; encrypted for transport). */
export interface RecoveryHelperPackage {
  v: 1;
  kind: "mindoodb-recovery-share";
  tenantId: string;
  /** Sync server of the tenant, as the helper's app knows it. */
  serverUrl?: string;
  /** The person being recovered. */
  username: string;
  /** The `rcv_` document the share belongs to. */
  setupDocId: string;
  threshold: number;
  rescueSigningKeyFingerprint: string;
  rescueBlob: string;
  /** Base64 Shamir share. */
  share: string;
  /** Who helped (display only). */
  helper: string;
  createdAt: number;
}

/** The result of combining enough packages: the opened rescue device. */
export interface CombinedRecoveryPackages {
  tenantId: string;
  serverUrl?: string;
  username: string;
  setupDocId: string;
  helpers: string[];
  rescueDevice: OpenedRescueDevice;
}

export class RecoveryPackageError extends Error {
  constructor(
    readonly code:
      | "malformed"
      | "wrong-password"
      | "too-few"
      | "mismatch"
      | "duplicate"
      | "cannot-open",
    message: string,
  ) {
    super(message);
    this.name = "RecoveryPackageError";
  }
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
}

/**
 * A one-time password for a package: 12 characters from an alphabet without
 * look-alikes (about 59 bits), shown in groups of four (`abcd-efgh-jkmn`).
 */
export function generateRecoveryPackagePassword(crypto: CryptoAdapter): string {
  const bound = 256 - (256 % PASSWORD_ALPHABET.length);
  const chars: string[] = [];
  const byte = new Uint8Array(1);
  while (chars.length < PASSWORD_LENGTH) {
    crypto.getRandomValues(byte);
    if (byte[0]! >= bound) continue;
    chars.push(PASSWORD_ALPHABET[byte[0]! % PASSWORD_ALPHABET.length]!);
  }
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8)].map((g) => g.join("")).join("-");
}

/** Typed passwords: case, spaces and dashes do not matter. */
export function normalizeRecoveryPackagePassword(password: string): string {
  return password.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function packageKey(
  crypto: CryptoAdapter,
  password: string,
  salt: Uint8Array,
  iterations: number,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  const subtle = crypto.getSubtle();
  const base = await subtle.importKey(
    "raw",
    toBuffer(new TextEncoder().encode(normalizeRecoveryPackagePassword(password))),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: toBuffer(salt), iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

/** Encrypt a package with its one-time password into the text form. */
export async function encryptRecoveryHelperPackage(
  crypto: CryptoAdapter,
  pkg: RecoveryHelperPackage,
  password: string,
): Promise<string> {
  if (normalizeRecoveryPackagePassword(password).length < 8) {
    throw new Error("The package password is too short.");
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const iterations = resolvePbkdf2Iterations(DEFAULT_PBKDF2_ITERATIONS);
  const ciphertext = new Uint8Array(
    await crypto.getSubtle().encrypt(
      { name: "AES-GCM", iv: toBuffer(iv), additionalData: toBuffer(PACKAGE_AAD), tagLength: 128 },
      await packageKey(crypto, password, salt, iterations, "encrypt"),
      toBuffer(new TextEncoder().encode(JSON.stringify(pkg))),
    ),
  );
  const out = new Uint8Array(16 + 12 + 4 + ciphertext.length);
  out.set(salt, 0);
  out.set(iv, 16);
  new DataView(out.buffer).setUint32(28, iterations);
  out.set(ciphertext, 32);
  return RECOVERY_PACKAGE_PREFIX + bytesToBase64Url(out);
}

/** Pull the package text out of whatever was pasted or scanned. */
export function extractRecoveryPackageText(input: string): string | null {
  const match = input.match(/mdbrescue1\.[A-Za-z0-9_-]+/);
  return match ? match[0] : null;
}

/** Decrypt a package; throws {@link RecoveryPackageError}. */
export async function decryptRecoveryHelperPackage(
  crypto: CryptoAdapter,
  text: string,
  password: string,
): Promise<RecoveryHelperPackage> {
  const extracted = extractRecoveryPackageText(text);
  if (!extracted) throw new RecoveryPackageError("malformed", "This is not a recovery package.");
  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(extracted.slice(RECOVERY_PACKAGE_PREFIX.length));
  } catch {
    throw new RecoveryPackageError("malformed", "The recovery package is damaged.");
  }
  if (bytes.length < 32 + 16) throw new RecoveryPackageError("malformed", "The recovery package is damaged.");
  const iterations = new DataView(bytes.buffer, bytes.byteOffset).getUint32(28);
  if (iterations < MIN_PBKDF2_ITERATIONS || iterations > 10_000_000) {
    throw new RecoveryPackageError("malformed", "The recovery package is damaged.");
  }
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await crypto.getSubtle().decrypt(
        {
          name: "AES-GCM",
          iv: toBuffer(bytes.slice(16, 28)),
          additionalData: toBuffer(PACKAGE_AAD),
          tagLength: 128,
        },
        await packageKey(crypto, password, bytes.slice(0, 16), iterations, "decrypt"),
        toBuffer(bytes.slice(32)),
      ),
    );
  } catch {
    throw new RecoveryPackageError("wrong-password", "The password does not open this package.");
  }
  let pkg: RecoveryHelperPackage;
  try {
    pkg = JSON.parse(new TextDecoder().decode(plain)) as RecoveryHelperPackage;
  } catch {
    throw new RecoveryPackageError("malformed", "The recovery package is damaged.");
  }
  if (
    pkg?.v !== 1 ||
    pkg.kind !== "mindoodb-recovery-share" ||
    typeof pkg.tenantId !== "string" ||
    typeof pkg.username !== "string" ||
    typeof pkg.setupDocId !== "string" ||
    typeof pkg.share !== "string" ||
    typeof pkg.rescueBlob !== "string"
  ) {
    throw new RecoveryPackageError("malformed", "The recovery package is damaged.");
  }
  return pkg;
}

/**
 * Combine decrypted packages from different contacts of the same setup and
 * open the rescue device. Fails with `too-few` below the threshold, `mismatch`
 * when the packages belong to different setups, `duplicate` for the same
 * share twice, and `cannot-open` when the combination does not open the blob.
 */
export async function combineRecoveryHelperPackages(
  crypto: CryptoAdapter,
  packages: RecoveryHelperPackage[],
): Promise<CombinedRecoveryPackages> {
  if (packages.length === 0) throw new RecoveryPackageError("too-few", "No recovery packages.");
  const first = packages[0]!;
  for (const pkg of packages) {
    if (
      pkg.setupDocId !== first.setupDocId ||
      pkg.tenantId !== first.tenantId ||
      pkg.username !== first.username ||
      pkg.rescueBlob !== first.rescueBlob ||
      pkg.rescueSigningKeyFingerprint !== first.rescueSigningKeyFingerprint
    ) {
      throw new RecoveryPackageError("mismatch", "The packages belong to different recovery setups.");
    }
  }
  const shares = packages.map((pkg) => base64ToBytes(pkg.share));
  const distinct = new Set(shares.map((s) => bytesToBase64(s)));
  if (distinct.size !== shares.length) {
    throw new RecoveryPackageError("duplicate", "The same package was used twice.");
  }
  const threshold = Math.max(2, first.threshold || 2);
  if (shares.length < threshold) {
    throw new RecoveryPackageError("too-few", `Packages from ${threshold} different contacts are needed.`);
  }
  let rescueDevice: OpenedRescueDevice;
  try {
    const secret = combineShares(shares);
    rescueDevice = await openRescueDevice(crypto, secret, first.rescueBlob);
    secret.fill(0);
  } catch {
    throw new RecoveryPackageError("cannot-open", "The packages do not open the rescue device.");
  }
  if (rescueDevice.signingKeyFingerprint !== first.rescueSigningKeyFingerprint) {
    throw new RecoveryPackageError("cannot-open", "The packages do not open the rescue device.");
  }
  const serverUrl = packages.map((pkg) => pkg.serverUrl).find((url) => typeof url === "string" && url);
  return {
    tenantId: first.tenantId,
    ...(serverUrl ? { serverUrl } : {}),
    username: first.username,
    setupDocId: first.setupDocId,
    helpers: packages.map((pkg) => pkg.helper),
    rescueDevice,
  };
}
