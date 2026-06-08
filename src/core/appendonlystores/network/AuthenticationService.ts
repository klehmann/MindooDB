import { v7 as uuidv7 } from "uuid";
import type { CryptoAdapter } from "../../crypto/CryptoAdapter";
import type { MindooTenantDirectory } from "../../types";
import type {
  AuthChallenge,
  AuthResult,
  NetworkAuthTokenPayload,
} from "./types";
import { NetworkError, NetworkErrorType } from "./types";
import { Logger, MindooLogger, getDefaultLogLevel } from "../../logging";

/**
 * Authentication service for network sync operations.
 * 
 * Handles:
 * - Challenge generation (UUID v7)
 * - Signature verification using user's public signing key
 * - JWT token generation and validation
 * - User revocation checks
 * 
 * Security features:
 * - Single-use challenges prevent replay attacks
 * - Challenge expiration (5 minutes default)
 * - Token expiration (1 hour default)
 * - Revocation checks against tenant directory
 */
export class AuthenticationService {
  private cryptoAdapter: CryptoAdapter;
  private directory: MindooTenantDirectory;
  private tenantId: string;
  
  // In-memory challenge storage (in production, use a distributed cache)
  private challenges: Map<string, AuthChallenge> = new Map();
  
  // JWT signing secret (in production, should be securely managed)
  private jwtSecret: Uint8Array;
  
  // Configuration
  private challengeExpirationMs: number;
  private tokenExpirationMs: number;
  private logger: Logger;

  constructor(
    cryptoAdapter: CryptoAdapter,
    directory: MindooTenantDirectory,
    tenantId: string,
    options?: {
      jwtSecret?: Uint8Array;
      challengeExpirationMs?: number;
      tokenExpirationMs?: number;
      logger?: Logger;
    }
  ) {
    this.cryptoAdapter = cryptoAdapter;
    this.directory = directory;
    this.tenantId = tenantId;
    
    // Generate random JWT secret if not provided
    this.jwtSecret = options?.jwtSecret || this.cryptoAdapter.getRandomValues(new Uint8Array(32));
    
    // Default: 5 minutes for challenge, 1 hour for token
    this.challengeExpirationMs = options?.challengeExpirationMs || 5 * 60 * 1000;
    this.tokenExpirationMs = options?.tokenExpirationMs || 60 * 60 * 1000;
    this.logger =
      options?.logger ||
      new MindooLogger(getDefaultLogLevel(), `AuthenticationService:${tenantId}`, true);
  }

  /**
   * Generate a challenge for a user to sign.
   *
   * Note: the server cannot distinguish between a user whose access was explicitly
   * revoked and a user whose grant-access document simply has not been synced to
   * this server yet. In both cases the directory exposes no active grant document
   * and we return USER_REVOKED with a message that mentions both possibilities so
   * admins can diagnose the issue.
   *
   * The username is optional: a client may instead identify itself by its
   * device signing public key (`options.signingPublicKey`), in which case the
   * server resolves the grant by key and never needs the cleartext name.
   *
   * @param username The username requesting authentication (optional)
   * @param options.signingPublicKey The device signing public key (Ed25519, PEM)
   *        the client is identifying with, when no username is supplied
   * @returns The challenge string (UUID v7)
   * @throws NetworkError if user not found or has no active access grant
   */
  async generateChallenge(
    username?: string,
    options?: { signingPublicKey?: string },
  ): Promise<string> {
    const signingPublicKey = options?.signingPublicKey;
    if (username) {
      return this.generateChallengeForUsername(username, signingPublicKey);
    }
    if (signingPublicKey) {
      return this.generateChallengeForKey(signingPublicKey);
    }
    throw new NetworkError(
      NetworkErrorType.USER_NOT_FOUND,
      `A username or signing public key is required to request a challenge.`,
    );
  }

  /** Username-based challenge (legacy path; the client still sends a username). */
  private async generateChallengeForUsername(
    username: string,
    signingPublicKey?: string,
  ): Promise<string> {
    this.logger.debug(`Generating challenge for user: ${username}`);

    // Check if user exists and is not revoked
    const userKeys = await this.directory.getUserPublicKeys(username);
    if (!userKeys) {
      // A revoked device may still need to authenticate far enough to learn it
      // must wipe (docs/accesscontrol.md §6.5). Allow the challenge if any of the
      // user's keys is the target of a remote-wipe directive.
      const universe = await this.getSigningKeyUniverse(username);
      if (universe.wipeRequested.length > 0) {
        return this.storeChallenge({ username, signingPublicKey });
      }
      // Check if user was revoked or never existed
      const isRevoked = await this.directory.isUserRevoked(username);
      if (isRevoked) {
        throw new NetworkError(
          NetworkErrorType.USER_REVOKED,
          `User "${username}" has no active access grant for this tenant on this server. `
            + `The access may have been revoked, or the tenant's directory database may not have `
            + `been synced to this server yet. Ask the tenant administrator to sync the directory.`,
        );
      }
      throw new NetworkError(
        NetworkErrorType.USER_NOT_FOUND,
        `User "${username}" is not found in this server's tenant directory. `
          + `The user may not have been registered yet, or the tenant's directory database may `
          + `not have been synced to this server yet. Ask the tenant administrator to sync the directory.`,
      );
    }

    const challenge = this.storeChallenge({ username, signingPublicKey });
    this.logger.debug(`Generated challenge for user ${username}: ${challenge}`);
    return challenge;
  }

  /**
   * Key-based challenge: the client identifies by its device signing public key
   * and the server resolves the grant without a cleartext username. The grant's
   * username (resolved from the directory) is recorded on the challenge so
   * downstream identity/wipe resolution keeps working.
   */
  private async generateChallengeForKey(signingPublicKey: string): Promise<string> {
    this.logger.debug(`Generating challenge for signing key`);

    if (typeof this.directory.getUserBySigningPublicKey === "function") {
      const lookup = await this.directory.getUserBySigningPublicKey(signingPublicKey);
      if (lookup) {
        // An entry in the lookup means the key is on an active grant.
        return this.storeChallenge({ username: lookup.username, signingPublicKey });
      }
    }

    // No active grant for this key. It may still be the target of a remote-wipe
    // directive on a revoked grant; if the directory can resolve that, allow the
    // challenge so the device can learn it must wipe (§6.5).
    throw new NetworkError(
      NetworkErrorType.USER_NOT_FOUND,
      `No active access grant is known for the provided signing key on this server. `
        + `The access may have been revoked, or the tenant's directory database may not have `
        + `been synced to this server yet. Ask the tenant administrator to sync the directory.`,
    );
  }

  /** Persist a fresh challenge and return its string. */
  private storeChallenge(fields: { username?: string; signingPublicKey?: string }): string {
    const challenge = uuidv7();
    const now = Date.now();
    const authChallenge: AuthChallenge = {
      challenge,
      createdAt: now,
      expiresAt: now + this.challengeExpirationMs,
      used: false,
    };
    if (fields.username) authChallenge.username = fields.username;
    if (fields.signingPublicKey) authChallenge.signingPublicKey = fields.signingPublicKey;
    this.challenges.set(challenge, authChallenge);
    this.cleanupExpiredChallenges();
    return challenge;
  }

  /**
   * Authenticate a user by verifying their signed challenge.
   * 
   * @param challenge The challenge string
   * @param signature The Ed25519 signature of the challenge
   * @returns AuthResult with success status and JWT token
   */
  async authenticate(challenge: string, signature: Uint8Array): Promise<AuthResult> {
    this.logger.debug(`Authenticating challenge: ${challenge}`);
    
    // Get and validate challenge
    const authChallenge = this.challenges.get(challenge);
    if (!authChallenge) {
      this.logger.debug(`Challenge not found: ${challenge}`);
      return {
        success: false,
        error: "Challenge not found or expired",
      };
    }
    
    // Check if challenge is expired
    if (Date.now() > authChallenge.expiresAt) {
      this.logger.debug(`Challenge expired: ${challenge}`);
      this.challenges.delete(challenge);
      return {
        success: false,
        error: "Challenge expired",
      };
    }
    
    // Check if challenge was already used
    if (authChallenge.used) {
      this.logger.debug(`Challenge already used: ${challenge}`);
      return {
        success: false,
        error: "Challenge already used",
      };
    }
    
    // Mark challenge as used (single-use)
    authChallenge.used = true;
    
    const username = authChallenge.username;
    // Resolve the principal: a username (legacy) or the device signing key the
    // client identified with. When only the key is known, resolve its grant's
    // username so wipe/identity lookups (which key by username) keep working.
    let resolvedUsername = username;
    if (
      !resolvedUsername &&
      authChallenge.signingPublicKey &&
      typeof this.directory.getUserBySigningPublicKey === "function"
    ) {
      const lookup = await this.directory.getUserBySigningPublicKey(
        authChallenge.signingPublicKey,
      );
      resolvedUsername = lookup?.username;
    }
    const principalLabel = username ?? authChallenge.signingPublicKey ?? "unknown";

    // Build the set of candidate signing keys this device could be using: the
    // user's active (granted) keys plus any keys targeted for remote wipe
    // (§6.5). The wipe set lets a revoked-by-key-removal device authenticate
    // just far enough to receive the directive.
    const universe = resolvedUsername
      ? await this.getSigningKeyUniverse(resolvedUsername)
      : { active: [] as string[], wipeRequested: [] as string[] };
    const candidateKeys = new Set<string>([...universe.active, ...universe.wipeRequested]);
    // Legacy fallback: directories without the wipe API expose only the primary
    // key via getUserPublicKeys.
    if (candidateKeys.size === 0 && resolvedUsername) {
      const userKeys = await this.directory.getUserPublicKeys(resolvedUsername);
      if (userKeys) candidateKeys.add(userKeys.signingPublicKey);
    }
    // Key-based challenge with no resolvable grant: the only candidate is the
    // key the client identified with.
    if (candidateKeys.size === 0 && authChallenge.signingPublicKey) {
      candidateKeys.add(authChallenge.signingPublicKey);
    }
    if (candidateKeys.size === 0) {
      this.logger.debug(`User not found or has no active access grant on this server: ${principalLabel}`);
      return {
        success: false,
        error:
          `User "${principalLabel}" is not found, or has no active access grant on this server. `
            + `The tenant's directory database may not have been synced to this server yet, `
            + `or the access was revoked.`,
      };
    }

    // Find which candidate key produced the signature; that is the device's key.
    let matchedKey: string | null = null;
    for (const key of candidateKeys) {
      if (await this.verifySignature(challenge, signature, key)) {
        matchedKey = key;
        break;
      }
    }

    if (!matchedKey) {
      this.logger.debug(`Invalid signature for user: ${principalLabel}`);
      return {
        success: false,
        error: "Invalid signature",
      };
    }

    const wipe = universe.wipeRequested.includes(matchedKey);
    // The subject is the cleartext username when one was supplied, otherwise the
    // authenticated device key (an opaque principal id; the read gate resolves
    // identity from deviceSigningKey).
    const sub = username ?? matchedKey;
    // Generate JWT token, recording the authenticated device key and whether it
    // is wipe-targeted so sync handlers can serve only the grant directive.
    const token = await this.generateToken(sub, { deviceSigningKey: matchedKey, wipe });
    
    this.logger.info(
      `Authentication successful for user: ${principalLabel}${wipe ? " (remote-wipe directive pending)" : ""}`,
    );
    return {
      success: true,
      token,
    };
  }

  /**
   * Resolve the user's signing-key universe (active + wipe-targeted) via the
   * optional directory API, returning empty sets when unsupported.
   */
  private async getSigningKeyUniverse(
    username: string,
  ): Promise<{ active: string[]; wipeRequested: string[] }> {
    if (typeof this.directory.getUserSigningKeyUniverse === "function") {
      try {
        return await this.directory.getUserSigningKeyUniverse(username);
      } catch (error) {
        this.logger.debug(`getUserSigningKeyUniverse failed for ${username}: ${error}`);
      }
    }
    return { active: [], wipeRequested: [] };
  }

  /**
   * Validate a JWT token.
   * 
   * @param token The JWT token to validate
   * @returns The token payload if valid, null otherwise
   */
  async validateToken(token: string): Promise<NetworkAuthTokenPayload | null> {
    this.logger.debug(`Validating token`);
    
    try {
      const payload = await this.verifyToken(token);
      
      if (!payload) {
        this.logger.debug(`Invalid token signature`);
        return null;
      }
      
      // Check expiration
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp < now) {
        this.logger.debug(`Token expired`);
        return null;
      }
      
      // Check if user is still valid (not revoked). A wipe-scoped token is the
      // deliberate exception (§6.5): a revoked device must still be able to fetch
      // the admin-signed grant doc carrying its wipe directive, so we honor the
      // token but downstream sync handlers restrict it to that single document.
      if (!payload.wipe) {
        const deviceKey = payload.deviceSigningKey;
        if (deviceKey && typeof this.directory.getUserSigningKeyUniverse === "function") {
          // Key-based revocation: the device key is valid only while it is in the
          // user's ACTIVE signing-key set. This is more precise than the
          // username-level check (it cuts off a single revoked device) and works
          // when `sub` is a key rather than a cleartext username. We resolve the
          // username from the device key when possible (the reverse lookup cache
          // intentionally survives revocation for historical display, so it
          // alone cannot prove the key is still active — hence the universe
          // check).
          let username = payload.sub;
          if (typeof this.directory.getUserBySigningPublicKey === "function") {
            const lookup = await this.directory.getUserBySigningPublicKey(deviceKey);
            if (lookup?.username) username = lookup.username;
          }
          const universe = await this.directory.getUserSigningKeyUniverse(username);
          const keyInactive = !universe.active.includes(deviceKey);
          const userRevoked = await this.directory.isUserRevoked(username);
          if (keyInactive || userRevoked) {
            this.logger.debug(`Device key no longer active (revoked): ${payload.sub}`);
            return null;
          }
        } else {
          const isRevoked = await this.directory.isUserRevoked(payload.sub);
          if (isRevoked) {
            this.logger.debug(`User revoked: ${payload.sub}`);
            return null;
          }
        }
      }
      
      this.logger.debug(`Token valid for user: ${payload.sub}`);
      return payload;
    } catch (error) {
      this.logger.error(`Token validation error:`, error);
      return null;
    }
  }

  /**
   * Verify an Ed25519 signature.
   */
  private async verifySignature(
    message: string,
    signature: Uint8Array,
    publicKeyPem: string
  ): Promise<boolean> {
    const subtle = this.cryptoAdapter.getSubtle();
    
    try {
      // Import public key
      const pemContents = publicKeyPem
        .replace(/-----BEGIN PUBLIC KEY-----/g, "")
        .replace(/-----END PUBLIC KEY-----/g, "")
        .replace(/\s/g, "");
      
      const keyData = this.base64ToUint8Array(pemContents);
      
      const publicKey = await subtle.importKey(
        "spki",
        keyData.buffer as ArrayBuffer,
        { name: "Ed25519" },
        false,
        ["verify"]
      );
      
      // Verify signature
      const messageBytes = new TextEncoder().encode(message);
      const isValid = await subtle.verify(
        { name: "Ed25519" },
        publicKey,
        signature.buffer.slice(signature.byteOffset, signature.byteOffset + signature.byteLength) as ArrayBuffer,
        messageBytes.buffer as ArrayBuffer
      );
      
      return isValid;
    } catch (error) {
      this.logger.error(`Signature verification error:`, error);
      return false;
    }
  }

  /**
   * Generate a JWT token.
   * Uses HMAC-SHA256 for signing.
   */
  private async generateToken(
    sub: string,
    options?: { deviceSigningKey?: string; wipe?: boolean },
  ): Promise<string> {
    const subtle = this.cryptoAdapter.getSubtle();
    
    const now = Math.floor(Date.now() / 1000);
    const payload: NetworkAuthTokenPayload = {
      sub,
      iat: now,
      exp: now + Math.floor(this.tokenExpirationMs / 1000),
      tenantId: this.tenantId,
    };
    if (options?.deviceSigningKey) payload.deviceSigningKey = options.deviceSigningKey;
    if (options?.wipe) payload.wipe = true;
    
    // Create JWT header and payload
    const header = { alg: "HS256", typ: "JWT" };
    const headerB64 = this.base64UrlEncode(JSON.stringify(header));
    const payloadB64 = this.base64UrlEncode(JSON.stringify(payload));
    
    // Sign with HMAC-SHA256
    const signingKey = await subtle.importKey(
      "raw",
      this.jwtSecret.buffer as ArrayBuffer,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    
    const dataToSign = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = await subtle.sign("HMAC", signingKey, dataToSign.buffer as ArrayBuffer);
    const signatureB64 = this.uint8ArrayToBase64Url(new Uint8Array(signature));
    
    return `${headerB64}.${payloadB64}.${signatureB64}`;
  }

  /**
   * Verify and decode a JWT token.
   */
  private async verifyToken(token: string): Promise<NetworkAuthTokenPayload | null> {
    const subtle = this.cryptoAdapter.getSubtle();
    
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }
    
    const [headerB64, payloadB64, signatureB64] = parts;
    
    try {
      // Verify signature
      const signingKey = await subtle.importKey(
        "raw",
        this.jwtSecret.buffer as ArrayBuffer,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"]
      );
      
      const dataToVerify = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
      const signature = this.base64UrlToUint8Array(signatureB64);
      
      const isValid = await subtle.verify(
        "HMAC",
        signingKey,
        signature.buffer.slice(signature.byteOffset, signature.byteOffset + signature.byteLength) as ArrayBuffer,
        dataToVerify.buffer as ArrayBuffer
      );
      
      if (!isValid) {
        return null;
      }
      
      // Decode payload
      const payloadJson = this.base64UrlDecode(payloadB64);
      const payload = JSON.parse(payloadJson) as NetworkAuthTokenPayload;
      
      return payload;
    } catch (error) {
      this.logger.error(`Token verification error:`, error);
      return null;
    }
  }

  /**
   * Clean up expired challenges.
   */
  private cleanupExpiredChallenges(): void {
    const now = Date.now();
    for (const [challenge, authChallenge] of this.challenges) {
      if (authChallenge.expiresAt < now) {
        this.challenges.delete(challenge);
      }
    }
  }

  // Base64 URL encoding/decoding utilities
  
  private base64UrlEncode(str: string): string {
    const base64 = btoa(str);
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  }
  
  private base64UrlDecode(str: string): string {
    let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4) {
      base64 += "=";
    }
    return atob(base64);
  }
  
  private uint8ArrayToBase64Url(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  }
  
  private base64UrlToUint8Array(str: string): Uint8Array {
    let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4) {
      base64 += "=";
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  
  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
}
