import { v7 as uuidv7 } from "uuid";
import type { CryptoAdapter } from "../../crypto/CryptoAdapter";
import type { MindooTenantDirectory } from "../../types";
import type {
  AuthChallenge,
  AuthResult,
  NetworkAuthTokenPayload,
} from "./types";
import { NetworkError, NetworkErrorType } from "./types";

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

  constructor(
    cryptoAdapter: CryptoAdapter,
    directory: MindooTenantDirectory,
    tenantId: string,
    options?: {
      jwtSecret?: Uint8Array;
      challengeExpirationMs?: number;
      tokenExpirationMs?: number;
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
  }

  /**
   * Generate a challenge for a user to sign.
   * 
   * @param username The username requesting authentication
   * @returns The challenge string (UUID v7)
   * @throws NetworkError if user not found or revoked
   */
  async generateChallenge(username: string): Promise<string> {
    console.log(`[AuthenticationService] Generating challenge for user: ${username}`);
    
    // Check if user exists and is not revoked
    const userKeys = await this.directory.getUserPublicKeys(username);
    if (!userKeys) {
      // Check if user was revoked or never existed
      const isRevoked = await this.directory.isUserRevoked(username);
      if (isRevoked) {
        throw new NetworkError(NetworkErrorType.USER_REVOKED, `User ${username} has been revoked`);
      }
      throw new NetworkError(NetworkErrorType.USER_NOT_FOUND, `User ${username} not found`);
    }
    
    // Generate UUID v7 challenge
    const challenge = uuidv7();
    const now = Date.now();
    
    // Store challenge
    const authChallenge: AuthChallenge = {
      challenge,
      username,
      createdAt: now,
      expiresAt: now + this.challengeExpirationMs,
      used: false,
    };
    
    this.challenges.set(challenge, authChallenge);
    
    // Clean up expired challenges periodically
    this.cleanupExpiredChallenges();
    
    console.log(`[AuthenticationService] Generated challenge for user ${username}: ${challenge}`);
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
    console.log(`[AuthenticationService] Authenticating challenge: ${challenge}`);
    
    // Get and validate challenge
    const authChallenge = this.challenges.get(challenge);
    if (!authChallenge) {
      console.log(`[AuthenticationService] Challenge not found: ${challenge}`);
      return {
        success: false,
        error: "Challenge not found or expired",
      };
    }
    
    // Check if challenge is expired
    if (Date.now() > authChallenge.expiresAt) {
      console.log(`[AuthenticationService] Challenge expired: ${challenge}`);
      this.challenges.delete(challenge);
      return {
        success: false,
        error: "Challenge expired",
      };
    }
    
    // Check if challenge was already used
    if (authChallenge.used) {
      console.log(`[AuthenticationService] Challenge already used: ${challenge}`);
      return {
        success: false,
        error: "Challenge already used",
      };
    }
    
    // Mark challenge as used (single-use)
    authChallenge.used = true;
    
    const username = authChallenge.username;
    
    // Get user's public signing key
    const userKeys = await this.directory.getUserPublicKeys(username);
    if (!userKeys) {
      console.log(`[AuthenticationService] User not found or revoked: ${username}`);
      return {
        success: false,
        error: "User not found or revoked",
      };
    }
    
    // Verify signature
    const isValid = await this.verifySignature(
      challenge,
      signature,
      userKeys.signingPublicKey
    );
    
    if (!isValid) {
      console.log(`[AuthenticationService] Invalid signature for user: ${username}`);
      return {
        success: false,
        error: "Invalid signature",
      };
    }
    
    // Generate JWT token
    const token = await this.generateToken(username);
    
    console.log(`[AuthenticationService] Authentication successful for user: ${username}`);
    return {
      success: true,
      token,
    };
  }

  /**
   * Validate a JWT token.
   * 
   * @param token The JWT token to validate
   * @returns The token payload if valid, null otherwise
   */
  async validateToken(token: string): Promise<NetworkAuthTokenPayload | null> {
    console.log(`[AuthenticationService] Validating token`);
    
    try {
      const payload = await this.verifyToken(token);
      
      if (!payload) {
        console.log(`[AuthenticationService] Invalid token signature`);
        return null;
      }
      
      // Check expiration
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp < now) {
        console.log(`[AuthenticationService] Token expired`);
        return null;
      }
      
      // Check if user is still valid (not revoked)
      const isRevoked = await this.directory.isUserRevoked(payload.sub);
      if (isRevoked) {
        console.log(`[AuthenticationService] User revoked: ${payload.sub}`);
        return null;
      }
      
      console.log(`[AuthenticationService] Token valid for user: ${payload.sub}`);
      return payload;
    } catch (error) {
      console.error(`[AuthenticationService] Token validation error:`, error);
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
      console.error(`[AuthenticationService] Signature verification error:`, error);
      return false;
    }
  }

  /**
   * Generate a JWT token.
   * Uses HMAC-SHA256 for signing.
   */
  private async generateToken(username: string): Promise<string> {
    const subtle = this.cryptoAdapter.getSubtle();
    
    const now = Math.floor(Date.now() / 1000);
    const payload: NetworkAuthTokenPayload = {
      sub: username,
      iat: now,
      exp: now + Math.floor(this.tokenExpirationMs / 1000),
      tenantId: this.tenantId,
    };
    
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
      console.error(`[AuthenticationService] Token verification error:`, error);
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
