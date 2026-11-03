/**
 * Capability rules for `/system/cluster/*` match the full request path.
 *
 * The cluster router is mounted below `/system`, and its guard used to see
 * only the path below that mount: `GET /system/cluster/status` was checked as
 * `/system/status`. A read-only auditor rule `GET:/system/cluster/*`
 * (README-server.md) then never matched, while an unrelated rule such as
 * `GET:/system/status` would have granted the cluster status.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { Server } from "http";

import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { MindooDBServerAdmin } from "../core/MindooDBServerAdmin";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { MindooDBServer } from "../node/server/MindooDBServer";
import type { PrivateUserId } from "../core/types";
import type { ServerConfig } from "../server/types";

const PASSWORD = "cluster-caps-pass";

describe("cluster capability paths", () => {
  jest.setTimeout(60_000);

  const crypto = new NodeCryptoAdapter();
  let dataDir: string;
  let httpServer: Server;
  let baseUrl: string;
  let auditor: PrivateUserId;
  let statusOnly: PrivateUserId;

  const adminClient = (user: PrivateUserId) =>
    new MindooDBServerAdmin({
      serverUrl: baseUrl,
      systemAdminUser: user,
      systemAdminPassword: PASSWORD,
      cryptoAdapter: crypto,
    });

  beforeAll(async () => {
    const factory = new BaseMindooTenantFactory(new InMemoryContentAddressedStoreFactory(), crypto);
    const serverIdentity = await factory.createUserId("CN=cluster-caps", PASSWORD);
    auditor = await factory.createUserId("cn=auditor/o=caps", PASSWORD);
    statusOnly = await factory.createUserId("cn=status-only/o=caps", PASSWORD);

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mindoodb-cluster-caps-"));
    fs.writeFileSync(path.join(dataDir, "server.identity.json"), JSON.stringify(serverIdentity));
    const principal = (user: PrivateUserId) => ({
      username: user.username,
      publicsignkey: user.userSigningKeyPair.publicKey as string,
    });
    const config: ServerConfig = {
      capabilities: {
        "GET:/system/cluster/*": [principal(auditor)],
        "GET:/system/status": [principal(statusOnly)],
      },
    };
    const server = new MindooDBServer(dataDir, PASSWORD, undefined, config);
    await new Promise<void>((resolve) => {
      httpServer = server.getApp().listen(0, "127.0.0.1", () => {
        const address = httpServer.address();
        baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test("GET:/system/cluster/* lets an auditor read but not act", async () => {
    const client = adminClient(auditor);
    await expect(client.getClusterStatus()).resolves.toEqual(expect.objectContaining({ peers: [] }));
    await expect(client.getClusterTopology()).resolves.toBeTruthy();
    await expect(client.runClusterAction("sync", {})).rejects.toThrow(/HTTP 403/);
    await expect(client.deleteClusterPeer("nobody")).rejects.toThrow(/HTTP 403/);
  });

  test("a rule on /system/status does not open the cluster status", async () => {
    await expect(adminClient(statusOnly).getClusterStatus()).rejects.toThrow(/HTTP 403/);
  });
});
