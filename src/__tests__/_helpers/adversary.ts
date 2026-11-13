import type { EntryRecipients } from "../../core/userkeys/sealedTypes";
import { sealedKeyId } from "../../core/userkeys/sealedTypes";
import type { MindooTenant, StoreEntryMetadata } from "../../core/types";
import type { DeviceHandle } from "./multiDevice";

/**
 * A dishonest replica for security tests.
 *
 * Honest clients hide documents they should not read, so "the document is gone
 * from `getAllDocumentIds`" proves nothing about the bytes. The hoarder is the
 * attacker we defend against: a (former) reader who keeps their private keys,
 * has every entry that was ever synced to their device, unwraps EVERY recipient
 * block that was ever published for a key series (not only the newest), keeps
 * every generation they ever saw, and then tries all of them on raw entries.
 *
 * Assertions made with it are cryptographic: `canDecryptEntry` is true only if
 * one of the hoarded generations really opens the ciphertext.
 */
export class KeyHoarder {
  /** key id -> generation (hex) -> bytes */
  private readonly hoard = new Map<string, Map<string, Uint8Array>>();

  /**
   * `session`: the tenant session the hoarder works in. Harvesting rewrites the
   * session's key cache, so tests that also assert the honest view of the same
   * device pass a separate session on the device's stores.
   */
  constructor(
    readonly device: DeviceHandle,
    private readonly session: MindooTenant = device.tenant,
  ) {}

  private tenant() {
    return this.session as unknown as {
      getSealedGenerations(keyId: string): Uint8Array[];
      rememberSealedGenerations(keyId: string, generations: Uint8Array[], block?: EntryRecipients): void;
      ingestSealedRecipients(keyId: string, recipients: EntryRecipients): Promise<void>;
      decryptPayload(payload: Uint8Array, keyId: string): Promise<Uint8Array>;
    };
  }

  private keep(keyId: string, generations: Uint8Array[]): void {
    const known = this.hoard.get(keyId) ?? new Map<string, Uint8Array>();
    for (const generation of generations) {
      known.set(Buffer.from(generation).toString("hex"), generation);
    }
    this.hoard.set(keyId, known);
  }

  /** Raw entry metadata of a document on this device, whatever its visibility. */
  async entriesOf(dbId: string, docId: string): Promise<StoreEntryMetadata[]> {
    const db = await this.session.openDB(dbId);
    return db.getStore().findNewEntriesForDoc([], docId);
  }

  /**
   * Collects every generation of the key series `$sealed:<keyDocId>` this
   * identity can get at right now: what the session holds, plus whatever any
   * recipient block ever written for `keyDocId` unwraps to. Call it whenever the
   * attacker "was online" (e.g. before and after a removal has synced).
   */
  async harvest(dbId: string, keyDocId: string): Promise<number> {
    const keyId = sealedKeyId(keyDocId);
    const tenant = this.tenant();
    const session = tenant.getSealedGenerations(keyId);
    this.keep(keyId, session);
    try {
      for (const entry of await this.entriesOf(dbId, keyDocId)) {
        if (!entry.recipients) continue;
        tenant.rememberSealedGenerations(keyId, []);
        await tenant.ingestSealedRecipients(keyId, entry.recipients);
        this.keep(keyId, tenant.getSealedGenerations(keyId));
      }
    } finally {
      // Leave the honest session as it was (its own next ingest re-validates).
      tenant.rememberSealedGenerations(keyId, session);
    }
    return this.hoard.get(keyId)?.size ?? 0;
  }

  generationCount(keyDocId: string): number {
    return this.hoard.get(sealedKeyId(keyDocId))?.size ?? 0;
  }

  /** True when one of the hoarded generations opens this raw entry. */
  async canDecryptEntry(dbId: string, entryId: string): Promise<boolean> {
    const db = await this.session.openDB(dbId);
    const [entry] = await db.getStore().getEntries([entryId]);
    if (!entry) {
      throw new Error(`KeyHoarder: entry ${entryId} never reached ${this.device.label}; sync first`);
    }
    const keyId = entry.decryptionKeyId;
    const tenant = this.tenant();
    const session = tenant.getSealedGenerations(keyId);
    try {
      for (const generation of this.hoard.get(keyId)?.values() ?? []) {
        tenant.rememberSealedGenerations(keyId, [generation]);
        try {
          await tenant.decryptPayload(entry.encryptedData, keyId);
          return true;
        } catch {
          // next generation
        }
      }
      return false;
    } finally {
      tenant.rememberSealedGenerations(keyId, session);
    }
  }

  /** Per entry of `docId`: whether the hoard opens it. */
  async readableEntries(
    dbId: string,
    docId: string,
  ): Promise<Array<{ id: string; entryType: string; readable: boolean }>> {
    const out: Array<{ id: string; entryType: string; readable: boolean }> = [];
    for (const entry of await this.entriesOf(dbId, docId)) {
      out.push({
        id: entry.id,
        entryType: entry.entryType,
        readable: await this.canDecryptEntry(dbId, entry.id),
      });
    }
    return out;
  }

  /** Entries of `docId` that are not yet in `before` (ids), e.g. "what was written since". */
  async newEntryIds(dbId: string, docId: string, before: Set<string>): Promise<string[]> {
    return (await this.entriesOf(dbId, docId)).map((entry) => entry.id).filter((id) => !before.has(id));
  }
}
