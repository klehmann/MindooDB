/**
 * Server-wide device discovery: prove possession of a device signing key,
 * then scan all tenants for an active grant and deliver RSA-wrapped
 * `$publicinfos` plus admin public keys — no join-response URI required.
 */

import { v7 as uuidv7 } from "uuid";
import type { CryptoAdapter } from "../../core/crypto/CryptoAdapter";
import { RSAEncryption } from "../../core/crypto/RSAEncryption";
import type { TenantManager } from "./TenantManager";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGES = 10_000;

interface DeviceChallenge {
  challenge: string;
  signingPublicKey: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

/** One tenant the device may bootstrap into. */
export interface DeviceTenantDelivery {
  tenantId: string;
  adminSigningPublicKey: string;
  adminEncryptionPublicKey: string;
  /** AES `$publicinfos` wrapped to the grant device encryption public key (base64). */
  wrappedPublicInfosKey: string;
  /** All `$publicinfos` versions, oldest first. `wrappedPublicInfosKey` is the newest. */
  wrappedPublicInfosKeys?: string[];
  /** Optional `$publicinfos`-readable hashes from the grant (saves a client scan). */
  username_hash?: string;
  identity_hashes?: string[];
}

export interface DeviceDiscoverResult {
  tenants: DeviceTenantDelivery[];
}

export class DeviceDiscoveryAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceDiscoveryAuthError";
  }
}

export class DeviceDiscoveryService {
  private challenges = new Map<string, DeviceChallenge>();

  constructor(
    private readonly tenantManager: TenantManager,
    private readonly cryptoAdapter: CryptoAdapter,
  ) {}

  /**
   * Issue a short-lived, single-use challenge bound to `signingPublicKey`.
   * Does not require the key to be on any tenant yet (discovery finds that).
   */
  createChallenge(signingPublicKey: string): string {
    const trimmed = signingPublicKey.trim();
    if (!trimmed) {
      throw new Error("signingPublicKey is required");
    }
    const challenge = uuidv7();
    const now = Date.now();
    this.challenges.set(challenge, {
      challenge,
      signingPublicKey: trimmed,
      createdAt: now,
      expiresAt: now + CHALLENGE_TTL_MS,
      used: false,
    });
    this.cleanup();
    return challenge;
  }

  /**
   * Verify the Ed25519 signature over the challenge, then scan every local
   * tenant for an active grant containing this signing key. Matching tenants
   * receive a delivery with RSA-wrapped `$publicinfos` (parallelized).
   */
  async discover(challenge: string, signature: Uint8Array): Promise<DeviceDiscoverResult> {
    const authChallenge = this.challenges.get(challenge);
    if (!authChallenge) {
      throw new DeviceDiscoveryAuthError("Challenge not found or expired");
    }
    if (Date.now() > authChallenge.expiresAt) {
      this.challenges.delete(challenge);
      throw new DeviceDiscoveryAuthError("Challenge expired");
    }
    if (authChallenge.used) {
      throw new DeviceDiscoveryAuthError("Challenge already used");
    }
    authChallenge.used = true;

    const ok = await this.verifySignature(
      challenge,
      signature,
      authChallenge.signingPublicKey,
    );
    if (!ok) {
      throw new DeviceDiscoveryAuthError("Invalid signature");
    }

    const signingPublicKey = authChallenge.signingPublicKey;
    const tenantIds = this.tenantManager.listTenants();

    type Match = {
      tenantId: string;
      adminSigningPublicKey: string;
      adminEncryptionPublicKey: string;
      encryptionPublicKey: string;
      username_hash?: string;
      identity_hashes?: string[];
    };
    const matches: Match[] = [];

    for (const tenantId of tenantIds) {
      try {
        const loaded = await this.tenantManager.getTenant(tenantId);
        const lookup = await loaded.directory.getUserBySigningPublicKey(signingPublicKey);
        if (!lookup?.encryptionPublicKey) continue;

        matches.push({
          tenantId,
          adminSigningPublicKey: loaded.context.config.adminSigningPublicKey,
          adminEncryptionPublicKey: loaded.context.config.adminEncryptionPublicKey,
          encryptionPublicKey: lookup.encryptionPublicKey,
          username_hash:
            typeof lookup.username === "string" && /^[a-f0-9]{64}$/i.test(lookup.username)
              ? lookup.username
              : undefined,
          identity_hashes: lookup.identityHashes,
        });
      } catch {
        // Tenant missing directory / not loadable — skip.
      }
    }

    if (matches.length === 0) {
      return { tenants: [] };
    }

    const rsa = new RSAEncryption(this.cryptoAdapter);
    const deliveries = await Promise.all(
      matches.map(async (match): Promise<DeviceTenantDelivery | null> => {
        try {
          const keys = await this.tenantManager.getPublicInfosKeysForTenant(match.tenantId);
          if (!keys.length) return null;
          const wrappedPublicInfosKeys = await Promise.all(
            keys.map((rawKey) => rsa.wrapKeyToBase64(rawKey, match.encryptionPublicKey)),
          );
          // getAllKeys is newest-first; keep wrappedPublicInfosKey as the current generation.
          const wrappedPublicInfosKey = wrappedPublicInfosKeys[0]!;
          console.log(
            `[DeviceDiscovery] Wrapped ${wrappedPublicInfosKeys.length} $publicinfos version(s) for tenant ${match.tenantId}`,
          );
          return {
            tenantId: match.tenantId,
            adminSigningPublicKey: match.adminSigningPublicKey,
            adminEncryptionPublicKey: match.adminEncryptionPublicKey,
            wrappedPublicInfosKey,
            ...(wrappedPublicInfosKeys.length > 1
              ? { wrappedPublicInfosKeys }
              : {}),
            ...(match.username_hash ? { username_hash: match.username_hash } : {}),
            ...(match.identity_hashes?.length
              ? { identity_hashes: match.identity_hashes }
              : {}),
          };
        } catch {
          return null;
        }
      }),
    );

    return { tenants: deliveries.filter((d): d is DeviceTenantDelivery => d !== null) };
  }

  private async verifySignature(
    challenge: string,
    signature: Uint8Array,
    publicKeyPem: string,
  ): Promise<boolean> {
    try {
      const subtle = this.cryptoAdapter.getSubtle();
      const pemContents = publicKeyPem
        .replace(/-----BEGIN PUBLIC KEY-----/g, "")
        .replace(/-----END PUBLIC KEY-----/g, "")
        .replace(/\s/g, "");
      const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
      const key = await subtle.importKey(
        "spki",
        binaryDer.buffer as ArrayBuffer,
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      const data = new TextEncoder().encode(challenge);
      return await subtle.verify(
        "Ed25519",
        key,
        signature.buffer.slice(
          signature.byteOffset,
          signature.byteOffset + signature.byteLength,
        ) as ArrayBuffer,
        data.buffer as ArrayBuffer,
      );
    } catch {
      return false;
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, entry] of this.challenges) {
      if (entry.used || entry.expiresAt <= now) {
        this.challenges.delete(id);
      }
    }
    while (this.challenges.size > MAX_CHALLENGES) {
      const oldest = this.challenges.keys().next().value;
      if (oldest === undefined) break;
      this.challenges.delete(oldest);
    }
  }
}
