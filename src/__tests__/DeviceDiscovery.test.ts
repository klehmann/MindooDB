/**
 * Device discovery: challenge / discover without a tenant id in the path.
 */
import { describe, expect, test } from "@jest/globals";
import { DeviceDiscoveryAuthError, DeviceDiscoveryService } from "../node/server/DeviceDiscoveryService";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { decryptPrivateKey } from "../core/crypto/privateKeyEncryption";
import { isValidTenantId } from "../core/tenantIdValidation";

function arrayBufferToPem(buffer: ArrayBuffer, label: string): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  const b64 = btoa(binary);
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}

describe("DeviceDiscoveryService", () => {
  test("device is reserved so it cannot collide with /device routes", () => {
    expect(isValidTenantId("device")).toBe(false);
  });

  test("returns empty tenants when the signing key has no grant", async () => {
    const cryptoAdapter = new NodeCryptoAdapter();
    const factory = new BaseMindooTenantFactory(
      new InMemoryContentAddressedStoreFactory(),
      cryptoAdapter,
    );
    const user = await factory.createUserId("cn=bob/o=discover", "bob-pass-123");
    const subtle = cryptoAdapter.getSubtle();
    const signingPrivate = await decryptPrivateKey(
      cryptoAdapter,
      user.userSigningKeyPair.privateKey,
      "bob-pass-123",
      "signing",
    );
    const signingKey = await subtle.importKey(
      "pkcs8",
      signingPrivate,
      { name: "Ed25519" },
      false,
      ["sign"],
    );

    const tenantManager = {
      listTenants: () => [] as string[],
      getTenant: async () => {
        throw new Error("unexpected getTenant");
      },
      getPublicInfosKeysForTenant: async () => [] as Uint8Array[],
    };

    const service = new DeviceDiscoveryService(tenantManager as never, cryptoAdapter);
    const challenge = service.createChallenge(user.userSigningKeyPair.publicKey);
    const sigBuf = await subtle.sign(
      "Ed25519",
      signingKey,
      new TextEncoder().encode(challenge),
    );
    const result = await service.discover(challenge, new Uint8Array(sigBuf));
    expect(result.tenants).toEqual([]);

    await expect(service.discover(challenge, new Uint8Array(sigBuf))).rejects.toBeInstanceOf(
      DeviceDiscoveryAuthError,
    );
  }, 60000);

  test("rejects invalid signatures", async () => {
    const cryptoAdapter = new NodeCryptoAdapter();
    const subtle = cryptoAdapter.getSubtle();
    const keyPair = (await subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const pubPem = arrayBufferToPem(await subtle.exportKey("spki", keyPair.publicKey), "PUBLIC KEY");

    const service = new DeviceDiscoveryService(
      {
        listTenants: () => [],
        getTenant: async () => {
          throw new Error("unused");
        },
        getPublicInfosKeysForTenant: async () => [],
      } as never,
      cryptoAdapter,
    );
    const challenge = service.createChallenge(pubPem);
    await expect(service.discover(challenge, new Uint8Array(16))).rejects.toBeInstanceOf(
      DeviceDiscoveryAuthError,
    );
  });
});
