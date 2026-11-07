/**
 * TenantManager handles loading, caching, and registration of tenants.
 *
 * Uses a global server identity (one per server, not per tenant) for
 * authenticating with remote servers and opening tenant directories.
 *
 * When a tenant has a $publicinfos key (sent during publishToServer), the
 * manager creates a real BaseMindooTenant for directory reading. User
 * authentication is then validated against the admin-signed directory DB
 * rather than a static JSON config.
 *
 * When no $publicinfos key is available, a SimpleMindooDirectory backed
 * by config.json users[] is used as a fallback (useful for tests).
 *
 * A CompositeMindooDirectory wraps whichever directory source is used and
 * also checks the global trusted-servers list, enabling server-to-server
 * auth without servers being in each tenant's user directory.
 */

import { AuthenticationService } from "../core/appendonlystores/network/AuthenticationService";
import { ServerNetworkContentAddressedStore } from "../appendonlystores/network/ServerNetworkContentAddressedStore";
import type {
  ServerTier1Evaluator,
  ServerDbAccessEvaluator,
  ServerDbAccessModeEvaluator,
  ServerRevokedKeyResolver,
  ServerPurgedDocResolver,
  ServerReadScopeResolver,
  ServerDocCreatorResolver,
  ServerPurgeRequestValidator,
  BuiltinWriteContext,
  ServerPeerTokenResolver,
  ServerTrustedWitnessResolver,
} from "../appendonlystores/network/ServerNetworkContentAddressedStore";
import { PurgedDocRegistry } from "./PurgedDocRegistry";
import { purgeDocumentHistoryFromStores } from "../core/appendonlystores/purgeDocumentHistory";
import type { WitnessSigner } from "../core/crypto/WitnessReceipt";
import type { AccessDecision, RuleType } from "../core/accesscontrol/types";
import type { TimestampProvider } from "../core/accesscontrol/timestamp/TimestampProvider";
import { Ed25519WitnessProvider } from "../core/accesscontrol/timestamp/Ed25519WitnessProvider";
import type { BaseMindooTenantDirectory } from "../core/BaseMindooTenantDirectory";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { RSAEncryption } from "../core/crypto/RSAEncryption";
import { decryptPrivateKey } from "../core/crypto/privateKeyEncryption";
import { KeyBag } from "../core/keys/KeyBag";
import type {
  MindooTenant,
  MindooTenantDirectory,
  ContentAddressedStore,
  ContentAddressedStoreFactory,
  CreateStoreResult,
  OpenStoreOptions,
  OpenTenantOptions,
  EncryptedPrivateKey,
  DirectoryUserLookup,
  GrantKeyPairInfo,
  StoreEntry,
} from "../core/types";
import {
  PUBLIC_INFOS_KEY_ID,
  StoreKind,
  USER_DIRECTORY_DB_ID,
} from "../core/types";
import {
  isPurgeRequestDocId,
  personalDatabaseOwner,
  purgeRequestDocIdsFromCreateBytes,
  usernameHashFromCreateChangeBytes,
} from "../core/builtinDbInvariants";
import { signingKeysEqual } from "../core/accesscontrol/DirectoryStateNode";
import {
  buildTier1Evaluator,
  type Tier1Directory,
} from "../core/accesscontrol/tier1Evaluator";
import type { PrivateUserId } from "../core/userid";
import type { CryptoAdapter } from "../core/crypto/CryptoAdapter";
import { base64ToBytes, bytesToBase64 } from "../core/utils/base64";

import type {
  ServerDataStore,
  ServerStoreProvider,
  TenantStoreFactory,
} from "./ServerDataStore";
import type {
  TenantConfig,
  TenantContext,
  RegisterTenantRequest,
  UserConfig,
  TrustedServer,
} from "./types";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface LoadedTenant {
  context: TenantContext;
  storeFactory: TenantStoreFactory;
  authService: AuthenticationService;
  directory: MindooTenantDirectory;
  mindooTenant?: MindooTenant;
  serverStores: Map<string, ServerNetworkContentAddressedStore>;
}

export interface RegisterTenantResult {
  context: TenantContext;
  created: boolean;
}

// ---------------------------------------------------------------------------
// StoreFactoryAdapter
// ---------------------------------------------------------------------------

class StoreFactoryAdapter implements ContentAddressedStoreFactory {
  constructor(private storeFactory: TenantStoreFactory) {}
  createStore(dbId: string, _options?: OpenStoreOptions): CreateStoreResult {
    return {
      docStore: this.storeFactory.getStore(dbId, StoreKind.docs),
      attachmentStore: this.storeFactory.getStore(dbId, StoreKind.attachments),
    };
  }
}

// ---------------------------------------------------------------------------
// SimpleMindooDirectory — config-based fallback
// ---------------------------------------------------------------------------

/** Document-id prefix of a document-history purge request in `directory` (§13). */
const DIRECTORY_PURGE_REQUEST_ID_PREFIX = "acl_dochistorypurge_";

export class SimpleMindooDirectory implements Pick<
  MindooTenantDirectory,
  | "getUserPublicKeys"
  | "isUserRevoked"
  | "validatePublicSigningKey"
  | "getUserBySigningPublicKey"
> {
  /** Canonical index: entries are identified by their signing public key. */
  private usersByKey: Map<string, UserConfig> = new Map();
  /**
   * Backward-compat index by documentation-only username, populated only for
   * config entries that carry a `username`. Lets legacy username-based
   * challenges keep resolving; `username` is never required.
   */
  private usersByUsername: Map<string, UserConfig> = new Map();
  private revokedUsers: Set<string> = new Set();
  private adminSigningPublicKey: string;

  constructor(config: TenantConfig) {
    this.adminSigningPublicKey = config.adminSigningPublicKey;

    if (config.users) {
      for (const user of config.users) {
        // Identity is the signing key. `username` is documentation-only and
        // ignored for matching; index it only as a legacy convenience.
        this.usersByKey.set(user.signingPublicKey, user);
        if (typeof user.username === "string" && user.username.trim()) {
          this.usersByUsername.set(user.username.toLowerCase(), user);
        }
      }
    }
  }

  async getUserPublicKeys(username: string): Promise<{
    signingPublicKey: string;
    encryptionPublicKey: string;
  } | null> {
    const normalizedUsername = username.toLowerCase();
    if (this.revokedUsers.has(normalizedUsername)) {
      return null;
    }
    const user = this.usersByUsername.get(normalizedUsername);
    if (!user) {
      return null;
    }
    return {
      signingPublicKey: user.signingPublicKey,
      encryptionPublicKey: user.encryptionPublicKey,
    };
  }

  async getUserBySigningPublicKey(
    publicKey: string,
  ): Promise<DirectoryUserLookup | null> {
    const exact = this.usersByKey.get(publicKey);
    if (exact) {
      return this.toLookup(exact);
    }
    const needle = publicKey.replace(/\s+/g, "");
    if (!needle) return null;
    for (const [key, user] of this.usersByKey) {
      if (key.replace(/\s+/g, "") === needle) {
        return this.toLookup(user);
      }
    }
    return null;
  }

  private toLookup(user: UserConfig): DirectoryUserLookup | null {
    if (
      typeof user.username === "string" &&
      this.revokedUsers.has(user.username.toLowerCase())
    ) {
      return null;
    }
    return {
      username: typeof user.username === "string" ? user.username : "",
      signingPublicKey: user.signingPublicKey,
      encryptionPublicKey: user.encryptionPublicKey,
      details: null,
    };
  }

  async isUserRevoked(username: string): Promise<boolean> {
    return this.revokedUsers.has(username.toLowerCase());
  }

  async validatePublicSigningKey(
    publicKey: string,
    _opts?: { forceRefresh?: boolean },
  ): Promise<boolean> {
    if (publicKey === this.adminSigningPublicKey) {
      return true;
    }
    const user = this.usersByKey.get(publicKey);
    if (!user) {
      return false;
    }
    if (
      typeof user.username === "string" &&
      this.revokedUsers.has(user.username.toLowerCase())
    ) {
      return false;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// CompositeMindooDirectory — wraps tenant directory + trusted servers
// ---------------------------------------------------------------------------

/**
 * Wraps a per-tenant directory (real or config-based) and also checks
 * the global trusted-servers list. Holds a reference to the array so
 * runtime changes via the admin API are immediately visible.
 */
class CompositeMindooDirectory implements Pick<
  MindooTenantDirectory,
  "getUserPublicKeys" | "isUserRevoked" | "validatePublicSigningKey"
> {
  private readonly adminUsernameNormalized: string | null;

  constructor(
    private inner: Pick<
      MindooTenantDirectory,
      "getUserPublicKeys" | "isUserRevoked" | "validatePublicSigningKey"
    > &
      Partial<
        Pick<
          MindooTenantDirectory,
          | "getUserBySigningPublicKey"
          | "getUserSigningKeyUniverse"
          | "getUserKeyPairs"
          | "getWipeGrantDocId"
          | "getRevokedDecryptionKeyIdsForSigningKey"
          | "resolveUsernameHashForSigningKey"
        >
      > &
      Partial<
        Pick<
          BaseMindooTenantDirectory,
          | "evaluateDbAccessForSigningKey"
          | "evaluateDbAccessModeForSigningKey"
          | "evaluateAccessForSigningKey"
          | "isSamePerson"
          | "evaluateReadScopeForSigningKey"
        >
      >,
    private trustedServers: TrustedServer[],
    private adminBootstrapIdentity?: {
      username: string;
      signingPublicKey: string;
      encryptionPublicKey: string;
    },
  ) {
    this.adminUsernameNormalized =
      adminBootstrapIdentity?.username.toLowerCase() ?? null;
  }

  async getUserPublicKeys(username: string): Promise<{
    signingPublicKey: string;
    encryptionPublicKey: string;
  } | null> {
    const normalizedUsername = username.toLowerCase();

    // Bootstrap special-case: allow configured admin identity to authenticate
    // even before directory grantaccess docs are present on the server.
    if (
      this.adminBootstrapIdentity &&
      this.adminUsernameNormalized &&
      normalizedUsername === this.adminUsernameNormalized
    ) {
      return {
        signingPublicKey: this.adminBootstrapIdentity.signingPublicKey,
        encryptionPublicKey: this.adminBootstrapIdentity.encryptionPublicKey,
      };
    }

    const result = await this.inner.getUserPublicKeys(username);
    if (result) return result;

    for (const server of this.trustedServers) {
      if (server.name.toLowerCase() === normalizedUsername) {
        return {
          signingPublicKey: server.signingPublicKey,
          encryptionPublicKey: server.encryptionPublicKey,
        };
      }
    }
    return null;
  }

  async isUserRevoked(username: string): Promise<boolean> {
    const normalizedUsername = username.toLowerCase();

    if (
      this.adminUsernameNormalized &&
      normalizedUsername === this.adminUsernameNormalized
    ) {
      return false;
    }

    for (const server of this.trustedServers) {
      if (server.name.toLowerCase() === normalizedUsername) {
        return false;
      }
    }
    return this.inner.isUserRevoked(username);
  }

  async validatePublicSigningKey(
    publicKey: string,
    opts?: { forceRefresh?: boolean },
  ): Promise<boolean> {
    if (
      this.adminBootstrapIdentity &&
      signingKeysEqual(this.adminBootstrapIdentity.signingPublicKey, publicKey)
    ) {
      return true;
    }

    const innerResult = await this.inner.validatePublicSigningKey(
      publicKey,
      opts,
    );
    if (innerResult) return true;

    for (const server of this.trustedServers) {
      if (server.signingPublicKey === publicKey) {
        return true;
      }
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Advanced directory features forwarded to the inner directory. Config-based
  // inner directories (SimpleMindooDirectory) do not implement these, so the
  // composite degrades gracefully (no key-based identity, no read policy, no
  // wipe directives) — preserving legacy config-only behavior — while a real
  // BaseMindooTenantDirectory inner enables the key-based auth, read gate, and
  // remote-wipe paths (docs/accesscontrol.md §6.5).
  // -----------------------------------------------------------------------

  async getUserBySigningPublicKey(
    publicKey: string,
  ): Promise<DirectoryUserLookup | null> {
    if (typeof this.inner.getUserBySigningPublicKey === "function") {
      const innerLookup = await this.inner.getUserBySigningPublicKey(publicKey);
      if (innerLookup) return innerLookup;
    }

    // Bootstrap/config fallback: the admin and trusted-server identities can be
    // resolved by their signing key even without a grantaccess document on this
    // server, mirroring getUserPublicKeys. Without this, key-based identity
    // resolution (and the validateToken active-key check below) would treat the
    // admin's own key as unknown the moment the directory has no admin grant.
    if (
      this.adminBootstrapIdentity &&
      signingKeysEqual(this.adminBootstrapIdentity.signingPublicKey, publicKey)
    ) {
      return {
        username: this.adminBootstrapIdentity.username,
        signingPublicKey: this.adminBootstrapIdentity.signingPublicKey,
        encryptionPublicKey: this.adminBootstrapIdentity.encryptionPublicKey,
        details: null,
      };
    }
    for (const server of this.trustedServers) {
      if (server.signingPublicKey === publicKey) {
        return {
          username: server.name,
          signingPublicKey: server.signingPublicKey,
          encryptionPublicKey: server.encryptionPublicKey,
          details: null,
        };
      }
    }
    return null;
  }

  async getUserSigningKeyUniverse(
    username: string,
  ): Promise<{ active: string[]; wipeRequested: string[] }> {
    const base =
      typeof this.inner.getUserSigningKeyUniverse === "function"
        ? await this.inner.getUserSigningKeyUniverse(username)
        : { active: [] as string[], wipeRequested: [] as string[] };

    // The admin bootstrap identity, trusted servers, and config-based users are
    // valid principals even without a grantaccess document on this server (the
    // server config / bootstrap identity is the root of trust). Their signing
    // key must therefore count as ACTIVE so the token-validation gate in
    // AuthenticationService.validateToken (which requires the device key to be
    // in this active set) does not reject a freshly-issued admin/config token.
    // We reuse getUserPublicKeys, which already applies exactly those fallbacks.
    const active = new Set(base.active);
    const fallback = await this.getUserPublicKeys(username);
    if (fallback) active.add(fallback.signingPublicKey);
    return { active: Array.from(active), wipeRequested: base.wipeRequested };
  }

  async getUserKeyPairs(username: string): Promise<GrantKeyPairInfo[]> {
    if (typeof this.inner.getUserKeyPairs === "function") {
      return this.inner.getUserKeyPairs(username);
    }
    return [];
  }

  async getWipeGrantDocId(signingKey: string): Promise<string | null> {
    if (typeof this.inner.getWipeGrantDocId === "function") {
      return this.inner.getWipeGrantDocId(signingKey);
    }
    return null;
  }

  async getRevokedDecryptionKeyIdsForSigningKey(
    signingKey: string,
  ): Promise<string[]> {
    if (
      typeof this.inner.getRevokedDecryptionKeyIdsForSigningKey === "function"
    ) {
      return this.inner.getRevokedDecryptionKeyIdsForSigningKey(signingKey);
    }
    return [];
  }

  async evaluateDbAccessForSigningKey(input: {
    dbid: string;
    signingKey: string;
  }): Promise<boolean> {
    if (typeof this.inner.evaluateDbAccessForSigningKey === "function") {
      return this.inner.evaluateDbAccessForSigningKey(input);
    }
    // Config-based directories carry no database-open policy -> unrestricted.
    return true;
  }

  /**
   * Forwarded so the server can tell read from deposit (docs/accesscontrol.md
   * §6.10). Without it the boolean gate above stays in charge and a depositor
   * is refused like anyone else without read access.
   */
  async evaluateDbAccessModeForSigningKey(input: {
    dbid: string;
    signingKey: string;
  }): Promise<{
    mode: "read" | "deposit" | "none";
    maxRecipients?: number;
    docIdPrefixes?: string[];
    internalMail?: { maxBytesPerMail: number; maxMailsPerHour: number };
    reason?: string;
  }> {
    if (typeof this.inner.evaluateDbAccessModeForSigningKey === "function") {
      return this.inner.evaluateDbAccessModeForSigningKey(input);
    }
    return { mode: (await this.evaluateDbAccessForSigningKey(input)) ? "read" : "none" };
  }

  /**
   * Forwarded so the witness enforces Tier 1 rules on push
   * (docs/accesscontrol.md §7). `buildTier1Evaluator` only wires the check when
   * the directory it is given has this method; without the forward every push
   * was accepted, whatever the tenant's rules said. Config-based directories
   * have no rules and therefore no method, which keeps their legacy behavior.
   */
  get evaluateAccessForSigningKey():
    | ((input: {
        op: RuleType;
        dbid: string;
        signingKey: string;
        trustedTime: number;
        isAuthor?: boolean;
      }) => Promise<AccessDecision>)
    | undefined {
    const inner = this.inner;
    return typeof inner.evaluateAccessForSigningKey === "function"
      ? (input) => inner.evaluateAccessForSigningKey!(input)
      : undefined;
  }

  /** Forwarded with {@link evaluateAccessForSigningKey}: `$author` at grant level. */
  get isSamePerson():
    | ((input: {
        creatorSigningKey: string;
        signerSigningKey: string;
        creatorTrustedTime: number;
        signerTrustedTime: number;
      }) => Promise<boolean>)
    | undefined {
    const inner = this.inner;
    return typeof inner.isSamePerson === "function" ? (input) => inner.isSamePerson!(input) : undefined;
  }

  /** Forwarded for the author-scoped read (§6.12). */
  get evaluateReadScopeForSigningKey():
    | ((input: { dbid: string; signingKey: string }) => Promise<"all" | "own">)
    | undefined {
    const inner = this.inner;
    return typeof inner.evaluateReadScopeForSigningKey === "function"
      ? (input) => inner.evaluateReadScopeForSigningKey!(input)
      : undefined;
  }

  /**
   * Forwarded so server-side `userdirectory` writes can resolve the signer's
   * grant. Without this, `evaluateUserdirectoryInvariant` sees a missing
   * method, leaves `signerUsernameHash` null, and denies every non-admin
   * change as "signer is not a granted device" — including the founder
   * wrapping a second device of their own User-Key.
   */
  async resolveUsernameHashForSigningKey(
    signingKey: string,
    trustedTime: number,
  ): Promise<string | null> {
    if (typeof this.inner.resolveUsernameHashForSigningKey === "function") {
      return this.inner.resolveUsernameHashForSigningKey(
        signingKey,
        trustedTime,
      );
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// TenantManager
// ---------------------------------------------------------------------------

/** Keys of the server-wide state in the {@link ServerDataStore}. */
const SERVER_IDENTITY_KEY = "server.identity.json";
const TRUSTED_SERVERS_KEY = "trusted-servers.json";
const SERVER_KEYBAG_KEY = "server.keybag";

export interface TenantManagerOptions {
  /** Server identity, trusted servers, key bag and tenant configs. */
  dataStore: ServerDataStore;
  /** Content-addressed stores of every tenant database. */
  storeProvider: ServerStoreProvider;
  cryptoAdapter: CryptoAdapter;
  /** Unlocks the server identity's private keys and the server key bag. */
  serverPassword?: string;
  /**
   * HMAC secret for a tenant's sync tokens. Without it every loaded tenant
   * gets a random secret, so tokens die with the process — fine for one
   * server process, wrong for a host that spreads one tenant over several
   * instances which must accept each other's tokens.
   */
  jwtSecretForTenant?: (tenantId: string) => Promise<Uint8Array>;
  /**
   * Source of a tenant's `$publicinfos` keys when they are not kept in this
   * manager's own `server.keybag` (e.g. a host instance that serves one
   * tenant database and gets the keys from a central registry).
   */
  publicInfosKeysResolver?: (tenantId: string) => Promise<Uint8Array[]>;
}

export interface ExecutePendingPurgesOptions {
  /**
   * Only purge in these databases; requests for other databases stay
   * unprocessed in this manager's registry. For hosts that serve a subset of
   * a tenant's databases per instance.
   */
  dbIds?: ReadonlySet<string>;
}

/**
 * TenantManager is responsible for:
 * - Loading the global server identity and trusted servers
 * - Loading tenant configurations from disk
 * - Caching loaded tenants
 * - Registering new tenants
 * - Managing tenant stores and authentication services
 * - Creating a real MindooDB tenant for directory reading (when keys available)
 * - Runtime management of trusted servers
 */
export class TenantManager {
  private readonly dataStore: ServerDataStore;
  private readonly storeProvider: ServerStoreProvider;
  private serverPassword: string | undefined;
  private cryptoAdapter: CryptoAdapter;
  private readonly jwtSecretForTenant: TenantManagerOptions["jwtSecretForTenant"];
  private readonly publicInfosKeysResolver: TenantManagerOptions["publicInfosKeysResolver"];
  private loadedTenants: Map<string, LoadedTenant> = new Map();

  private serverIdentity: PrivateUserId | null = null;
  private trustedServers: TrustedServer[] = [];
  /** Lazily-built, cached witness signer (server's Ed25519 signing identity). */
  private witnessSigner: WitnessSigner | undefined;
  /** Lazily-imported RSA private key for peer replication (see getServerEncryptionPrivateKey). */
  private serverEncryptionPrivateKey: CryptoKey | undefined;
  /** Peer wiring handed down to every server store; see setPeerAccessControl. */
  private peerAccessControl: {
    peerTokenResolver?: ServerPeerTokenResolver;
    trustedWitnessResolver?: ServerTrustedWitnessResolver;
  } = {};
  /** Per-tenant persistent registry of executed purges (docs/accesscontrol.md §13). */
  private purgedDocRegistries: Map<string, PurgedDocRegistry> = new Map();
  /** In-flight purge executions, keyed by normalized tenant id (serializes runs). */
  private purgeInFlight: Map<string, Promise<void>> = new Map();

  constructor(options: TenantManagerOptions) {
    this.dataStore = options.dataStore;
    this.storeProvider = options.storeProvider;
    this.serverPassword = options.serverPassword;
    this.cryptoAdapter = options.cryptoAdapter;
    this.jwtSecretForTenant = options.jwtSecretForTenant;
    this.publicInfosKeysResolver = options.publicInfosKeysResolver;

    // Load global server identity
    const identityJson = this.dataStore.readText(SERVER_IDENTITY_KEY);
    if (identityJson !== null) {
      this.serverIdentity = JSON.parse(identityJson);
      console.log(
        `[TenantManager] Loaded server identity: ${this.serverIdentity!.username}`,
      );
    } else {
      console.log(
        `[TenantManager] No server.identity.json found (run "npm run init" to create one)`,
      );
    }

    // Load trusted servers
    const trustedJson = this.dataStore.readText(TRUSTED_SERVERS_KEY);
    if (trustedJson !== null) {
      this.trustedServers = JSON.parse(trustedJson);
      console.log(
        `[TenantManager] Loaded ${this.trustedServers.length} trusted server(s)`,
      );
    }
  }

  // =======================================================================
  // Server identity
  // =======================================================================

  getServerIdentity(): PrivateUserId | null {
    return this.serverIdentity;
  }

  getServerPublicInfo(): TrustedServer | null {
    if (!this.serverIdentity) return null;
    return {
      name: this.serverIdentity.username,
      signingPublicKey: this.serverIdentity.userSigningKeyPair
        .publicKey as string,
      encryptionPublicKey: this.serverIdentity.userEncryptionKeyPair
        .publicKey as string,
    };
  }

  /**
   * Teach every server store how to recognise a trusted peer.
   *
   * `MindooDBServer` calls this once at startup. Two hooks, both required for
   * peer replication to be correct:
   *
   * - `peerTokenResolver` lets a peer's cluster-level JWT through the tenant
   *   sync routes. A peer holds no per-tenant grant, so without it the mirror
   *   would need a second replication protocol; with it the peer reuses the
   *   client one and the store skips the per-user gates that do not apply to a
   *   full replica.
   * - `trustedWitnessResolver` decides whose witness receipts may be preserved
   *   instead of re-stamped (convergence invariant 3). Without it a replicated
   *   entry would get a fresh `receivedAt` on every hop and "trusted time"
   *   would mean "time it reached the last server".
   *
   * Must be called before the first {@link getServerStore}, since stores are
   * cached per tenant and database.
   */
  setPeerAccessControl(options: {
    peerTokenResolver?: ServerPeerTokenResolver;
    trustedWitnessResolver?: ServerTrustedWitnessResolver;
  }): void {
    this.peerAccessControl = options;
  }

  /**
   * Database ids this server holds for a tenant (on Node, the directories in
   * `{dataDir}/{tenantId}/stores`). Used by peer replication to mirror every
   * database rather than a configured subset.
   */
  listDatabases(tenantId: string): string[] {
    return this.storeProvider.listDatabases(this.tenantKey(tenantId.toLowerCase()));
  }

  /**
   * The server's own RSA private key, imported for decryption.
   *
   * Peer replication needs it because the remote wraps transported entries to
   * this server's `encryptionPublicKey` (the one in its `trusted-servers.json`),
   * exactly as it would wrap them for a client.
   */
  async getServerEncryptionPrivateKey(): Promise<CryptoKey | undefined> {
    if (this.serverEncryptionPrivateKey) return this.serverEncryptionPrivateKey;
    if (!this.serverIdentity || !this.serverPassword) return undefined;

    const subtle = this.cryptoAdapter.getSubtle();
    const keyBuffer = await decryptPrivateKey(
      this.cryptoAdapter,
      this.serverIdentity.userEncryptionKeyPair
        .privateKey as EncryptedPrivateKey,
      this.serverPassword,
      "encryption",
    );
    this.serverEncryptionPrivateKey = await subtle.importKey(
      "pkcs8",
      keyBuffer,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["decrypt"],
    );
    return this.serverEncryptionPrivateKey;
  }

  /**
   * Build (and cache) the server's witness identity used to stamp receipts on
   * accepted entries (docs/accesscontrol.md §5.3). Returns undefined when the
   * server identity or its unlock password is unavailable, in which case the
   * server runs in pre-access-control mode (no stamping, no Tier 1 advertised).
   */
  async getWitnessSigner(): Promise<WitnessSigner | undefined> {
    if (this.witnessSigner) return this.witnessSigner;
    if (!this.serverIdentity || !this.serverPassword) return undefined;

    const subtle = this.cryptoAdapter.getSubtle();
    const signingKeyBuffer = await decryptPrivateKey(
      this.cryptoAdapter,
      this.serverIdentity.userSigningKeyPair.privateKey as EncryptedPrivateKey,
      this.serverPassword,
      "signing",
    );
    const signingPrivateKey = await subtle.importKey(
      "pkcs8",
      signingKeyBuffer,
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    this.witnessSigner = {
      publicKeyPem: this.serverIdentity.userSigningKeyPair.publicKey as string,
      signingPrivateKey,
      subtle,
    };
    return this.witnessSigner;
  }

  /**
   * Build the trusted-time provider that stamps receipts on accepted entries
   * (docs/accesscontrol.md §5.3, §13). v1 wraps the server's Ed25519 witness
   * identity; returns undefined when no witness signer is available, leaving the
   * server in pre-access-control mode.
   */
  async getTimestampProvider(): Promise<TimestampProvider | undefined> {
    const signer = await this.getWitnessSigner();
    if (!signer) return undefined;
    return new Ed25519WitnessProvider({ signer, subtle: signer.subtle });
  }

  // =======================================================================
  // Trusted server management
  // =======================================================================

  listTrustedServers(): TrustedServer[] {
    return [...this.trustedServers];
  }

  addTrustedServer(server: TrustedServer): void {
    const existing = this.trustedServers.find(
      (s) => s.name.toLowerCase() === server.name.toLowerCase(),
    );
    if (existing) {
      throw new Error(`Trusted server "${server.name}" already exists`);
    }
    this.trustedServers.push(server);
    this.persistTrustedServers();
    console.log(`[TenantManager] Added trusted server: ${server.name}`);
  }

  /**
   * Add or replace a trusted server by name.
   *
   * Peer CRUD needs an upsert: `addTrustedServer` throws on an existing name,
   * which is right for `add-to-network` (a silent overwrite of a peer's keys
   * would be a trust change disguised as a config edit) but wrong for the admin
   * API, where changing a peer's url or role is the common case.
   */
  saveTrustedServer(server: TrustedServer): void {
    const idx = this.trustedServers.findIndex(
      (s) => s.name.toLowerCase() === server.name.toLowerCase(),
    );
    if (idx === -1) {
      this.trustedServers.push(server);
    } else {
      this.trustedServers[idx] = server;
    }
    this.persistTrustedServers();
    console.log(`[TenantManager] Saved trusted server: ${server.name}`);
  }

  removeTrustedServer(name: string): boolean {
    const idx = this.trustedServers.findIndex(
      (s) => s.name.toLowerCase() === name.toLowerCase(),
    );
    if (idx === -1) return false;
    this.trustedServers.splice(idx, 1);
    this.persistTrustedServers();
    console.log(`[TenantManager] Removed trusted server: ${name}`);
    return true;
  }

  private persistTrustedServers(): void {
    this.dataStore.writeText(
      TRUSTED_SERVERS_KEY,
      JSON.stringify(this.trustedServers, null, 2),
    );
  }

  private async loadServerKeyBag(): Promise<KeyBag> {
    if (!this.serverIdentity || !this.serverPassword) {
      throw new Error(
        "Server identity and server password are required to manage tenant $publicinfos keys",
      );
    }
    const keyBag = await this.createServerKeyBag(
      this.serverIdentity,
      this.serverPassword,
    );
    const data = this.dataStore.readBytes(SERVER_KEYBAG_KEY);
    if (data !== null) {
      await keyBag.load(data);
    }
    return keyBag;
  }

  private async createServerKeyBag(
    serverUser: PrivateUserId,
    serverPassword: string,
  ): Promise<KeyBag> {
    const wrappingKey = await KeyBag.deriveWrappingKey(
      serverUser.userEncryptionKeyPair.privateKey,
      serverPassword,
      this.cryptoAdapter,
    );

    return new KeyBag({
      wrappingKey,
      cryptoAdapter: this.cryptoAdapter,
    });
  }

  private async saveServerKeyBag(keyBag: KeyBag): Promise<void> {
    this.dataStore.writeBytes(SERVER_KEYBAG_KEY, await keyBag.save());
  }

  private bytesToBase64(bytes: Uint8Array): string {
    return bytesToBase64(bytes);
  }

  private mergeUniqueKeys(keys: Uint8Array[]): Uint8Array[] {
    const seen = new Set<string>();
    const unique: Uint8Array[] = [];
    for (const key of keys) {
      const signature = this.bytesToBase64(key);
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      unique.push(key);
    }
    return unique;
  }

  private async computePublicInfosFingerprint(
    key: Uint8Array,
  ): Promise<string> {
    const digest = await this.cryptoAdapter
      .getSubtle()
      .digest("SHA-256", key as BufferSource);
    return Array.from(new Uint8Array(digest).slice(0, 8))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(":");
  }

  /**
   * The data-store key of a tenant's directory. Tenant ids reach this from
   * request paths, so anything that could address another key is refused.
   */
  private tenantKey(tenantId: string): string {
    if (
      tenantId.length === 0 ||
      tenantId.includes("/") ||
      tenantId.includes("\\") ||
      tenantId === "." ||
      tenantId === ".."
    ) {
      throw new Error(
        `Resolved tenant path escapes data directory for tenantId "${tenantId}"`,
      );
    }
    return tenantId;
  }

  private tenantConfigKey(tenantId: string): string {
    return `${this.tenantKey(tenantId)}/config.json`;
  }

  private readTenantConfig(tenantId: string): TenantConfig | null {
    const json = this.dataStore.readText(this.tenantConfigKey(tenantId));
    return json === null ? null : (JSON.parse(json) as TenantConfig);
  }

  private writeTenantConfig(tenantId: string, config: TenantConfig): void {
    this.dataStore.writeText(
      this.tenantConfigKey(tenantId),
      JSON.stringify(config, null, 2),
    );
  }

  private async decryptEncryptedPublicInfosKey(
    base64Payload: string,
  ): Promise<Uint8Array> {
    if (!this.serverIdentity) {
      throw new Error(
        "Server identity not initialized; cannot decrypt encrypted $publicinfos payload",
      );
    }
    if (!this.serverPassword) {
      throw new Error(
        "Server password not configured; cannot decrypt encrypted $publicinfos payload",
      );
    }
    const privateKeyBuffer = await decryptPrivateKey(
      this.cryptoAdapter,
      this.serverIdentity.userEncryptionKeyPair
        .privateKey as EncryptedPrivateKey,
      this.serverPassword,
      "encryption",
    );
    const privateKey = await this.cryptoAdapter.getSubtle().importKey(
      "pkcs8",
      privateKeyBuffer,
      {
        name: "RSA-OAEP",
        hash: "SHA-256",
      },
      false,
      ["decrypt"],
    );
    const decrypted = await new RSAEncryption(this.cryptoAdapter).decrypt(
      base64ToBytes(base64Payload),
      privateKey,
    );
    return new Uint8Array(decrypted);
  }

  private async resolveIncomingPublicInfosKey(
    request: RegisterTenantRequest,
  ): Promise<Uint8Array> {
    if (request.encryptedPublicInfosKey) {
      return this.decryptEncryptedPublicInfosKey(
        request.encryptedPublicInfosKey,
      );
    }
    if (request.publicInfosKey) {
      return base64ToBytes(request.publicInfosKey);
    }
    throw new Error(
      "Tenant registration requires encryptedPublicInfosKey or publicInfosKey",
    );
  }

  private async getStoredPublicInfosKeys(
    tenantId: string,
  ): Promise<Uint8Array[]> {
    if (this.publicInfosKeysResolver) {
      return this.mergeUniqueKeys(await this.publicInfosKeysResolver(tenantId));
    }
    const keys: Uint8Array[] = [];
    if (
      this.serverIdentity &&
      this.serverPassword &&
      this.dataStore.exists(SERVER_KEYBAG_KEY)
    ) {
      const keyBag = await this.loadServerKeyBag();
      keys.push(
        ...(await keyBag.getAllKeys("doc", tenantId, PUBLIC_INFOS_KEY_ID)),
      );
    }
    return this.mergeUniqueKeys(keys);
  }

  private async persistTenantPublicInfosKey(
    tenantId: string,
    key: Uint8Array,
  ): Promise<void> {
    const keyBag = await this.loadServerKeyBag();
    const existingKeys = await keyBag.getAllKeys(
      "doc",
      tenantId,
      PUBLIC_INFOS_KEY_ID,
    );
    const incomingSignature = this.bytesToBase64(key);
    const alreadyStored = existingKeys.some(
      (entry) => this.bytesToBase64(entry) === incomingSignature,
    );
    if (!alreadyStored) {
      await keyBag.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, key, Date.now());
      await this.saveServerKeyBag(keyBag);
    }
  }

  /**
   * All stored `$publicinfos` AES key versions for a tenant from `server.keybag`.
   * Empty when the tenant was never published or the server keybag is locked.
   */
  async getPublicInfosKeysForTenant(tenantId: string): Promise<Uint8Array[]> {
    return this.getStoredPublicInfosKeys(tenantId.toLowerCase());
  }

  async listTenantPublicInfosFingerprints(tenantId: string): Promise<string[]> {
    const normalizedId = tenantId.toLowerCase();
    if (!this.dataStore.exists(this.tenantConfigKey(normalizedId))) {
      throw new Error(`Tenant ${normalizedId} not found`);
    }
    const fingerprints = await Promise.all(
      (await this.getStoredPublicInfosKeys(normalizedId)).map((key) =>
        this.computePublicInfosFingerprint(key),
      ),
    );
    return [...new Set(fingerprints)].sort();
  }

  // =======================================================================
  // Tenant management
  // =======================================================================

  async registerTenant(
    request: RegisterTenantRequest,
  ): Promise<RegisterTenantResult> {
    const tenantId = request.tenantId.toLowerCase();
    const tenantKey = this.tenantKey(tenantId);
    if (!this.serverIdentity || !this.serverPassword) {
      throw new Error(
        "Tenant registration requires an unlocked server identity to store $publicinfos keys",
      );
    }
    const publicInfosKey = await this.resolveIncomingPublicInfosKey(request);

    const existingConfig = this.readTenantConfig(tenantId);
    if (existingConfig !== null) {
      const incomingSignature = this.bytesToBase64(publicInfosKey);
      const existingKeys = await this.getStoredPublicInfosKeys(tenantId);
      const hasMatch = existingKeys.some(
        (key) => this.bytesToBase64(key) === incomingSignature,
      );
      if (hasMatch) {
        console.log(
          `[TenantManager] Tenant ${tenantId} already registered with matching $publicinfos key`,
        );
        return {
          context: { tenantId, config: existingConfig },
          created: false,
        };
      }
      throw new Error(
        `Tenant ${tenantId} already exists with different $publicinfos key`,
      );
    }

    const config: TenantConfig = {
      adminUsername: request.adminUsername,
      adminSigningPublicKey: request.adminSigningPublicKey,
      adminEncryptionPublicKey: request.adminEncryptionPublicKey,
      defaultStoreType: request.defaultStoreType || "file",
      users: [],
    };
    try {
      this.writeTenantConfig(tenantId, config);
      await this.persistTenantPublicInfosKey(tenantId, publicInfosKey);
    } catch (error) {
      this.dataStore.deleteTree(tenantKey);
      throw error;
    }

    console.log(
      `[TenantManager] Registered tenant: ${tenantId} ($publicinfos stored in server keybag)`,
    );

    return {
      context: { tenantId, config },
      created: true,
    };
  }

  async getTenant(tenantId: string): Promise<LoadedTenant> {
    const normalizedId = tenantId.toLowerCase();

    const cached = this.loadedTenants.get(normalizedId);
    if (cached) {
      return cached;
    }

    const loaded = await this.loadTenant(normalizedId);
    this.loadedTenants.set(normalizedId, loaded);

    return loaded;
  }

  tenantExists(tenantId: string): boolean {
    const normalizedId = tenantId.toLowerCase();
    return this.dataStore.exists(this.tenantConfigKey(normalizedId));
  }

  /**
   * Read the tenant's registered admin signing key without fully loading the
   * tenant. Returns `null` if the tenant is missing or the config is unreadable.
   */
  getTenantAdminSigningPublicKey(tenantId: string): string | null {
    try {
      const normalizedId = tenantId.toLowerCase();
      const cached = this.loadedTenants.get(normalizedId);
      if (cached?.context.config.adminSigningPublicKey) {
        return cached.context.config.adminSigningPublicKey;
      }
      const config = this.readTenantConfig(normalizedId);
      if (config === null) {
        return null;
      }
      return typeof config.adminSigningPublicKey === "string" &&
        config.adminSigningPublicKey.length > 0
        ? config.adminSigningPublicKey
        : null;
    } catch {
      return null;
    }
  }

  /**
   * True when `publicsignkey` is the registered tenant-admin signing key for
   * `tenantId` (PEM whitespace-insensitive).
   */
  isTenantAdminSigningKeyFor(tenantId: string, publicsignkey: string): boolean {
    const adminKey = this.getTenantAdminSigningPublicKey(tenantId);
    return adminKey !== null && signingKeysEqual(adminKey, publicsignkey);
  }

  /**
   * True when `publicsignkey` is the registered admin signing key of any
   * tenant on this server. Used to issue a system JWT so that admin can
   * DELETE their own tenant; other `/system/*` routes stay capability-gated.
   */
  isRegisteredTenantAdminSigningKey(publicsignkey: string): boolean {
    for (const tenantId of this.listTenants()) {
      if (this.isTenantAdminSigningKeyFor(tenantId, publicsignkey)) {
        return true;
      }
    }
    return false;
  }

  listTenants(): string[] {
    return this.dataStore
      .listDirectories("")
      .filter((entry) => this.dataStore.exists(`${entry}/config.json`))
      .sort();
  }

  /**
   * Update operator-owned fields of an existing tenant configuration.
   * Only the fields present in `updates` are overwritten.
   */
  updateTenantConfig(
    tenantId: string,
    updates: Partial<Pick<TenantConfig, "defaultStoreType">>,
  ): void {
    const normalizedId = tenantId.toLowerCase();
    const config = this.readTenantConfig(normalizedId);
    if (config === null) {
      throw new Error(`Tenant ${normalizedId} not found`);
    }

    if (updates.defaultStoreType !== undefined) {
      config.defaultStoreType = updates.defaultStoreType;
    }

    this.writeTenantConfig(normalizedId, config);
    this.loadedTenants.delete(normalizedId);
    console.log(`[TenantManager] Updated tenant config: ${normalizedId}`);
  }

  async removeTenant(tenantId: string): Promise<void> {
    const normalizedId = tenantId.toLowerCase();
    const tenantKey = this.tenantKey(normalizedId);

    if (!this.dataStore.exists(tenantKey)) {
      throw new Error(`Tenant ${normalizedId} does not exist`);
    }

    this.loadedTenants.delete(normalizedId);
    if (
      this.serverIdentity &&
      this.serverPassword &&
      this.dataStore.exists(SERVER_KEYBAG_KEY)
    ) {
      const keyBag = await this.loadServerKeyBag();
      await keyBag.deleteKey("doc", normalizedId, PUBLIC_INFOS_KEY_ID);
      await this.saveServerKeyBag(keyBag);
    }
    this.dataStore.deleteTree(tenantKey);
    await this.storeProvider.removeTenantStores?.(normalizedId);

    console.log(`[TenantManager] Removed tenant: ${normalizedId}`);
  }

  // =======================================================================
  // Server stores
  // =======================================================================

  async getServerStore(
    tenantId: string,
    dbId: string,
    storeKind: StoreKind,
  ): Promise<ServerNetworkContentAddressedStore> {
    const tenant = await this.getTenant(tenantId);

    const cacheKey = `${dbId}:${storeKind}`;
    const cached = tenant.serverStores.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Created on first real use, i.e. after the request's token and rights
    // were checked: a refused or unauthenticated request must not leave a
    // store directory behind for an arbitrary database id (disk, inodes, and
    // listDatabases() would report it).
    const localStore = lazyContentAddressedStore(dbId, storeKind, () =>
      tenant.storeFactory.getStore(dbId, storeKind),
    );

    // Access-control v1 wiring (docs/accesscontrol.md §5–§7). The witness signer
    // lets the server stamp receipts on accepted entries; the Tier 1 evaluator
    // enforces identity-tier rules at push time. Both are only active when the
    // server identity is unlocked and the directory supports evaluation, so
    // pre-access-control deployments keep their existing behavior.
    const timestampProvider = await this.getTimestampProvider();
    const directory = tenant.directory as unknown as MindooTenantDirectory;
    const tier1Evaluator = this.buildTier1Evaluator(directory, localStore);
    const wipeGrantDocIdResolver = this.buildWipeGrantDocIdResolver(directory);
    // Database-open gate (directory-restricted policy). Never applied to the
    // directory store itself, which must always sync so the policy can be read.
    const dbAccessEvaluator =
      dbId === "directory" ? undefined : this.buildDbAccessEvaluator(directory);
    // Same gate, also reporting the deposit right (docs/accesscontrol.md §6.10).
    const dbAccessModeEvaluator =
      dbId === "directory" ? undefined : this.buildDbAccessModeEvaluator(directory);
    // Per-user revoked-key blacklist (§13). Never applied to the directory store
    // itself (its policy, which defines the blacklist, must always sync).
    const revokedKeyResolver =
      dbId === "directory"
        ? undefined
        : this.buildRevokedKeyResolver(directory);
    // Purged-document denylist (§13). In the directory store the purge requests
    // themselves (`acl_dochistorypurge_…`) must always sync, so they are never
    // on it; any other purged directory document is, or a member whose replica
    // still holds it (it has not processed the request yet) would upload it
    // again on its next push, and the server would keep it for good.
    const purgedDocResolver: ServerPurgedDocResolver | undefined =
      dbId === "directory"
        ? () => {
            const ids = this.getPurgedDocRegistry(tenantId).getPurgedDocIds(dbId);
            return new Set([...ids].filter((id) => !id.startsWith(DIRECTORY_PURGE_REQUEST_ID_PREFIX)));
          }
        : () => this.getPurgedDocRegistry(tenantId).getPurgedDocIds(dbId);

    // Author-scoped read (§6.12). Never for the directory databases. The
    // attachments store finds a document's creator in the docs store.
    const readScopeResolver =
      dbId === "directory" || dbId === USER_DIRECTORY_DB_ID
        ? undefined
        : this.buildReadScopeResolver(directory, dbId);
    const docCreatorResolver =
      storeKind === StoreKind.attachments
        ? this.buildDocCreatorResolver(
            // Lazy as well: a refused request must not create the docs store.
            lazyContentAddressedStore(dbId, StoreKind.docs, () => tenant.storeFactory.getStore(dbId, StoreKind.docs)),
          )
        : undefined;

    // Purge requests in personal databases (§6.11): checked on push (only in
    // the docs store, where the request documents live).
    const purgeRequestValidator: ServerPurgeRequestValidator | undefined =
      storeKind === StoreKind.docs && personalDatabaseOwner(dbId)
        ? this.buildPurgeRequestValidator(tenant, directory, localStore, dbId)
        : undefined;

    const builtinWriteContext: BuiltinWriteContext | undefined =
      dbId === USER_DIRECTORY_DB_ID
        ? this.buildUserdirectoryWriteContext(tenant, localStore)
        : undefined;

    const serverStore = new ServerNetworkContentAddressedStore(
      localStore,
      directory,
      tenant.authService,
      this.cryptoAdapter,
      undefined,
      {
        timestampProvider,
        witnessDbid: dbId,
        tier1Evaluator,
        wipeGrantDocIdResolver,
        dbAccessEvaluator,
        dbAccessModeEvaluator,
        revokedKeyResolver,
        purgedDocResolver,
        readScopeResolver,
        docCreatorResolver,
        purgeRequestValidator,
        builtinWriteContext,
        ...this.peerAccessControl,
      },
    );

    tenant.serverStores.set(cacheKey, serverStore);
    console.log(
      `[TenantManager] Created server store for ${tenantId}/${dbId}/${storeKind}`,
    );

    return serverStore;
  }

  /**
   * Build a Tier 1 evaluator closure for a server store, or undefined when the
   * directory cannot evaluate access (e.g. config-based directory without the
   * access-control state chain). The closure resolves `$author` for non-create
   * ops by reading the document's `doc_create` entry creator key from the local
   * store (metadata only, no decryption) and comparing it to the change author.
   */
  /**
   * The witness's Tier 1 gate. The evaluation itself is shared with the peer
   * listener, which has to run it for entries that never reach a witness at
   * all — see `core/accesscontrol/tier1Evaluator.ts`.
   */
  private buildTier1Evaluator(
    directory: MindooTenantDirectory,
    localStore: ContentAddressedStore,
  ): ServerTier1Evaluator | undefined {
    return buildTier1Evaluator(
      directory as unknown as Tier1Directory,
      localStore,
    );
  }

  /**
   * Builtin `userdirectory` write invariant: admin may create/delete, only the
   * owning person may change. `username_hash` is read from the decrypted
   * `doc_create` payload (`$publicinfos`). Personal documents are sealed to
   * their owner and therefore undecryptable here, so they are owned by whoever
   * signed their `doc_create` — `resolveCreatorSigningKey` answers that from
   * the entry chain alone.
   */
  private buildUserdirectoryWriteContext(
    tenant: LoadedTenant,
    localStore: ContentAddressedStore,
  ): BuiltinWriteContext {
    const adminPublicKey = tenant.context.config.adminSigningPublicKey;
    const mindooTenant = tenant.mindooTenant;
    return {
      adminPublicKey,
      resolveCreatorSigningKey: async (entry: StoreEntry) => {
        const createEntry = await this.findCreateEntry(localStore, entry);
        return createEntry?.createdByPublicKey ?? null;
      },
      resolveDocumentUsernameHash: mindooTenant
        ? async (entry: StoreEntry) => {
            const createEntry = await this.findCreateEntry(localStore, entry);
            if (!createEntry) return null;
            try {
              const plaintext = await mindooTenant.decryptPayload(
                createEntry.encryptedData,
                createEntry.decryptionKeyId,
              );
              return usernameHashFromCreateChangeBytes(plaintext);
            } catch {
              return null;
            }
          }
        : undefined,
    };
  }

  /**
   * Read-scope resolver (§6.12): `null` (reads everything) unless the
   * database's `docReadScope` is `"own"` for this principal; then the principal
   * sees documents whose creator is the same person (grant level).
   */
  private buildReadScopeResolver(
    directory: MindooTenantDirectory,
    dbId: string,
  ): ServerReadScopeResolver | undefined {
    const dir = directory as unknown as {
      evaluateReadScopeForSigningKey?: (input: { dbid: string; signingKey: string }) => Promise<"all" | "own">;
      isSamePerson?: (input: {
        creatorSigningKey: string;
        signerSigningKey: string;
        creatorTrustedTime: number;
        signerTrustedTime: number;
      }) => Promise<boolean>;
    };
    const evaluate = dir.evaluateReadScopeForSigningKey;
    const isSamePerson = dir.isSamePerson;
    if (typeof evaluate !== "function" || typeof isSamePerson !== "function") return undefined;
    return async (principal) => {
      const signingKey = principal.signingKey;
      // No principal key: nothing to attribute documents to, so nothing is shown.
      if (!signingKey) {
        return { scopeId: "none", ownsDocument: async () => false };
      }
      if ((await evaluate({ dbid: dbId, signingKey })) === "all") return null;
      return {
        scopeId: "own",
        ownsDocument: (creatorSigningKey, creatorTrustedTime) =>
          isSamePerson({
            creatorSigningKey,
            signerSigningKey: signingKey,
            creatorTrustedTime,
            signerTrustedTime: Number.MAX_SAFE_INTEGER,
          }),
      };
    };
  }

  /** Finds a document's `doc_create` creator in the given (docs) store. */
  private buildDocCreatorResolver(docsStore: ContentAddressedStore): ServerDocCreatorResolver {
    return async (docId) => {
      const metas = await docsStore.findNewEntriesForDoc([], docId);
      const create = metas.find((m) => m.entryType === "doc_create");
      return create
        ? { signingKey: create.createdByPublicKey, trustedTime: create.receivedAt ?? create.createdAt }
        : null;
    };
  }

  private async findCreateEntry(
    localStore: ContentAddressedStore,
    entry: StoreEntry,
  ): Promise<StoreEntry | null> {
    if (entry.entryType === "doc_create") {
      return entry;
    }
    try {
      const metas = await localStore.findNewEntriesForDoc([], entry.docId);
      const createMeta = metas.find((m) => m.entryType === "doc_create");
      if (!createMeta) return null;
      const loaded = await localStore.getEntries([createMeta.id]);
      return loaded[0] ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Build a database-open evaluator closure for a server store, or undefined
   * when the directory cannot evaluate the database-open policy (e.g. a
   * config-based directory without the access-control state chain). When the
   * tenant policy is `"directory-restricted"`, this rejects sync for any
   * database id that is not in the allowlist; `"directory"` is always allowed
   * and the tenant admin is exempt (resolved from the principal signing key).
   */
  private buildDbAccessEvaluator(
    directory: MindooTenantDirectory,
  ): ServerDbAccessEvaluator | undefined {
    const evaluable = directory as unknown as {
      evaluateDbAccessForSigningKey?: BaseMindooTenantDirectory["evaluateDbAccessForSigningKey"];
    };
    if (typeof evaluable.evaluateDbAccessForSigningKey !== "function") {
      return undefined;
    }

    return async (principal, dbid) => {
      return evaluable.evaluateDbAccessForSigningKey!({
        dbid,
        signingKey: principal.signingKey ?? "",
      });
    };
  }

  /**
   * Like {@link buildDbAccessEvaluator}, but reports read / deposit / none
   * (docs/accesscontrol.md §6.10). Undefined when the directory predates it,
   * in which case the boolean evaluator stays in charge.
   */
  private buildDbAccessModeEvaluator(
    directory: MindooTenantDirectory,
  ): ServerDbAccessModeEvaluator | undefined {
    const evaluable = directory as unknown as {
      evaluateDbAccessModeForSigningKey?: BaseMindooTenantDirectory["evaluateDbAccessModeForSigningKey"];
    };
    if (typeof evaluable.evaluateDbAccessModeForSigningKey !== "function") {
      return undefined;
    }
    return async (principal, dbid) =>
      evaluable.evaluateDbAccessModeForSigningKey!({ dbid, signingKey: principal.signingKey ?? "" });
  }

  /**
   * Build a remote-wipe resolver closure for a server store, or undefined when
   * the directory does not support wipe directives (docs/accesscontrol.md §6.5).
   * Maps a wipe-targeted signing key to the admin-signed grant document id so
   * the server can serve only that document to the targeted device.
   */
  private buildWipeGrantDocIdResolver(
    directory: MindooTenantDirectory,
  ): ((signingKey: string) => Promise<string | null>) | undefined {
    if (typeof directory.getWipeGrantDocId !== "function") {
      return undefined;
    }
    return (signingKey: string) => directory.getWipeGrantDocId!(signingKey);
  }

  /**
   * Build a per-user revoked-key blacklist resolver for a server store, or
   * undefined when the directory cannot resolve revoked keys (e.g. a
   * config-based directory). Maps the authenticated principal's signing key to
   * the set of decryption key ids revoked for them at the directory head
   * (docs/accesscontrol.md §13).
   */
  private buildRevokedKeyResolver(
    directory: MindooTenantDirectory,
  ): ServerRevokedKeyResolver | undefined {
    if (
      typeof directory.getRevokedDecryptionKeyIdsForSigningKey !== "function"
    ) {
      return undefined;
    }
    return async (principal) => {
      const ids = await directory.getRevokedDecryptionKeyIdsForSigningKey!(
        principal.signingKey ?? "",
      );
      return new Set(ids);
    };
  }

  async getStore(
    tenantId: string,
    dbId: string,
    storeKind: StoreKind,
  ): Promise<ContentAddressedStore> {
    const tenant = await this.getTenant(tenantId);
    return tenant.storeFactory.getStore(dbId, storeKind);
  }

  /**
   * Documents purged from `dbId` on this server (the persistent purge
   * registry). Peer pull replication refuses their entries.
   */
  getPurgedDocIds(tenantId: string, dbId: string): ReadonlySet<string> {
    return this.getPurgedDocRegistry(tenantId).getPurgedDocIds(dbId);
  }

  /** The (lazily-loaded, cached) purge registry for a tenant. */
  private getPurgedDocRegistry(tenantId: string): PurgedDocRegistry {
    const normalizedId = tenantId.toLowerCase();
    let registry = this.purgedDocRegistries.get(normalizedId);
    if (!registry) {
      registry = new PurgedDocRegistry(
        this.dataStore,
        `${this.tenantKey(normalizedId)}/purged-docs.json`,
      );
      this.purgedDocRegistries.set(normalizedId, registry);
    }
    return registry;
  }

  /**
   * Execute any not-yet-processed document-history purge requests for a tenant
   * (docs/accesscontrol.md §13). Reads the admin-signed purge requests from the
   * tenant directory (server-readable `$publicinfos` envelope), physically
   * purges each requested document's history from the tenant's `docs` and
   * `attachments` stores, and records the purge in the persistent registry so
   * (a) it is never executed twice and (b) re-pushes of the purged docs are
   * rejected at sync time.
   *
   * No-op when the server cannot read the directory (config-based fallback, or
   * the directory does not expose the purge reader). Runs are serialized per
   * tenant; concurrent callers share the in-flight promise.
   */
  async executePendingPurges(
    tenantId: string,
    options?: ExecutePendingPurgesOptions,
  ): Promise<void> {
    const normalizedId = tenantId.toLowerCase();
    const existing = this.purgeInFlight.get(normalizedId);
    if (existing) return existing;
    const run = this.executePendingPurgesInternal(normalizedId, options?.dbIds).finally(() => {
      this.purgeInFlight.delete(normalizedId);
    });
    this.purgeInFlight.set(normalizedId, run);
    return run;
  }

  private async executePendingPurgesInternal(
    normalizedId: string,
    dbIds: ReadonlySet<string> | undefined,
  ): Promise<void> {
    const tenant = await this.getTenant(normalizedId);
    if (!tenant.mindooTenant) {
      // Config-based fallback: the server holds no $publicinfos directory and
      // cannot read purge requests. Clients still purge locally on reconcile.
      return;
    }

    let directory: MindooTenantDirectory;
    try {
      directory = await tenant.mindooTenant.openDirectory();
    } catch (error) {
      console.error(
        `[TenantManager] executePendingPurges: cannot open directory for ${normalizedId}:`,
        error,
      );
      return;
    }

    if (typeof directory.getRequestedDocHistoryPurges !== "function") {
      return;
    }

    let requests: Awaited<
      ReturnType<
        NonNullable<MindooTenantDirectory["getRequestedDocHistoryPurges"]>
      >
    >;
    try {
      requests = await directory.getRequestedDocHistoryPurges();
    } catch (error) {
      console.error(
        `[TenantManager] executePendingPurges: cannot read purge requests for ${normalizedId}:`,
        error,
      );
      return;
    }
    if (requests.length === 0) return;

    const registry = this.getPurgedDocRegistry(normalizedId);
    const purgedNow = new Set<string>();
    const touchedDbIds = new Set<string>();
    for (const request of requests) {
      if (registry.isRequestProcessed(request.purgeRequestDocId)) {
        continue;
      }
      if (typeof request.dbId !== "string" || request.dbId.length === 0) {
        continue;
      }
      if (dbIds && !dbIds.has(request.dbId)) {
        continue;
      }
      for (const docId of request.docIds) {
        if (typeof docId !== "string" || docId.length === 0) continue;
        // Denylist BEFORE purging: the sync push path consults the registry
        // live, so from this moment re-pushes of the doc are rejected. Doing it
        // after the store purges would leave a window in which the entries are
        // already gone but a stale client could still re-push (and the server
        // would re-accept) the very history that is being purged. The record is
        // kept regardless of per-store outcome so re-pushes are rejected even
        // if one store had nothing to purge.
        registry.recordPurgedDoc(request.dbId, docId);
        await this.purgeDocumentFromDatabase(normalizedId, request.dbId, docId);
        purgedNow.add(`${request.dbId}\u0000${docId}`);
        touchedDbIds.add(request.dbId);
      }
      registry.markRequestProcessed(request.purgeRequestDocId);
      console.log(
        `[TenantManager] Executed purge request ${request.purgeRequestDocId} (${request.docIds.length} doc(s)) for ${normalizedId}/${request.dbId}`,
      );
    }

    // A purge keeps attachment chunks that another document's history still
    // references (an in-place copy). Once that document is purged as well,
    // the earlier purge's leftovers are unreferenced: sweep them now, since a
    // processed request is never executed again.
    for (const dbId of touchedDbIds) {
      for (const docId of registry.getPurgedDocIds(dbId)) {
        if (!purgedNow.has(`${dbId}\u0000${docId}`)) {
          await this.purgeDocumentFromDatabase(normalizedId, dbId, docId);
        }
      }
    }
  }

  /**
   * The push check for purge requests in a personal database (§6.11): a
   * `$publicinfos` create, signed by someone with read access to the database
   * (a device of the owner, a service with a matching `accessPrefixes` grant,
   * the tenant admin), naming only documents that are deleted (last
   * delete/undelete is a delete, on the server or in the same push). Purge
   * requests themselves cannot be purged, changed or deleted.
   */
  private buildPurgeRequestValidator(
    tenant: LoadedTenant,
    directory: MindooTenantDirectory,
    localStore: ContentAddressedStore,
    dbId: string,
  ): ServerPurgeRequestValidator | undefined {
    const mindooTenant = tenant.mindooTenant;
    const dir = directory as unknown as {
      evaluateDbAccessModeForSigningKey?: (input: { dbid: string; signingKey: string }) => Promise<{ mode: string }>;
    };
    return async (entry, batch) => {
      if (entry.entryType !== "doc_create") {
        return "a purge request can only be created, not changed or deleted";
      }
      if (entry.decryptionKeyId !== PUBLIC_INFOS_KEY_ID) {
        return "a purge request must be encrypted with $publicinfos";
      }
      if (!mindooTenant || typeof dir.evaluateDbAccessModeForSigningKey !== "function") {
        return "this server cannot check purge requests";
      }
      const access = await dir.evaluateDbAccessModeForSigningKey({ dbid: dbId, signingKey: entry.createdByPublicKey });
      if (access.mode !== "read") {
        return "only the owner, a service with access or the tenant admin may purge";
      }
      let docIds: string[] | null = null;
      try {
        docIds = purgeRequestDocIdsFromCreateBytes(
          await mindooTenant.decryptPayload(entry.encryptedData, PUBLIC_INFOS_KEY_ID),
        );
      } catch {
        docIds = null;
      }
      if (!docIds) return "not a readable purge request";
      for (const docId of docIds) {
        if (isPurgeRequestDocId(docId)) return "purge requests cannot be purged";
        const history = [
          ...(await localStore.findNewEntriesForDoc([], docId)),
          ...batch.filter((e) => e.docId === docId),
        ].filter((e) => e.entryType === "doc_delete" || e.entryType === "doc_undelete");
        history.sort((a, b) => (a.receivedAt ?? a.createdAt) - (b.receivedAt ?? b.createdAt));
        if (history.at(-1)?.entryType !== "doc_delete") {
          return `document ${docId} is not deleted`;
        }
      }
      return null;
    };
  }

  /**
   * Executes the purge requests of one personal database (§6.11): every
   * document a request names is put on the denylist and removed from the docs
   * and attachment stores. Called after accepted writes to the database;
   * requests already executed are skipped. Serialized per database.
   */
  async executePersonalPurges(tenantId: string, dbId: string): Promise<void> {
    const key = `${tenantId.toLowerCase()}\u0000${dbId}`;
    const existing = this.purgeInFlight.get(key);
    if (existing) return existing;
    const run = this.executePersonalPurgesInternal(tenantId.toLowerCase(), dbId).finally(() => {
      this.purgeInFlight.delete(key);
    });
    this.purgeInFlight.set(key, run);
    return run;
  }

  private async executePersonalPurgesInternal(normalizedId: string, dbId: string): Promise<void> {
    if (!personalDatabaseOwner(dbId)) return;
    const tenant = await this.getTenant(normalizedId);
    const mindooTenant = tenant.mindooTenant;
    if (!mindooTenant) return;
    const docsStore = await this.getStore(normalizedId, dbId, StoreKind.docs);
    const creates = (await docsStore.findEntries("doc_create", null, null)).filter((m) => isPurgeRequestDocId(m.docId));
    if (creates.length === 0) return;
    const registry = this.getPurgedDocRegistry(normalizedId);
    for (const meta of creates) {
      const requestKey = `${dbId}/${meta.docId}`;
      if (registry.isRequestProcessed(requestKey)) continue;
      const [entry] = await docsStore.getEntries([meta.id]);
      if (!entry) continue;
      let docIds: string[] | null = null;
      try {
        docIds = purgeRequestDocIdsFromCreateBytes(await mindooTenant.decryptPayload(entry.encryptedData, entry.decryptionKeyId));
      } catch (error) {
        console.error(`[TenantManager] purge request ${requestKey} is not readable:`, error);
        continue;
      }
      for (const docId of docIds ?? []) {
        if (isPurgeRequestDocId(docId)) continue;
        // Denylist first, as for directory purge requests (see above).
        registry.recordPurgedDoc(dbId, docId);
        await this.purgeDocumentFromDatabase(normalizedId, dbId, docId);
      }
      registry.markRequestProcessed(requestKey);
      console.log(`[TenantManager] Executed personal purge ${requestKey} (${docIds?.length ?? 0} doc(s)) for ${normalizedId}`);
    }
  }

  /**
   * Purge one document from a database's docs and attachment stores. Attachment
   * chunks still referenced by another document are kept (see
   * `purgeDocumentHistory.ts`). Failures are logged, never thrown.
   */
  private async purgeDocumentFromDatabase(
    tenantId: string,
    dbId: string,
    docId: string,
  ): Promise<void> {
    try {
      await purgeDocumentHistoryFromStores(
        {
          docsStore: await this.getStore(tenantId, dbId, StoreKind.docs),
          attachmentStore: await this.getStore(tenantId, dbId, StoreKind.attachments),
        },
        docId,
      );
    } catch (error) {
      console.error(
        `[TenantManager] executePendingPurges: failed to purge ${docId} in ${tenantId}/${dbId}:`,
        error,
      );
    }
  }

  async getAuthService(tenantId: string): Promise<AuthenticationService> {
    const tenant = await this.getTenant(tenantId);
    return tenant.authService;
  }

  getCryptoAdapter(): CryptoAdapter {
    return this.cryptoAdapter;
  }

  async reloadTenant(tenantId: string): Promise<LoadedTenant> {
    const normalizedId = tenantId.toLowerCase();
    this.loadedTenants.delete(normalizedId);
    return this.getTenant(normalizedId);
  }

  clearCache(): void {
    this.loadedTenants.clear();
    console.log(`[TenantManager] Cleared tenant cache`);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async loadTenant(tenantId: string): Promise<LoadedTenant> {
    const config = this.readTenantConfig(tenantId);

    if (config === null) {
      throw new Error(`Tenant ${tenantId} not found: ${this.tenantConfigKey(tenantId)}`);
    }

    const context: TenantContext = { tenantId, config };
    const storeFactory = this.storeProvider.createTenantStores(tenantId, config);

    // Build the inner directory (real or config-based fallback)
    let innerDirectory: Pick<
      MindooTenantDirectory,
      "getUserPublicKeys" | "isUserRevoked" | "validatePublicSigningKey"
    >;
    let mindooTenant: MindooTenant | undefined;

    const publicInfosKeys = await this.getStoredPublicInfosKeys(tenantId);
    if (
      publicInfosKeys.length > 0 &&
      this.serverIdentity &&
      this.serverPassword
    ) {
      try {
        const result = await this.createDirectoryTenant(
          tenantId,
          config,
          storeFactory,
          publicInfosKeys,
        );
        mindooTenant = result.tenant;
        innerDirectory = await mindooTenant.openDirectory();
        console.log(
          `[TenantManager] Loaded tenant ${tenantId} with real directory`,
        );
      } catch (error) {
        console.error(
          `[TenantManager] Failed to create real directory for ${tenantId}, falling back to config:`,
          error,
        );
        innerDirectory = new SimpleMindooDirectory(config);
      }
    } else {
      if (publicInfosKeys.length > 0 && !this.serverIdentity) {
        console.log(
          `[TenantManager] Tenant ${tenantId} has $publicinfos keys but no server identity; using config-based directory`,
        );
      } else {
        console.log(
          `[TenantManager] No $publicinfos keys for ${tenantId}, using config-based directory`,
        );
      }
      innerDirectory = new SimpleMindooDirectory(config);
    }

    // Wrap with CompositeMindooDirectory so trusted servers are also recognized
    const directory = new CompositeMindooDirectory(
      innerDirectory,
      this.trustedServers,
      config.adminUsername
        ? {
            username: config.adminUsername,
            signingPublicKey: config.adminSigningPublicKey,
            encryptionPublicKey: config.adminEncryptionPublicKey,
          }
        : undefined,
    ) as unknown as MindooTenantDirectory;

    const authService = new AuthenticationService(
      this.cryptoAdapter,
      directory,
      tenantId,
      this.jwtSecretForTenant
        ? { jwtSecret: await this.jwtSecretForTenant(tenantId) }
        : undefined,
    );

    console.log(`[TenantManager] Loaded tenant: ${tenantId}`);

    return {
      context,
      storeFactory,
      authService,
      directory,
      mindooTenant,
      serverStores: new Map(),
    };
  }

  /**
   * Create a real BaseMindooTenant for directory reading using the global
   * server identity.
   */
  private async createDirectoryTenant(
    tenantId: string,
    config: TenantConfig,
    storeFactory: TenantStoreFactory,
    publicInfosKeys: Uint8Array[],
  ): Promise<{ tenant: MindooTenant }> {
    const storeFactoryAdapter = new StoreFactoryAdapter(storeFactory);
    const factory = new BaseMindooTenantFactory(
      storeFactoryAdapter,
      this.cryptoAdapter,
    );

    const serverUser = this.serverIdentity!;

    // Create a KeyBag using the server user's encryption key
    const keyBag = await this.createServerKeyBag(
      serverUser,
      this.serverPassword!,
    );
    for (const publicInfosKey of this.mergeUniqueKeys(publicInfosKeys)) {
      await keyBag.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, publicInfosKey);
    }

    // Collect trusted server signing keys for additionalTrustedKeys
    const openOptions: OpenTenantOptions = {};
    if (this.trustedServers.length > 0) {
      const trustedKeys = new Map<string, boolean>();
      for (const server of this.trustedServers) {
        trustedKeys.set(server.signingPublicKey, true);
      }
      openOptions.additionalTrustedKeys = trustedKeys;
    }

    const tenant = await factory.openTenant(
      tenantId,
      config.adminSigningPublicKey,
      config.adminEncryptionPublicKey,
      serverUser,
      this.serverPassword!,
      keyBag,
      openOptions,
    );

    return { tenant };
  }
}

/**
 * A store that is only created when something other than its identity
 * (`getId`, `getStoreKind`) is used. See {@link TenantManager.getServerStore}.
 */
export function lazyContentAddressedStore(
  dbId: string,
  storeKind: StoreKind,
  create: () => ContentAddressedStore,
): ContentAddressedStore {
  let real: ContentAddressedStore | null = null;
  const target = (): ContentAddressedStore => (real ??= create());
  return new Proxy({} as ContentAddressedStore, {
    get(_shell, prop) {
      if (prop === "getId") return () => dbId;
      if (prop === "getStoreKind") return () => storeKind;
      const store = target();
      const value = (store as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(store) : value;
    },
    has(_shell, prop) {
      return prop in target();
    },
  });
}
