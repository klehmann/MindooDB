import type { BaseMindooTenant } from "../BaseMindooTenant";
import type { BaseMindooTenantDirectory } from "../BaseMindooTenantDirectory";
import { extractRevokedKeyPairs } from "../accesscontrol/grantKeys";
import { encryptPrivateKey } from "../crypto/privateKeyEncryption";
import { RSAEncryption } from "../crypto/RSAEncryption";
import { generateRsaOaep3072, importRsaOaepPrivateKey } from "../crypto/rsaOaep3072";
import type { EncryptionKeyPair, MindooDB, MindooDoc, PrivateUserId, SigningKeyPair } from "../types";
import { DEFAULT_TENANT_KEY_ID, USER_DIRECTORY_DB_ID } from "../types";
import { fingerprintEncryptionPublicKey } from "./fingerprint";
import {
  applyGenerationValidity,
  resolveUserKeyDocument,
  type ResolvedUserKeyDocument,
} from "./resolveUserKeyDocument";
import {
  deriveGenerationSigningKey,
  ed25519FromPkcs8,
  generateSelfGrantKeyPair,
  signEd25519,
  userKeyGenerationSigningMessage,
} from "./generationSignature";
import { normalizePublicKeyPem } from "./fingerprint";
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
  DEVICE_SELF_GRANT_PRIVATE_SALT,
  USERKEY_PRIVATE_SALT,
  USERKEY_USERNAME_HASH_VERSION,
  UserKeyDecryptError,
  UserKeyMismatchError,
  currentUserKeyEpoch,
  isPendingUserKeyDocument,
  userKeyDocumentId,
  type PendingUserKeyDevice,
  type UserKeyDeviceRow,
  type UserKeyDeviceWrap,
  type UserKeyDocumentPayload,
  type UserKeyGeneration,
  type UserKeyGenerationSignature,
  type UserKeyEnrollmentStatus,
  type UserKeyWaitState,
} from "./types";

export class UserKeyManager {
  private userDirectoryFetched = false;
  private lastUserDirectoryFetchError: unknown = null;
  private decryptedUserKeyCache: CryptoKey | null = null;
  private decryptedUserKeyBytes: Uint8Array | null = null;
  private seededBytesMatchLocalPublic: boolean | null = null;
  private seededBytesVerifiedForPublicKey: string | null = null;
  private resolvingOwnDeviceWrap = false;
  private reconcileInFlight: Promise<UserKeyEnrollmentStatus> | null = null;
  private decryptedSelfGrantBytes: Uint8Array | null = null;
  private resolvingSelfGrantWrap = false;

  constructor(private readonly tenant: BaseMindooTenant) {}

  noteUserDirectoryFetched(): void {
    this.userDirectoryFetched = true;
    this.lastUserDirectoryFetchError = null;
  }

  noteUserDirectoryFetchFailed(error: unknown): void {
    this.lastUserDirectoryFetchError = error;
  }

  /**
   * Inject User-Key PKCS8 bytes already decrypted by the host (Haven unlock).
   * Used when `currentUserPassword` is empty so mint/wrap does not generate a
   * second pair.
   */
  seedDecryptedUserKeyBytes(bytes: Uint8Array): void {
    this.decryptedUserKeyBytes = bytes.slice();
    this.decryptedUserKeyCache = null;
    this.seededBytesMatchLocalPublic = null;
    this.seededBytesVerifiedForPublicKey = null;
  }

  /**
   * RSA round-trip against `publicKeyPem`: seal a probe with the public key and
   * open it with the seeded private bytes. Cheaper than deriving the public key
   * from PKCS8 and works on every crypto adapter.
   */
  private async seededBytesBelongToLocalPublicKey(publicKeyPem: string): Promise<boolean> {
    if (
      this.seededBytesMatchLocalPublic !== null &&
      this.seededBytesVerifiedForPublicKey === publicKeyPem
    ) {
      return this.seededBytesMatchLocalPublic;
    }
    const bytes = this.decryptedUserKeyBytes;
    if (!bytes) return false;
    let matches = false;
    try {
      const crypto = this.tenant.getCryptoAdapter();
      const rsa = new RSAEncryption(crypto);
      const probe = crypto.getRandomValues(new Uint8Array(16));
      const sealed = await rsa.encrypt(probe, publicKeyPem);
      const privateKey = await importRsaOaepPrivateKey(crypto, bytes.slice(), false);
      const opened = await rsa.decrypt(sealed, privateKey);
      matches = opened.length === probe.length && opened.every((b, i) => b === probe[i]);
    } catch (error) {
      console.warn("[userkeys] User-Key round-trip check failed", error);
      matches = false;
    }
    const fingerprint = await fingerprintEncryptionPublicKey(
      publicKeyPem,
      this.tenant.getCryptoAdapter().getSubtle(),
    ).catch(() => "?");
    console.log(
      matches
        ? "[userkeys] seeded User-Key private bytes match the local public key"
        : "[userkeys] seeded User-Key private bytes do NOT match the local public key",
      { publicKeyFingerprint: fingerprint },
    );
    this.seededBytesMatchLocalPublic = matches;
    this.seededBytesVerifiedForPublicKey = publicKeyPem;
    return matches;
  }

  hasFetchedUserDirectory(): boolean {
    return this.userDirectoryFetched;
  }

  async ensureLocalUserKeyPair(user: PrivateUserId, password: string): Promise<EncryptionKeyPair> {
    if (user.userKeyPair) {
      // Host-seeded bytes come first: Haven opens with an empty password, so
      // trying PBKDF2 would only log a decrypt failure per call. They must
      // belong to `userKeyPair.publicKey` — a foreign pair would publish a
      // document whose wraps nobody, not even this device, can open.
      if (
        this.decryptedUserKeyBytes &&
        (await this.seededBytesBelongToLocalPublicKey(user.userKeyPair.publicKey))
      ) {
        return user.userKeyPair;
      }
      const usable = password
        ? await this.decryptUserKeyPairBytes(user.userKeyPair, password)
        : null;
      if (usable) {
        this.decryptedUserKeyBytes = usable;
        this.seededBytesMatchLocalPublic = true;
        this.seededBytesVerifiedForPublicKey = user.userKeyPair.publicKey;
        return user.userKeyPair;
      }
      // Joined device: the key lives as a wrap to this device's key, and the
      // host may have seeded different bytes for the same identity.
      const fromWrap = await this.ownDeviceWrapPrivateKeyBytes(user.userKeyPair.publicKey);
      if (fromWrap) {
        this.decryptedUserKeyBytes = fromWrap;
        this.decryptedUserKeyCache = null;
        this.seededBytesMatchLocalPublic = true;
        this.seededBytesVerifiedForPublicKey = user.userKeyPair.publicKey;
        return user.userKeyPair;
      }
      if (this.decryptedUserKeyBytes) {
        console.error(
          "[userkeys] seeded User-Key private bytes do not match the identity's User-Key public key",
        );
      }
      throw new UserKeyDecryptError();
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
    this.seededBytesMatchLocalPublic = true;
    this.seededBytesVerifiedForPublicKey = pair.publicKey;
    if (!user.deviceSelfGrantKeyPair) {
      await this.generateLocalSelfGrantKey(user, password);
    }
    return pair;
  }

  // ==================== Device self-grant key (docs/userkeys.md §9) ====================

  private async generateLocalSelfGrantKey(user: PrivateUserId, password: string): Promise<void> {
    const crypto = this.tenant.getCryptoAdapter();
    const generated = await generateSelfGrantKeyPair(crypto);
    user.deviceSelfGrantKeyPair = {
      publicKey: generated.publicKeyPem,
      privateKey: await encryptPrivateKey(
        crypto,
        generated.privateKeyBytes,
        password,
        DEVICE_SELF_GRANT_PRIVATE_SALT,
      ),
    };
    this.decryptedSelfGrantBytes = generated.privateKeyBytes;
  }

  /**
   * Public half of this person's device self-grant key, as held by this
   * device (docs/userkeys.md §9). The admin names it in the grant with
   * `directory.setDeviceSelfGrant`. `null` while this device holds none.
   */
  async getDeviceSelfGrantPublicKey(): Promise<string | null> {
    const bytes = await this.getSelfGrantPrivateKeyBytes();
    if (!bytes) return null;
    return this.tenant.getCurrentPrivateUser().deviceSelfGrantKeyPair?.publicKey ?? null;
  }

  /**
   * The self-grant private key (PKCS8): from memory, the password-encrypted
   * copy on the identity, or this device's wrap in the own User-Key document.
   * When the admin named a key in the grant, a held key that differs is not
   * returned as long as a wrap of the granted key exists.
   */
  async getSelfGrantPrivateKeyBytes(): Promise<Uint8Array | null> {
    if (this.decryptedSelfGrantBytes) return this.decryptedSelfGrantBytes;
    const user = this.tenant.getCurrentPrivateUser();
    const pair = user.deviceSelfGrantKeyPair;
    const password = this.tenant.getCurrentUserPassword();
    // A device that made its own key before joining holds one nobody else
    // knows; the person's key (the one in the grant) comes from a wrap.
    const granted = await this.grantedSelfGrantKey();
    if (granted && pair && normalizePublicKeyPem(pair.publicKey) !== normalizePublicKeyPem(granted)) {
      const fromWrap = await this.importSelfGrantKeyFromWrap();
      if (fromWrap) return fromWrap;
    }
    if (pair && password) {
      try {
        const bytes = new Uint8Array(
          await this.tenant.decryptPrivateKey(pair.privateKey, password, DEVICE_SELF_GRANT_PRIVATE_SALT),
        );
        const derived = await ed25519FromPkcs8(this.tenant.getCryptoAdapter(), bytes);
        if (normalizePublicKeyPem(derived.publicKeyPem) === normalizePublicKeyPem(pair.publicKey)) {
          this.decryptedSelfGrantBytes = bytes;
          return bytes;
        }
      } catch {
        // fall through to the wrap
      }
    }
    return this.importSelfGrantKeyFromWrap();
  }

  /** Unwrap the self-grant key from this device's wrap and keep it on the identity. */
  private async importSelfGrantKeyFromWrap(): Promise<Uint8Array | null> {
    if (this.resolvingSelfGrantWrap) return null;
    this.resolvingSelfGrantWrap = true;
    try {
      if (!this.canReconcileAgainstUserDirectory()) return null;
      const deviceKey = await this.tenant.getEncryptionPrivateKeyForReconcile();
      if (!deviceKey) return null;
      const resolved = await this.resolveOwnUserKeyDocument();
      if (!resolved) return null;
      const crypto = this.tenant.getCryptoAdapter();
      const user = this.tenant.getCurrentPrivateUser();
      const deviceFp = await fingerprintEncryptionPublicKey(
        user.userEncryptionKeyPair.publicKey,
        crypto.getSubtle(),
      );
      const granted = await this.grantedSelfGrantKey();
      let fallback: { bytes: Uint8Array; publicKeyPem: string } | null = null;
      for (const epoch of this.epochsNewestFirst(resolved.payload)) {
        const wrapped = resolved.payload.userKeys[epoch]?.deviceWraps?.[deviceFp]?.wrappedSelfGrantKey;
        if (!wrapped) continue;
        try {
          const bytes = await unwrapPrivateKeyFromDevice({
            cryptoAdapter: crypto,
            wrappedKeyB64: wrapped,
            deviceEncryptionPrivateKey: deviceKey,
          });
          const { publicKeyPem } = await ed25519FromPkcs8(crypto, bytes);
          if (!granted || normalizePublicKeyPem(publicKeyPem) === normalizePublicKeyPem(granted)) {
            fallback = { bytes, publicKeyPem };
            break;
          }
          fallback ??= { bytes, publicKeyPem };
        } catch (error) {
          console.warn("[userkeys] self-grant key unwrap failed", { epoch }, error);
        }
      }
      if (!fallback) return null;
      user.deviceSelfGrantKeyPair = {
        publicKey: fallback.publicKeyPem,
        privateKey: await encryptPrivateKey(
          crypto,
          fallback.bytes,
          this.tenant.getCurrentUserPassword(),
          DEVICE_SELF_GRANT_PRIVATE_SALT,
        ),
      };
      this.decryptedSelfGrantBytes = fallback.bytes;
      return fallback.bytes;
    } finally {
      this.resolvingSelfGrantWrap = false;
    }
  }

  /** The self-grant key the admin named in this person's grant, or `null`. */
  private async grantedSelfGrantKey(): Promise<string | null> {
    try {
      const directory = await this.directory();
      const username = (await this.tenant.getCurrentUserId()).username;
      const grant = await directory.getDeviceSelfGrant(username);
      return grant && grant.revokedAt === undefined ? grant.signingPublicKey : null;
    } catch {
      return null;
    }
  }

  /** Self-grant signer for this device, if it holds the key. */
  private async selfGrantSigner(): Promise<{ privateKey: CryptoKey; publicKeyPem: string } | null> {
    const bytes = await this.getSelfGrantPrivateKeyBytes();
    if (!bytes) return null;
    try {
      return await ed25519FromPkcs8(this.tenant.getCryptoAdapter(), bytes);
    } catch {
      return null;
    }
  }

  /** Wrap the self-grant key to a device, when this device holds it. */
  private async wrapSelfGrantKeyFor(deviceEncryptionPublicKey: string): Promise<string | undefined> {
    const bytes = await this.getSelfGrantPrivateKeyBytes();
    if (!bytes) return undefined;
    return wrapPrivateKeyForDevice({
      cryptoAdapter: this.tenant.getCryptoAdapter(),
      privateKeyBytes: bytes,
      deviceEncryptionPublicKey,
    });
  }

  /**
   * Signing key and signatures for a generation (docs/userkeys.md §9.3).
   * `ownBytes` derive the generation's own signing key. Signs with the
   * previous generation's key when `previous` is given, with the self-grant
   * key when this device holds it, and with its own key when `selfSign`
   * (pending adoption; harmless otherwise).
   */
  private async generationSignatureFields(input: {
    usernameHash: string;
    epoch: string;
    gen: Pick<UserKeyGeneration, "publicKey" | "fingerprint" | "createdAt">;
    ownBytes: Uint8Array;
    previous?: { gen: UserKeyGeneration; bytes: Uint8Array } | null;
    selfSign?: boolean;
  }): Promise<{ signingPublicKey: string; signatures: UserKeyGenerationSignature[] }> {
    const crypto = this.tenant.getCryptoAdapter();
    const own = await deriveGenerationSigningKey(crypto, input.ownBytes);
    const message = userKeyGenerationSigningMessage(input.usernameHash, input.epoch, {
      ...input.gen,
      signingPublicKey: own.publicKeyPem,
    });
    const signatures: UserKeyGenerationSignature[] = [];
    if (input.previous?.gen.signingPublicKey) {
      const prev = await deriveGenerationSigningKey(crypto, input.previous.bytes);
      if (
        normalizePublicKeyPem(prev.publicKeyPem) ===
        normalizePublicKeyPem(input.previous.gen.signingPublicKey)
      ) {
        signatures.push({
          signerPublicKey: prev.publicKeyPem,
          signature: await signEd25519(crypto, prev.privateKey, message),
        });
      }
    }
    const selfGrant = await this.selfGrantSigner();
    if (selfGrant) {
      signatures.push({
        signerPublicKey: selfGrant.publicKeyPem,
        signature: await signEd25519(crypto, selfGrant.privateKey, message),
      });
    }
    if (input.selfSign) {
      signatures.push({
        signerPublicKey: own.publicKeyPem,
        signature: await signEd25519(crypto, own.privateKey, message),
      });
    }
    return { signingPublicKey: own.publicKeyPem, signatures };
  }

  /** The document's generations that count (docs/userkeys.md §9.3). */
  private async validated(doc: MindooDoc): Promise<ResolvedUserKeyDocument | null> {
    const raw = asUserKeyPayload(doc.getData());
    if (!raw) return null;
    return applyGenerationValidity(doc, raw, {
      db: doc.getDatabase(),
      directory: await this.directory(),
    });
  }

  /** Effective cutoff for unsigned generations of this person (tenant policy, self-grant). */
  private async generationSignatureCutoff(usernameHash: string): Promise<number | undefined> {
    const directory = await this.directory();
    const tenantCutoff = await directory.getRequireUserKeyGenerationSignatureSince();
    const selfGrant = await directory.getDeviceSelfGrantForUsernameHash(usernameHash);
    const cutoffs = [tenantCutoff, selfGrant?.grantedAt].filter(
      (t): t is number => typeof t === "number" && Number.isFinite(t),
    );
    return cutoffs.length > 0 ? Math.min(...cutoffs) : undefined;
  }

  /**
   * Give the current generation its signing key when it has none (or one this
   * device cannot derive), so the next rotation can be chained to it. Written
   * only when the change will count: while the person's document is pending,
   * before the cutoff, or signed by a granted self-grant key.
   */
  private async ensureCurrentGenerationSigningKey(
    resolved: ResolvedUserKeyDocument,
  ): Promise<void> {
    const epoch = currentUserKeyEpoch(resolved.payload);
    if (!epoch) return;
    const gen = resolved.payload.userKeys[epoch];
    const bytes = await this.privateKeyBytesForEpoch(resolved.payload, epoch);
    if (!gen || !bytes) return;
    const crypto = this.tenant.getCryptoAdapter();
    const derived = await deriveGenerationSigningKey(crypto, bytes);
    if (
      gen.signingPublicKey &&
      normalizePublicKeyPem(gen.signingPublicKey) === normalizePublicKeyPem(derived.publicKeyPem)
    ) {
      return;
    }
    const usernameHash = resolved.payload.username_hash;
    const pending = isPendingUserKeyDocument(resolved.rawPayload);
    const cutoff = await this.generationSignatureCutoff(usernameHash);
    const granted = await this.grantedSelfGrantKey();
    const selfGrant = granted ? await this.selfGrantSigner() : null;
    const holdsGranted =
      !!selfGrant && normalizePublicKeyPem(selfGrant.publicKeyPem) === normalizePublicKeyPem(granted!);
    const lowest = this.epochsNewestFirst(resolved.payload).reverse()[0] === epoch;
    const counts = (pending && lowest) || cutoff === undefined || Date.now() < cutoff || holdsGranted;
    if (!counts) return;
    const fields = await this.generationSignatureFields({
      usernameHash,
      epoch,
      gen,
      ownBytes: bytes,
      selfSign: pending && lowest,
    });
    const live = asUserKeyPayload(resolved.doc.getData()) ?? resolved.rawPayload;
    await replaceUserKeys(resolved.doc.getDatabase(), resolved.doc, {
      ...live.userKeys,
      [epoch]: { ...(live.userKeys[epoch] ?? gen), ...fields },
    });
  }

  /**
   * Make sure this person has a self-grant key and every approved device of
   * the current generation holds it (docs/userkeys.md §9). The first updated
   * device that holds the User-Key and finds no wrapped self-grant key creates
   * one; every device wraps the key it holds to devices that lack it.
   */
  private async ensureSelfGrantKeyDistributed(resolved: ResolvedUserKeyDocument): Promise<void> {
    const epoch = currentUserKeyEpoch(resolved.payload);
    if (!epoch) return;
    const gen = resolved.payload.userKeys[epoch];
    if (!gen) return;
    const userKeyBytes = await this.privateKeyBytesForEpoch(resolved.payload, epoch);
    if (!userKeyBytes) return;
    let bytes = await this.getSelfGrantPrivateKeyBytes();
    const anyWrapped = Object.values(gen.deviceWraps ?? {}).some((w) => !!w.wrappedSelfGrantKey);
    if (!bytes && !anyWrapped) {
      const user = this.tenant.getCurrentPrivateUser();
      await this.generateLocalSelfGrantKey(user, this.tenant.getCurrentUserPassword());
      bytes = this.decryptedSelfGrantBytes;
    }
    if (!bytes) return;
    const directory = await this.directory();
    const username = (await this.tenant.getCurrentUserId()).username;
    const overview = await directory.getUserGrantOverview(username);
    const crypto = this.tenant.getCryptoAdapter();
    const db = resolved.doc.getDatabase();
    for (const device of overview.activeDevices) {
      const fp = await fingerprintEncryptionPublicKey(device.encryptionPublicKey, crypto.getSubtle());
      const wrap = gen.deviceWraps?.[fp];
      if (!wrap?.wrappedKey || wrap.wrappedSelfGrantKey) continue;
      await writeDeviceWrap({
        db,
        doc: resolved.doc,
        epoch,
        deviceFingerprint: fp,
        wrap: { ...wrap, wrappedSelfGrantKey: await this.wrapSelfGrantKeyFor(device.encryptionPublicKey) },
      });
    }
    // Wraps written by other devices may not be in the grant overview yet
    // (directory not pulled). This device's own wrap is covered either way.
    const user = this.tenant.getCurrentPrivateUser();
    const ownFp = await fingerprintEncryptionPublicKey(
      user.userEncryptionKeyPair.publicKey,
      crypto.getSubtle(),
    );
    const live = asUserKeyPayload(resolved.doc.getData());
    const ownWrap = live?.userKeys[epoch]?.deviceWraps?.[ownFp];
    if (ownWrap?.wrappedKey && !ownWrap.wrappedSelfGrantKey) {
      await writeDeviceWrap({
        db,
        doc: resolved.doc,
        epoch,
        deviceFingerprint: ownFp,
        wrap: {
          ...ownWrap,
          wrappedSelfGrantKey: await this.wrapSelfGrantKeyFor(user.userEncryptionKeyPair.publicKey),
        },
      });
    }
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
    const user = this.tenant.getCurrentPrivateUser();
    const pair = user.userKeyPair;
    if (this.decryptedUserKeyBytes) {
      if (!pair) return this.decryptedUserKeyBytes;
      // Host-seeded bytes are only usable if they open the published pair;
      // wrapping with a foreign key produces wraps nobody can unwrap. On a
      // mismatch fall through to the password path rather than giving up.
      if (await this.seededBytesBelongToLocalPublicKey(pair.publicKey)) {
        return this.decryptedUserKeyBytes;
      }
    }
    if (!pair) return null;
    const password = this.tenant.getCurrentUserPassword();
    // Haven live-bag opens with "". PBKDF2 then fails loudly, so skip it and
    // let the device wrap supply the key.
    const bytes = password ? await this.decryptUserKeyPairBytes(pair, password) : null;
    if (bytes) {
      this.decryptedUserKeyBytes = bytes;
      this.seededBytesMatchLocalPublic = true;
      this.seededBytesVerifiedForPublicKey = pair.publicKey;
      return bytes;
    }
    // A joined device holds the User-Key only as a wrap to its device key, and
    // the host may have seeded this identity's own (different) bytes over it.
    // Recover from the wrap so wrapping/reconcile is not lost for the session.
    const fromWrap = await this.ownDeviceWrapPrivateKeyBytes(pair.publicKey);
    if (!fromWrap) return null;
    this.decryptedUserKeyBytes = fromWrap;
    this.decryptedUserKeyCache = null;
    this.seededBytesMatchLocalPublic = true;
    this.seededBytesVerifiedForPublicKey = pair.publicKey;
    return fromWrap;
  }

  /**
   * The User-Key private bytes taken from THIS device's wrap in the own
   * User-Key document, verified against `publicKeyPem`. Returns null when no
   * wrap for this device exists or it does not open the pair. Kept free of
   * {@link getDecryptedUserKeyBytes} so the two cannot recurse.
   */
  private async ownDeviceWrapPrivateKeyBytes(publicKeyPem: string): Promise<Uint8Array | null> {
    if (this.resolvingOwnDeviceWrap) return null;
    this.resolvingOwnDeviceWrap = true;
    try {
      const deviceKey = await this.tenant.getEncryptionPrivateKeyForReconcile();
      if (!deviceKey) return null;
      const resolved = await this.resolveOwnUserKeyDocument();
      if (!resolved) return null;
      const user = this.tenant.getCurrentPrivateUser();
      const deviceFp = await fingerprintEncryptionPublicKey(
        user.userEncryptionKeyPair.publicKey,
        this.tenant.getCryptoAdapter().getSubtle(),
      );
      for (const epoch of this.epochsNewestFirst(resolved.payload)) {
        const gen = resolved.payload.userKeys[epoch];
        if (gen?.publicKey !== publicKeyPem) continue;
        const wrappedKeyB64 = gen.deviceWraps?.[deviceFp]?.wrappedKey;
        if (!wrappedKeyB64) continue;
        try {
          const bytes = await unwrapPrivateKeyFromDevice({
            cryptoAdapter: this.tenant.getCryptoAdapter(),
            wrappedKeyB64,
            deviceEncryptionPrivateKey: deviceKey,
          });
          console.log("[userkeys] recovered User-Key private bytes from own device wrap", {
            epoch,
            ownDeviceFingerprint: deviceFp,
          });
          return bytes;
        } catch (error) {
          console.warn("[userkeys] own device wrap unwrap failed", { epoch }, error);
        }
      }
      return null;
    } finally {
      this.resolvingOwnDeviceWrap = false;
    }
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
    let usedPublishedDocument = false;
    // Prefer the published User-Key (possibly a different pair than this
    // device generated). Opening userdirectory during directory bring-up
    // races a second Automerge WASM heap — only do it when that DB is
    // already fetched or already open on this tenant instance.
    const canUseUserDirectory = this.canReconcileAgainstUserDirectory();
    let resolvedDocId: string | undefined;
    if (canUseUserDirectory) {
      try {
        const resolved = await this.resolveOwnUserKeyDocument();
        if (resolved) {
          usedPublishedDocument = true;
          resolvedDocId = resolved.doc.getId();
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
      } catch (error) {
        console.warn("[userkeys] getUserKeyCryptoKeysForReconcile: published lookup failed", error);
      }
    }
    if (keys.length === 0) {
      const current = await this.getDecryptedUserKey();
      if (current) keys.push(current);
    }
    console.log("[userkeys] getUserKeyCryptoKeysForReconcile", {
      canUseUserDirectory,
      usedPublishedDocument,
      resolvedDocId,
      userKeyFingerprints: [...seen],
      keyCount: keys.length,
    });
    return keys;
  }

  async openUserDirectory(): Promise<MindooDB> {
    return this.tenant.openDB(USER_DIRECTORY_DB_ID);
  }

  async resolveOwnUserKeyDocument(): Promise<ResolvedUserKeyDocument | null> {
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

    // Additional device: `acl_keydistribution_default` is already wrapped to
    // the published User-Key. Minting a second pair (this device's locally
    // generated key) desyncs dist — Device 2 would publish a key that cannot
    // unwrap `default`. Wait for the userkey document and import from wrap.
    if (await this.defaultAlreadyWrappedForCurrentUser()) {
      return null;
    }

    const user = this.tenant.getCurrentPrivateUser();
    let pair: EncryptionKeyPair;
    try {
      pair = await this.ensureLocalUserKeyPair(user, this.tenant.getCurrentUserPassword());
    } catch (error) {
      if (error instanceof UserKeyDecryptError) return null;
      throw error;
    }
    const userId = await this.tenant.getCurrentUserId();
    const binding = await this.mintBindingForUsername(userId.username, userId.userSigningPublicKey);
    if (!binding) return null;
    const { grantDocId, usernameHash, usernameHashVersion } = binding;
    const fingerprint = await fingerprintUserPublicKey(pair.publicKey, this.tenant.getCryptoAdapter());
    const mintBytes = await this.getDecryptedUserKeyBytes();
    const createdAt = Date.now();
    const signed = mintBytes
      ? await this.generationSignatureFields({
          usernameHash,
          epoch: "1",
          gen: { publicKey: pair.publicKey, fingerprint, createdAt },
          ownBytes: mintBytes,
          selfSign: true,
        })
      : undefined;
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
          createdAt,
          ...signed,
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
          createdAt,
          ...signed,
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
    // "Current" only among generations that count (§9.3); write into `live`.
    const valid = (await this.validated(doc))?.payload ?? payload;
    const epoch = currentUserKeyEpoch(valid);
    if (!epoch || !localPublic) return;
    const gen = live.userKeys[epoch] ?? valid.userKeys[epoch];
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
      deviceWraps[deviceFp] = await this.buildDeviceWrap({
        userKeyBytes: bytes,
        deviceEncryptionPublicKey: device.encryptionPublicKey,
        label: device.label,
        approvedAt: now,
        approvedBySigningPublicKey: signer.userSigningPublicKey,
      });
      changed = true;
    }
    if (!changed) return;
    await replaceUserKeys(doc.getDatabase(), doc, {
      ...live.userKeys,
      [epoch]: { ...gen, deviceWraps },
    });
  }

  /** A device wrap of the User-Key, plus the self-grant key when this device holds it. */
  private async buildDeviceWrap(input: {
    userKeyBytes: Uint8Array;
    deviceEncryptionPublicKey: string;
    label?: string;
    approvedAt: number;
    approvedBySigningPublicKey: string;
  }): Promise<UserKeyDeviceWrap> {
    const wrappedSelfGrantKey = await this.wrapSelfGrantKeyFor(input.deviceEncryptionPublicKey);
    return {
      wrappedKey: await wrapPrivateKeyForDevice({
        cryptoAdapter: this.tenant.getCryptoAdapter(),
        privateKeyBytes: input.userKeyBytes,
        deviceEncryptionPublicKey: input.deviceEncryptionPublicKey,
      }),
      ...(input.label ? { label: input.label } : {}),
      approvedAt: input.approvedAt,
      approvedBySigningPublicKey: input.approvedBySigningPublicKey,
      ...(wrappedSelfGrantKey ? { wrappedSelfGrantKey } : {}),
    };
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
        this.seededBytesMatchLocalPublic = true;
        this.seededBytesVerifiedForPublicKey = gen.publicKey;
        // The person's self-grant key travels with their User-Key and
        // replaces one this device may have made for itself before joining.
        if (wrap.wrappedSelfGrantKey) {
          this.decryptedSelfGrantBytes = null;
          await this.importSelfGrantKeyFromWrap().catch(() => null);
        }
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
    const live = (await this.validated(doc))?.payload ?? asUserKeyPayload(doc.getData()) ?? payload;
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
      await writeDeviceWrap({
        db,
        doc,
        epoch,
        deviceFingerprint: deviceFp,
        wrap: await this.buildDeviceWrap({
          userKeyBytes: bytes,
          deviceEncryptionPublicKey: user.userEncryptionKeyPair.publicKey,
          label: ownLabel,
          approvedAt: Date.now(),
          approvedBySigningPublicKey: signer.userSigningPublicKey,
        }),
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
    const createdAt = gen?.createdAt ?? Date.now();
    const bytes = await this.getDecryptedUserKeyBytes();
    // Adopting a pending document counts only self-signed (§9.3, rule 3).
    const signed = bytes
      ? await this.generationSignatureFields({
          usernameHash: payload.username_hash,
          epoch,
          gen: { publicKey: pair.publicKey, fingerprint, createdAt },
          ownBytes: bytes,
          selfSign: true,
        })
      : {};
    const raw = asUserKeyPayload(doc.getData()) ?? payload;
    await replaceUserKeys(doc.getDatabase(), doc, {
      ...raw.userKeys,
      [epoch]: {
        publicKey: pair.publicKey,
        fingerprint,
        createdAt,
        deviceWraps: {},
        ...signed,
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
        // While still pending, give generation 1 its signing key first, so the
        // self-signed change counts as an adoption (§9.3, rule 3).
        const current = await this.validated(doc);
        if (current) await this.ensureCurrentGenerationSigningKey(current);
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

      let resolved: { doc: MindooDoc; payload: UserKeyDocumentPayload } | null =
        await this.resolveOwnUserKeyDocument();
      if (!resolved) {
        resolved = await this.ensureOwnUserKeyDocument(options);
      }
      if (!resolved) {
        // First device of a newly granted user: `default` already arrived via
        // key distribution, so minting a User-Key is refused. That is not
        // "unknown" and not "waiting for another device" — this device can
        // already unwrap tenant content.
        if (await this.defaultAlreadyWrappedForCurrentUser()) {
          return { state: "approved", pending: false, missingKeys: [] };
        }
        return this.enrollmentStatus(null, this.userDirectoryFetched ? "waiting" : "unknown");
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
      try {
        const latest =
          (await this.resolveOwnUserKeyDocument()) ?? (await this.validated(resolved.doc));
        if (latest) {
          await this.ensureCurrentGenerationSigningKey(latest);
          const afterSign = (await this.resolveOwnUserKeyDocument()) ?? latest;
          await this.ensureSelfGrantKeyDistributed(afterSign);
          resolved = (await this.resolveOwnUserKeyDocument()) ?? afterSign;
        }
      } catch (error) {
        console.warn("[userkeys] generation signing key / self-grant key upkeep failed", error);
      }
      return this.enrollmentStatus(resolved.payload, this.waitState());
    } catch (error) {
      if (error instanceof UserKeyMismatchError || error instanceof UserKeyDecryptError) throw error;
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

  /**
   * Wrap every User-Key epoch to `encryptionPublicKey` (the joining device).
   * Does not look up the grant overview — join approval just registered the
   * device, and the directory cache can still miss it.
   */
  async wrapUserKeyForGrantDevice(encryptionPublicKey: string, label?: string): Promise<void> {
    const fingerprint = await fingerprintEncryptionPublicKey(
      encryptionPublicKey,
      this.tenant.getCryptoAdapter().getSubtle(),
    );
    const resolved = await this.resolveOwnUserKeyDocument();
    console.log("[userkeys] wrapUserKeyForGrantDevice: start", {
      joiningDeviceFingerprint: fingerprint,
      hasUserKeyDocument: !!resolved,
      docId: resolved?.doc.getId(),
      epochs: resolved ? this.epochsNewestFirst(resolved.payload) : [],
    });
    if (!resolved) {
      throw new Error("Cannot wrap User-Key for joining device: no user-key document");
    }
    const signer = await this.tenant.getCurrentUserId();
    const db = resolved.doc.getDatabase();
    let wroteWrap = false;
    for (const epoch of this.epochsNewestFirst(resolved.payload).reverse()) {
      const bytes = await this.privateKeyBytesForEpoch(resolved.payload, epoch);
      console.log("[userkeys] wrapUserKeyForGrantDevice: epoch", {
        epoch,
        hasPrivateKeyBytes: !!bytes,
      });
      if (!bytes) continue;
      await writeDeviceWrap({
        db,
        doc: resolved.doc,
        epoch,
        deviceFingerprint: fingerprint,
        wrap: await this.buildDeviceWrap({
          userKeyBytes: bytes,
          deviceEncryptionPublicKey: encryptionPublicKey,
          label,
          approvedAt: Date.now(),
          approvedBySigningPublicKey: signer.userSigningPublicKey,
        }),
      });
      wroteWrap = true;
    }
    if (!wroteWrap) {
      throw new Error("Cannot wrap User-Key for joining device: local User-Key is locked");
    }
    console.log("[userkeys] wrapUserKeyForGrantDevice: wrote wrap", {
      joiningDeviceFingerprint: fingerprint,
    });
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
      await writeDeviceWrap({
        db,
        doc: resolved.doc,
        epoch,
        deviceFingerprint: fingerprint,
        wrap: await this.buildDeviceWrap({
          userKeyBytes: bytes,
          deviceEncryptionPublicKey: match.encryptionPublicKey,
          label: match.label,
          approvedAt: Date.now(),
          approvedBySigningPublicKey: signer.userSigningPublicKey,
        }),
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
    // Above every stored epoch, including ones that do not count (§9.3).
    const highestStored = Object.keys(resolved.rawPayload.userKeys ?? {})
      .filter((e) => /^\d+$/.test(e))
      .reduce((max, e) => (BigInt(e) > max ? BigInt(e) : max), BigInt(current));
    const nextEpoch = (highestStored + 1n).toString();
    const previousGen = resolved.payload.userKeys[current];
    const previousBytes = await this.privateKeyBytesForEpoch(resolved.payload, current);
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
    const signed = await this.generationSignatureFields({
      usernameHash: resolved.payload.username_hash,
      epoch: nextEpoch,
      gen: { publicKey: generated.publicKeyPem, fingerprint, createdAt: now },
      ownBytes: generated.privateKeyBytes,
      previous: previousGen && previousBytes ? { gen: previousGen, bytes: previousBytes } : null,
    });
    if (signed.signatures.length === 0) {
      const cutoff = await this.generationSignatureCutoff(resolved.payload.username_hash);
      if (cutoff !== undefined && now >= cutoff) {
        throw new Error(
          "Cannot rotate: this device can sign the new User-Key generation neither with the previous generation nor with a granted device self-grant key, so it would not count.",
        );
      }
    }
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
      deviceWraps[deviceFp] = await this.buildDeviceWrap({
        userKeyBytes: generated.privateKeyBytes,
        deviceEncryptionPublicKey: device.encryptionPublicKey,
        label: device.label,
        approvedAt: now,
        approvedBySigningPublicKey: signer.userSigningPublicKey,
      });
    }
    const raw = asUserKeyPayload(resolved.doc.getData()) ?? resolved.rawPayload;
    await replaceUserKeys(resolved.doc.getDatabase(), resolved.doc, {
      ...raw.userKeys,
      [current]: { ...(raw.userKeys[current] ?? previousGen), retiredAt: now },
      [nextEpoch]: {
        publicKey: generated.publicKeyPem,
        fingerprint,
        createdAt: now,
        deviceWraps,
        ...signed,
      },
    });
  }

  /**
   * Admin-only delete of the published user-key document for `username`.
   * Lookup uses the same grant-binding path as {@link publishedUserKeyFor}.
   * Recovery path when every device that held the private key is gone.
   * A remaining enrolled device keeps local access; it does not republish
   * the tombstone on unlock while `default` is already wrapped to that user.
   */
  async deletePublishedUserKeyFor(input: {
    username: string;
    signingKeyPair: SigningKeyPair;
    signingKeyPassword: string;
  }): Promise<void> {
    const resolved = await this.resolvePublishedUserKeyDocument(input.username);
    if (!resolved) {
      throw new Error(`No published personal key document for "${input.username}".`);
    }
    const db = await this.openUserDirectory();
    await db.deleteDocument(resolved.doc.getId(), {
      signingKeyPair: input.signingKeyPair,
      signingKeyPassword: input.signingKeyPassword,
    });
  }

  async publishedUserKeyFor(username: string): Promise<{
    publicKey: string;
    fingerprint: string;
    pending: boolean;
  } | null> {
    const resolved = await this.resolvePublishedUserKeyDocument(username);
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

  /**
   * Lookup only — Trap 1 (no mint from local emptiness) does not apply.
   * Haven reopens a fresh tenant per action; blocking on
   * `userDirectoryFetched` made wrapKeyForUser return null so
   * `acl_keydistribution_default` never gained a User-Key wrap.
   */
  private async resolvePublishedUserKeyDocument(username: string) {
    const directory = await this.directory();
    const db = await this.openUserDirectory();
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

  async getEnrollmentStatus(): Promise<UserKeyEnrollmentStatus> {
    if (this.lastUserDirectoryFetchError && !this.userDirectoryFetched) {
      return this.enrollmentStatus(null, "unknown");
    }
    const resolved = await this.resolveOwnUserKeyDocument();
    if (!resolved) {
      if (await this.defaultAlreadyWrappedForCurrentUser()) {
        return { state: "approved", pending: false, missingKeys: [] };
      }
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
    const publicKeyMatchesLocal = !!localPublic && gen.publicKey === localPublic;
    if (publicKeyMatchesLocal) {
      const localBytes = await this.getDecryptedUserKeyBytes();
      if (localBytes) return localBytes;
      // Haven restoreTenantWithLiveBag opens with an empty password, so the
      // identity's password-encrypted User-Key may not unwrap even when the
      // public key matches. Fall through to the device wrap.
    }
    const deviceKey = await this.tenant.getEncryptionPrivateKeyForReconcile();
    const user = this.tenant.getCurrentPrivateUser();
    const deviceFp = await fingerprintEncryptionPublicKey(
      user.userEncryptionKeyPair.publicKey,
      this.tenant.getCryptoAdapter().getSubtle(),
    );
    const wrap = gen.deviceWraps?.[deviceFp];
    console.log("[userkeys] privateKeyBytesForEpoch", {
      epoch,
      publicKeyMatchesLocal,
      seededUserKeyBytes: !!this.decryptedUserKeyBytes,
      ownDeviceFingerprint: deviceFp,
      wrappedDeviceFingerprints: Object.keys(gen.deviceWraps ?? {}),
      hasOwnDeviceWrap: !!wrap?.wrappedKey,
      hasDeviceEncryptionKey: !!deviceKey,
    });
    if (!deviceKey) return null;
    if (!wrap?.wrappedKey) return null;
    try {
      return unwrapPrivateKeyFromDevice({
        cryptoAdapter: this.tenant.getCryptoAdapter(),
        wrappedKeyB64: wrap.wrappedKey,
        deviceEncryptionPrivateKey: deviceKey,
      });
    } catch (error) {
      console.warn("[userkeys] privateKeyBytesForEpoch: device wrap unwrap failed", epoch, error);
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
    // Write back every stored generation, also those that do not count.
    const raw = asUserKeyPayload(doc.getData()) ?? payload;
    for (const [epoch, gen] of Object.entries(raw.userKeys ?? {})) {
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

  private async defaultAlreadyWrappedForCurrentUser(): Promise<boolean> {
    try {
      const directory = await this.directory();
      const username = (await this.tenant.getCurrentUserId()).username;
      const managed = await directory.getManagedKeyIds(username);
      return managed.includes(DEFAULT_TENANT_KEY_ID);
    } catch {
      return false;
    }
  }

  private async directory(): Promise<BaseMindooTenantDirectory> {
    const directory = await this.tenant.openDirectory();
    return directory as BaseMindooTenantDirectory;
  }
}

