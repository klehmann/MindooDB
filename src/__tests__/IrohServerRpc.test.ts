import { randomBytes } from "crypto";
import { IrohNetworkTransport, serveIrohRpc } from "../core/appendonlystores/network/IrohNetworkTransport";
import { createLoopbackIrohPair } from "../core/appendonlystores/network/IrohStreamIO";
import { isIrohLocator, parseIrohLocator } from "../core/appendonlystores/network/irohLocator";
import { createMindooDBServerIrohHandler } from "../node/server/IrohServerRpc";
import { validateServerConfig } from "../node/server/config";
import { DEFAULT_SERVER_IROH_CONFIG } from "../node/server/types";
import { StoreKind } from "../core/appendonlystores/types";

describe("Iroh server locator and config", () => {
  test("parses iroh: tickets and raw endpoint tickets", () => {
    const key = randomBytes(32);
    const ticket = `endpoint${encodeBase32(Buffer.concat([key, Buffer.from("more")]))}`;
    expect(isIrohLocator(ticket)).toBe(true);
    expect(isIrohLocator(`iroh:${ticket}`)).toBe(true);
    const parsed = parseIrohLocator(`iroh:${ticket}`);
    expect(parsed.ticket).toBe(ticket);
    expect(parsed.locator).toBe(`iroh:${key.toString("hex")}`);
    expect(parsed.endpointId).toBe(key.toString("hex"));
  });

  test("config.json iroh defaults to disabled and rejects bad shapes", () => {
    expect(DEFAULT_SERVER_IROH_CONFIG).toEqual({
      enabled: false,
      secretKeyPath: "iroh-secret.key",
    });
    const disabled = validateServerConfig({ capabilities: {} }, "config.json");
    expect(disabled.iroh).toBeUndefined();

    const enabled = validateServerConfig(
      { capabilities: {}, iroh: { enabled: true, secretKeyPath: "iroh-secret.key" } },
      "config.json",
    );
    expect(enabled.iroh).toEqual({ enabled: true, secretKeyPath: "iroh-secret.key" });

    expect(() => validateServerConfig({ capabilities: {}, iroh: { enabled: "yes" } }, "config.json")).toThrow(
      /iroh.enabled/,
    );
  });
});

describe("Iroh server RPC", () => {
  test("getServerInfo and challenge reach the host over loopback", async () => {
    const { a, b } = createLoopbackIrohPair();
    const incoming = b.listen!()[Symbol.asyncIterator]().next();
    const handler = createMindooDBServerIrohHandler({
      getServerPublicInfo: () => ({
        name: "cn=home/o=mindoo",
        signingPublicKey: "sign-pem",
        encryptionPublicKey: "enc-pem",
      }),
      getClusterRole: () => "peer",
      listTenantPublicInfosFingerprints: async () => ["fp-1"],
      getAuthService: async () => ({
        generateChallenge: async (username) => `challenge-for-${username ?? "anon"}`,
        authenticate: async () => ({ success: true, token: "jwt" }),
      }),
      getServerStore: async () => {
        throw new Error("store should not be opened for discovery");
      },
    });

    const transport = new IrohNetworkTransport(a, "loopback:b", {
      tenantId: "acme",
      dbId: "db1",
      storeKind: StoreKind.docs,
    });
    const pendingInfo = transport.getServerInfo();
    const { value: stream } = await incoming;
    void serveIrohRpc(stream!, handler);
    await expect(pendingInfo).resolves.toMatchObject({
      name: "cn=home/o=mindoo",
      signingPublicKey: "sign-pem",
      clusterRole: "peer",
    });
    await expect(transport.requestChallenge("alice")).resolves.toBe("challenge-for-alice");
    await expect(transport.getTenantPublicInfosFingerprints("acme")).resolves.toEqual({
      tenantId: "acme",
      fingerprints: ["fp-1"],
    });
  });
});

function encodeBase32(bytes: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits > 0) {
    out += alphabet[(value << (5 - bits)) & 31];
  }
  return out;
}
