import type { EncryptedPrivateKey, MindooDB, MindooDoc, SigningKeyPair } from "../types";
import { PUBLIC_INFOS_KEY_ID } from "../types";
import { RSAEncryption } from "../crypto/RSAEncryption";
import type { CryptoAdapter } from "../crypto/CryptoAdapter";
import {
  USERKEY_FORM,
  USERKEY_SCHEMA_VERSION,
  USERKEY_TYPE,
  currentUserKeyEpoch,
  isPendingUserKeyDocument,
  userKeyDocumentId,
  type UserKeyDeviceWrap,
  type UserKeyDocumentPayload,
  type UserKeyGeneration,
} from "./types";
import { base64ToBytes, bytesToBase64, fingerprintEncryptionPublicKey } from "./fingerprint";

export { isPendingUserKeyDocument, currentUserKeyEpoch, userKeyDocumentId };

/** Copy `username_hash` / `username_hash_v` from a grantaccess document (docs/userkeys.md §6.1). */
export function usernameHashBindingFromGrant(data: Record<string, unknown>): {
  usernameHash: string;
  usernameHashVersion: number;
} | null {
  const usernameHash = typeof data.username_hash === "string" ? data.username_hash : "";
  if (!usernameHash) return null;
  const version = data.username_hash_v;
  return {
    usernameHash,
    usernameHashVersion: typeof version === "number" && Number.isInteger(version) ? version : 1,
  };
}

export function buildPendingUserKeyPayload(input: {
  usernameHash: string;
  usernameHashVersion: number;
  publicKey: string;
  fingerprint: string;
  createdAt: number;
}): UserKeyDocumentPayload {
  return {
    form: USERKEY_FORM,
    type: USERKEY_TYPE,
    schemaVersion: USERKEY_SCHEMA_VERSION,
    username_hash: input.usernameHash,
    username_hash_v: input.usernameHashVersion,
    userKeys: {
      "1": {
        publicKey: input.publicKey,
        fingerprint: input.fingerprint,
        createdAt: input.createdAt,
        deviceWraps: {},
      },
    },
  };
}

/** Drop `undefined` so Automerge does not throw `RangeError: invalid value`. */
function plainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Nested `applyJsonPatch` hydrates objects through Automerge's
 * `putObjectFromHydrate`, which throws `RangeError: invalid value` on this
 * document shape. `changeDoc` assigns a top-level field inside `Automerge.change`,
 * which is the same path `createDocument` already uses successfully.
 */
async function replaceTopLevelField(
  db: MindooDB,
  doc: MindooDoc,
  field: "userKeys" | "rejectedDevices",
  value: unknown,
): Promise<void> {
  await db.changeDoc(doc, (editable) => {
    (editable.getData() as Record<string, unknown>)[field] = plainJson(value);
  });
}

export async function createPendingUserKeyDocument(input: {
  db: MindooDB;
  grantDocId: string;
  usernameHash: string;
  usernameHashVersion: number;
  publicKey: string;
  fingerprint: string;
  signingKeyPair?: SigningKeyPair;
  signingKeyPassword?: string;
  assumeUniqueId?: boolean;
}): Promise<MindooDoc> {
  const payload = buildPendingUserKeyPayload({
    usernameHash: input.usernameHash,
    usernameHashVersion: input.usernameHashVersion,
    publicKey: input.publicKey,
    fingerprint: input.fingerprint,
    createdAt: Date.now(),
  });
  const id = userKeyDocumentId(input.grantDocId);
  const create = {
    decryptionKeyId: PUBLIC_INFOS_KEY_ID,
    signingKeyPair: input.signingKeyPair,
    signingKeyPassword: input.signingKeyPassword,
    initialValues: payload as unknown as Record<string, unknown>,
  };
  try {
    return await input.db.createDocument({
      ...create,
      id,
      assumeUniqueId: input.assumeUniqueId ?? true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("invalid document id")) throw error;
    return input.db.createDocument({
      ...create,
      idPrefix: "userkey",
    });
  }
}

export async function wrapPrivateKeyForDevice(input: {
  cryptoAdapter: CryptoAdapter;
  privateKeyBytes: Uint8Array;
  deviceEncryptionPublicKey: string;
}): Promise<string> {
  const rsa = new RSAEncryption(input.cryptoAdapter);
  const wrapped = await rsa.encrypt(input.privateKeyBytes, input.deviceEncryptionPublicKey);
  return bytesToBase64(wrapped);
}

export async function writeDeviceWrap(input: {
  db: MindooDB;
  doc: MindooDoc;
  epoch: string;
  deviceFingerprint: string;
  wrap: UserKeyDeviceWrap;
}): Promise<void> {
  const payload = input.doc.getData() as unknown as UserKeyDocumentPayload;
  const userKeys = plainJson(payload.userKeys ?? {});
  const gen = userKeys[input.epoch] ?? {
    publicKey: "",
    fingerprint: "",
    createdAt: Date.now(),
    deviceWraps: {},
  };
  gen.deviceWraps = { ...(gen.deviceWraps ?? {}) };
  const existing = gen.deviceWraps[input.deviceFingerprint];
  if (existing?.wrappedKey) {
    if (!existing.label && input.wrap.label) {
      gen.deviceWraps[input.deviceFingerprint] = { ...existing, label: input.wrap.label };
      userKeys[input.epoch] = gen;
      await replaceTopLevelField(input.db, input.doc, "userKeys", userKeys);
    }
    return;
  }
  gen.deviceWraps[input.deviceFingerprint] = {
    wrappedKey: input.wrap.wrappedKey,
    approvedAt: input.wrap.approvedAt,
    approvedBySigningPublicKey: input.wrap.approvedBySigningPublicKey,
    ...(input.wrap.label ? { label: input.wrap.label } : {}),
  };
  userKeys[input.epoch] = gen;
  await replaceTopLevelField(input.db, input.doc, "userKeys", userKeys);
}

export async function replaceUserKeys(
  db: MindooDB,
  doc: MindooDoc,
  userKeys: UserKeyDocumentPayload["userKeys"],
): Promise<void> {
  await replaceTopLevelField(db, doc, "userKeys", userKeys);
}

export async function replaceRejectedDevices(
  db: MindooDB,
  doc: MindooDoc,
  rejectedDevices: UserKeyDocumentPayload["rejectedDevices"],
): Promise<void> {
  await replaceTopLevelField(db, doc, "rejectedDevices", rejectedDevices ?? {});
}

export async function fingerprintUserPublicKey(
  publicKeyPem: string,
  cryptoAdapter: CryptoAdapter,
): Promise<string> {
  return fingerprintEncryptionPublicKey(publicKeyPem, cryptoAdapter.getSubtle());
}

export async function unwrapPrivateKeyFromDevice(input: {
  cryptoAdapter: CryptoAdapter;
  wrappedKeyB64: string;
  deviceEncryptionPrivateKey: CryptoKey;
}): Promise<Uint8Array> {
  const rsa = new RSAEncryption(input.cryptoAdapter);
  return rsa.decrypt(base64ToBytes(input.wrappedKeyB64), input.deviceEncryptionPrivateKey);
}

export function generationAt(
  payload: UserKeyDocumentPayload,
  epoch: string,
): UserKeyGeneration | undefined {
  return payload.userKeys?.[epoch];
}

export type { EncryptedPrivateKey };
