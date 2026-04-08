import fs from "fs";
import os from "os";
import path from "path";
import { Server } from "http";

import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { MindooDBServer } from "../node/server/MindooDBServer";

describe("MindooDBServer", () => {
  let server: MindooDBServer;
  let httpServer: Server;
  let baseUrl: string;
  let testDataDir: string;

  beforeAll(async () => {
    const cryptoAdapter = new NodeCryptoAdapter();
    const factory = new BaseMindooTenantFactory(
      new InMemoryContentAddressedStoreFactory(),
      cryptoAdapter,
    );
    testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mindoodb-server-test-"));
    const serverIdentity = await factory.createUserId("CN=mindoodb-test-server", "test-password");
    fs.writeFileSync(
      path.join(testDataDir, "server.identity.json"),
      JSON.stringify(serverIdentity, null, 2),
      "utf-8",
    );

    server = new MindooDBServer(testDataDir, "test-password");
    await new Promise<void>((resolve) => {
      httpServer = server.getApp().listen(0, () => {
        const address = httpServer.address();
        if (!address || typeof address === "string") {
          throw new Error("Failed to determine test server port");
        }
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  }, 30000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    fs.rmSync(testDataDir, { recursive: true, force: true });
  });

  test("returns 413 for oversized json request bodies", async () => {
    const response = await fetch(`${baseUrl}/health`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        payload: "x".repeat(6 * 1024 * 1024),
      }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Request body too large",
    });
  });

  test("exposes the configured json body limit in the well-known server info", async () => {
    const response = await fetch(`${baseUrl}/.well-known/mindoodb-server-info`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      name: "CN=mindoodb-test-server",
      signingPublicKey: expect.stringContaining("-----BEGIN PUBLIC KEY-----"),
      encryptionPublicKey: expect.stringContaining("-----BEGIN PUBLIC KEY-----"),
      maxJsonRequestBodyLimit: "5mb",
      maxJsonRequestBodyBytes: 5 * 1024 * 1024,
    });
  });
});
