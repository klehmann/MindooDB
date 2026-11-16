/**
 * Recovery contacts on the person's and on the contacts' devices
 * (docs/userkeys.md §12). Reached through the tenant:
 * `tenant.setupRecoveryContacts`, `getRecoveryContactsSetup`,
 * `removeRecoveryContacts`, `listRecoveryContactRequests`,
 * `createRecoveryHelperPackage`.
 */
import type { BaseMindooTenant } from "../BaseMindooTenant";
import type { BaseMindooTenantDirectory } from "../BaseMindooTenantDirectory";
import { RSAEncryption } from "../crypto/RSAEncryption";
import { DEFAULT_TENANT_KEY_ID, USER_DIRECTORY_DB_ID, type MindooDB } from "../types";
import type { UserKeyManager } from "../userkeys/UserKeyManager";
import { base64ToBytes, bytesToBase64 } from "../userkeys/fingerprint";
import { USERKEY_FORM } from "../userkeys/types";
import {
  RECOVERY_CONTACTS_DOC_ID_PREFIX,
  RECOVERY_CONTACTS_MIN,
  RECOVERY_CONTACTS_SCHEMA_VERSION,
  RECOVERY_CONTACTS_THRESHOLD,
  RECOVERY_CONTACTS_TYPE,
  verifyRecoveryContactsDoc,
  type RecoveryContactsPayload,
  type RecoveryContactsSetup,
} from "./RecoveryContactsDocument";
import type { RecoveryHelperPackage } from "./recoveryPackage";
import { generateRescueDevice } from "./rescueDevice";
import { splitSecret } from "./shamir";

export type RecoveryContactsErrorCode =
  | "self-grant-required"
  | "too-few-contacts"
  | "contact-is-self"
  | "contact-without-key"
  | "no-user-key"
  | "no-default-key"
  | "not-a-contact"
  | "no-setup";

export class RecoveryContactsError extends Error {
  constructor(
    readonly code: RecoveryContactsErrorCode,
    message: string,
    /** Usernames the error is about (`contact-without-key`, `contact-is-self`). */
    readonly usernames: string[] = [],
  ) {
    super(message);
    this.name = "RecoveryContactsError";
  }
}

/** A person who named this device's person as a recovery contact. */
export interface RecoveryContactRequest {
  docId: string;
  username: string;
  createdAt: number;
  threshold: number;
  /** All contacts of that setup, this person included. */
  contacts: string[];
}

export interface SetupRecoveryContactsOptions {
  /** Label of the rescue device certificate. Default "Rescue device". */
  rescueDeviceLabel?: string;
  /**
   * Signing-key fingerprints of further rescue devices to withdraw, such as
   * the one a recovery just used, in case its setup is not in this replica.
   */
  withdrawRescueDevices?: string[];
}

export class RecoveryContactsManager {
  constructor(
    private readonly tenant: BaseMindooTenant,
    private readonly userKeys: UserKeyManager,
  ) {}

  private async userDirectory(): Promise<MindooDB> {
    return this.tenant.openDB(USER_DIRECTORY_DB_ID);
  }

  private async directory(): Promise<BaseMindooTenantDirectory> {
    return (await this.tenant.openDirectory()) as BaseMindooTenantDirectory;
  }

  /** Every `rcv_` document that verifies, newest first. */
  private async verifiedSetups(): Promise<RecoveryContactsSetup[]> {
    const db = await this.userDirectory();
    const directory = await this.directory();
    const out: RecoveryContactsSetup[] = [];
    for (const id of await db.getAllDocumentIds()) {
      if (!id.startsWith(RECOVERY_CONTACTS_DOC_ID_PREFIX)) continue;
      try {
        const doc = await db.getDocument(id);
        const setup = await verifyRecoveryContactsDoc({ db, doc, directory });
        if (setup) out.push(setup);
      } catch {
        // unreadable (no `default` yet) or damaged: not a setup
      }
    }
    return out.sort((a, b) => b.payload.createdAt - a.payload.createdAt || (a.docId < b.docId ? 1 : -1));
  }

  private async ownUsernameHash(): Promise<string | null> {
    const resolved = await this.userKeys.resolveOwnUserKeyDocument();
    return resolved?.payload.username_hash ?? null;
  }

  /** This person's current setups, newest first (normally one). */
  private async ownSetups(): Promise<RecoveryContactsSetup[]> {
    const hash = await this.ownUsernameHash();
    if (!hash) return [];
    return (await this.verifiedSetups()).filter((s) => s.payload.username_hash === hash);
  }

  /** This person's current recovery contacts, or `null` when none are set up. */
  async getSetup(): Promise<RecoveryContactsSetup | null> {
    return (await this.ownSetups())[0] ?? null;
  }

  /**
   * Name recovery contacts: make a new rescue device, certify it, split its
   * secret among the contacts (any two recover) and publish the `rcv_`
   * document. Replaces an earlier setup and withdraws its rescue device.
   * Needs the person's device self-grant (the rescue device is certified with
   * it) and a published User-Key for every contact.
   */
  async setup(
    contactUsernames: string[],
    options?: SetupRecoveryContactsOptions,
  ): Promise<RecoveryContactsSetup> {
    const me = await this.tenant.getCurrentUserId();
    const directory = await this.directory();
    const ownResolved = await this.userKeys.resolveOwnUserKeyDocument();
    if (!ownResolved) {
      throw new RecoveryContactsError("no-user-key", "This person has no published User-Key yet.");
    }
    const ownHash = ownResolved.payload.username_hash;
    if (!(await this.tenant.hasDecryptionKey(DEFAULT_TENANT_KEY_ID))) {
      throw new RecoveryContactsError("no-default-key", "This device does not hold the tenant key yet.");
    }

    const seen = new Set<string>();
    const contacts: string[] = [];
    for (const raw of contactUsernames) {
      const username = raw.trim();
      if (!username) continue;
      const key = username.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      contacts.push(username);
    }
    const selfNamed: string[] = [];
    for (const username of contacts) {
      const hashes = await directory.getUsernameHashCandidates(username);
      if (hashes.includes(ownHash)) selfNamed.push(username);
    }
    if (selfNamed.length > 0) {
      throw new RecoveryContactsError("contact-is-self", "You cannot be your own recovery contact.", selfNamed);
    }
    if (contacts.length < RECOVERY_CONTACTS_MIN) {
      throw new RecoveryContactsError(
        "too-few-contacts",
        `Name at least ${RECOVERY_CONTACTS_MIN} recovery contacts.`,
      );
    }
    if (!(await this.userKeys.canIssueDeviceCertificates())) {
      throw new RecoveryContactsError(
        "self-grant-required",
        "Recovery contacts need device self-grant: the administrator must allow this person to add own devices.",
      );
    }

    const recipients: Array<{ username: string; publicKey: string; fingerprint: string }> = [];
    const missing: string[] = [];
    for (const username of contacts) {
      const published = await this.userKeys.publishedUserKeyFor(username);
      if (!published || published.pending) {
        missing.push(username);
        continue;
      }
      recipients.push({ username, publicKey: published.publicKey, fingerprint: published.fingerprint });
    }
    if (missing.length > 0) {
      throw new RecoveryContactsError(
        "contact-without-key",
        `These people cannot be recovery contacts yet (no published User-Key): ${missing.join(", ")}`,
        missing,
      );
    }

    const previous = await this.ownSetups();
    const crypto = this.tenant.getCryptoAdapter();
    const rescue = await generateRescueDevice(crypto);
    const label = options?.rescueDeviceLabel?.trim() || "Rescue device";
    const { docId: certificateDocId } = await this.userKeys.issueDeviceCertificate(
      { signingPublicKey: rescue.signingPublicKey, encryptionPublicKey: rescue.encryptionPublicKey },
      label,
    );

    const shares = splitSecret(crypto, rescue.secret, recipients.length, RECOVERY_CONTACTS_THRESHOLD);
    rescue.secret.fill(0);
    const rsa = new RSAEncryption(crypto);
    const payload: RecoveryContactsPayload = {
      form: USERKEY_FORM,
      type: RECOVERY_CONTACTS_TYPE,
      schemaVersion: RECOVERY_CONTACTS_SCHEMA_VERSION,
      username: me.username,
      username_hash: ownHash,
      threshold: RECOVERY_CONTACTS_THRESHOLD,
      createdAt: Date.now(),
      rescueDevice: {
        signingPublicKey: rescue.signingPublicKey,
        encryptionPublicKey: rescue.encryptionPublicKey,
        signingKeyFingerprint: rescue.signingKeyFingerprint,
        certificateDocId,
      },
      rescueBlob: rescue.blob,
      contacts: [],
    };
    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i]!;
      payload.contacts.push({
        username: recipient.username,
        userKeyFingerprint: recipient.fingerprint,
        sealedShare: bytesToBase64(await rsa.encrypt(shares[i]!, recipient.publicKey)),
      });
      shares[i]!.fill(0);
    }
    rescue.signingPkcs8.fill(0);
    rescue.encryptionPkcs8.fill(0);

    const db = await this.userDirectory();
    const doc = await db.createDocument({
      decryptionKeyId: DEFAULT_TENANT_KEY_ID,
      idPrefix: RECOVERY_CONTACTS_DOC_ID_PREFIX.replace(/_$/, ""),
      initialValues: payload as unknown as Record<string, unknown>,
    });

    // Only now retire what came before: a failure above leaves it working.
    for (const old of previous) {
      await this.retire(db, old);
    }
    await this.withdrawExtra(options?.withdrawRescueDevices, previous);
    return { docId: doc.getId(), payload: JSON.parse(JSON.stringify(payload)) as RecoveryContactsPayload };
  }

  /** Delete a setup and withdraw its rescue device. */
  private async retire(db: MindooDB, setup: RecoveryContactsSetup): Promise<void> {
    try {
      await this.userKeys.revokeOwnDeviceCertificate(setup.payload.rescueDevice.signingKeyFingerprint);
    } catch {
      // already withdrawn
    }
    try {
      await db.deleteDocument(setup.docId);
    } catch {
      // already deleted
    }
  }

  /** Withdraw rescue devices by fingerprint that no retired setup covered. */
  private async withdrawExtra(fingerprints: string[] | undefined, retired: RecoveryContactsSetup[]): Promise<void> {
    const covered = new Set(retired.map((s) => s.payload.rescueDevice.signingKeyFingerprint));
    for (const fingerprint of fingerprints ?? []) {
      if (covered.has(fingerprint)) continue;
      try {
        await this.userKeys.revokeOwnDeviceCertificate(fingerprint);
      } catch {
        // not in this replica, or already withdrawn
      }
    }
  }

  /**
   * Remove recovery contacts: delete every own setup and withdraw its rescue
   * device (and `withdrawRescueDevices`). Returns how many setups were removed.
   */
  async remove(options?: { withdrawRescueDevices?: string[] }): Promise<number> {
    const db = await this.userDirectory();
    const setups = await this.ownSetups();
    for (const setup of setups) await this.retire(db, setup);
    await this.withdrawExtra(options?.withdrawRescueDevices, setups);
    return setups.length;
  }

  /**
   * People who named this person as a recovery contact, one entry per person
   * (their newest setup), newest first.
   */
  async listRequests(): Promise<RecoveryContactRequest[]> {
    const ownHash = await this.ownUsernameHash();
    if (!ownHash) return [];
    const fingerprints = new Set((await this.userKeys.ownUserKeyGenerations()).map((g) => g.fingerprint));
    if (fingerprints.size === 0) return [];
    const byPerson = new Map<string, RecoveryContactsSetup>();
    for (const setup of await this.verifiedSetups()) {
      if (setup.payload.username_hash === ownHash) continue;
      if (byPerson.has(setup.payload.username_hash)) continue; // newest first
      byPerson.set(setup.payload.username_hash, setup);
    }
    const out: RecoveryContactRequest[] = [];
    for (const setup of byPerson.values()) {
      if (!setup.payload.contacts.some((c) => fingerprints.has(c.userKeyFingerprint))) continue;
      out.push({
        docId: setup.docId,
        username: setup.payload.username,
        createdAt: setup.payload.createdAt,
        threshold: setup.payload.threshold,
        contacts: setup.payload.contacts.map((c) => c.username),
      });
    }
    return out;
  }

  /**
   * Help a person recover: open this contact's share of their newest setup
   * and build the package (plaintext — encrypt it with
   * {@link encryptRecoveryHelperPackage} before handing it over).
   * `person` is the person's username or the setup document id.
   */
  async createHelperPackage(
    person: string,
    options?: { serverUrl?: string },
  ): Promise<RecoveryHelperPackage> {
    const ownHash = await this.ownUsernameHash();
    const setups = (await this.verifiedSetups()).filter((s) => s.payload.username_hash !== ownHash);
    let setup = setups.find((s) => s.docId === person);
    if (!setup) {
      const directory = await this.directory();
      const hashes = new Set(await directory.getUsernameHashCandidates(person));
      setup = setups.find((s) => hashes.has(s.payload.username_hash));
    } else {
      // A setup id must still be the person's newest one.
      const hash = setup.payload.username_hash;
      setup = setups.find((s) => s.payload.username_hash === hash);
    }
    if (!setup) {
      throw new RecoveryContactsError("no-setup", "This person has no recovery contacts set up.");
    }
    const generations = await this.userKeys.ownUserKeyGenerations();
    const rsa = new RSAEncryption(this.tenant.getCryptoAdapter());
    let share: Uint8Array | null = null;
    for (const entry of setup.payload.contacts) {
      const matching = generations.filter((g) => g.fingerprint === entry.userKeyFingerprint);
      for (const generation of matching) {
        try {
          share = await rsa.decrypt(base64ToBytes(entry.sealedShare), generation.privateKey);
          break;
        } catch {
          // not this generation
        }
      }
      if (share) break;
    }
    if (!share) {
      throw new RecoveryContactsError("not-a-contact", "You are not a recovery contact of this person.");
    }
    const me = await this.tenant.getCurrentUserId();
    const serverUrl = options?.serverUrl?.trim().replace(/\/$/, "");
    return {
      v: 1,
      kind: "mindoodb-recovery-share",
      tenantId: this.tenant.getId(),
      ...(serverUrl ? { serverUrl } : {}),
      username: setup.payload.username,
      setupDocId: setup.docId,
      threshold: setup.payload.threshold,
      rescueSigningKeyFingerprint: setup.payload.rescueDevice.signingKeyFingerprint,
      rescueBlob: setup.payload.rescueBlob,
      share: bytesToBase64(share),
      helper: me.username,
      createdAt: Date.now(),
    };
  }

  /**
   * Signing keys of the rescue devices of every verified setup in the local
   * replica (deleted setups are not included). A certificate issued by one of
   * them means a recovery took place (docs/userkeys.md §12.5).
   */
  async rescueDeviceSigningKeys(): Promise<Array<{ username: string; signingPublicKey: string }>> {
    return (await this.verifiedSetups()).map((s) => ({
      username: s.payload.username,
      signingPublicKey: s.payload.rescueDevice.signingPublicKey,
    }));
  }
}
