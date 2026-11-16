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
import { fingerprintPublicKeyPem } from "../userkeys/fingerprint";

export class RecoveryError extends Error {
  constructor(
    readonly code: "no-server" | "tenant-not-found" | "not-certified" | "sync-failed" | "device-not-on-grant",
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

interface RescueSession {
  tenant: import("../types").MindooTenant;
  serverUrl: string;
  username: string;
}

/** Sign in to the server as the rescue device, in throwaway storage. */
async function openRescueSession(input: {
  cryptoAdapter: CryptoAdapter;
  recovery: CombinedRecoveryPackages;
  serverUrl?: string;
  storeFactory?: ContentAddressedStoreFactory;
}): Promise<RescueSession> {
  const serverUrl = (input.serverUrl ?? input.recovery.serverUrl ?? "").trim().replace(/\/$/, "");
  if (!serverUrl) throw new RecoveryError("no-server", "No server address to recover from.");
  const crypto = input.cryptoAdapter;
  const password = randomPassword(crypto);
  const rescueUser = await rescueDeviceUserId(crypto, input.recovery.rescueDevice, input.recovery.username, password);
  const factory = new BaseMindooTenantFactory(input.storeFactory ?? new InMemoryContentAddressedStoreFactory(), crypto);
  const refused = (error: unknown) =>
    new RecoveryError(
      "not-certified",
      `The server does not accept the rescue device (${error instanceof Error ? error.message : String(error)}). It may have been replaced by a newer setup.`,
    );
  let deliveries;
  try {
    deliveries = await factory.discoverTenantsOnServer(serverUrl, { user: rescueUser, password });
  } catch (error) {
    throw refused(error);
  }
  const delivery = deliveries.find((d) => d.tenantId === input.recovery.tenantId);
  if (!delivery) {
    throw new RecoveryError(
      "tenant-not-found",
      `The rescue device has no access to tenant "${input.recovery.tenantId}" on ${serverUrl}.`,
    );
  }
  try {
    // A withdrawn rescue device still finds the tenant (discovery keeps naming
    // revoked devices so they can learn about a wipe), but sync refuses it.
    const joined = await factory.bootstrapTenantFromDelivery(delivery, { user: rescueUser, password, serverUrl });
    return { tenant: joined.tenant, serverUrl, username: joined.user.username };
  } catch (error) {
    throw refused(error);
  }
}

async function pushUserDirectory(session: RescueSession, what: string): Promise<void> {
  const local = await session.tenant.openDB(USER_DIRECTORY_DB_ID);
  const remote = await session.tenant.connectToServer(session.serverUrl, USER_DIRECTORY_DB_ID);
  const pushed = await local.pushChangesTo(remote);
  if (pushed.cancelled) throw new RecoveryError("sync-failed", `Sending ${what} to the server was cancelled.`);
}

async function closeSession(session: RescueSession): Promise<void> {
  try {
    await (session.tenant as { close?: () => Promise<void> }).close?.();
  } catch {
    // throwaway session
  }
}

/**
 * Certify a new device of the person with the rescue device that the
 * combined helper packages opened.
 */
export async function certifyDeviceWithRescueDevice(
  input: CertifyDeviceWithRescueDeviceInput,
): Promise<CertifyDeviceWithRescueDeviceResult> {
  const session = await openRescueSession(input);
  try {
    if (!session.tenant.issueDeviceCertificate) {
      throw new RecoveryError("not-certified", "This tenant cannot certify devices.");
    }
    // bootstrap pulled both directories and reconciled; certify now.
    const { docId } = await session.tenant.issueDeviceCertificate(input.device, input.label);
    await pushUserDirectory(session, "the new device certificate");
    return {
      tenantId: input.recovery.tenantId,
      serverUrl: session.serverUrl,
      username: session.username,
      certificateDocId: docId,
      rescueSigningKeyFingerprint: input.recovery.rescueDevice.signingKeyFingerprint,
    };
  } finally {
    await closeSession(session);
  }
}

/**
 * Recovery with an admin-approved rescue device (docs/userkeys.md §12.9): the
 * new device has joined with a normal join request and the administrator put
 * it on the person's grant. The rescue device, which holds the User-Key, now
 * wraps it to the new device. Fails with `device-not-on-grant` while the
 * administrator has not approved the new device yet — call again later.
 */
export async function approveDeviceWithRescueDevice(input: {
  cryptoAdapter: CryptoAdapter;
  recovery: CombinedRecoveryPackages;
  serverUrl?: string;
  /** Encryption public key of the new device. */
  deviceEncryptionPublicKey: string;
  storeFactory?: ContentAddressedStoreFactory;
}): Promise<{ tenantId: string; serverUrl: string; username: string; rescueSigningKeyFingerprint: string }> {
  const session = await openRescueSession(input);
  try {
    const crypto = input.cryptoAdapter;
    const fingerprint = await fingerprintPublicKeyPem(input.deviceEncryptionPublicKey, crypto.getSubtle());
    const rows = (await session.tenant.listUserKeyDevices?.()) ?? [];
    const row = rows.find((r) => r.fingerprint === fingerprint);
    if (!row) {
      throw new RecoveryError(
        "device-not-on-grant",
        "The administrator has not added this device to the person yet.",
      );
    }
    if (row.status !== "approved") {
      await session.tenant.approveUserKeyDevice!(fingerprint);
      await pushUserDirectory(session, "the User-Key for the new device");
    }
    return {
      tenantId: input.recovery.tenantId,
      serverUrl: session.serverUrl,
      username: session.username,
      rescueSigningKeyFingerprint: input.recovery.rescueDevice.signingKeyFingerprint,
    };
  } finally {
    await closeSession(session);
  }
}
