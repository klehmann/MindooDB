/**
 * Paper rescue device (docs/userkeys.md §12.8).
 *
 * A printed recovery sheet used to carry a copy of the device's own keys, so
 * a restore was the same device again and the sheet went stale once the
 * User-Key rotated away from that device. With a paper rescue device the
 * sheet carries a rescue device of its own instead: certified with the
 * self-grant key like the rescue device of recovery contacts, so it receives
 * every User-Key generation, and independent of it — changing contacts does
 * not touch the sheet and vice versa.
 *
 * The sheet holds the recovery secret and the rescue blob (encrypted by the
 * application with the printout's own secret). The tenant keeps only the
 * public half in a personal document `rpp_…` (tenant `default` key), so that a
 * new sheet can withdraw the previous one and other devices can recognise
 * certificates it issues. A sheet that is lost is withdrawn by printing a new
 * one or by {@link PaperRescueManager.remove}.
 */
import type { BaseMindooTenant } from "../BaseMindooTenant";
import type { BaseMindooTenantDirectory } from "../BaseMindooTenantDirectory";
import type { CryptoAdapter } from "../crypto/CryptoAdapter";
import { DEFAULT_TENANT_KEY_ID, USER_DIRECTORY_DB_ID, type MindooDB, type MindooDoc } from "../types";
import type { UserKeyManager } from "../userkeys/UserKeyManager";
import { base64ToBytes, bytesToBase64 } from "../userkeys/fingerprint";
import { USERKEY_FORM } from "../userkeys/types";
import { isRescueDeviceRef, type RescueDeviceRef } from "./rescueApproval";
import { personalDocBelongsTo } from "./RecoveryContactsDocument";
import {
  RecoveryContactsError,
  admitRescueDevice,
  rescueDeviceStatus,
  rescueRefIsGenuine,
  type RescueDeviceStatus,
} from "./RecoveryContactsManager";
import type { CombinedRecoveryPackages } from "./recoveryPackage";
import { generateRescueDevice, openRescueDevice } from "./rescueDevice";

export const PAPER_RESCUE_DOC_ID_PREFIX = "rpp_";
export const PAPER_RESCUE_TYPE = "paperrescue";
export const PAPER_RESCUE_SCHEMA_VERSION = 1;

export interface PaperRescuePayload {
  form: typeof USERKEY_FORM;
  type: typeof PAPER_RESCUE_TYPE;
  schemaVersion: number;
  username: string;
  username_hash: string;
  createdAt: number;
  rescueDevice: RescueDeviceRef;
}

/** What goes onto the sheet (the application encrypts it). */
export interface PaperRescueSecret {
  tenantId: string;
  username: string;
  /** Base64 32-byte recovery secret. */
  secret: string;
  /** The rescue device's private keys, AES-256-GCM under `secret`. */
  rescueBlob: string;
  rescueSigningKeyFingerprint: string;
  /** `admin`: the rescue device is on the grant, not certified (docs/userkeys.md §12.9). */
  approval?: "admin";
  /** The `rpp_` document of this sheet. */
  docId: string;
}

/** What {@link PaperRescueManager.create} returns: the sheet, and how it gets admitted. */
export interface CreatePaperRescueResult extends PaperRescueSecret {
  /** Set when the administrator must put the rescue device on the grant. */
  joinRequestUri?: string;
  /** Earlier admin-approved paper rescue devices still on the grant (only the admin can remove them). */
  rescueDevicesToRemove: string[];
}

export interface PaperRescueRecord {
  docId: string;
  payload: PaperRescuePayload;
}

function asPaperRescuePayload(data: unknown): PaperRescuePayload | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.form !== USERKEY_FORM || d.type !== PAPER_RESCUE_TYPE) return null;
  if (typeof d.username !== "string" || typeof d.username_hash !== "string" || typeof d.createdAt !== "number") {
    return null;
  }
  const rescue = d.rescueDevice as Record<string, unknown> | undefined;
  if (!rescue || typeof rescue !== "object") return null;
  if (!isRescueDeviceRef(rescue)) return null;
  return d as unknown as PaperRescuePayload;
}

/** Verify an `rpp_` document like an `rcv_` one: created by the person it names. */
export async function verifyPaperRescueDoc(input: {
  db: MindooDB;
  doc: MindooDoc;
  directory: BaseMindooTenantDirectory;
}): Promise<PaperRescueRecord | null> {
  const docId = input.doc.getId();
  if (!docId.startsWith(PAPER_RESCUE_DOC_ID_PREFIX) || input.doc.isDeleted()) return null;
  const payload = asPaperRescuePayload(input.doc.getData());
  if (!payload) return null;
  const owned = await personalDocBelongsTo({
    db: input.db,
    docId,
    directory: input.directory,
    username: payload.username,
    usernameHash: payload.username_hash,
  });
  return owned ? { docId, payload: JSON.parse(JSON.stringify(payload)) as PaperRescuePayload } : null;
}

/**
 * Turn the secret from a sheet back into what
 * {@link certifyDeviceWithRescueDevice} takes. Throws when the secret does not
 * open the blob.
 */
export async function openPaperRescueSecret(
  crypto: CryptoAdapter,
  sheet: Pick<PaperRescueSecret, "tenantId" | "username" | "secret" | "rescueBlob" | "rescueSigningKeyFingerprint" | "docId" | "approval">,
  serverUrl?: string,
): Promise<CombinedRecoveryPackages> {
  const rescueDevice = await openRescueDevice(crypto, base64ToBytes(sheet.secret), sheet.rescueBlob);
  if (rescueDevice.signingKeyFingerprint !== sheet.rescueSigningKeyFingerprint) {
    throw new Error("The paper rescue device does not match its fingerprint.");
  }
  return {
    tenantId: sheet.tenantId,
    ...(serverUrl ? { serverUrl } : {}),
    username: sheet.username,
    setupDocId: sheet.docId,
    helpers: [],
    ...(sheet.approval === "admin" ? { rescueApproval: "admin" as const } : {}),
    rescueDevice,
  };
}

export class PaperRescueManager {
  constructor(
    private readonly tenant: BaseMindooTenant,
    private readonly userKeys: UserKeyManager,
  ) {}

  private async userDirectory(): Promise<MindooDB> {
    return this.tenant.openDB(USER_DIRECTORY_DB_ID);
  }

  /** This person's paper rescue devices in the local replica, newest first. */
  async list(): Promise<PaperRescueRecord[]> {
    const resolved = await this.userKeys.resolveOwnUserKeyDocument();
    if (!resolved) return [];
    return (await this.listAll()).filter((r) => r.payload.username_hash === resolved.payload.username_hash);
  }

  /** Every verified paper rescue device in the local replica, newest first. */
  async listAll(): Promise<PaperRescueRecord[]> {
    const db = await this.userDirectory();
    const directory = (await this.tenant.openDirectory()) as BaseMindooTenantDirectory;
    const out: PaperRescueRecord[] = [];
    for (const id of await db.getAllDocumentIds()) {
      if (!id.startsWith(PAPER_RESCUE_DOC_ID_PREFIX)) continue;
      try {
        const record = await verifyPaperRescueDoc({ db, doc: await db.getDocument(id), directory });
        if (
          record &&
          (await rescueRefIsGenuine({
            tenant: this.tenant,
            userKeys: this.userKeys,
            username: record.payload.username,
            usernameHash: record.payload.username_hash,
            ref: record.payload.rescueDevice,
          }))
        ) {
          out.push(record);
        }
      } catch {
        // unreadable or damaged
      }
    }
    return out.sort((a, b) => b.payload.createdAt - a.payload.createdAt);
  }

  /**
   * Make a new paper rescue device for a printout: certify it, publish its
   * public half and withdraw every earlier paper rescue device of this person.
   * Returns what the sheet must carry. Needs device self-grant.
   */
  async create(options?: { label?: string; allowAdminApproval?: boolean }): Promise<CreatePaperRescueResult> {
    const resolved = await this.userKeys.resolveOwnUserKeyDocument();
    if (!resolved) {
      throw new RecoveryContactsError("no-user-key", "This person has no published User-Key yet.");
    }
    if (!(await this.tenant.hasDecryptionKey(DEFAULT_TENANT_KEY_ID))) {
      throw new RecoveryContactsError("no-default-key", "This device does not hold the tenant key yet.");
    }
    const previous = await this.list();
    const me = await this.tenant.getCurrentUserId();
    const rescue = await generateRescueDevice(this.tenant.getCryptoAdapter());
    const admitted = await admitRescueDevice({
      userKeys: this.userKeys,
      rescue,
      label: options?.label?.trim() || "Paper rescue device",
      usernameHash: resolved.payload.username_hash,
      ...(options?.allowAdminApproval !== undefined ? { allowAdminApproval: options.allowAdminApproval } : {}),
    });
    const payload: PaperRescuePayload = {
      form: USERKEY_FORM,
      type: PAPER_RESCUE_TYPE,
      schemaVersion: PAPER_RESCUE_SCHEMA_VERSION,
      username: me.username,
      username_hash: resolved.payload.username_hash,
      createdAt: Date.now(),
      rescueDevice: admitted.ref,
    };
    const db = await this.userDirectory();
    const doc = await db.createDocument({
      decryptionKeyId: DEFAULT_TENANT_KEY_ID,
      idPrefix: PAPER_RESCUE_DOC_ID_PREFIX.replace(/_$/, ""),
      initialValues: payload as unknown as Record<string, unknown>,
    });
    for (const old of previous) await this.retire(db, old);
    const rescueDevicesToRemove: string[] = [];
    for (const old of previous) {
      if (old.payload.rescueDevice.approval !== "admin") continue;
      const status = await rescueDeviceStatus(this.tenant, this.userKeys, old.payload.rescueDevice);
      if (status === "active" || status === "waiting-for-key") {
        rescueDevicesToRemove.push(old.payload.rescueDevice.signingKeyFingerprint);
      }
    }
    const sheet: CreatePaperRescueResult = {
      tenantId: this.tenant.getId(),
      username: me.username,
      secret: bytesToBase64(rescue.secret),
      rescueBlob: rescue.blob,
      rescueSigningKeyFingerprint: rescue.signingKeyFingerprint,
      ...(admitted.ref.approval === "admin" ? { approval: "admin" as const } : {}),
      docId: doc.getId(),
      ...(admitted.joinRequestUri ? { joinRequestUri: admitted.joinRequestUri } : {}),
      rescueDevicesToRemove,
    };
    rescue.secret.fill(0);
    rescue.signingPkcs8.fill(0);
    rescue.encryptionPkcs8.fill(0);
    return sheet;
  }

  private async retire(db: MindooDB, record: PaperRescueRecord): Promise<void> {
    try {
      await this.userKeys.revokeOwnDeviceCertificate(record.payload.rescueDevice.signingKeyFingerprint);
    } catch {
      // already withdrawn
    }
    try {
      await db.deleteDocument(record.docId);
    } catch {
      // already deleted
    }
  }

  /** Where this person's newest paper rescue device stands (`null` without one). */
  async status(): Promise<RescueDeviceStatus | null> {
    const newest = (await this.list())[0];
    return newest ? rescueDeviceStatus(this.tenant, this.userKeys, newest.payload.rescueDevice) : null;
  }

  /** Withdraw every paper rescue device of this person (all printed sheets stop working). */
  async remove(): Promise<number> {
    const db = await this.userDirectory();
    const records = await this.list();
    for (const record of records) await this.retire(db, record);
    return records.length;
  }
}
