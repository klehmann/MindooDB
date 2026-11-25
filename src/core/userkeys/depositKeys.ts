/**
 * Deposit keys: write-only delivery into a group document's audience.
 *
 * A group document's key series (`groupKeyDocId`, docs/userkeys.md §6.6) is
 * symmetric, so whoever can encrypt with it can also read everything encrypted
 * with it. A depositor such as a mail gateway must be able to deliver to a
 * group (a mailbox and its delegates) without that. A deposit key is an
 * RSA-OAEP key pair for this:
 *
 * - the public half is handed to depositors, who seal each delivered document
 *   to it (`recipients: [{ devicePem }]`, one wrap, `includeSelf: false`);
 * - the private half is stored in a document of the same database that uses the
 *   group's key series, so every member of the group (and nobody else) can
 *   open the deliveries. Members without the group's older generations
 *   (`history: "none"`) cannot open older deposit keys either, so they do not
 *   read older deliveries.
 *
 * The document id is derived from the public key fingerprint, so a reader that
 * finds a wrap it cannot open looks up the matching deposit key by id without
 * decrypting anything. One document per key pair, written once: rotating
 * creates a new pair (and document); the old one stays so the remaining
 * members keep reading what was delivered to it.
 */
import type { CryptoAdapter } from "../crypto/CryptoAdapter";
import { generateRsaOaep3072, importRsaOaepPrivateKey } from "../crypto/rsaOaep3072";
import { base64ToBytes, bytesToBase64, fingerprintPublicKeyPem } from "./fingerprint";

/** Id prefix of deposit key documents (`dkey_<fingerprint hex>`). */
export const DEPOSIT_KEY_DOC_PREFIX = "dkey_";

/** `form` of a deposit key document. */
export const DEPOSIT_KEY_FORM = "depositkey";

export interface DepositKeyInfo {
  /** Id of the document holding the private half. */
  docId: string;
  /** The group document whose members can open deliveries. */
  groupDocId: string;
  /** Public half (SPKI PEM) for depositors. */
  publicKeyPem: string;
  /** Fingerprint of {@link publicKeyPem}, as recipient wraps carry it. */
  fingerprint: string;
  /** Creation time (ms) as written by the creator. */
  createdAt: number;
}

/** Document id for the deposit key with this fingerprint (`aa:bb:…` → `dkey_aabb…`). */
export function depositKeyDocId(fingerprint: string): string {
  return `${DEPOSIT_KEY_DOC_PREFIX}${fingerprint.replace(/:/g, "").toLowerCase()}`;
}

export function isDepositKeyDocId(docId: string): boolean {
  return docId.startsWith(DEPOSIT_KEY_DOC_PREFIX);
}

/** A new key pair with the fields of its document. */
export async function generateDepositKey(
  crypto: CryptoAdapter,
  groupDocId: string,
  now: number,
): Promise<{ info: DepositKeyInfo; fields: Record<string, unknown> }> {
  const { publicKeyPem, privateKeyBytes } = await generateRsaOaep3072(crypto);
  const fingerprint = await fingerprintPublicKeyPem(publicKeyPem, crypto.getSubtle());
  const docId = depositKeyDocId(fingerprint);
  return {
    info: { docId, groupDocId, publicKeyPem, fingerprint, createdAt: now },
    fields: {
      form: DEPOSIT_KEY_FORM,
      group: groupDocId,
      publicKey: publicKeyPem,
      privateKey: bytesToBase64(privateKeyBytes),
      fingerprint,
      createdAt: now,
    },
  };
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "val" in value) return String((value as { val: unknown }).val);
  return value === undefined || value === null ? "" : String(value);
}

/** The public part of a deposit key document's data, or null when it is not one. */
export function depositKeyInfoOf(docId: string, data: Record<string, unknown>): DepositKeyInfo | null {
  if (!isDepositKeyDocId(docId) || text(data.form) !== DEPOSIT_KEY_FORM) return null;
  const publicKeyPem = text(data.publicKey);
  const fingerprint = text(data.fingerprint);
  if (!publicKeyPem || !fingerprint || depositKeyDocId(fingerprint) !== docId) return null;
  return {
    docId,
    groupDocId: text(data.group),
    publicKeyPem,
    fingerprint,
    createdAt: Number(text(data.createdAt)) || 0,
  };
}

/**
 * The private half of a deposit key document, checked against its id: the
 * public key in the document must have the fingerprint the id names, so a
 * document cannot claim a key it does not hold.
 */
export async function importDepositPrivateKey(
  crypto: CryptoAdapter,
  docId: string,
  data: Record<string, unknown>,
): Promise<{ info: DepositKeyInfo; privateKey: CryptoKey } | null> {
  const info = depositKeyInfoOf(docId, data);
  if (!info) return null;
  const fingerprint = await fingerprintPublicKeyPem(info.publicKeyPem, crypto.getSubtle());
  if (fingerprint !== info.fingerprint) return null;
  const privateKeyText = text(data.privateKey);
  if (!privateKeyText) return null;
  const privateKey = await importRsaOaepPrivateKey(crypto, base64ToBytes(privateKeyText));
  return { info, privateKey };
}
