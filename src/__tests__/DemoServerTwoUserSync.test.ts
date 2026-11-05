/**
 * HTTP end-to-end, the whole story of two people on a demo server:
 *
 * 1. A fresh `MindooDBServer` runs in the demo mode from README-server.md: anyone may
 *    create a tenant (`POST:/system/tenants/*` with the `*` principal), nothing else.
 *    Counter-check: a server without that rule refuses the same tenant.
 * 2. On device A Karsten founds a tenant (admin + user identity), writes documents
 *    locally and pushes the tenant to the server, authenticating with his own admin
 *    key — there is no system admin.
 * 3. Jane, on device B, is not a member yet: discovery finds nothing and the tenant's
 *    auth challenge refuses her. Karsten approves her join request; now discovery
 *    finds the tenant and she bootstraps it.
 * 4. Jane pulls the data, changes a document and pushes; Karsten receives it.
 * 5. Both change the same document offline at the same time (different fields, the
 *    same text, the same list, the same atomic field); after syncing both ways
 *    Automerge has merged the edits and both devices hold the same state.
 * 6. Publishing added the server as a trusted witness and the server stamped every
 *    entry it accepted. With access control switched on, both devices still read
 *    all documents. Counter-check (second test): a tenant published without the
 *    witness gets its stamped entries quarantined once access control is on.
 *
 * `JoinNewUserServer` covers the join itself in more depth; this test is about the
 * data round trip around it.
 */
import fs from "fs";
import { Server } from "http";

import { IsolatedInMemoryStoreFactory } from "./_helpers/multiDevice";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { MindooDBServer } from "../node/server/MindooDBServer";
import {
  DEFAULT_TENANT_KEY_ID,
  USER_DIRECTORY_DB_ID,
  type MindooTenant,
  type PrivateUserId,
} from "../core/types";
import { MindooValue } from "../core/values";
import type { ServerConfig } from "../server/types";

const KARSTEN_PASSWORD = "karsten-pass";
const JANE_PASSWORD = "jane-pass";
const SERVER_PASSWORD = "demo-server-pass";
const NOTES_DB = "notes";

/** The open demo server from README-server.md. */
const DEMO_CONFIG: ServerConfig = {
  capabilities: {
    "POST:/system/tenants/*": [{ username: "*", publicsignkey: "*" }],
  },
};

interface RunningServer {
  httpServer: Server;
  baseUrl: string;
  dataDir: string;
}

async function startServer(name: string, config: ServerConfig): Promise<RunningServer> {
  const dataDir = `/tmp/mindoodb-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.mkdirSync(dataDir, { recursive: true });
  const factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), new NodeCryptoAdapter());
  const serverIdentity = await factory.createUserId(`CN=${name}`, SERVER_PASSWORD);
  fs.writeFileSync(`${dataDir}/server.identity.json`, JSON.stringify(serverIdentity, null, 2), "utf-8");
  fs.writeFileSync(`${dataDir}/trusted-servers.json`, "[]", "utf-8");
  const server = new MindooDBServer(dataDir, SERVER_PASSWORD, undefined, config);
  return new Promise((resolve, reject) => {
    const httpServer = server.getApp().listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to determine test server port"));
        return;
      }
      resolve({ httpServer, baseUrl: `http://127.0.0.1:${address.port}`, dataDir });
    });
    httpServer.on("error", reject);
  });
}

async function stopServer(running: RunningServer | undefined): Promise<void> {
  if (!running) return;
  await new Promise<void>((resolve) => running.httpServer.close(() => resolve()));
  fs.rmSync(running.dataDir, { recursive: true, force: true });
}

async function openDb(tenant: MindooTenant, dbId: string) {
  return tenant.openDB(dbId, dbId === "directory" ? { adminOnlyDb: true } : undefined);
}

async function push(
  tenant: MindooTenant,
  baseUrl: string,
  dbId: string,
  auth?: { user: PrivateUserId; password: string },
): Promise<void> {
  const local = await openDb(tenant, dbId);
  const result = await local.pushChangesTo(
    await tenant.connectToServer(baseUrl, dbId),
    auth ? { networkAuthOverride: auth } : undefined,
  );
  expect(result.cancelled).toBe(false);
  expect(result.rejectedEntries ?? []).toEqual([]);
}

async function pull(tenant: MindooTenant, baseUrl: string, dbId: string): Promise<void> {
  const local = await openDb(tenant, dbId);
  await local.pullChangesFrom(await tenant.connectToServer(baseUrl, dbId));
  await local.syncStoreChanges();
}

/** Every document of `dbId` as plain JSON, keyed by id. */
async function snapshot(tenant: MindooTenant, dbId: string): Promise<Record<string, unknown>> {
  const db = await openDb(tenant, dbId);
  const result: Record<string, unknown> = {};
  for (const id of (await db.getAllDocumentIds()).sort()) {
    result[id] = JSON.parse(JSON.stringify((await db.getDocument(id)).getData()));
  }
  return result;
}

/** Server signing (witness) key from its well-known info. */
async function serverSigningKey(baseUrl: string): Promise<string> {
  const info = (await (await fetch(`${baseUrl}/.well-known/mindoodb-server-info`)).json()) as { signingPublicKey: string };
  expect(typeof info.signingPublicKey).toBe("string");
  return info.signingPublicKey;
}

/** Switches access control on (admin writes the directory) and drops the cached documents. */
async function enableAccessControl(tenant: MindooTenant, admin: PrivateUserId, password: string): Promise<void> {
  const directory = await tenant.openDirectory();
  await directory.setDefaultAccessPolicy!(
    { disableAllAccessChecksAndPolicies: false },
    admin.userSigningKeyPair.privateKey,
    password,
  );
}

/** Forgets materialized documents so the next read replays (and re-checks) the entries. */
async function dropDocCache(tenant: MindooTenant, dbId: string): Promise<void> {
  const db = (await openDb(tenant, dbId)) as unknown as { docCache: Map<string, unknown> };
  db.docCache.clear();
}

async function update(tenant: MindooTenant, docId: string, fn: (data: any) => void): Promise<void> {
  const db = await openDb(tenant, NOTES_DB);
  await db.changeDoc(await db.getDocument(docId), (d) => fn(d.getData()));
}

describe("two users on a demo server: create, publish, join, sync, merge", () => {
  jest.setTimeout(240000);
  const crypto = new NodeCryptoAdapter();
  let demo: RunningServer | undefined;
  let locked: RunningServer | undefined;

  afterEach(async () => {
    await stopServer(demo);
    await stopServer(locked);
    demo = locked = undefined;
  });

  test("Jane joins Karsten's tenant, they exchange edits and concurrent edits merge", async () => {
    demo = await startServer("demo-server", DEMO_CONFIG);
    // No rule for tenant creation at all: the counter-check for step 1.
    locked = await startServer("locked-server", { capabilities: {} });
    const baseUrl = demo.baseUrl;

    // --- Device A: Karsten founds the tenant and writes data locally ---------------
    const tenantId = `demo-${Date.now().toString(16)}`;
    const factoryA = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    const adminUser = await factoryA.createUserId(`cn=admin/o=${tenantId}`, KARSTEN_PASSWORD);
    const karstenUser = await factoryA.createUserId(`cn=karsten/o=${tenantId}`, KARSTEN_PASSWORD);
    await factoryA.ensureUserKeyPair(karstenUser, KARSTEN_PASSWORD);
    const { tenant: karsten } = await factoryA.createTenant({
      tenantId,
      adminUser,
      adminPassword: KARSTEN_PASSWORD,
      appUser: karstenUser,
      userPassword: KARSTEN_PASSWORD,
    });
    karsten.noteUserDirectoryFetched!();
    expect((await karsten.reconcileUserKeys!({ allowSelfCreate: true })).state).toBe("approved");

    const notes = await openDb(karsten, NOTES_DB);
    const docIds: string[] = [];
    for (const title of ["Einkaufsliste", "Projektplan"]) {
      const doc = await notes.createDocument();
      await notes.changeDoc(doc, (d) => {
        const data = d.getData();
        data.title = title;
        data.tags = ["start"];
      });
      docIds.push(doc.getId());
    }
    const [shoppingId, planId] = docIds;

    // --- Publish: refused without the demo rule, accepted with it -------------------
    const publishAsAdmin = { systemAdminUser: adminUser, systemAdminPassword: KARSTEN_PASSWORD, adminUsername: adminUser.username };
    // The locked server does not know the admin as a principal for any /system route.
    await expect(karsten.publishToServer(locked.baseUrl, publishAsAdmin)).rejects.toThrow(/HTTP 40[34]/);
    // Even the demo server wants a signed request.
    await expect(karsten.publishToServer(baseUrl, { adminUsername: adminUser.username })).rejects.toThrow(/HTTP 401|HTTP 403/);
    await karsten.publishToServer(baseUrl, publishAsAdmin);

    const adminAuth = { user: adminUser, password: KARSTEN_PASSWORD };
    await push(karsten, baseUrl, "directory", adminAuth);
    await push(karsten, baseUrl, USER_DIRECTORY_DB_ID);
    await push(karsten, baseUrl, NOTES_DB);

    // --- Device B: Jane has no access yet ------------------------------------------
    const factoryB = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    const janeUser = await factoryB.createUserId(`cn=jane/o=${tenantId}`, JANE_PASSWORD);
    await factoryB.ensureUserKeyPair(janeUser, JANE_PASSWORD);
    const janeAuth = { user: janeUser, password: JANE_PASSWORD };

    const before = await factoryB.discoverTenantsOnServer(baseUrl, janeAuth);
    expect(before.find((d) => d.tenantId === tenantId)).toBeUndefined();
    const challengeBefore = await fetch(`${baseUrl}/${tenantId}/auth/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: janeUser.username }),
    });
    expect([401, 403, 404]).toContain(challengeBefore.status);

    // --- Join request / response ---------------------------------------------------
    const joinRequest = factoryB.createJoinRequest(janeUser, { label: "Jane Laptop" });
    const joinResponse = await karsten.approveJoinRequest(joinRequest, {
      adminSigningKey: adminUser.userSigningKeyPair.privateKey,
      adminPassword: KARSTEN_PASSWORD,
      adminUsername: adminUser.username,
      label: "Jane Laptop",
      serverUrl: baseUrl,
    });
    expect(joinResponse.username).toBe(janeUser.username);
    await push(karsten, baseUrl, "directory", adminAuth);
    await push(karsten, baseUrl, USER_DIRECTORY_DB_ID);

    // --- Discovery now finds the tenant ---------------------------------------------
    const after = await factoryB.discoverTenantsOnServer(baseUrl, janeAuth);
    const delivery = after.find((d) => d.tenantId === tenantId);
    expect(delivery).toBeTruthy();
    const joined = await factoryB.bootstrapTenantFromDelivery(delivery!, { ...janeAuth, serverUrl: baseUrl });
    const jane = joined.tenant;
    await pull(jane, baseUrl, "directory");
    await pull(jane, baseUrl, USER_DIRECTORY_DB_ID);
    jane.noteUserDirectoryFetched!();
    expect((await jane.reconcileUserKeys!()).state).toBe("approved");
    await jane.reconcileKeyDistributionsForCurrentUser!();
    expect(await jane.hasDecryptionKey!(DEFAULT_TENANT_KEY_ID)).toBe(true);

    // --- Jane pulls Karsten's data ---------------------------------------------------
    await pull(jane, baseUrl, NOTES_DB);
    expect(await snapshot(jane, NOTES_DB)).toEqual(await snapshot(karsten, NOTES_DB));
    expect(Object.keys(await snapshot(jane, NOTES_DB))).toEqual([...docIds].sort());

    // --- Jane edits, Karsten receives ------------------------------------------------
    await update(jane, shoppingId, (data) => {
      data.items = ["Milch", "Brot"];
    });
    await push(jane, baseUrl, NOTES_DB);
    await pull(karsten, baseUrl, NOTES_DB);
    expect((await snapshot(karsten, NOTES_DB))[shoppingId]).toMatchObject({
      title: "Einkaufsliste",
      tags: ["start"],
      items: ["Milch", "Brot"],
    });

    // --- Concurrent edits to the same document, both offline --------------------------
    // Fields are written the way best-practices.md §6.2/§7.6 recommends: atomic values
    // for status-like fields, text splices for prose, list inserts for lists.
    // (`changeDoc` only records top-level assignments, so `getData().tags.push()`
    // would be dropped silently.)
    const notesK = await openDb(karsten, NOTES_DB);
    const notesJ = await openDb(jane, NOTES_DB);
    const title = "Projektplan";
    await notesK.applyJsonPatch(await notesK.getDocument(planId), {
      set: [
        { path: ["status"], value: "in Arbeit" },
        { path: ["priority"], value: MindooValue.atomic("hoch") },
      ],
      textSplice: [{ path: ["title"], index: title.length, deleteCount: 0, insert: " 2027" }],
      listInsert: [{ path: ["tags"], index: 1, values: ["karsten"] }],
    });
    await notesJ.applyJsonPatch(await notesJ.getDocument(planId), {
      set: [
        { path: ["owner"], value: "Jane" },
        { path: ["priority"], value: MindooValue.atomic("niedrig") },
      ],
      textSplice: [{ path: ["title"], index: 0, deleteCount: 0, insert: "Neuer " }],
      listInsert: [{ path: ["tags"], index: 1, values: ["jane"] }],
    });
    await push(karsten, baseUrl, NOTES_DB);
    await push(jane, baseUrl, NOTES_DB);
    await pull(karsten, baseUrl, NOTES_DB);
    await pull(jane, baseUrl, NOTES_DB);

    const karstenView = await snapshot(karsten, NOTES_DB);
    const janeView = await snapshot(jane, NOTES_DB);
    // Converged: both devices hold exactly the same documents.
    expect(janeView).toEqual(karstenView);
    const plan = karstenView[planId] as { title: string; tags: string[]; status: string; owner: string; priority: string };
    // Different fields: both edits survive.
    expect(plan.status).toBe("in Arbeit");
    expect(plan.owner).toBe("Jane");
    // Text edits at different places merge character by character.
    expect(plan.title).toBe("Neuer Projektplan 2027");
    // List inserts from both sides are both kept.
    expect(plan.tags[0]).toBe("start");
    expect([...plan.tags].sort()).toEqual(["jane", "karsten", "start"]);
    // Same atomic field: one value wins deterministically, the same on both devices.
    expect(["hoch", "niedrig"]).toContain(plan.priority);
    // The other document was not touched by the merge.
    expect(karstenView[shoppingId]).toMatchObject({ title: "Einkaufsliste", tags: ["start"], items: ["Milch", "Brot"] });

    // --- The server is a trusted witness and stamped every entry -----------------
    const serverKey = await serverSigningKey(baseUrl);
    for (const tenant of [karsten, jane]) {
      const trusted = await (await tenant.openDirectory()).getTrustedWitnessKeysAt!(Date.now());
      expect([...trusted]).toEqual([serverKey]);
    }
    for (const docId of docIds) {
      const metas = await (await openDb(karsten, NOTES_DB)).getStore().findNewEntriesForDoc([], docId);
      expect(metas.length).toBeGreaterThan(0);
      for (const meta of metas) expect(meta.receivedByPublicKey).toBe(serverKey);
    }
    expect((await (await openDb(karsten, NOTES_DB)).getDocument(planId)).isWitnessed()).toBe(true);

    // --- With access control on, both devices still read everything -----------------
    await enableAccessControl(karsten, adminUser, KARSTEN_PASSWORD);
    await push(karsten, baseUrl, "directory", adminAuth);
    await pull(jane, baseUrl, "directory");
    for (const tenant of [karsten, jane]) {
      await dropDocCache(tenant, NOTES_DB);
      expect(await snapshot(tenant, NOTES_DB)).toEqual(karstenView);
    }
  });

  test("without the server as trusted witness, its receipts are quarantined once access control is on", async () => {
    demo = await startServer("demo-server-nowitness", DEMO_CONFIG);
    const baseUrl = demo.baseUrl;
    const tenantId = `demo-nw-${Date.now().toString(16)}`;
    const factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    const adminUser = await factory.createUserId(`cn=admin/o=${tenantId}`, KARSTEN_PASSWORD);
    const user = await factory.createUserId(`cn=karsten/o=${tenantId}`, KARSTEN_PASSWORD);
    await factory.ensureUserKeyPair(user, KARSTEN_PASSWORD);
    const { tenant } = await factory.createTenant({
      tenantId,
      adminUser,
      adminPassword: KARSTEN_PASSWORD,
      appUser: user,
      userPassword: KARSTEN_PASSWORD,
    });
    tenant.noteUserDirectoryFetched!();
    await tenant.reconcileUserKeys!({ allowSelfCreate: true });
    await tenant.publishToServer(baseUrl, {
      systemAdminUser: adminUser,
      systemAdminPassword: KARSTEN_PASSWORD,
      adminUsername: adminUser.username,
      skipTrustedWitness: true,
    });
    expect((await (await tenant.openDirectory()).getTrustedWitnessKeysAt!(Date.now())).size).toBe(0);

    const adminAuth = { user: adminUser, password: KARSTEN_PASSWORD };
    await push(tenant, baseUrl, "directory", adminAuth);
    await push(tenant, baseUrl, USER_DIRECTORY_DB_ID);
    const notes = await openDb(tenant, NOTES_DB);
    const doc = await notes.createDocument();
    await notes.changeDoc(doc, (d) => {
      d.getData().title = "stamped by an untrusted server";
    });
    await push(tenant, baseUrl, NOTES_DB);
    const metas = await notes.getStore().findNewEntriesForDoc([], doc.getId());
    expect(metas.some((m) => m.receivedByPublicKey === undefined)).toBe(false);

    // Readable while access control is off ...
    await dropDocCache(tenant, NOTES_DB);
    expect((await notes.getDocument(doc.getId())).getData().title).toBe("stamped by an untrusted server");
    // ... quarantined once it is on.
    await enableAccessControl(tenant, adminUser, KARSTEN_PASSWORD);
    await dropDocCache(tenant, NOTES_DB);
    await expect(notes.getDocument(doc.getId())).rejects.toThrow(/not found/i);
    // Trust counts from when the witness was added, so adding it now does not
    // make the earlier receipt trusted.
    await (await tenant.openDirectory()).addTrustedWitness!(
      { witnessPublicKey: await serverSigningKey(baseUrl), serverUrl: baseUrl },
      adminUser.userSigningKeyPair.privateKey,
      KARSTEN_PASSWORD,
    );
    await dropDocCache(tenant, NOTES_DB);
    await expect(notes.getDocument(doc.getId())).rejects.toThrow(/not found/i);
  });
});
