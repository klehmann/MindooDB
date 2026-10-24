/**
 * Access control enforced by a real server over HTTP (docs/accesscontrol.md §6–§13).
 *
 * The other access-control tests check one side at a time: the directory evaluates
 * rules correctly (`ServerPublicInfosAccess`), or a server store refuses what a fake
 * evaluator denies (`ServerWitnessStamping`). The server wires the two together
 * through `TenantManager` and its `CompositeMindooDirectory` wrapper, and a method
 * that wrapper did not forward silently switched the Tier 1 check off. So every
 * test here goes the whole way: an admin writes policies into the directory, pushes
 * it to a `MindooDBServer`, and members sync over HTTP.
 *
 * Cast: the admin, Karsten (the founder's device) and Jane (a second person who
 * joined with the tenant key). Entries a rule forbids are written before the member
 * has pulled the rule — a client that is offline or does not run the local
 * precheck — so only the server stands in the way.
 */
import fs from "fs";
import { Server } from "http";

import { IsolatedInMemoryStoreFactory } from "./_helpers/multiDevice";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { MindooDBServer } from "../node/server/MindooDBServer";
import {
  DEFAULT_TENANT_KEY_ID,
  StoreKind,
  USER_DIRECTORY_DB_ID,
  type MindooTenant,
  type MindooTenantDirectory,
  type PrivateUserId,
} from "../core/types";
import type { ServerConfig } from "../node/server/types";

const PASSWORD = "member-pass";
const SYSTEM_ADMIN_PASSWORD = "sysadmin-pass";
const SERVER_PASSWORD = "server-acl-http-pass";
/** The database-open gate answers both §6.7 and §6.8 with the allowed-list message. */
const DENIED = /denied|ACCESS_DENIED|not allowed|forbidden|allowed database list/i;

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

interface AclTenant {
  tenantId: string;
  adminUser: PrivateUserId;
  karsten: MindooTenant;
  karstenUser: PrivateUserId;
  jane: MindooTenant;
  janeUser: PrivateUserId;
  /** The admin's view of the directory (on Karsten's device, signed with the admin key). */
  directory: MindooTenantDirectory;
  adminKey: PrivateUserId["userSigningKeyPair"]["privateKey"];
  push(tenant: MindooTenant, dbId: string): Promise<Awaited<ReturnType<Awaited<ReturnType<MindooTenant["openDB"]>>["pushChangesTo"]>>>;
  pull(tenant: MindooTenant, dbId: string): Promise<void>;
  pushDirectory(): Promise<void>;
  /** Switches access control on (new tenants start with the master switch on) and applies `policy`. */
  enable(policy?: Record<string, unknown>): Promise<void>;
  create(tenant: MindooTenant, dbId: string, title: string): Promise<string>;
  /** The documents of a database as Karsten sees them after a pull: the server's plus his own (all accepted). */
  serverDocs(dbId: string): Promise<Map<string, { title: unknown; deleted: boolean }>>;
}

describe("access control on a real server (HTTP)", () => {
  jest.setTimeout(240000);
  let httpServer: Server;
  let baseUrl: string;
  let dataDir: string;
  let systemAdmin: PrivateUserId;
  const crypto = new NodeCryptoAdapter();

  // A server per test: device discovery (the join) is rate limited per client.
  beforeEach(async () => {
    const factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    dataDir = `/tmp/mindoodb-acl-http-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    fs.mkdirSync(dataDir, { recursive: true });
    const serverIdentity = await factory.createUserId("CN=acl-http-server", SERVER_PASSWORD);
    fs.writeFileSync(`${dataDir}/server.identity.json`, JSON.stringify(serverIdentity, null, 2), "utf-8");
    fs.writeFileSync(`${dataDir}/trusted-servers.json`, "[]", "utf-8");
    systemAdmin = await factory.createUserId("cn=sysadmin/o=acl-http", SYSTEM_ADMIN_PASSWORD);
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

  async function openDb(tenant: MindooTenant, dbId: string) {
    return tenant.openDB(dbId, dbId === "directory" ? { adminOnlyDb: true } : undefined);
  }

  async function setupTenant(): Promise<AclTenant> {
    const tenantId = `aclhttp-${Date.now().toString(16)}`;
    const founderFactory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    const adminUser = await founderFactory.createUserId(`cn=admin/o=${tenantId}`, PASSWORD);
    const karstenUser = await founderFactory.createUserId(`cn=karsten/o=${tenantId}`, PASSWORD);
    await founderFactory.ensureUserKeyPair(karstenUser, PASSWORD);
    const { tenant: karsten } = await founderFactory.createTenant({ tenantId, adminUser, adminPassword: PASSWORD, appUser: karstenUser, userPassword: PASSWORD });
    karsten.noteUserDirectoryFetched!();
    await karsten.reconcileUserKeys!({ allowSelfCreate: true });
    await karsten.publishToServer(baseUrl, { systemAdminUser: systemAdmin, systemAdminPassword: SYSTEM_ADMIN_PASSWORD, adminUsername: adminUser.username });

    const adminAuth = { networkAuthOverride: { user: adminUser, password: PASSWORD } };
    const push = async (tenant: MindooTenant, dbId: string) => {
      const local = await openDb(tenant, dbId);
      return local.pushChangesTo(await tenant.connectToServer(baseUrl, dbId, StoreKind.docs), dbId === "directory" ? adminAuth : undefined);
    };
    const pull = async (tenant: MindooTenant, dbId: string) => {
      const local = await openDb(tenant, dbId);
      await local.pullChangesFrom(await tenant.connectToServer(baseUrl, dbId, StoreKind.docs));
      await local.syncStoreChanges();
    };
    const pushDirectory = async () => {
      await push(karsten, "directory");
    };
    await pushDirectory();
    await push(karsten, USER_DIRECTORY_DB_ID);

    // Jane joins as a new person, with the tenant key.
    const janeFactory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    const janeUser = await janeFactory.createUserId(`cn=jane/o=${tenantId}`, PASSWORD);
    await janeFactory.ensureUserKeyPair(janeUser, PASSWORD);
    await karsten.approveJoinRequest(janeFactory.createJoinRequest(janeUser, { label: "Jane" }), {
      adminSigningKey: adminUser.userSigningKeyPair.privateKey,
      adminPassword: PASSWORD,
      adminUsername: adminUser.username,
      label: "Jane",
      serverUrl: baseUrl,
    });
    await pushDirectory();
    await push(karsten, USER_DIRECTORY_DB_ID);
    const delivery = (await janeFactory.discoverTenantsOnServer(baseUrl, { user: janeUser, password: PASSWORD })).find((d) => d.tenantId === tenantId)!;
    const joined = await janeFactory.bootstrapTenantFromDelivery(delivery, { user: janeUser, password: PASSWORD, serverUrl: baseUrl });
    const jane = joined.tenant;
    await pull(jane, "directory");
    await pull(jane, USER_DIRECTORY_DB_ID);
    jane.noteUserDirectoryFetched!();
    await jane.reconcileUserKeys!();
    await jane.reconcileKeyDistributionsForCurrentUser!();
    expect(await jane.hasDecryptionKey!(DEFAULT_TENANT_KEY_ID)).toBe(true);

    const directory = await karsten.openDirectory();
    const adminKey = adminUser.userSigningKeyPair.privateKey;

    return {
      tenantId,
      adminUser,
      karsten,
      karstenUser,
      jane,
      janeUser: joined.user,
      directory,
      adminKey,
      push,
      pull,
      pushDirectory,
      async enable(policy = {}) {
        await directory.setDefaultAccessPolicy!({ disableAllAccessChecksAndPolicies: false, ...policy }, adminKey, PASSWORD);
      },
      async create(tenant, dbId, title) {
        const db = await openDb(tenant, dbId);
        const doc = await db.createDocument();
        await db.changeDoc(doc, (d) => {
          d.getData().title = title;
        });
        return doc.getId();
      },
      async serverDocs(dbId) {
        await pull(karsten, dbId);
        const db = await openDb(karsten, dbId);
        const result = new Map<string, { title: unknown; deleted: boolean }>();
        for (const id of await db.getAllDocumentIds()) {
          const doc = await db.getDocument(id);
          result.set(id, { title: doc.getData().title, deleted: doc.isDeleted() });
        }
        return result;
      },
    };
  }

  function expectPolicyRejections(result: { rejectedEntries?: Array<{ rejectionClass?: string; reason: string }> }, reason: RegExp) {
    const rejected = result.rejectedEntries ?? [];
    expect(rejected.length).toBeGreaterThan(0);
    for (const rejection of rejected) {
      expect(rejection.rejectionClass).toBe("policy");
      expect(rejection.reason).toMatch(reason);
    }
  }

  test("deny rules for create, change, delete and undelete refuse those pushes", async () => {
    const t = await setupTenant();
    const kept = await t.create(t.karsten, "main", "kept");
    const removed = await t.create(t.karsten, "main", "removed");
    await t.push(t.karsten, "main");
    // Karsten deletes one document so Jane has something to undelete.
    const karstenMain = await openDb(t.karsten, "main");
    await karstenMain.deleteDocument(removed);
    await t.push(t.karsten, "main");
    await t.pull(t.jane, "main");

    // Jane, before she has the rules: creates, changes, deletes and undeletes.
    const janeMain = await openDb(t.jane, "main");
    const forged = await t.create(t.jane, "main", "forged");
    await janeMain.changeDoc(await janeMain.getDocument(kept), (d) => {
      d.getData().title = "defaced";
    });
    const third = await t.create(t.karsten, "main", "third");
    await t.push(t.karsten, "main");
    await t.pull(t.jane, "main");
    await janeMain.deleteDocument(third);
    await janeMain.undeleteDocument(removed);

    await t.enable();
    for (const type of ["doc_create", "doc_change", "doc_delete", "doc_undelete"] as const) {
      await t.directory.createAccessRule!(
        { ruleId: `jane_no_${type}`, type, dbid: "main", action: "deny", usernames: [t.janeUser.username] },
        t.adminKey,
        PASSWORD,
      );
    }
    await t.pushDirectory();

    expectPolicyRejections(await t.push(t.jane, "main"), /jane_no_doc_(create|change|delete|undelete)/);
    const onServer = await t.serverDocs("main");
    expect(onServer.has(forged)).toBe(false);
    expect(onServer.get(kept)).toEqual({ title: "kept", deleted: false });
    expect(onServer.get(third)?.deleted).toBe(false);
    // Still deleted: deleted documents are not listed.
    expect(onServer.has(removed)).toBe(false);

    // The rules target Jane only: Karsten keeps writing.
    await karstenMain.changeDoc(await karstenMain.getDocument(kept), (d) => {
      d.getData().title = "kept, edited";
    });
    expect((await t.push(t.karsten, "main")).rejectedEntries ?? []).toHaveLength(0);
    expect((await t.serverDocs("main")).get(kept)?.title).toBe("kept, edited");
  });

  test("an allow rule opens a deny baseline for its target only", async () => {
    const t = await setupTenant();
    const janes = await t.create(t.jane, "main", "jane, unauthorized");
    await t.enable();
    await t.directory.setDatabaseAccessPolicy!("main", { denyDocCreate: true }, t.adminKey, PASSWORD);
    await t.directory.createAccessRule!(
      { ruleId: "karsten_may_create", type: "doc_create", dbid: "main", action: "allow", usernames: [t.karstenUser.username] },
      t.adminKey,
      PASSWORD,
    );
    await t.pushDirectory();
    const karstens = await t.create(t.karsten, "main", "karsten, allowed");

    expect((await t.push(t.karsten, "main")).rejectedEntries ?? []).toHaveLength(0);
    expectPolicyRejections(await t.push(t.jane, "main"), /baseline|deny/i);
    const entries = await (await t.karsten.connectToServer(baseUrl, "main", StoreKind.docs)).findNewEntries([]);
    expect(entries.some((entry) => entry.docId === karstens && entry.entryType === "doc_create")).toBe(true);
    expect(entries.some((entry) => entry.docId === janes && entry.entryType === "doc_create")).toBe(false);
  });

  // Known gap: the server judges each entry on its own. The create of Jane's
  // document is refused, but her first change to it is a doc_change, which no rule
  // denies, so it is accepted. Other replicas then list a document id whose
  // document cannot be loaded (getDocument throws DocumentNotFoundError).
  // Remove `.failing` once a refused create takes the document's changes with it.
  test.failing("a refused create leaves no part of the document on the server", async () => {
    const t = await setupTenant();
    const janes = await t.create(t.jane, "main", "jane, unauthorized");
    await t.enable();
    await t.directory.setDatabaseAccessPolicy!("main", { denyDocCreate: true }, t.adminKey, PASSWORD);
    await t.pushDirectory();
    expectPolicyRejections(await t.push(t.jane, "main"), /baseline|deny/i);

    const entries = await (await t.karsten.connectToServer(baseUrl, "main", StoreKind.docs)).findNewEntries([]);
    expect(entries.filter((entry) => entry.docId === janes).map((entry) => entry.entryType)).toEqual([]);
  });

  test("$author: only the creator may change a document", async () => {
    const t = await setupTenant();
    const doc = await t.create(t.karsten, "main", "original");
    await t.push(t.karsten, "main");
    await t.pull(t.jane, "main");
    const janeMain = await openDb(t.jane, "main");
    await janeMain.changeDoc(await janeMain.getDocument(doc), (d) => {
      d.getData().title = "changed by jane";
    });

    await t.enable();
    await t.directory.setDatabaseAccessPolicy!("main", { denyDocChange: true }, t.adminKey, PASSWORD);
    await t.directory.createAccessRule!(
      { ruleId: "authors_change_own", type: "doc_change", dbid: "main", action: "allow", users_hashes: ["$author"] },
      t.adminKey,
      PASSWORD,
    );
    await t.pushDirectory();

    expectPolicyRejections(await t.push(t.jane, "main"), /baseline|deny/i);
    expect((await t.serverDocs("main")).get(doc)?.title).toBe("original");

    const karstenMain = await openDb(t.karsten, "main");
    await karstenMain.changeDoc(await karstenMain.getDocument(doc), (d) => {
      d.getData().title = "changed by the author";
    });
    expect((await t.push(t.karsten, "main")).rejectedEntries ?? []).toHaveLength(0);
    expect((await t.serverDocs("main")).get(doc)?.title).toBe("changed by the author");
  });

  test("denyDocRead with a doc_read allow rule: others can neither pull nor push the database", async () => {
    const t = await setupTenant();
    const secret = await t.create(t.karsten, "secret", "for karsten only");
    await t.push(t.karsten, "secret");
    await t.pull(t.jane, "secret");
    const janesSecret = await t.create(t.jane, "secret", "jane writes into secret");
    await t.create(t.jane, "main", "jane writes into main");

    await t.enable();
    await t.directory.setDatabaseAccessPolicy!("secret", { denyDocRead: true }, t.adminKey, PASSWORD);
    await t.directory.createAccessRule!(
      { ruleId: "karsten_reads_secret", type: "doc_read", dbid: "secret", action: "allow", usernames: [t.karstenUser.username] },
      t.adminKey,
      PASSWORD,
    );
    await t.pushDirectory();

    const janeRemote = await t.jane.connectToServer(baseUrl, "secret", StoreKind.docs);
    await expect(janeRemote.findNewEntries([])).rejects.toThrow(DENIED);
    await expect(t.push(t.jane, "secret")).rejects.toThrow(DENIED);
    const onServer = await t.serverDocs("secret");
    expect(onServer.has(secret)).toBe(true);
    expect(onServer.has(janesSecret)).toBe(false);

    // The gate is per database: main stays open to Jane, secret to Karsten.
    expect((await t.push(t.jane, "main")).rejectedEntries ?? []).toHaveLength(0);
    const karstenRemote = await t.karsten.connectToServer(baseUrl, "secret", StoreKind.docs);
    expect((await karstenRemote.findNewEntries([])).length).toBeGreaterThan(0);
  });

  test("directory-restricted: only listed databases sync, the directory always does", async () => {
    const t = await setupTenant();
    await t.create(t.jane, "scratch", "a database nobody listed");
    await t.enable({ databaseCreationPolicy: "directory-restricted", allowedDbIds: ["main"] });
    await t.pushDirectory();

    await expect(t.push(t.jane, "scratch")).rejects.toThrow(DENIED);
    const janeRemote = await t.jane.connectToServer(baseUrl, "scratch", StoreKind.docs);
    await expect(janeRemote.findNewEntries([])).rejects.toThrow(DENIED);
    await t.create(t.jane, "main", "listed database");
    expect((await t.push(t.jane, "main")).rejectedEntries ?? []).toHaveLength(0);
    await expect(t.pull(t.jane, "directory")).resolves.toBeUndefined();
  });

  test("a key pulled from a user: the server withholds its entries and refuses re-uploads", async () => {
    const t = await setupTenant();
    const doc = await t.create(t.karsten, "main", "under the tenant key");
    await t.push(t.karsten, "main");
    await t.pull(t.jane, "main");
    // Written while Jane still had the key, pushed after she lost it.
    const janes = await t.create(t.jane, "main", "jane, before losing the key");

    // Karsten keeps the key, Jane loses it.
    const directory = t.directory as MindooTenantDirectory & {
      getKeyVersionManifest(keyId: string): Promise<unknown[]>;
      wrapKeyForUser(keyId: string, username: string): Promise<unknown>;
      getUsernameHash(username: string): Promise<string>;
    };
    await t.enable();
    await t.directory.publishKeyDistribution!(
      {
        v: 1,
        tenantId: t.tenantId,
        keyId: DEFAULT_TENANT_KEY_ID,
        keyVersions: (await directory.getKeyVersionManifest(DEFAULT_TENANT_KEY_ID)) as never,
        title: "Tenant key",
        preparedByPublicKey: t.karstenUser.userSigningKeyPair.publicKey as string,
        // People with a User-Key get one wrap per person (docs/userkeys.md).
        pushto: [(await directory.wrapKeyForUser(DEFAULT_TENANT_KEY_ID, t.karstenUser.username)) as never],
        pullfrom: [{ username: t.janeUser.username, username_hash: await directory.getUsernameHash(t.janeUser.username) }],
      },
      t.adminKey,
      PASSWORD,
    );
    await t.pushDirectory();

    const janeRemote = await t.jane.connectToServer(baseUrl, "main", StoreKind.docs);
    expect((await janeRemote.findNewEntries([])).some((entry) => entry.docId === doc)).toBe(false);
    const karstenRemote = await t.karsten.connectToServer(baseUrl, "main", StoreKind.docs);
    expect((await karstenRemote.findNewEntries([])).some((entry) => entry.docId === doc)).toBe(true);

    const upload = await t.push(t.jane, "main");
    const rejected = upload.rejectedEntries ?? [];
    expect(rejected.length).toBeGreaterThan(0);
    for (const rejection of rejected) expect(rejection.rejectionClass).toBe("revoked-key");
    expect((await t.serverDocs("main")).has(janes)).toBe(false);
  });

  test("remote wipe: the targeted device gets no data and may not push", async () => {
    const t = await setupTenant();
    await t.create(t.karsten, "main", "visible before the wipe");
    await t.push(t.karsten, "main");
    await t.create(t.jane, "main", "pushed after the wipe directive");

    await t.directory.requestDeviceWipe!(t.janeUser.username, [t.janeUser.userSigningKeyPair.publicKey as string], t.adminKey, PASSWORD);
    await t.pushDirectory();

    const janeRemote = await t.jane.connectToServer(baseUrl, "main", StoreKind.docs);
    expect(await janeRemote.findNewEntries([])).toHaveLength(0);
    await expect(t.push(t.jane, "main")).rejects.toThrow(/wipe/i);
    // The directory serves only the grant document that carries the directive.
    const janeDirectory = await t.jane.connectToServer(baseUrl, "directory", StoreKind.docs);
    const served = await janeDirectory.findNewEntries([]);
    expect(served.length).toBeGreaterThan(0);
    expect(new Set(served.map((entry) => entry.docId)).size).toBe(1);
  });
});
