/**
 * Author-scoped read (docs/accesscontrol.md §6.12) enforced by a real server
 * over HTTP: in a database with `docReadScope: "own"` every member pulls only
 * the documents they created themselves (any of their devices), while the
 * tenant admin and members matched by a `doc_read_all` rule read everything.
 * Nothing about other people's documents leaks through the read paths
 * (scan, getEntries, metadata, ids, dependencies, materialization plans,
 * attachments), and pushes into other people's documents are refused.
 *
 * Cast as in ServerAccessControlHttp: the admin, Karsten (founder's device)
 * and Jane (a second person with the tenant key).
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
import type { ServerConfig } from "../server/types";

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

describe("author-scoped read on a real server (HTTP, docs/accesscontrol.md §6.12)", () => {
  jest.setTimeout(240000);
  let httpServer: Server;
  let baseUrl: string;
  let dataDir: string;
  let systemAdmin: PrivateUserId;
  const crypto = new NodeCryptoAdapter();

  // A server per test: device discovery (the join) is rate limited per client.
  beforeEach(async () => {
    const factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    dataDir = `/tmp/mindoodb-authorread-http-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
    const tenantId = `authread-${Date.now().toString(16)}`;
    const founderFactory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    const adminUser = await founderFactory.createUserId(`cn=admin/o=${tenantId}`, PASSWORD);
    const karstenUser = await founderFactory.createUserId(`cn=karsten/o=${tenantId}`, PASSWORD);
    await founderFactory.ensureUserKeyPair(karstenUser, PASSWORD);
    const { tenant: karsten } = await founderFactory.createTenant({ tenantId, adminUser, adminPassword: PASSWORD, appUser: karstenUser, userPassword: PASSWORD });
    karsten.noteUserDirectoryFetched!();
    await karsten.reconcileUserKeys!({ allowSelfCreate: true });
    // With the administration key the server becomes a trusted witness, as in a real tenant:
    // with access control on, receipts of an untrusted server would quarantine every entry.
    await karsten.publishToServer(baseUrl, {
      systemAdminUser: systemAdmin,
      systemAdminPassword: SYSTEM_ADMIN_PASSWORD,
      adminUsername: adminUser.username,
      adminSigningKey: adminUser.userSigningKeyPair.privateKey,
      adminPassword: PASSWORD,
    });

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

  const DB = "inbox";

  /** Ids of the documents a member gets from the server (fresh scan of the docs store). */
  async function serverDocIdsFor(t: AclTenant, tenant: MindooTenant): Promise<Set<string>> {
    const remote = await tenant.connectToServer(baseUrlOf(), DB, StoreKind.docs);
    const metas = await remote.findNewEntries([]);
    return new Set(metas.map((m) => m.docId));
  }
  const baseUrlOf = () => baseUrl;

  async function scopeOwn(t: AclTenant) {
    await t.enable();
    await t.directory.setDatabaseAccessPolicy!(DB, { docReadScope: "own" }, t.adminKey, PASSWORD);
    await t.pushDirectory();
  }

  test("each member pulls only their own documents", async () => {
    const t = await setupTenant();
    await scopeOwn(t);
    const k1 = await t.create(t.karsten, DB, "karsten 1");
    const j1 = await t.create(t.jane, DB, "jane 1");
    await t.push(t.karsten, DB);
    await t.push(t.jane, DB);

    await t.pull(t.jane, DB);
    const janeDb = await openDb(t.jane, DB);
    const janeIds = await janeDb.getAllDocumentIds();
    expect(janeIds).toContain(j1);
    expect(janeIds).not.toContain(k1);

    await t.pull(t.karsten, DB);
    const karstenIds = await (await openDb(t.karsten, DB)).getAllDocumentIds();
    expect(karstenIds).toContain(k1);
    expect(karstenIds).not.toContain(j1);

    expect([...(await serverDocIdsFor(t, t.jane))]).toEqual([j1]);
  });

  test("no read path reveals another person's document", async () => {
    const t = await setupTenant();
    await scopeOwn(t);
    const k1 = await t.create(t.karsten, DB, "karsten secret");
    const karstenDb = await openDb(t.karsten, DB);
    await karstenDb.changeDoc(await karstenDb.getDocument(k1), async (d) => {
      await d.addAttachment(new Uint8Array([1, 2, 3, 4]), "a.bin", "application/octet-stream");
    });
    await karstenDb.pushChangesTo(await t.karsten.connectToServer(baseUrl, DB, StoreKind.attachments), {
      storeKind: StoreKind.attachments,
    });
    await t.push(t.karsten, DB);
    const karstenDocs = await t.karsten.connectToServer(baseUrl, DB, StoreKind.docs);
    const karstenEntryIds = (await karstenDocs.findNewEntries([])).map((m) => m.id);
    const karstenChunks = await (await t.karsten.connectToServer(baseUrl, DB, StoreKind.attachments)).getAllIds();
    expect(karstenEntryIds.length).toBeGreaterThan(0);
    expect(karstenChunks.length).toBeGreaterThan(0);

    const docs = await t.jane.connectToServer(baseUrl, DB, StoreKind.docs);
    const atts = await t.jane.connectToServer(baseUrl, DB, StoreKind.attachments);
    expect(await docs.findNewEntries([])).toEqual([]);
    expect(await docs.findNewEntriesForDoc([], k1)).toEqual([]);
    expect(await docs.getAllIds()).toEqual([]);
    expect(await docs.getEntries(karstenEntryIds)).toEqual([]);
    expect(await docs.getEntryMetadata(karstenEntryIds[0]!)).toBeNull();
    expect(await docs.resolveDependencies(karstenEntryIds[karstenEntryIds.length - 1]!)).toEqual([]);
    const scan = await docs.scanEntriesSince!(null, 100);
    expect(scan.entries).toEqual([]);
    if (docs.planDocumentMaterialization) {
      const plan = await docs.planDocumentMaterialization(k1);
      expect(plan.entryIdsToApply).toEqual([]);
      expect(plan.snapshotEntryId).toBeNull();
    }
    expect(await atts.getAllIds()).toEqual([]);
    expect(await atts.getEntries(karstenChunks)).toEqual([]);
    expect(await atts.findNewEntries([])).toEqual([]);
  });

  test("a doc_read_all rule and the admin read everything; the scope change re-scans", async () => {
    const t = await setupTenant();
    await scopeOwn(t);
    const k1 = await t.create(t.karsten, DB, "karsten 1");
    const j1 = await t.create(t.jane, DB, "jane 1");
    await t.push(t.karsten, DB);
    await t.push(t.jane, DB);
    await t.pull(t.karsten, DB);
    expect(await (await openDb(t.karsten, DB)).getAllDocumentIds()).not.toContain(j1);
    const scopedHead = await (await t.karsten.connectToServer(baseUrl, DB, StoreKind.docs)).getStoreHead!();

    // Karsten becomes a reader of everything: his next pull starts over
    // (another epoch) and now brings Jane's document, too.
    await t.directory.createAccessRule!(
      { ruleId: "karsten_reads_all", type: "doc_read_all", dbid: DB, action: "allow", usernames: [t.karstenUser.username] },
      t.adminKey,
      PASSWORD,
    );
    await t.pushDirectory();
    const fullHead = await (await t.karsten.connectToServer(baseUrl, DB, StoreKind.docs)).getStoreHead!();
    expect(fullHead.epoch).not.toBe(scopedHead.epoch);
    await t.pull(t.karsten, DB);
    const ids = await (await openDb(t.karsten, DB)).getAllDocumentIds();
    expect(ids).toEqual(expect.arrayContaining([k1, j1]));

  });

  test("the tenant admin reads everything", async () => {
    const t = await setupTenant();
    await scopeOwn(t);
    const k1 = await t.create(t.karsten, DB, "karsten 1");
    const j1 = await t.create(t.jane, DB, "jane 1");
    await t.push(t.karsten, DB);
    await t.push(t.jane, DB);
    // Karsten's device, but logged in with the admin key.
    const local = await openDb(t.karsten, DB);
    await local.pullChangesFrom(await t.karsten.connectToServer(baseUrl, DB, StoreKind.docs), {
      networkAuthOverride: { user: t.adminUser, password: PASSWORD },
    });
    await local.syncStoreChanges();
    expect(await local.getAllDocumentIds()).toEqual(expect.arrayContaining([k1, j1]));
  });

  test("pushes into another person's document are refused", async () => {
    const t = await setupTenant();
    // Before the scope: Jane gets Karsten's document.
    const k0 = await t.create(t.karsten, DB, "karsten 0");
    await t.push(t.karsten, DB);
    await t.pull(t.jane, DB);
    await scopeOwn(t);

    const janeDb = await openDb(t.jane, DB);
    await janeDb.changeDoc(await janeDb.getDocument(k0), (d) => {
      d.getData().title = "changed by jane";
    });
    const own = await t.create(t.jane, DB, "jane's own");
    const result = await t.push(t.jane, DB);
    const rejected = result.rejectedEntries ?? [];
    expect(rejected.length).toBeGreaterThan(0);
    for (const r of rejected) {
      expect(r.rejectionClass).toBe("policy");
      expect(r.reason).toMatch(/outside the principal's read scope/);
    }
    // Her own document went through.
    expect([...(await serverDocIdsFor(t, t.jane))]).toEqual([own]);
    // Karsten's document is unchanged.
    await t.pull(t.karsten, DB);
    const k = await (await openDb(t.karsten, DB)).getDocument(k0);
    expect(k.getData().title).toBe("karsten 0");
  });

  test("databases without the scope and the directory are not affected", async () => {
    const t = await setupTenant();
    await scopeOwn(t);
    const k1 = await t.create(t.karsten, "main", "open db");
    await t.push(t.karsten, "main");
    await t.pull(t.jane, "main");
    expect(await (await openDb(t.jane, "main")).getAllDocumentIds()).toContain(k1);
    await t.pull(t.jane, "directory");
  });
});
