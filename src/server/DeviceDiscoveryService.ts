/**
 * Server-wide device discovery: prove possession of a device signing key,
 * then scan all tenants for an active grant and deliver RSA-wrapped
 * `$publicinfos` plus admin public keys and the per-device join bootstrap —
 * no join-response URI required.
 */

import { issueAuthChallenge, verifyAuthChallengeSignature } from "../core/crypto/AuthChallenge";
import type { CryptoAdapter } from "../core/crypto/CryptoAdapter";
import { RSAEncryption } from "../core/crypto/RSAEncryption";
import type { DeviceTenantDelivery } from "../core/types";
import type { TenantManager } from "./TenantManager";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGES = 10_000;
/**
 * Budget per tenant for "is this signing key granted here?". One tenant whose
 * directory hangs or rebuilds slowly must not hold the whole request: behind
 * a proxy (Cloudflare gives up after 100–120 s) the device would only see a
 * 5xx page and never learn about the tenants that did answer.
 */
const DEFAULT_TENANT_LOOKUP_TIMEOUT_MS = 10_000;
const DEFAULT_TENANT_LOOKUP_CONCURRENCY = 4;
/** Lookups slower than this are logged with the tenant id, to find the culprit. */
const SLOW_TENANT_LOOKUP_MS = 2_000;

export interface DeviceDiscoveryOptions {
  tenantLookupTimeoutMs?: number;
  tenantLookupConcurrency?: number;
}

class TenantLookupTimeout extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TenantLookupTimeout(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface DeviceChallenge {
  challenge: string;
  signingPublicKey: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

export type { DeviceTenantDelivery };

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

  private readonly tenantLookupTimeoutMs: number;
  private readonly tenantLookupConcurrency: number;

  constructor(
    private readonly tenantManager: TenantManager,
    private readonly cryptoAdapter: CryptoAdapter,
    options: DeviceDiscoveryOptions = {},
  ) {
    this.tenantLookupTimeoutMs = options.tenantLookupTimeoutMs ?? DEFAULT_TENANT_LOOKUP_TIMEOUT_MS;
    this.tenantLookupConcurrency = Math.max(
      1,
      options.tenantLookupConcurrency ?? DEFAULT_TENANT_LOOKUP_CONCURRENCY,
    );
  }

  /**
   * Issue a short-lived, single-use challenge bound to `signingPublicKey`.
   * Does not require the key to be on any tenant yet (discovery finds that).
   */
  createChallenge(signingPublicKey: string): string {
    const trimmed = signingPublicKey.trim();
    if (!trimmed) {
      throw new Error("signingPublicKey is required");
    }
    const challenge = issueAuthChallenge();
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
      joinResponseWrapped?: string;
    };
    const matches: Match[] = [];

    const lookupTenant = async (tenantId: string): Promise<Match | null> => {
      const loaded = await this.tenantManager.getTenant(tenantId);
      const lookup = await loaded.directory.getUserBySigningPublicKey(signingPublicKey);
      if (!lookup?.encryptionPublicKey) return null;
      return {
        tenantId,
        adminSigningPublicKey: loaded.context.config.adminSigningPublicKey,
        adminEncryptionPublicKey: loaded.context.config.adminEncryptionPublicKey,
        encryptionPublicKey: lookup.encryptionPublicKey,
        username_hash:
          typeof lookup.username === "string" && /^[a-f0-9]{64}$/i.test(lookup.username)
            ? lookup.username
            : undefined,
        identity_hashes: lookup.identityHashes,
        joinResponseWrapped:
          typeof lookup.joinResponseWrapped === "string" && lookup.joinResponseWrapped.trim()
            ? lookup.joinResponseWrapped.trim()
            : undefined,
      };
    };

    // Tenants are checked a few at a time, each within its own time budget.
    // A lookup that times out keeps running in the background (it cannot be
    // cancelled) but no longer delays the answer.
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < tenantIds.length) {
        const tenantId = tenantIds[next++]!;
        const started = Date.now();
        try {
          const match = await withTimeout(lookupTenant(tenantId), this.tenantLookupTimeoutMs);
          if (match) matches.push(match);
          const elapsed = Date.now() - started;
          if (elapsed >= SLOW_TENANT_LOOKUP_MS) {
            console.warn(`[DeviceDiscovery] tenant ${tenantId}: lookup took ${elapsed} ms`);
          }
        } catch (error) {
          if (error instanceof TenantLookupTimeout) {
            console.warn(
              `[DeviceDiscovery] tenant ${tenantId}: skipped, ${error.message} (directory lookup still running)`,
            );
          }
          // Otherwise: tenant missing directory / not loadable — skip.
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.tenantLookupConcurrency, tenantIds.length) }, worker),
    );

    // Workers finish in any order; answer in the server's tenant order.
    matches.sort((a, b) => tenantIds.indexOf(a.tenantId) - tenantIds.indexOf(b.tenantId));

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
            ...(match.joinResponseWrapped
              ? { wrappedJoinResponse: match.joinResponseWrapped }
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
      return await verifyAuthChallengeSignature(subtle, key, challenge, signature, {
        use: "device-discovery",
      });
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
