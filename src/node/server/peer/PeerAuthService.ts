/**
 * Peer (server-to-server) authentication for `/system/peer/*`.
 *
 * Same Ed25519 challenge-response as the tenant sync handshake, but the key
 * lookup goes to `trusted-servers.json` instead of a tenant directory. The
 * issued JWT is deliberately a **different token class** from the system-admin
 * JWT: `/system/peer/*` accepts only peer tokens and `/system/cluster/*` only
 * admin tokens, so a peer can never administer this node and an admin can never
 * write as a peer.
 */

import { v7 as uuidv7 } from "uuid";
import type { CryptoAdapter } from "../../../core/crypto/CryptoAdapter";
import type { TrustedServer } from "../types";

export interface PeerTokenPayload {
  /** Trusted-server name that authenticated. */
  sub: string;
  /** The Ed25519 key that signed the challenge, i.e. the peer's identity. */
  publicsignkey: string;
  /** Marks this as a peer token; absent/false tokens are rejected by peer routes. */
  peer: true;
  iat: number;
  exp: number;
}

interface StoredChallenge {
  challenge: string;
  serverName: string;
  publicsignkey: string;
  expiresAt: number;
  used: boolean;
}

/** Whitespace-insensitive PEM comparison (JSON transport reflows line endings). */
function normalizePem(pem: string): string {
  return pem.replace(/\s+/g, "");
}

export class PeerAuthService {
  private challenges: Map<string, StoredChallenge> = new Map();
  /** Challenge creation is unauthenticated, so the map is bounded (DoS guard). */
  private static readonly MAX_CHALLENGES = 10_000;

  private readonly jwtSecret: Uint8Array;
  private readonly challengeExpirationMs: number;
  private readonly tokenExpirationMs: number;

  constructor(
    private readonly cryptoAdapter: CryptoAdapter,
    /** Live view of `trusted-servers.json` — re-read on every handshake. */
    private readonly listTrustedServers: () => TrustedServer[],
    options?: {
      jwtSecret?: Uint8Array;
      challengeExpirationMs?: number;
      tokenExpirationMs?: number;
    },
  ) {
    this.jwtSecret =
      options?.jwtSecret ?? cryptoAdapter.getRandomValues(new Uint8Array(32));
    this.challengeExpirationMs = options?.challengeExpirationMs ?? 5 * 60 * 1000;
    this.tokenExpirationMs = options?.tokenExpirationMs ?? 60 * 60 * 1000;
  }

  /** Resolve a trusted server by its signing key (the canonical identity). */
  findTrustedServerByKey(publicsignkey: string): TrustedServer | null {
    const wanted = normalizePem(publicsignkey);
    return (
      this.listTrustedServers().find(
        (server) => normalizePem(server.signingPublicKey) === wanted,
      ) ?? null
    );
  }

  /**
   * Issue a challenge for a peer identified by its signing key.
   *
   * @throws Error("Unknown peer") when the key is not in trusted-servers.json.
   */
  async generateChallenge(publicsignkey: string): Promise<string> {
    const server = this.findTrustedServerByKey(publicsignkey);
    if (!server) {
      throw new Error("Unknown peer");
    }

    const challenge = uuidv7();
    this.challenges.set(challenge, {
      challenge,
      serverName: server.name,
      publicsignkey: server.signingPublicKey,
      expiresAt: Date.now() + this.challengeExpirationMs,
      used: false,
    });
    this.cleanupExpiredChallenges();
    this.evictChallengesOverCap();
    return challenge;
  }

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

    // Re-resolve against the live trust list: an operator may have removed the
    // peer between challenge and response.
    if (!this.findTrustedServerByKey(stored.publicsignkey)) {
      return { success: false, error: "Peer is no longer trusted" };
    }

    const valid = await this.verifySignature(challenge, signature, stored.publicsignkey);
    if (!valid) {
      return { success: false, error: "Invalid signature" };
    }

    const token = await this.generateToken(stored.serverName, stored.publicsignkey);
    return { success: true, token };
  }

  /**
   * Validate a peer JWT. Returns null unless the token carries `peer: true`
   * *and* the signing key is still trusted — revoking trust must cut off
   * outstanding tokens, not just future handshakes.
   */
  async validateToken(token: string): Promise<PeerTokenPayload | null> {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, signatureB64] = parts;

    try {
      // Pin the algorithm to HS256 to block algorithm-confusion attacks.
      const header = JSON.parse(this.base64UrlDecode(headerB64)) as { alg?: string };
      if (header.alg !== "HS256") return null;

      const subtle = this.cryptoAdapter.getSubtle();
      const signingKey = await subtle.importKey(
        "raw",
        this.jwtSecret.buffer as ArrayBuffer,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const dataToVerify = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
      const sig = this.base64UrlToUint8Array(signatureB64);
      const isValid = await subtle.verify(
        "HMAC",
        signingKey,
        sig.buffer.slice(sig.byteOffset, sig.byteOffset + sig.byteLength) as ArrayBuffer,
        dataToVerify.buffer as ArrayBuffer,
      );
      if (!isValid) return null;

      const payload = JSON.parse(this.base64UrlDecode(payloadB64)) as PeerTokenPayload;
      if (payload.peer !== true) return null;
      if (payload.exp < Math.floor(Date.now() / 1000)) return null;
      if (!this.findTrustedServerByKey(payload.publicsignkey)) return null;
      return payload;
    } catch {
      return null;
    }
  }

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

  private async generateToken(serverName: string, publicsignkey: string): Promise<string> {
    const subtle = this.cryptoAdapter.getSubtle();
    const now = Math.floor(Date.now() / 1000);
    const payload: PeerTokenPayload = {
      sub: serverName,
      publicsignkey,
      peer: true,
      iat: now,
      exp: now + Math.floor(this.tokenExpirationMs / 1000),
    };

    const headerB64 = this.base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payloadB64 = this.base64UrlEncode(JSON.stringify(payload));
    const signingKey = await subtle.importKey(
      "raw",
      this.jwtSecret.buffer as ArrayBuffer,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const dataToSign = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = await subtle.sign("HMAC", signingKey, dataToSign.buffer as ArrayBuffer);
    return `${headerB64}.${payloadB64}.${this.uint8ArrayToBase64Url(new Uint8Array(signature))}`;
  }

  private cleanupExpiredChallenges(): void {
    const now = Date.now();
    for (const [key, challenge] of this.challenges) {
      if (challenge.expiresAt < now) {
        this.challenges.delete(key);
      }
    }
  }

  private evictChallengesOverCap(): void {
    let overflow = this.challenges.size - PeerAuthService.MAX_CHALLENGES;
    if (overflow <= 0) return;
    for (const key of this.challenges.keys()) {
      if (overflow-- <= 0) break;
      this.challenges.delete(key);
    }
  }

  private base64UrlEncode(str: string): string {
    return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
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
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
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
