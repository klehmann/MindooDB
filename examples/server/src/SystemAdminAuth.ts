/**
 * System admin authentication service.
 *
 * Reuses the existing `AuthenticationService` by providing a
 * `SystemAdminDirectory` adapter that derives user lookup data from
 * the capabilities section of `config.json` rather than a tenant
 * directory.  Challenges require both username and publicsignkey so
 * the issued JWT can carry both fields for capability matching.
 */

import { v7 as uuidv7 } from "uuid";
import type { CryptoAdapter } from "mindoodb/core/crypto/CryptoAdapter";
import type { ServerConfig, SystemAdminPrincipal } from "./types";
import { extractAllPrincipals } from "./config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SystemAdminTokenPayload {
  sub: string;
  publicsignkey: string;
  iat: number;
  exp: number;
}

interface StoredChallenge {
  challenge: string;
  username: string;
  publicsignkey: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

// ---------------------------------------------------------------------------
// SystemAdminAuthService
// ---------------------------------------------------------------------------

export class SystemAdminAuthService {
  private challenges: Map<string, StoredChallenge> = new Map();
  private jwtSecret: Uint8Array;
  private challengeExpirationMs: number;
  private tokenExpirationMs: number;
  private principals: SystemAdminPrincipal[];
  private cryptoAdapter: CryptoAdapter;

  constructor(
    cryptoAdapter: CryptoAdapter,
    config: ServerConfig,
    options?: {
      jwtSecret?: Uint8Array;
      challengeExpirationMs?: number;
      tokenExpirationMs?: number;
    },
  ) {
    this.cryptoAdapter = cryptoAdapter;
    this.principals = extractAllPrincipals(config);
    this.jwtSecret =
      options?.jwtSecret ?? cryptoAdapter.getRandomValues(new Uint8Array(32));
    this.challengeExpirationMs = options?.challengeExpirationMs ?? 5 * 60 * 1000;
    this.tokenExpirationMs = options?.tokenExpirationMs ?? 60 * 60 * 1000;
  }

  /**
   * Hot-swap the principal list from a new config.
   * In-flight challenges and existing JWTs remain valid (same HMAC secret);
   * removed principals will fail the CapabilityMatcher check on their next request.
   */
  reloadPrincipals(config: ServerConfig): void {
    this.principals = extractAllPrincipals(config);
  }

  /**
   * Generate a challenge for a system admin.
   * Both `username` and `publicsignkey` are required so we can bind
   * the issued JWT to a specific keypair.
   */
  async generateChallenge(
    username: string,
    publicsignkey: string,
  ): Promise<string> {
    const normalizedUsername = username.toLowerCase();

    const found = this.principals.some(
      (p) =>
        p.username.toLowerCase() === normalizedUsername &&
        p.publicsignkey === publicsignkey,
    );
    if (!found) {
      throw new Error("Unknown system admin principal");
    }

    const challenge = uuidv7();
    const now = Date.now();

    this.challenges.set(challenge, {
      challenge,
      username,
      publicsignkey,
      createdAt: now,
      expiresAt: now + this.challengeExpirationMs,
      used: false,
    });

    this.cleanupExpiredChallenges();
    return challenge;
  }

  /**
   * Verify a signed challenge and return a JWT containing both
   * `sub` (username) and `publicsignkey`.
   */
  async authenticate(
    challenge: string,
    signature: Uint8Array,
  ): Promise<{ success: boolean; token?: string; error?: string }> {
    const stored = this.challenges.get(challenge);
    if (!stored) {
      return { success: false, error: "Challenge not found or expired" };
    }

    if (Date.now() > stored.expiresAt) {
      this.challenges.delete(challenge);
      return { success: false, error: "Challenge expired" };
    }

    if (stored.used) {
      return { success: false, error: "Challenge already used" };
    }

    stored.used = true;

    const isValid = await this.verifySignature(
      challenge,
      signature,
      stored.publicsignkey,
    );

    if (!isValid) {
      return { success: false, error: "Invalid signature" };
    }

    const token = await this.generateToken(stored.username, stored.publicsignkey);
    return { success: true, token };
  }

  /**
   * Validate and decode a system admin JWT.
   */
  async validateToken(
    token: string,
  ): Promise<SystemAdminTokenPayload | null> {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;

    try {
      const subtle = this.cryptoAdapter.getSubtle();
      const signingKey = await subtle.importKey(
        "raw",
        this.jwtSecret.buffer as ArrayBuffer,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );

      const dataToVerify = new TextEncoder().encode(
        `${headerB64}.${payloadB64}`,
      );
      const sig = this.base64UrlToUint8Array(signatureB64);

      const isValid = await subtle.verify(
        "HMAC",
        signingKey,
        sig.buffer.slice(
          sig.byteOffset,
          sig.byteOffset + sig.byteLength,
        ) as ArrayBuffer,
        dataToVerify.buffer as ArrayBuffer,
      );

      if (!isValid) return null;

      const payload = JSON.parse(
        this.base64UrlDecode(payloadB64),
      ) as SystemAdminTokenPayload;

      const now = Math.floor(Date.now() / 1000);
      if (payload.exp < now) return null;

      return payload;
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async verifySignature(
    message: string,
    signature: Uint8Array,
    publicKeyPem: string,
  ): Promise<boolean> {
    const subtle = this.cryptoAdapter.getSubtle();

    try {
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
        ["verify"],
      );

      const messageBytes = new TextEncoder().encode(message);
      return await subtle.verify(
        { name: "Ed25519" },
        publicKey,
        signature.buffer.slice(
          signature.byteOffset,
          signature.byteOffset + signature.byteLength,
        ) as ArrayBuffer,
        messageBytes.buffer as ArrayBuffer,
      );
    } catch {
      return false;
    }
  }

  private async generateToken(
    username: string,
    publicsignkey: string,
  ): Promise<string> {
    const subtle = this.cryptoAdapter.getSubtle();
    const now = Math.floor(Date.now() / 1000);

    const payload: SystemAdminTokenPayload = {
      sub: username,
      publicsignkey,
      iat: now,
      exp: now + Math.floor(this.tokenExpirationMs / 1000),
    };

    const header = { alg: "HS256", typ: "JWT" };
    const headerB64 = this.base64UrlEncode(JSON.stringify(header));
    const payloadB64 = this.base64UrlEncode(JSON.stringify(payload));

    const signingKey = await subtle.importKey(
      "raw",
      this.jwtSecret.buffer as ArrayBuffer,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const dataToSign = new TextEncoder().encode(
      `${headerB64}.${payloadB64}`,
    );
    const signature = await subtle.sign(
      "HMAC",
      signingKey,
      dataToSign.buffer as ArrayBuffer,
    );

    const signatureB64 = this.uint8ArrayToBase64Url(new Uint8Array(signature));
    return `${headerB64}.${payloadB64}.${signatureB64}`;
  }

  private cleanupExpiredChallenges(): void {
    const now = Date.now();
    for (const [key, ch] of this.challenges) {
      if (ch.expiresAt < now) {
        this.challenges.delete(key);
      }
    }
  }

  // Base64 utilities

  private base64UrlEncode(str: string): string {
    const base64 = btoa(str);
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  }

  private base64UrlDecode(str: string): string {
    let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4) base64 += "=";
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
    while (base64.length % 4) base64 += "=";
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
