/**
 * Team mailbox and team calendar on a real server over HTTP
 * (docs/accesscontrol.md §6.11, "Team databases"). The admin makes the group
 * "support" (Jane, Bob) a team mailbox; Jane seals the team's key document to
 * Bob and creates a deposit key. The server lets the members sync, the gateway
 * and other members only deposit; when the admin takes Bob out of the group,
 * the server refuses him at once and his replica is dropped.
 */
import fs from "fs";
import { Server } from "http";

import { IsolatedInMemoryStoreFactory } from "./_helpers/multiDevice";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { MindooDBServer } from "../node/server/MindooDBServer";
import {
  PUBLIC_INFOS_KEY_ID,
  StoreKind,
  USER_DIRECTORY_DB_ID,
  type MindooTenant,
  type MindooTenantDirectory,
  type PrivateUserId,
} from "../core/types";
import type { ServerConfig } from "../server/types";

const PASSWORD = "member-pass";
const SYSTEM_ADMIN_PASSWORD = "sysadmin-pass";
const SERVER_PASSWORD = "server-matrix-pass";
const DENIED = /denied|ACCESS_DENIED|deposit sealed documents only|not allowed/i;
type Actor = "jane" | "bob" | "carol" | "eve" | "gateway";

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

describe("team mailbox on a real server (HTTP)", () => {
  jest.setTimeout(600000);
  const crypto = new NodeCryptoAdapter();
  let httpServer: Server;
  let baseUrl: string;
  let dataDir: string;
  let systemAdmin: PrivateUserId;

  beforeEach(async () => {
    const factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    dataDir = `/tmp/mindoodb-team-http-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    fs.mkdirSync(dataDir, { recursive: true });
    const serverIdentity = await factory.createUserId("CN=matrix-server", SERVER_PASSWORD);
    fs.writeFileSync(`${dataDir}/server.identity.json`, JSON.stringify(serverIdentity, null, 2), "utf-8");
    fs.writeFileSync(`${dataDir}/trusted-servers.json`, "[]", "utf-8");
    systemAdmin = await factory.createUserId("cn=sysadmin/o=matrix", SYSTEM_ADMIN_PASSWORD);
    const config: ServerConfig = {
      capabilities: {
        "ALL:/system/*": [{ username: systemAdmin.username, publicsignkey: systemAdmin.userSigningKeyPair.publicKey as string }],
      },
    };
    ({ httpServer, baseUrl } = await startServer(new MindooDBServer(dataDir, SERVER_PASSWORD, undefined, config)));
  }, 60000);

  afterEach(async () => {
    if (httpServer) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    if (dataDir && fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const openDb = (tenant: MindooTenant, dbId: string) =>
    tenant.openDB(dbId, dbId === "directory" ? { adminOnlyDb: true } : undefined);

  async function pull(tenant: MindooTenant, dbId: string) {
    const local = await openDb(tenant, dbId);
    await local.pullChangesFrom(await tenant.connectToServer(baseUrl, dbId, StoreKind.docs));
    await local.syncStoreChanges();
    return local;
  }

  async function push(tenant: MindooTenant, dbId: string, auth?: { user: PrivateUserId; password: string }) {
    const local = await openDb(tenant, dbId);
    return local.pushChangesTo(await tenant.connectToServer(baseUrl, dbId, StoreKind.docs), auth ? { networkAuthOverride: auth } : undefined);
  }

  /** Jane, Bob, Carol and Eve as full members, the gateway with $publicinfos and deposit rights. */
  async function setup() {
    const tenantId = `matrix-${Date.now().toString(16)}${Math.random().toString(16).slice(2, 6)}`;
    const founderFactory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    const admin = await founderFactory.createUserId(`cn=admin/o=${tenantId}`, PASSWORD);
    const janeUser = await founderFactory.createUserId(`cn=jane/o=${tenantId}`, PASSWORD);
    await founderFactory.ensureUserKeyPair(janeUser, PASSWORD);
    const { tenant: jane } = await founderFactory.createTenant({
      tenantId,
      adminUser: admin,
      adminPassword: PASSWORD,
      appUser: janeUser,
      userPassword: PASSWORD,
    });
    jane.noteUserDirectoryFetched!();
    await jane.reconcileUserKeys!({ allowSelfCreate: true });
    await jane.publishToServer(baseUrl, {
      systemAdminUser: systemAdmin,
      systemAdminPassword: SYSTEM_ADMIN_PASSWORD,
      adminUsername: admin.username,
      adminSigningKey: admin.userSigningKeyPair.privateKey,
      adminPassword: PASSWORD,
    });
    const adminAuth = { user: admin, password: PASSWORD };
    const pushDirectory = async () => {
      await push(jane, "directory", adminAuth);
      await push(jane, USER_DIRECTORY_DB_ID);
    };
    await pushDirectory();

    async function join(name: string, options: { publicInfosOnly?: boolean; depositPrefixes?: string[] } = {}) {
      const factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
      const user = await factory.createUserId(`cn=${name}/o=${tenantId}`, PASSWORD);
      await factory.ensureUserKeyPair(user, PASSWORD);
      await jane.approveJoinRequest(factory.createJoinRequest(user, { label: name }), {
        adminSigningKey: admin.userSigningKeyPair.privateKey,
        adminPassword: PASSWORD,
        adminUsername: admin.username,
        label: name,
        username: user.username,
        serverUrl: baseUrl,
        ...(options.publicInfosOnly ? { sharedDocKeyIds: [PUBLIC_INFOS_KEY_ID] } : {}),
        ...(options.depositPrefixes ? { depositPrefixes: options.depositPrefixes } : {}),
      });
      await pushDirectory();
      const delivery = (await factory.discoverTenantsOnServer(baseUrl, { user, password: PASSWORD })).find((d) => d.tenantId === tenantId)!;
      const tenant = (await factory.bootstrapTenantFromDelivery(delivery, { user, password: PASSWORD, serverUrl: baseUrl })).tenant;
      await pull(tenant, "directory");
      await pull(tenant, USER_DIRECTORY_DB_ID);
      tenant.noteUserDirectoryFetched!();
      await tenant.reconcileUserKeys!({ allowSelfCreate: false });
      await push(tenant, USER_DIRECTORY_DB_ID);
      return { tenant, username: user.username };
    }

    const bob = await join("bob");
    const carol = await join("carol");
    const eve = await join("eve");
    const gateway = await join("mail-gateway", { publicInfosOnly: true, depositPrefixes: ["tmail_", "tcal_"] });
    for (const t of [jane, bob.tenant, carol.tenant, eve.tenant, gateway.tenant]) {
      await pull(t, "directory");
      await pull(t, USER_DIRECTORY_DB_ID);
    }
    const directory = (await jane.openDirectory()) as MindooTenantDirectory;
    const grantOf = async (username: string) => (await directory.findGrantAccessDocuments!(username)).find((d) => !d.isDeleted())!.getId();
    const janeGrant = await grantOf(janeUser.username);
    const tenants: Record<Actor, MindooTenant> = { jane, bob: bob.tenant, carol: carol.tenant, eve: eve.tenant, gateway: gateway.tenant };
    const usernames: Record<Actor, string> = {
      jane: janeUser.username,
      bob: bob.username,
      carol: carol.username,
      eve: eve.username,
      gateway: gateway.username,
    };
    const grants = {} as Record<Actor, string>;
    for (const actor of Object.keys(usernames) as Actor[]) grants[actor] = await grantOf(usernames[actor]);
    return { tenantId, tenants, usernames, grants, janeGrant, admin, pushDirectory };
  }

  async function texts(tenant: MindooTenant, dbId: string): Promise<string[]> {
    const db = await openDb(tenant, dbId);
    await db.syncStoreChanges();
    const out: string[] = [];
    for (const id of await db.getAllDocumentIds()) {
      try {
        const text = (await db.getDocument(id)).getData().text;
        if (typeof text === "string") out.push(text);
      } catch {
        // not readable
      }
    }
    return out.sort();
  }

  it("members sync, others deposit, removal from the group ends access at once", async () => {
    const t = await setup();
    const mailboxId = "support0001";
    const dbId = `tmail_${mailboxId}`;
    const adminDir = (await t.tenants.jane.openDirectory()) as MindooTenantDirectory;
    const adminKey = t.admin.userSigningKeyPair.privateKey;
    await adminDir.addUsersToGroup("support", [t.usernames.jane, t.usernames.bob], adminKey, PASSWORD);
    await adminDir.setGroupTeamMailboxId!("support", mailboxId, adminKey, PASSWORD);
    await t.pushDirectory();
    for (const actor of ["bob", "carol", "eve", "gateway"] as Actor[]) await pull(t.tenants[actor], "directory");

    // Jane sets up the team's key document and a deposit key, Bob reads.
    const janeDb = await openDb(t.tenants.jane, dbId);
    const group = await janeDb.createDocument({ recipients: [t.usernames.bob], initialValues: { name: "support" } });
    const depositKey = await janeDb.createDepositKey!(group.getId());
    await janeDb.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "welcome" } });
    expect((await push(t.tenants.jane, dbId)).rejectedEntries ?? []).toEqual([]);
    await pull(t.tenants.bob, dbId);
    expect(await texts(t.tenants.bob, dbId)).toEqual(["welcome"]);
    const bobDb = await openDb(t.tenants.bob, dbId);
    await bobDb.createDocument({ groupKeyDocId: group.getId(), initialValues: { text: "bob writes" } });
    expect((await push(t.tenants.bob, dbId)).rejectedEntries ?? []).toEqual([]);

    // Carol is no member: no sync.
    await expect(pull(t.tenants.carol, dbId)).rejects.toThrow(DENIED);

    // The gateway delivers, sealed to the deposit key; members read it.
    const gatewayDb = await openDb(t.tenants.gateway, dbId);
    await gatewayDb.createDocument({
      idPrefix: "memo",
      recipients: [{ devicePem: depositKey.publicKeyPem, label: "deposit" }],
      recipientOptions: { includeSelf: false },
      initialValues: { text: "from outside" },
    });
    expect((await push(t.tenants.gateway, dbId)).rejectedEntries ?? []).toEqual([]);
    await expect(pull(t.tenants.gateway, dbId)).rejects.toThrow(DENIED);

    // Carol sends internal mail to the team: a deposit too.
    const carolDb = await openDb(t.tenants.carol, dbId);
    await carolDb.createDocument({
      idPrefix: "memo",
      recipients: [{ devicePem: depositKey.publicKeyPem, label: "deposit" }],
      recipientOptions: { includeSelf: false },
      initialValues: { text: "from carol" },
    });
    expect((await push(t.tenants.carol, dbId)).rejectedEntries ?? []).toEqual([]);
    // Anything but a message is refused for a depositor.
    await carolDb.createDocument({
      id: "event_sneaky",
      assumeUniqueId: true,
      recipients: [{ devicePem: depositKey.publicKeyPem, label: "deposit" }],
      recipientOptions: { includeSelf: false },
      initialValues: { text: "sneaky" },
    });
    const sneaky = await push(t.tenants.carol, dbId).catch((error: unknown) => ({ error }));
    expect("error" in sneaky || (sneaky.rejectedEntries ?? []).length > 0).toBe(true);

    await pull(t.tenants.bob, dbId);
    expect(await texts(t.tenants.bob, dbId)).toEqual(["bob writes", "from carol", "from outside", "welcome"]);
    await pull(t.tenants.jane, dbId);
    expect(await texts(t.tenants.jane, dbId)).toEqual(["bob writes", "from carol", "from outside", "welcome"]);

    // The admin takes Bob out of the group: refused at once, the replica goes.
    await adminDir.removeUsersFromGroup("support", [t.usernames.bob], adminKey, PASSWORD);
    await t.pushDirectory();
    await pull(t.tenants.bob, "directory");
    await expect(pull(t.tenants.bob, dbId)).rejects.toThrow(DENIED);
    expect(await texts(t.tenants.bob, dbId)).toEqual([]);

    // The tcal_ twin follows the same group.
    await expect(pull(t.tenants.bob, `tcal_${mailboxId}`)).rejects.toThrow(DENIED);
    await pull(t.tenants.jane, `tcal_${mailboxId}`);
    // No marker text in clear on the server.
    const stored = fs.readdirSync(dataDir, { recursive: true }) as string[];
    for (const file of stored) {
      const full = `${dataDir}/${file}`;
      if (fs.statSync(full).isFile()) expect(fs.readFileSync(full).includes(Buffer.from("from outside"))).toBe(false);
    }
  });
});
