/**
 * Tier 1 rules enforced by a real server over HTTP (docs/accesscontrol.md §2, §10).
 *
 * The server wraps the tenant's directory (CompositeMindooDirectory, so trusted
 * servers are recognized too). The witness only checks Tier 1 when that wrapper
 * offers `evaluateAccessForSigningKey`; before it was forwarded, every push was
 * accepted whatever the rules said, although the directory itself denied it.
 */
import fs from "fs";
import { Server } from "http";

import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { MindooDBServer } from "../node/server/MindooDBServer";
import type { ServerConfig } from "../node/server/types";

async function startServer(server: MindooDBServer): Promise<{ httpServer: Server; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const httpServer = server.getApp().listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to determine test server port"));
        return;
      }
      resolve({ httpServer, baseUrl: `http://127.0.0.1:${address.port}` });
    });
    httpServer.on("error", reject);
  });
}

describe("server-side Tier 1 enforcement (HTTP)", () => {
  let httpServer: Server;
  let baseUrl: string;
  let dataDir: string;
  let systemAdmin: Awaited<ReturnType<BaseMindooTenantFactory["createUserId"]>>;
  const serverPassword = "server-pass";

  beforeAll(async () => {
    const factory = new BaseMindooTenantFactory(new InMemoryContentAddressedStoreFactory(), new NodeCryptoAdapter());
    dataDir = `/tmp/mindoodb-tier1-server-${Date.now()}`;
    fs.mkdirSync(dataDir, { recursive: true });
    const serverIdentity = await factory.createUserId("CN=tier1-test-server", serverPassword);
    fs.writeFileSync(`${dataDir}/server.identity.json`, JSON.stringify(serverIdentity, null, 2), "utf-8");
    fs.writeFileSync(`${dataDir}/trusted-servers.json`, "[]", "utf-8");
    systemAdmin = await factory.createUserId("cn=tier1-sysadmin/o=test", "sysadmin-pass");
    const config: ServerConfig = {
      capabilities: {
        "ALL:/system/*": [{ username: systemAdmin.username, publicsignkey: systemAdmin.userSigningKeyPair.publicKey as string }],
      },
    };
    ({ httpServer, baseUrl } = await startServer(new MindooDBServer(dataDir, serverPassword, undefined, config)));
  }, 60000);

  afterAll(async () => {
    if (httpServer) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    if (dataDir && fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test("refuses a push that a deny rule forbids, and keeps accepting allowed ones", async () => {
    const factory = new BaseMindooTenantFactory(new InMemoryContentAddressedStoreFactory(), new NodeCryptoAdapter());
    const tenantId = `tier1-${Date.now()}`;
    const adminPassword = "admin-pass";
    const userName = `cn=user1/o=${tenantId}`;
    const result = await factory.createTenant({
      tenantId,
      adminName: `cn=admin/o=${tenantId}`,
      adminPassword,
      userName,
      userPassword: "user-pass",
    });
    await result.tenant.publishToServer(baseUrl, {
      systemAdminUser: systemAdmin,
      systemAdminPassword: "sysadmin-pass",
      adminUsername: result.adminUser.username,
    });
    const directoryDb = await result.tenant.openDB("directory");
    const remoteDirectory = await result.tenant.connectToServer(baseUrl, "directory");
    const pushDirectory = () =>
      directoryDb.pushChangesTo(remoteDirectory, { networkAuthOverride: { user: result.adminUser, password: adminPassword } });
    await pushDirectory();

    const mainDb = await result.tenant.openDB("main");
    const remoteMain = await result.tenant.connectToServer(baseUrl, "main");
    const create = async (title: string) => {
      const doc = await mainDb.createDocument();
      await mainDb.changeDoc(doc, (d) => {
        d.getData().title = title;
      });
      return doc.getId();
    };

    // Before any rule: accepted.
    await create("before the rule");
    const first = await mainDb.pushChangesTo(remoteMain);
    expect(first.rejectedEntries ?? []).toHaveLength(0);

    // Written locally while still allowed (the local precheck would refuse it later),
    // pushed only after the admin denied user1 creating documents in `main`.
    const late = await create("after the rule");
    const directory = await result.tenant.openDirectory();
    const adminKey = result.adminUser.userSigningKeyPair.privateKey;
    // New tenants start with the master switch on (access control disabled).
    await directory.setDefaultAccessPolicy!({ disableAllAccessChecksAndPolicies: false }, adminKey, adminPassword);
    await directory.createAccessRule!(
      { ruleId: "main_no_create_user1", type: "doc_create", dbid: "main", action: "deny", usernames: [userName] },
      adminKey,
      adminPassword,
    );
    await pushDirectory();

    const second = await mainDb.pushChangesTo(remoteMain);
    expect(second.cancelled).toBe(false);
    const rejected = second.rejectedEntries ?? [];
    expect(rejected.length).toBeGreaterThan(0);
    for (const rejection of rejected) {
      expect(rejection.rejectionClass).toBe("policy");
      expect(rejection.reason).toMatch(/main_no_create_user1/);
    }
    // The rule is about creating: the document's create entry stays out. (Its later
    // change entries are judged as doc_change, which no rule denies here.)
    const onServer = await remoteMain.findNewEntries([]);
    expect(onServer.some((entry) => entry.docId === late && entry.entryType === "doc_create")).toBe(false);
  }, 120000);
});
