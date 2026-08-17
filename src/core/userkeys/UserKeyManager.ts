import type { BaseMindooTenant } from "../BaseMindooTenant";
import type { BaseMindooTenantDirectory } from "../BaseMindooTenantDirectory";
import { extractRevokedKeyPairs } from "../accesscontrol/grantKeys";
import { encryptPrivateKey } from "../crypto/privateKeyEncryption";
import { generateRsaOaep3072, importRsaOaepPrivateKey } from "../crypto/rsaOaep3072";
import type { EncryptionKeyPair, MindooDB, MindooDoc, PrivateUserId } from "../types";
import { USER_DIRECTORY_DB_ID } from "../types";
import { fingerprintEncryptionPublicKey } from "./fingerprint";
import { resolveUserKeyDocument } from "./resolveUserKeyDocument";
import { asUserKeyPayload } from "./validateUserKeyDocument";
import {
  buildPendingUserKeyPayload,
  createPendingUserKeyDocument,
  fingerprintUserPublicKey,
  usernameHashBindingFromGrant,
  replaceRejectedDevices,
  replaceUserKeys,
  unwrapPrivateKeyFromDevice,
  wrapPrivateKeyForDevice,
  writeDeviceWrap,
} from "./UserKeyDocument";
import {
  USERKEY_PRIVATE_SALT,
  USERKEY_USERNAME_HASH_VERSION,
  UserKeyMismatchError,
  currentUserKeyEpoch,
  isPendingUserKeyDocument,
  userKeyDocumentId,
  type PendingUserKeyDevice,
  type UserKeyDeviceRow,
  type UserKeyDocumentPayload,
  type UserKeyEnrollmentStatus,
  type UserKeyWaitState,
} from "./types";

export class UserKeyManager {
  private userDirectoryFetched = false;
  private lastUserDirectoryFetchError: unknown = null;
  private decryptedUserKeyCache: CryptoKey | null = null;
  private decryptedUserKeyBytes: Uint8Array | null = null;
  private reconcileInFlight: Promise<UserKeyEnrollmentStatus> | null = null;

  constructor(private readonly tenant: BaseMindooTenant) {}

  noteUserDirectoryFetched(): void {
    this.userDirectoryFetched = true;
    this.lastUserDirectoryFetchError = null;
  }

  noteUserDirectoryFetchFailed(error: unknown): void {
    this.lastUserDirectoryFetchError = error;
  }

  hasFetchedUserDirectory(): boolean {
    return this.userDirectoryFetched;
  }

  async ensureLocalUserKeyPair(user: PrivateUserId, password: string): Promise<EncryptionKeyPair> {
    if (user.userKeyPair) {
      const usable = await this.decryptUserKeyPairBytes(user.userKeyPair, password);
      if (usable) {
        this.decryptedUserKeyBytes = usable;
        return user.userKeyPair;
      }
    }
    const crypto = this.tenant.getCryptoAdapter();
    const generated = await generateRsaOaep3072(crypto);
    const encrypted = await encryptPrivateKey(
      crypto,
      generated.privateKeyBytes,
      password,
      USERKEY_PRIVATE_SALT,
    );
    const pair: EncryptionKeyPair = {
      publicKey: generated.publicKeyPem,
      privateKey: encrypted,
    };
    user.userKeyPair = pair;
    this.decryptedUserKeyBytes = generated.privateKeyBytes;
    this.decryptedUserKeyCache = null;
    return pair;
  }

  async getLocalUserPublicKey(): Promise<string | null> {
    const user = this.tenant.getCurrentPrivateUser();
    if (user.userKeyPair?.publicKey) return user.userKeyPair.publicKey;
    return null;
  }

  private async decryptUserKeyPairBytes(
    pair: EncryptionKeyPair,
    password: string,
  ): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(
        await this.tenant.decryptPrivateKey(pair.privateKey, password, USERKEY_PRIVATE_SALT),
      );
    } catch {
      return null;
    }
  }

  async getDecryptedUserKeyBytes(): Promise<Uint8Array | null> {
    if (this.decryptedUserKeyBytes) return this.decryptedUserKeyBytes;
    const user = this.tenant.getCurrentPrivateUser();
    const pair = user.userKeyPair;
    if (!pair) return null;
    const bytes = await this.decryptUserKeyPairBytes(pair, this.tenant.getCurrentUserPassword());
    if (!bytes) return null;
    this.decryptedUserKeyBytes = bytes;
    return bytes;
  }

  async getDecryptedUserKey(): Promise<CryptoKey | null> {
    if (this.decryptedUserKeyCache) return this.decryptedUserKeyCache;
    const bytes = await this.getDecryptedUserKeyBytes();
    if (!bytes) return null;
    const key = await importRsaOaepPrivateKey(this.tenant.getCryptoAdapter(), bytes, false);
    this.decryptedUserKeyCache = key;
    return key;
  }

  /**
   * All epochs this device can open, newest first. Used by key-distribution
   * reconcile so wraps addressed to a retired fingerprint still import.
   */
  async getUserKeyCryptoKeysForReconcile(): Promise<CryptoKey[]> {
    const keys: CryptoKey[] = [];
    const seen = new Set<string>();
    // Opening userdirectory during directory bring-up races a second Automerge
    // WASM heap and OOMs Jest. Other epochs are only needed after a rotation,
    // once the session has already fetched userdirectory.
    if (this.userDirectoryFetched) {
      try {
        const resolved = await this.resolveOwnUserKeyDocument();
        if (resolved) {
          for (const epoch of this.epochsNewestFirst(resolved.payload)) {
            const bytes = await this.privateKeyBytesForEpoch(resolved.payload, epoch);
            if (!bytes) continue;
            const fingerprint = resolved.payload.userKeys[epoch]?.fingerprint;
            if (!fingerprint || seen.has(fingerprint)) continue;
            seen.add(fingerprint);
            keys.push(
              await importRsaOaepPrivateKey(this.tenant.getCryptoAdapter(), bytes.slice(), false),
            );
          }
        }
      } catch {
        // Fall through to the session key.
      }
    }
    if (keys.length === 0) {
      const current = await this.getDecryptedUserKey();
      if (current) keys.push(current);
    }
    return keys;
  }

  async openUserDirectory(): Promise<MindooDB> {
    return this.tenant.openDB(USER_DIRECTORY_DB_ID);
  }

  async resolveOwnUserKeyDocument(): Promise<{
    doc: MindooDoc;
    payload: UserKeyDocumentPayload;
  } | null> {
    const db = await this.openUserDirectory();
    const directory = await this.directory();
    const username = (await this.tenant.getCurrentUserId()).username;
    const hashes = await directory.getUsernameHashCandidates(username);
    const grants = await directory.findGrantAccessDocuments(username);
    return resolveUserKeyDocument({
      db,
      directory,
      username,
      usernameHashCandidates: hashes,
      grantDocIds: grants.map((g) => g.getId()),
      adminPublicKey: this.tenant.getAdministrationPublicKey(),
    });
  }

  /**
   * Admin path: create a pending userkey document from a join-request public key.
   */
  async createPendingFromJoin(input: {
    username: string;
    userPublicKey: string;
    signingKeyPair: { publicKey: string; privateKey: import("../types").EncryptedPrivateKey };
    signingKeyPassword: string;
  }): Promise<MindooDoc> {
    const binding = await this.mintBindingForUsername(input.username);
    if (!binding) {
      throw new Error(`Cannot create user key: no grant for "${input.username}"`);
    }
    const { grantDocId, usernameHash, usernameHashVersion } = binding;
    const fingerprint = await fingerprintUserPublicKey(
      input.userPublicKey,
      this.tenant.getCryptoAdapter(),
    );
    const db = await this.openUserDirectory();
    try {
      const existing = await db.getDocument(userKeyDocumentId(grantDocId));
      if (existing && !existing.isDeleted()) return existing;
    } catch {
      // missing
    }
    return createPendingUserKeyDocument({
      db,
      grantDocId,
      usernameHash,
      usernameHashVersion,
      publicKey: input.userPublicKey,
      fingerprint,
      signingKeyPair: {
        publicKey: input.signingKeyPair.publicKey,
        privateKey: input.signingKeyPair.privateKey,
      },
      signingKeyPassword: input.signingKeyPassword,
    });
  }

  /**
   * Self-create for legacy users who never sent a User-Key in a join request.
   * Refuses unless userdirectory has been fetched this session (Trap 1).
   * On mint, wraps the new private key to every active grant device so already
   * enrolled devices can import without an approval dialog. Devices added to
   * the grant afterwards still require explicit approval.
   */
  async ensureOwnUserKeyDocument(options?: { allowSelfCreate?: boolean }): Promise<{
    doc: MindooDoc;
    payload: UserKeyDocumentPayload;
  } | null> {
    const existing = await this.resolveOwnUserKeyDocument();
    if (existing) return existing;
    const allow =
      options?.allowSelfCreate === true || this.userDirectoryFetched;
    if (!allow) return null;

    const user = this.tenant.getCurrentPrivateUser();
    const pair = await this.ensureLocalUserKeyPair(user, this.tenant.getCurrentUserPassword());
    const userId = await this.tenant.getCurrentUserId();
    const binding = await this.mintBindingForUsername(userId.username, userId.userSigningPublicKey);
    if (!binding) return null;
    const { grantDocId, usernameHash, usernameHashVersion } = binding;
    const fingerprint = await fingerprintUserPublicKey(pair.publicKey, this.tenant.getCryptoAdapter());
    const db = await this.openUserDirectory();
    let doc;
    let mintedHere = false;
    try {
      const occupied = await db.getDocument(userKeyDocumentId(grantDocId));
      if (occupied && !occupied.isDeleted() && asUserKeyPayload(occupied.getData())) {
        doc = occupied;
      }
    } catch {
      // missing
    }
    if (!doc) {
      const occupiedInvalid = await db.getDocument(userKeyDocumentId(grantDocId)).catch(() => null);
      if (occupiedInvalid && !occupiedInvalid.isDeleted() && !asUserKeyPayload(occupiedInvalid.getData())) {
        const built = buildPendingUserKeyPayload({
          usernameHash,
          usernameHashVersion,
          publicKey: pair.publicKey,
          fingerprint,
          createdAt: Date.now(),
        });
        doc = await db.createDocument({
          idPrefix: "userkey",
          decryptionKeyId: "$publicinfos",
          initialValues: built as unknown as Record<string, unknown>,
        });
      } else {
        doc = await createPendingUserKeyDocument({
          db,
          grantDocId,
          usernameHash,
          usernameHashVersion,
          publicKey: pair.publicKey,
          fingerprint,
        });
      }
      mintedHere = true;
    }
    const payload = asUserKeyPayload(doc.getData());
    if (!payload) return null;
    // Occupied valid document: another replica won the mint. Do not wrap-all
    // onto it — that would auto-approve later grant devices.
    if (!mintedHere) {
      return { doc, payload };
    }
    try {
      await this.wrapPrivateKeyForActiveGrantDevices(doc, payload);
    } catch (error) {
      if (!(error instanceof UserKeyMismatchError)) throw error;
    }
    // Grant overview can be empty (directory not pulled yet). Still wrap this
    // device so the document does not stay pending with `deviceWraps: {}`.
    await this.writeOwnDeviceWrap(doc, payload);
    const refreshed = await db.getDocument(doc.getId());
    const next = asUserKeyPayload(refreshed.getData());
    return next ? { doc: refreshed, payload: next } : { doc, payload };
  }

  /**
   * Bootstrap / recreate: wrap the new private key to every active grant
   * device. Later devices added to the grant still require explicit approval.
   *
   * `legacyUnstampedOnly` wraps only grant devices with no `addedAt` (pre-User-Keys
   * fleet). Devices stamped with `addedAt` after the userkey document exists still
   * need an explicit approve.
   */
  private async wrapPrivateKeyForActiveGrantDevices(
    doc: MindooDoc,
    payload: UserKeyDocumentPayload,
    options?: { legacyUnstampedOnly?: boolean },
  ): Promise<void> {
    const bytes = await this.getDecryptedUserKeyBytes();
    if (!bytes) {
      throw new UserKeyMismatchError("Local User-Key private material is unavailable");
    }
    const live = asUserKeyPayload(doc.getData()) ?? payload;
    const localPublic = await this.getLocalUserPublicKey();
    const epoch = currentUserKeyEpoch(live);
    if (!epoch || !localPublic) return;
    const gen = live.userKeys[epoch];
    if (!gen || gen.publicKey !== localPublic) return;
    const directory = await this.directory();
    const signer = await this.tenant.getCurrentUserId();
    const user = this.tenant.getCurrentPrivateUser();
    const overview = await directory.getUserGrantOverview(signer.username);
    const now = Date.now();
    const deviceWraps: UserKeyDocumentPayload["userKeys"][string]["deviceWraps"] = {
      ...(gen.deviceWraps ?? {}),
    };
    let changed = false;
    const devices = [...overview.activeDevices];
    if (
      !devices.some((device) => device.encryptionPublicKey === user.userEncryptionKeyPair.publicKey)
    ) {
      devices.push({
        signingPublicKey: user.userSigningKeyPair.publicKey,
        encryptionPublicKey: user.userEncryptionKeyPair.publicKey,
        wipeRequested: false,
      });
    }
    for (const device of devices) {
      if (device.wipeRequested) continue;
      if (options?.legacyUnstampedOnly && typeof device.addedAt === "number") continue;
      const deviceFp = await fingerprintEncryptionPublicKey(
        device.encryptionPublicKey,
        this.tenant.getCryptoAdapter().getSubtle(),
      );
      const existing = deviceWraps[deviceFp];
      if (existing) {
        if (!existing.label && device.label) {
          deviceWraps[deviceFp] = { ...existing, label: device.label };
          changed = true;
        }
        continue;
      }
      deviceWraps[deviceFp] = {
        wrappedKey: await wrapPrivateKeyForDevice({
          cryptoAdapter: this.tenant.getCryptoAdapter(),
          privateKeyBytes: bytes,
          deviceEncryptionPublicKey: device.encryptionPublicKey,
        }),
        ...(device.label ? { label: device.label } : {}),
        approvedAt: now,
        approvedBySigningPublicKey: signer.userSigningPublicKey,
      };
      changed = true;
    }
    if (!changed) return;
    await replaceUserKeys(doc.getDatabase(), doc, {
      ...live.userKeys,
      [epoch]: { ...gen, deviceWraps },
    });
  }

  private async tryImportUserKeyFromWrap(payload: UserKeyDocumentPayload): Promise<boolean> {
    const user = this.tenant.getCurrentPrivateUser();
    const deviceKey = await this.tenant.getEncryptionPrivateKeyForReconcile();
    if (!deviceKey) return false;
    const deviceFp = await fingerprintEncryptionPublicKey(
      user.userEncryptionKeyPair.publicKey,
      this.tenant.getCryptoAdapter().getSubtle(),
    );
    for (const epoch of this.epochsNewestFirst(payload)) {
      const gen = payload.userKeys[epoch];
      const wrap = gen?.deviceWraps?.[deviceFp];
      if (!wrap?.wrappedKey) continue;
      try {
        const bytes = await unwrapPrivateKeyFromDevice({
          cryptoAdapter: this.tenant.getCryptoAdapter(),
          wrappedKeyB64: wrap.wrappedKey,
          deviceEncryptionPrivateKey: deviceKey,
        });
        const encrypted = await encryptPrivateKey(
          this.tenant.getCryptoAdapter(),
          bytes,
          this.tenant.getCurrentUserPassword(),
          USERKEY_PRIVATE_SALT,
        );
        user.userKeyPair = {
          publicKey: gen.publicKey,
          privateKey: encrypted,
        };
        this.decryptedUserKeyBytes = bytes;
        this.decryptedUserKeyCache = null;
        return true;
      } catch {
        // wrap is not for this device or is corrupt; try next generation
      }
    }
    return false;
  }

  async writeOwnDeviceWrap(doc: MindooDoc, payload: UserKeyDocumentPayload): Promise<void> {
    const localPublic = await this.getLocalUserPublicKey();
    if (!localPublic) {
      throw new UserKeyMismatchError(
        "This device has no local User-Key to compare against the published document",
      );
    }
    const live = asUserKeyPayload(doc.getData()) ?? payload;
    const currentEpoch = currentUserKeyEpoch(live);
    if (!currentEpoch) {
      throw new UserKeyMismatchError("Published user-key document has no generations");
    }
    const published = live.userKeys[currentEpoch]?.publicKey;
    if (published !== localPublic) {
      throw new UserKeyMismatchError();
    }
    const user = this.tenant.getCurrentPrivateUser();
    const deviceFp = await fingerprintEncryptionPublicKey(
      user.userEncryptionKeyPair.publicKey,
      this.tenant.getCryptoAdapter().getSubtle(),
    );
    const signer = await this.tenant.getCurrentUserId();
    const ownLabel = await this.labelForOwnEncryptionKey();
    const db = doc.getDatabase();
    for (const epoch of Object.keys(live.userKeys)) {
      const gen = live.userKeys[epoch];
      if (gen.publicKey !== localPublic) continue;
      if (gen.deviceWraps?.[deviceFp]) {
        if (!gen.deviceWraps[deviceFp].label && ownLabel) {
          await writeDeviceWrap({
            db,
            doc,
            epoch,
            deviceFingerprint: deviceFp,
            wrap: { ...gen.deviceWraps[deviceFp], label: ownLabel },
          });
        }
        continue;
      }
      const bytes = await this.privateKeyBytesForEpoch(live, epoch);
      if (!bytes) {
        throw new UserKeyMismatchError("Local User-Key private material is unavailable");
      }
      const wrapped = await wrapPrivateKeyForDevice({
        cryptoAdapter: this.tenant.getCryptoAdapter(),
        privateKeyBytes: bytes,
        deviceEncryptionPublicKey: user.userEncryptionKeyPair.publicKey,
      });
      await writeDeviceWrap({
        db,
        doc,
        epoch,
        deviceFingerprint: deviceFp,
        wrap: {
          wrappedKey: wrapped,
          ...(ownLabel ? { label: ownLabel } : {}),
          approvedAt: Date.now(),
          approvedBySigningPublicKey: signer.userSigningPublicKey,
        },
      });
    }
  }

  /**
   * A wrap-less userkey document cannot be imported by anyone. Replace its
   * planted public key with this device's local pair and wrap the current
   * grant (same outcome as a first mint).
   */
  private async adoptPendingUserKeyDocument(
    doc: MindooDoc,
    payload: UserKeyDocumentPayload,
  ): Promise<{ doc: MindooDoc; payload: UserKeyDocumentPayload }> {
    const user = this.tenant.getCurrentPrivateUser();
    const pair = await this.ensureLocalUserKeyPair(user, this.tenant.getCurrentUserPassword());
    const epoch = currentUserKeyEpoch(payload) ?? "1";
    const gen = payload.userKeys[epoch];
    const fingerprint = await fingerprintUserPublicKey(pair.publicKey, this.tenant.getCryptoAdapter());
    await replaceUserKeys(doc.getDatabase(), doc, {
      ...payload.userKeys,
      [epoch]: {
        publicKey: pair.publicKey,
        fingerprint,
        createdAt: gen?.createdAt ?? Date.now(),
        deviceWraps: {},
      },
    });
    const db = await this.openUserDirectory();
    const refreshed = await db.getDocument(doc.getId());
    const nextPayload = asUserKeyPayload(refreshed.getData()) ?? payload;
    const nextDoc = refreshed;
    await this.wrapPrivateKeyForActiveGrantDevices(nextDoc, nextPayload);
    const wrappedDoc = await db.getDocument(nextDoc.getId());
    const wrappedPayload = asUserKeyPayload(wrappedDoc.getData()) ?? nextPayload;
    await this.writeOwnDeviceWrap(wrappedDoc, wrappedPayload);
    const afterDoc = await db.getDocument(wrappedDoc.getId());
    const afterPayload = asUserKeyPayload(afterDoc.getData());
    return afterPayload
      ? { doc: afterDoc, payload: afterPayload }
      : { doc: wrappedDoc, payload: wrappedPayload };
  }

  /**
   * A wrap-less document cannot be used by any device. Either wrap it with the
   * local pair that matches the planted public key, or replace that key and wrap.
   * This is the recovery path for an already-minted pending document (the user's
   * leftover `deviceWraps: {}` row).
   */
  private async sealPendingUserKeyDocument(
    doc: MindooDoc,
    payload: UserKeyDocumentPayload,
  ): Promise<{ doc: MindooDoc; payload: UserKeyDocumentPayload }> {
    const user = this.tenant.getCurrentPrivateUser();
    await this.ensureLocalUserKeyPair(user, this.tenant.getCurrentUserPassword());
    const localPublic = await this.getLocalUserPublicKey();
    const epoch = currentUserKeyEpoch(payload);
    const published = epoch ? payload.userKeys[epoch]?.publicKey : undefined;
    const bytes = await this.getDecryptedUserKeyBytes();
    const canUsePlantedKey = Boolean(
      localPublic && published && localPublic === published && bytes,
    );
    try {
      if (canUsePlantedKey) {
        await this.writeOwnDeviceWrap(doc, payload);
        await this.wrapPrivateKeyForActiveGrantDevices(doc, payload, {
          legacyUnstampedOnly: true,
        });
      } else {
        console.warn(
          "[userkeys] sealing pending document by adopting a new pair",
          {
            hasLocalPublic: Boolean(localPublic),
            publicKeysMatch: localPublic === published,
            hasPrivateBytes: Boolean(bytes),
          },
        );
        return await this.adoptPendingUserKeyDocument(doc, payload);
      }
    } catch (error) {
      console.warn("[userkeys] wrap of pending document failed, adopting", error);
      return await this.adoptPendingUserKeyDocument(doc, payload);
    }
    const db = await this.openUserDirectory();
    const afterDoc = await db.getDocument(doc.getId());
    const afterPayload = asUserKeyPayload(afterDoc.getData());
    return afterPayload ? { doc: afterDoc, payload: afterPayload } : { doc, payload };
  }

  isReconciling(): boolean {
    return this.reconcileInFlight !== null;
  }

  /**
   * True when userdirectory has been fetched this session, or is already fully
   * initialized. In-flight `openDB` does **not** count: treating that as ready
   * starts reconcile during initialize, which re-enters `updateUnifiedCache`
   * and unbounded-allocates Automerge/AES heaps.
   */
  private canReconcileAgainstUserDirectory(): boolean {
    if (this.userDirectoryFetched) return true;
    if (typeof this.tenant.isDatabaseReady === "function") {
      return this.tenant.isDatabaseReady(USER_DIRECTORY_DB_ID);
    }
    return this.tenant.isDatabaseOpen?.(USER_DIRECTORY_DB_ID) === true;
  }

  async reconcile(options?: { allowSelfCreate?: boolean }): Promise<UserKeyEnrollmentStatus> {
    if (this.reconcileInFlight) {
      const inFlight = await this.reconcileInFlight;
      if (options?.allowSelfCreate !== true) return inFlight;
    }
    const run = this.reconcileInner(options).finally(() => {
      if (this.reconcileInFlight === run) this.reconcileInFlight = null;
    });
    this.reconcileInFlight = run;
    return run;
  }

  private async reconcileInner(options?: { allowSelfCreate?: boolean }): Promise<UserKeyEnrollmentStatus> {
    try {
      if (!this.canReconcileAgainstUserDirectory()) {
        return this.enrollmentStatus(null, "unknown");
      }
      const db = await this.openUserDirectory();
      await db.syncStoreChanges();
      if (this.userDirectoryFetched) {
        this.lastUserDirectoryFetchError = null;
      }

      let resolved = await this.resolveOwnUserKeyDocument();
      if (!resolved) {
        resolved = await this.ensureOwnUserKeyDocument(options);
      }
      if (!resolved) {
        return this.enrollmentStatus(null, "unknown");
      }

      if (isPendingUserKeyDocument(resolved.payload)) {
        resolved = await this.sealPendingUserKeyDocument(resolved.doc, resolved.payload);
      }

      const localPublic = await this.getLocalUserPublicKey();
      if (!localPublic) {
        await this.tryImportUserKeyFromWrap(resolved.payload);
      }
      let afterImport = await this.getLocalUserPublicKey();
      if (afterImport) {
        const epoch = currentUserKeyEpoch(resolved.payload);
        const published = epoch ? resolved.payload.userKeys[epoch]?.publicKey : undefined;
        if (published && published !== afterImport) {
          await this.tryImportUserKeyFromWrap(resolved.payload);
          afterImport = await this.getLocalUserPublicKey();
        }
        const user = this.tenant.getCurrentPrivateUser();
        const deviceFp = await fingerprintEncryptionPublicKey(
          user.userEncryptionKeyPair.publicKey,
          this.tenant.getCryptoAdapter().getSubtle(),
        );
        const hasOwnWrap = Object.values(resolved.payload.userKeys).some(
          (gen) => !!gen.deviceWraps?.[deviceFp],
        );
        if (published && afterImport && published !== afterImport) {
          const matchesSomeEpoch = Object.values(resolved.payload.userKeys).some(
            (gen) => gen.publicKey === afterImport,
          );
          if (!matchesSomeEpoch) {
            if (hasOwnWrap) {
              throw new UserKeyMismatchError();
            }
            await this.dropRevokedDeviceWraps(resolved.doc, resolved.payload);
            return this.enrollmentStatus(resolved.payload, "waiting");
          }
        }
        if (!hasOwnWrap && afterImport === published) {
          await this.writeOwnDeviceWrap(resolved.doc, resolved.payload);
          resolved = (await this.resolveOwnUserKeyDocument()) ?? resolved;
        }
        if (afterImport === published) {
          await this.wrapPrivateKeyForActiveGrantDevices(resolved.doc, resolved.payload, {
            legacyUnstampedOnly: true,
          });
          resolved = (await this.resolveOwnUserKeyDocument()) ?? resolved;
        }
      }

      await this.dropRevokedDeviceWraps(resolved.doc, resolved.payload);
      return this.enrollmentStatus(resolved.payload, this.waitState());
    } catch (error) {
      if (error instanceof UserKeyMismatchError) throw error;
      this.lastUserDirectoryFetchError = error;
      console.warn("[userkeys] reconcile failed", error);
      return this.enrollmentStatus(null, "unknown");
    }
  }

  async listPendingUserKeyDevices(): Promise<PendingUserKeyDevice[]> {
    const resolved = await this.resolveOwnUserKeyDocument();
    if (!resolved) return [];
    const directory = await this.directory();
    const username = (await this.tenant.getCurrentUserId()).username;
    const overview = await directory.getUserGrantOverview(username);
    const fallbackAddedAt = await this.grantCreatedAtFallback(username);
    const wrapped = this.wrappedDeviceFingerprints(resolved.payload);
    const rejected = new Set(Object.keys(resolved.payload.rejectedDevices ?? {}));
    const pending: PendingUserKeyDevice[] = [];
    for (const device of overview.activeDevices) {
      const fp = await fingerprintEncryptionPublicKey(
        device.encryptionPublicKey,
        this.tenant.getCryptoAdapter().getSubtle(),
      );
      if (wrapped.has(fp) || rejected.has(fp)) continue;
      pending.push({
        fingerprint: fp,
        signingPublicKey: device.signingPublicKey,
        encryptionPublicKey: device.encryptionPublicKey,
        label: device.label,
        addedAt: device.addedAt ?? fallbackAddedAt,
      });
    }
    return pending;
  }

  async listUserKeyDevices(): Promise<UserKeyDeviceRow[]> {
    const resolved = await this.resolveOwnUserKeyDocument();
    if (!resolved) return [];
    const directory = await this.directory();
    const username = (await this.tenant.getCurrentUserId()).username;
    const overview = await directory.getUserGrantOverview(username);
    const fallbackAddedAt = await this.grantCreatedAtFallback(username);
    const wrapped = this.wrappedDeviceFingerprints(resolved.payload);
    const rejected = resolved.payload.rejectedDevices ?? {};
    const rows: UserKeyDeviceRow[] = [];
    const seen = new Set<string>();
    for (const device of overview.activeDevices) {
      const fp = await fingerprintEncryptionPublicKey(
        device.encryptionPublicKey,
        this.tenant.getCryptoAdapter().getSubtle(),
      );
      seen.add(fp);
      const status = wrapped.has(fp) ? "approved" : rejected[fp] ? "declined" : "pending";
      rows.push({
        fingerprint: fp,
        signingPublicKey: device.signingPublicKey,
        encryptionPublicKey: device.encryptionPublicKey,
        label: device.label,
        addedAt: device.addedAt ?? fallbackAddedAt,
        status,
      });
    }
    for (const [fp, wrap] of Object.entries(
      Object.values(resolved.payload.userKeys ?? {}).reduce<
        Record<string, { label?: string; approvedAt?: number }>
      >(
        (acc, gen) => Object.assign(acc, gen.deviceWraps ?? {}),
        {},
      ),
    )) {
      if (seen.has(fp)) continue;
      rows.push({
        fingerprint: fp,
        label: wrap.label,
        addedAt: wrap.approvedAt,
        status: "approved",
      });
    }
    for (const fp of Object.keys(rejected)) {
      if (seen.has(fp)) continue;
      rows.push({ fingerprint: fp, status: "declined" });
    }
    return rows;
  }

  async approveUserKeyDevice(fingerprint: string): Promise<void> {
    const resolved = await this.resolveOwnUserKeyDocument();
    if (!resolved) {
      throw new Error("Cannot approve a device: no user-key document");
    }
    const directory = await this.directory();
    const username = (await this.tenant.getCurrentUserId()).username;
    const overview = await directory.getUserGrantOverview(username);
    const match = await this.findActiveDeviceByFingerprint(overview.activeDevices, fingerprint);
    if (!match) {
      throw new Error(`Cannot approve device "${fingerprint}": not an active grant device`);
    }
    const signer = await this.tenant.getCurrentUserId();
    const db = resolved.doc.getDatabase();
    let wroteWrap = false;
    for (const epoch of this.epochsNewestFirst(resolved.payload).reverse()) {
      const bytes = await this.privateKeyBytesForEpoch(resolved.payload, epoch);
      if (!bytes) continue;
      const wrapped = await wrapPrivateKeyForDevice({
        cryptoAdapter: this.tenant.getCryptoAdapter(),
        privateKeyBytes: bytes,
        deviceEncryptionPublicKey: match.encryptionPublicKey,
      });
      await writeDeviceWrap({
        db,
        doc: resolved.doc,
        epoch,
        deviceFingerprint: fingerprint,
        wrap: {
          wrappedKey: wrapped,
          ...(match.label ? { label: match.label } : {}),
          approvedAt: Date.now(),
          approvedBySigningPublicKey: signer.userSigningPublicKey,
        },
      });
      wroteWrap = true;
    }
    if (!wroteWrap) {
      throw new Error("Cannot approve a device: local User-Key is locked");
    }
    if (resolved.payload.rejectedDevices?.[fingerprint]) {
      const next = { ...resolved.payload.rejectedDevices };
      delete next[fingerprint];
      await replaceRejectedDevices(db, resolved.doc, next);
    }
  }

  async declineUserKeyDevice(fingerprint: string): Promise<void> {
    const resolved = await this.resolveOwnUserKeyDocument();
    if (!resolved) {
      throw new Error("Cannot decline a device: no user-key document");
    }
    const signer = await this.tenant.getCurrentUserId();
    await replaceRejectedDevices(resolved.doc.getDatabase(), resolved.doc, {
      ...(resolved.payload.rejectedDevices ?? {}),
      [fingerprint]: {
        rejectedAt: Date.now(),
        rejectedBySigningPublicKey: signer.userSigningPublicKey,
      },
    });
  }

  async undoDeclineUserKeyDevice(fingerprint: string): Promise<void> {
    const resolved = await this.resolveOwnUserKeyDocument();
    if (!resolved) return;
    if (!resolved.payload.rejectedDevices?.[fingerprint]) return;
    const next = { ...resolved.payload.rejectedDevices };
    delete next[fingerprint];
    await replaceRejectedDevices(resolved.doc.getDatabase(), resolved.doc, next);
  }

  async rotateUserKey(): Promise<void> {
    const resolved = await this.resolveOwnUserKeyDocument();
    if (!resolved) {
      throw new Error("Cannot rotate: no user-key document");
    }
    const current = currentUserKeyEpoch(resolved.payload);
    if (!current) {
      throw new Error("Cannot rotate: user-key document has no generations");
    }
    const nextEpoch = (BigInt(current) + 1n).toString();
    if (resolved.payload.userKeys[nextEpoch]) {
      throw new Error(`Cannot rotate: epoch ${nextEpoch} already exists`);
    }
    const user = this.tenant.getCurrentPrivateUser();
    const generated = await generateRsaOaep3072(this.tenant.getCryptoAdapter());
    const encrypted = await encryptPrivateKey(
      this.tenant.getCryptoAdapter(),
      generated.privateKeyBytes,
      this.tenant.getCurrentUserPassword(),
      USERKEY_PRIVATE_SALT,
    );
    user.userKeyPair = {
      publicKey: generated.publicKeyPem,
      privateKey: encrypted,
    };
    this.decryptedUserKeyBytes = generated.privateKeyBytes;
    this.decryptedUserKeyCache = null;
    const fingerprint = await fingerprintUserPublicKey(
      generated.publicKeyPem,
      this.tenant.getCryptoAdapter(),
    );
    const signer = await this.tenant.getCurrentUserId();
    const now = Date.now();
    const directory = await this.directory();
    const overview = await directory.getUserGrantOverview(signer.username);
    const previousWraps = resolved.payload.userKeys[current]?.deviceWraps ?? {};
    const deviceWraps: UserKeyDocumentPayload["userKeys"][string]["deviceWraps"] = {};
    for (const device of overview.activeDevices) {
      const deviceFp = await fingerprintEncryptionPublicKey(
        device.encryptionPublicKey,
        this.tenant.getCryptoAdapter().getSubtle(),
      );
      if (!previousWraps[deviceFp]) continue;
      deviceWraps[deviceFp] = {
        wrappedKey: await wrapPrivateKeyForDevice({
          cryptoAdapter: this.tenant.getCryptoAdapter(),
          privateKeyBytes: generated.privateKeyBytes,
          deviceEncryptionPublicKey: device.encryptionPublicKey,
        }),
        ...(device.label ? { label: device.label } : {}),
        approvedAt: now,
        approvedBySigningPublicKey: signer.userSigningPublicKey,
      };
    }
    await replaceUserKeys(resolved.doc.getDatabase(), resolved.doc, {
      ...resolved.payload.userKeys,
      [current]: { ...resolved.payload.userKeys[current], retiredAt: now },
      [nextEpoch]: {
        publicKey: generated.publicKeyPem,
        fingerprint,
        createdAt: now,
        deviceWraps,
      },
    });
  }

  async publishedUserKeyFor(username: string): Promise<{
    publicKey: string;
    fingerprint: string;
    pending: boolean;
  } | null> {
    if (!this.canReconcileAgainstUserDirectory()) {
      return null;
    }
    const directory = await this.directory();
    const db = await this.openUserDirectory();
    const hashes = await directory.getUsernameHashCandidates(username);
    const grants = await directory.findGrantAccessDocuments(username);
    const resolved = await resolveUserKeyDocument({
      db,
      directory,
      username,
      usernameHashCandidates: hashes,
      grantDocIds: grants.map((g) => g.getId()),
      adminPublicKey: this.tenant.getAdministrationPublicKey(),
    });
    if (!resolved) return null;
    const epoch = currentUserKeyEpoch(resolved.payload);
    if (!epoch) return null;
    const gen = resolved.payload.userKeys[epoch];
    return {
      publicKey: gen.publicKey,
      fingerprint: gen.fingerprint,
      pending: isPendingUserKeyDocument(resolved.payload),
    };
  }

  async getEnrollmentStatus(): Promise<UserKeyEnrollmentStatus> {
    if (this.lastUserDirectoryFetchError && !this.userDirectoryFetched) {
      return this.enrollmentStatus(null, "unknown");
    }
    const resolved = await this.resolveOwnUserKeyDocument();
    if (!resolved) {
      return this.enrollmentStatus(null, this.userDirectoryFetched ? "waiting" : "unknown");
    }
    return this.enrollmentStatus(resolved.payload, this.waitState());
  }

  private waitState(): UserKeyWaitState {
    if (!this.userDirectoryFetched && this.lastUserDirectoryFetchError) return "unknown";
    return this.userDirectoryFetched ? "waiting" : "unknown";
  }

  private async waitStateForDevice(payload: UserKeyDocumentPayload): Promise<UserKeyWaitState> {
    const user = this.tenant.getCurrentPrivateUser();
    const fp = await fingerprintEncryptionPublicKey(
      user.userEncryptionKeyPair.publicKey,
      this.tenant.getCryptoAdapter().getSubtle(),
    );
    // A wrap on this device is enough to be approved. Do not wait for a
    // userdirectory fetch flag: reload / local-only mint already has the wrap
    // in the local replica, and treating that as "unknown" keeps the waiting
    // banner up after the approve dialog is gone.
    if (this.wrappedDeviceFingerprints(payload).has(fp)) return "approved";
    if (!this.userDirectoryFetched && this.lastUserDirectoryFetchError) return "unknown";
    if (!this.userDirectoryFetched) return "unknown";
    return "waiting";
  }

  private async enrollmentStatus(
    payload: UserKeyDocumentPayload | null,
    fallback: UserKeyWaitState,
  ): Promise<UserKeyEnrollmentStatus> {
    if (!payload) {
      return { state: fallback, pending: true, missingKeys: ["default"] };
    }
    const state = await this.waitStateForDevice(payload);
    const pending = isPendingUserKeyDocument(payload);
    const missingKeys = state === "approved" ? [] : ["default"];
    return { state, pending, missingKeys };
  }

  private epochsNewestFirst(payload: UserKeyDocumentPayload): string[] {
    return Object.keys(payload.userKeys ?? {})
      .filter((epoch) => /^\d+$/.test(epoch))
      .sort((a, b) => (BigInt(a) > BigInt(b) ? -1 : BigInt(a) < BigInt(b) ? 1 : 0));
  }

  private async privateKeyBytesForEpoch(
    payload: UserKeyDocumentPayload,
    epoch: string,
  ): Promise<Uint8Array | null> {
    const gen = payload.userKeys[epoch];
    if (!gen) return null;
    const localPublic = await this.getLocalUserPublicKey();
    if (localPublic && gen.publicKey === localPublic) {
      return this.getDecryptedUserKeyBytes();
    }
    const deviceKey = await this.tenant.getEncryptionPrivateKeyForReconcile();
    if (!deviceKey) return null;
    const user = this.tenant.getCurrentPrivateUser();
    const deviceFp = await fingerprintEncryptionPublicKey(
      user.userEncryptionKeyPair.publicKey,
      this.tenant.getCryptoAdapter().getSubtle(),
    );
    const wrap = gen.deviceWraps?.[deviceFp];
    if (!wrap?.wrappedKey) return null;
    try {
      return unwrapPrivateKeyFromDevice({
        cryptoAdapter: this.tenant.getCryptoAdapter(),
        wrappedKeyB64: wrap.wrappedKey,
        deviceEncryptionPrivateKey: deviceKey,
      });
    } catch {
      return null;
    }
  }

  private async grantCreatedAtFallback(username: string): Promise<number | undefined> {
    const directory = await this.directory();
    const grants = await directory.findGrantAccessDocuments(username);
    let earliest: number | undefined;
    for (const grant of grants) {
      const created = grant.getCreatedAt();
      if (typeof created !== "number") continue;
      earliest = earliest == null ? created : Math.min(earliest, created);
    }
    return earliest;
  }

  private wrappedDeviceFingerprints(payload: UserKeyDocumentPayload): Set<string> {
    const fps = new Set<string>();
    for (const gen of Object.values(payload.userKeys ?? {})) {
      for (const fp of Object.keys(gen.deviceWraps ?? {})) fps.add(fp);
    }
    return fps;
  }

  private async dropRevokedDeviceWraps(
    doc: MindooDoc,
    payload: UserKeyDocumentPayload,
  ): Promise<void> {
    const directory = await this.directory();
    const username = (await this.tenant.getCurrentUserId()).username;
    const grants = await directory.findGrantAccessDocuments(username);
    const revokedFps = new Set<string>();
    const crypto = this.tenant.getCryptoAdapter();
    for (const grant of grants) {
      for (const pair of extractRevokedKeyPairs(grant.getData())) {
        if (!pair.encryptionPublicKey) continue;
        revokedFps.add(
          await fingerprintEncryptionPublicKey(pair.encryptionPublicKey, crypto.getSubtle()),
        );
      }
    }
    if (revokedFps.size === 0) return;
    let changed = false;
    const userKeys: UserKeyDocumentPayload["userKeys"] = {};
    for (const [epoch, gen] of Object.entries(payload.userKeys ?? {})) {
      const deviceWraps = { ...(gen.deviceWraps ?? {}) };
      for (const fp of Object.keys(deviceWraps)) {
        if (revokedFps.has(fp)) {
          delete deviceWraps[fp];
          changed = true;
        }
      }
      userKeys[epoch] = { ...gen, deviceWraps };
    }
    if (!changed) return;
    await replaceUserKeys(doc.getDatabase(), doc, userKeys);
  }

  private async findActiveDeviceByFingerprint(
    devices: Array<{ signingPublicKey: string; encryptionPublicKey: string; label?: string }>,
    fingerprint: string,
  ): Promise<{ signingPublicKey: string; encryptionPublicKey: string; label?: string } | null> {
    const crypto = this.tenant.getCryptoAdapter();
    for (const device of devices) {
      const fp = await fingerprintEncryptionPublicKey(device.encryptionPublicKey, crypto.getSubtle());
      if (fp === fingerprint) return device;
    }
    return null;
  }

  /**
   * Bind a userkey document to the grant that names this person.
   * Writes the grant's `username_hash` (not the current write-version hash) so
   * the userdirectory invariant matches `resolveUsernameHashForSigningKey`.
   * When `signingPublicKey` is set (self-mint), that key must be on the grant.
   */
  private async mintBindingForUsername(
    username: string,
    signingPublicKey?: string,
  ): Promise<{ grantDocId: string; usernameHash: string; usernameHashVersion: number } | null> {
    const directory = await this.directory();
    const grants = await directory.findGrantAccessDocuments(username);
    if (grants.length === 0) return null;
    let signerHash: string | null = null;
    if (signingPublicKey && typeof directory.resolveUsernameHashForSigningKey === "function") {
      signerHash = await directory.resolveUsernameHashForSigningKey(
        signingPublicKey,
        Number.MAX_SAFE_INTEGER,
      );
      if (!signerHash) return null;
    }
    const grant =
      (signerHash
        ? grants.find((g) => (g.getData() as Record<string, unknown>).username_hash === signerHash)
        : undefined) ?? grants[0];
    const binding = usernameHashBindingFromGrant(grant.getData() as Record<string, unknown>);
    const usernameHash = signerHash ?? binding?.usernameHash;
    if (!usernameHash) return null;
    return {
      grantDocId: grant.getId(),
      usernameHash,
      usernameHashVersion: binding?.usernameHashVersion ?? USERKEY_USERNAME_HASH_VERSION,
    };
  }

  private async labelForOwnEncryptionKey(): Promise<string | undefined> {
    try {
      const directory = await this.directory();
      const signer = await this.tenant.getCurrentUserId();
      const user = this.tenant.getCurrentPrivateUser();
      const overview = await directory.getUserGrantOverview(signer.username);
      return overview.activeDevices.find(
        (device) => device.encryptionPublicKey === user.userEncryptionKeyPair.publicKey,
      )?.label;
    } catch {
      return undefined;
    }
  }

  private async directory(): Promise<BaseMindooTenantDirectory> {
    const directory = await this.tenant.openDirectory();
    return directory as BaseMindooTenantDirectory;
  }
}

