/**
 * Recovery on a new device (docs/userkeys.md §12.4): act as the rescue device
 * for one session and certify the new device's keys with the person's
 * self-grant key, which the rescue device receives as a wrap like any device.
 *
 * The rescue device runs in throwaway in-memory storage. It authenticates to
 * the server with its own keys (the server knows it from its `dcert_`
 * certificate), pulls `directory` and `userdirectory`, opens the User-Key and
 * self-grant key wrapped to it, writes the new device's certificate plus its
 * wraps and pushes `userdirectory`. From then on the new device is a device
 * of the person in its own right and joins through ordinary device discovery
 * (`discoverTenantsOnServer` + `bootstrapTenantFromDelivery`).
 */
import { BaseMindooTenantFactory } from "../BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStore";
import type { CryptoAdapter } from "../crypto/CryptoAdapter";
import { USER_DIRECTORY_DB_ID, type ContentAddressedStoreFactory } from "../types";
import type { CombinedRecoveryPackages } from "./recoveryPackage";
import { rescueDeviceUserId } from "./rescueDevice";

export class RecoveryError extends Error {
  constructor(
    readonly code: "no-server" | "tenant-not-found" | "not-certified" | "sync-failed",
    message: string,
  ) {
    super(message);
    this.name = "RecoveryError";
  }
}

export interface CertifyDeviceWithRescueDeviceInput {
  cryptoAdapter: CryptoAdapter;
  /** From the combined packages. */
  recovery: CombinedRecoveryPackages;
  /** Overrides `recovery.serverUrl` (the packages may not carry one). */
  serverUrl?: string;
  /** Public keys of the new device. */
  device: { signingPublicKey: string; encryptionPublicKey: string };
  label?: string;
  /** Storage for the throwaway rescue session. Default: in memory. */
  storeFactory?: ContentAddressedStoreFactory;
}

export interface CertifyDeviceWithRescueDeviceResult {
  tenantId: string;
  serverUrl: string;
  username: string;
  certificateDocId: string;
  /** The rescue device that issued it, to withdraw once the new device is set up. */
  rescueSigningKeyFingerprint: string;
}

function randomPassword(crypto: CryptoAdapter): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Certify a new device of the person with the rescue device that the
 * combined helper packages opened.
 */
export async function certifyDeviceWithRescueDevice(
  input: CertifyDeviceWithRescueDeviceInput,
): Promise<CertifyDeviceWithRescueDeviceResult> {
  const serverUrl = (input.serverUrl ?? input.recovery.serverUrl ?? "").trim().replace(/\/$/, "");
  if (!serverUrl) throw new RecoveryError("no-server", "No server address to recover from.");
  const crypto = input.cryptoAdapter;
  const password = randomPassword(crypto);
  const rescueUser = await rescueDeviceUserId(
    crypto,
    input.recovery.rescueDevice,
    input.recovery.username,
    password,
  );
  const factory = new BaseMindooTenantFactory(
    input.storeFactory ?? new InMemoryContentAddressedStoreFactory(),
    crypto,
  );

  let deliveries;
  try {
    deliveries = await factory.discoverTenantsOnServer(serverUrl, { user: rescueUser, password });
  } catch (error) {
    throw new RecoveryError(
      "not-certified",
      `The server does not accept the rescue device (${error instanceof Error ? error.message : String(error)}). It may have been replaced by a newer setup.`,
    );
  }
  const delivery = deliveries.find((d) => d.tenantId === input.recovery.tenantId);
  if (!delivery) {
    throw new RecoveryError(
      "tenant-not-found",
      `The rescue device has no access to tenant "${input.recovery.tenantId}" on ${serverUrl}.`,
    );
  }
  let joined;
  try {
    joined = await factory.bootstrapTenantFromDelivery(delivery, {
      user: rescueUser,
      password,
      serverUrl,
    });
  } catch (error) {
    // A withdrawn rescue device still finds the tenant (discovery keeps naming
    // revoked devices so they can learn about a wipe), but sync refuses it.
    throw new RecoveryError(
      "not-certified",
      `The server does not accept the rescue device (${error instanceof Error ? error.message : String(error)}). It may have been replaced by a newer setup.`,
    );
  }
  const tenant = joined.tenant;
  try {
    if (!tenant.issueDeviceCertificate) {
      throw new RecoveryError("not-certified", "This tenant cannot certify devices.");
    }
    // bootstrap pulled both directories and reconciled; certify now.
    const { docId } = await tenant.issueDeviceCertificate(input.device, input.label);
    const local = await tenant.openDB(USER_DIRECTORY_DB_ID);
    const remote = await tenant.connectToServer(serverUrl, USER_DIRECTORY_DB_ID);
    const pushed = await local.pushChangesTo(remote);
    if (pushed.cancelled) {
      throw new RecoveryError("sync-failed", "Sending the new device certificate to the server was cancelled.");
    }
    return {
      tenantId: input.recovery.tenantId,
      serverUrl,
      username: joined.user.username,
      certificateDocId: docId,
      rescueSigningKeyFingerprint: input.recovery.rescueDevice.signingKeyFingerprint,
    };
  } finally {
    try {
      await (tenant as { close?: () => Promise<void> }).close?.();
    } catch {
      // throwaway session
    }
  }
}
