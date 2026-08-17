import type { RSAEncryption } from "../crypto/RSAEncryption";

/**
 * Discovery-usable slice of a join response: the registered username (plus the
 * optional tenant label and admin name) RSA-hybrid-encrypted to one granted
 * device.
 *
 * Stored on that device's `userKeyPairs[]` entry in the `$publicinfos` grant
 * so the server can forward the ciphertext during device discovery without
 * ever seeing the cleartext name.
 */
export interface DeviceJoinBootstrap {
  username: string;
  tenantLabel?: string;
  /**
   * Display name of the approving admin. The admin holds no grantaccess
   * document, so a device that joins through discovery has no other way to
   * learn the name and would have to show a key fingerprint instead.
   */
  adminUsername?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function wrapDeviceJoinBootstrap(
  rsa: RSAEncryption,
  payload: DeviceJoinBootstrap,
  encryptionPublicKey: string,
): Promise<string> {
  const username = payload.username.trim();
  if (!username) {
    throw new Error("Cannot wrap device join bootstrap: username is required");
  }
  const body: DeviceJoinBootstrap = { username };
  const tenantLabel = typeof payload.tenantLabel === "string" ? payload.tenantLabel.trim() : "";
  if (tenantLabel) body.tenantLabel = tenantLabel;
  const adminUsername =
    typeof payload.adminUsername === "string" ? payload.adminUsername.trim() : "";
  if (adminUsername) body.adminUsername = adminUsername;
  return rsa.encryptToBase64(new TextEncoder().encode(JSON.stringify(body)), encryptionPublicKey);
}

export async function unwrapDeviceJoinBootstrap(
  rsa: RSAEncryption,
  wrapped: string,
  encryptionPrivateKey: CryptoKey | string,
): Promise<DeviceJoinBootstrap> {
  const bytes = await rsa.decryptFromBase64(wrapped, encryptionPrivateKey);
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  const username = isNonEmptyString(parsed.username) ? parsed.username.trim() : "";
  if (!username) {
    throw new Error("Device join bootstrap is missing username");
  }
  const tenantLabel = isNonEmptyString(parsed.tenantLabel) ? parsed.tenantLabel.trim() : "";
  const adminUsername = isNonEmptyString(parsed.adminUsername) ? parsed.adminUsername.trim() : "";
  return {
    username,
    ...(tenantLabel ? { tenantLabel } : {}),
    ...(adminUsername ? { adminUsername } : {}),
  };
}
