/**
 * Live channel over HTTP: two people on a real server exchange ephemeral, encrypted,
 * signed messages for a database (see `src/core/live/LiveChannel.ts`).
 *
 * (The setup below is the one from `DemoServerTwoUserSync`:
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
 *    all documents.
 * 7. The admin makes the notes database read-only. Jane syncs that first, and her
 *    local write fails right away (client precheck). Karsten had already edited a
 *    document offline before the policy reached him; his push is refused by the
 *    server's Tier 1 check, the edit never reaches Jane, and reading stays open. Counter-check (second test): a tenant published without the
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
import { AccessDeniedError } from "../core/accesscontrol/AccessDeniedError";
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
  // Open event streams would keep `close()` waiting forever.
  running.httpServer.closeAllConnections();
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

/** Push without asserting: returns what the server accepted and rejected. */
async function pushResult(tenant: MindooTenant, baseUrl: string, dbId: string) {
  const local = await openDb(tenant, dbId);
  return local.pushChangesTo(await tenant.connectToServer(baseUrl, dbId));
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



import { isLiveTransport, openLiveChannel, type LiveMessage } from "../core/live/LiveChannel";

describe("live channel", () => {
  jest.setTimeout(90000);
  const crypto = new NodeCryptoAdapter();
  let demo: RunningServer | undefined;
  afterEach(async () => { await stopServer(demo); demo = undefined; });

  async function until(condition: () => boolean, ms = 5000): Promise<void> {
    const end = Date.now() + ms;
    while (!condition()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  test("typing notices reach the other reader, encrypted, signed and never echoed", async () => {
    demo = await startServer("live-server", DEMO_CONFIG);
    const baseUrl = demo.baseUrl;
    const tenantId = `live-${Date.now().toString(16)}`;
    const factoryA = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    const adminUser = await factoryA.createUserId(`cn=admin/o=${tenantId}`, KARSTEN_PASSWORD);
    const karstenUser = await factoryA.createUserId(`cn=karsten/o=${tenantId}`, KARSTEN_PASSWORD);
    await factoryA.ensureUserKeyPair(karstenUser, KARSTEN_PASSWORD);
    const { tenant: karsten } = await factoryA.createTenant({ tenantId, adminUser, adminPassword: KARSTEN_PASSWORD, appUser: karstenUser, userPassword: KARSTEN_PASSWORD });
    karsten.noteUserDirectoryFetched!();
    await karsten.reconcileUserKeys!({ allowSelfCreate: true });

    const ROOM = "mchat_live";
    const room = await openDb(karsten, ROOM);
    await room.createDocument({ initialValues: { text: "hello" } });
    await karsten.publishToServer(baseUrl, { systemAdminUser: adminUser, systemAdminPassword: KARSTEN_PASSWORD, adminUsername: adminUser.username });
    const adminAuth = { user: adminUser, password: KARSTEN_PASSWORD };
    await push(karsten, baseUrl, "directory", adminAuth);
    await push(karsten, baseUrl, USER_DIRECTORY_DB_ID);
    await push(karsten, baseUrl, ROOM);

    const factoryB = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    const janeUser = await factoryB.createUserId(`cn=jane/o=${tenantId}`, JANE_PASSWORD);
    await factoryB.ensureUserKeyPair(janeUser, JANE_PASSWORD);
    const janeAuth = { user: janeUser, password: JANE_PASSWORD };
    const joinRequest = factoryB.createJoinRequest(janeUser, { label: "Jane Laptop" });
    await karsten.approveJoinRequest(joinRequest, { adminSigningKey: adminUser.userSigningKeyPair.privateKey, adminPassword: KARSTEN_PASSWORD, adminUsername: adminUser.username, label: "Jane Laptop", serverUrl: baseUrl });
    await push(karsten, baseUrl, "directory", adminAuth);
    await push(karsten, baseUrl, USER_DIRECTORY_DB_ID);
    const delivery = (await factoryB.discoverTenantsOnServer(baseUrl, janeAuth)).find((d) => d.tenantId === tenantId);
    const jane = (await factoryB.bootstrapTenantFromDelivery(delivery!, { ...janeAuth, serverUrl: baseUrl })).tenant;
    await pull(jane, baseUrl, "directory");
    await pull(jane, baseUrl, USER_DIRECTORY_DB_ID);
    jane.noteUserDirectoryFetched!();
    await jane.reconcileUserKeys!();
    await jane.reconcileKeyDistributionsForCurrentUser!();
    await pull(jane, baseUrl, ROOM);

    const karstenRemote = await karsten.connectToServer(baseUrl, ROOM);
    const janeRemote = await jane.connectToServer(baseUrl, ROOM);
    expect(isLiveTransport(karstenRemote)).toBe(true);
    if (!isLiveTransport(karstenRemote) || !isLiveTransport(janeRemote)) throw new Error("no live transport");

    const karstenChannel = openLiveChannel(karsten, karstenRemote, { keyId: "default" });
    const janeChannel = openLiveChannel(jane, janeRemote, { keyId: "default" });
    const atKarsten: LiveMessage[] = [];
    const atJane: LiveMessage[] = [];
    karstenChannel.onMessage((message) => atKarsten.push(message));
    janeChannel.onMessage((message) => atJane.push(message));
    await until(() => karstenChannel.state === "connected" && janeChannel.state === "connected");

    // Karsten types: Jane sees it with his checked name, he gets no echo.
    await karstenChannel.send("typing", { until: 123 });
    await until(() => atJane.length === 1);
    expect(atJane[0]).toMatchObject({ from: karstenUser.username, type: "typing", data: { until: 123 } });
    expect(Math.abs(Date.now() - atJane[0]!.sentAt)).toBeLessThan(5000);
    await janeChannel.send("here");
    await until(() => atKarsten.length === 1);
    expect(atKarsten[0]).toMatchObject({ from: janeUser.username, type: "here", data: null });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(atKarsten).toHaveLength(1);
    expect(atJane).toHaveLength(1);

    // What travels is ciphertext: the server-side relay never sees "typing".
    const relayed: string[] = [];
    const stopTap = (janeRemote as any).subscribeToLive((event: { payload: string }) => relayed.push(Buffer.from(event.payload, "base64").toString("utf8")));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await karstenChannel.send("typing", { secret: "do not leak" });
    await until(() => relayed.length === 1);
    expect(relayed[0]).not.toContain("typing");
    expect(relayed[0]).not.toContain("do not leak");
    stopTap();
    await until(() => atJane.length === 2);

    // A channel on another key cannot read it, and a stale message is dropped.
    const wrongKey = openLiveChannel(jane, janeRemote, { keyId: "$publicinfos" });
    const stale = openLiveChannel(jane, janeRemote, { keyId: "default", now: () => Date.now() + 10 * 60_000 });
    const atWrongKey: LiveMessage[] = [];
    const atStale: LiveMessage[] = [];
    wrongKey.onMessage((message) => atWrongKey.push(message));
    stale.onMessage((message) => atStale.push(message));
    await until(() => wrongKey.state === "connected" && stale.state === "connected");
    await karstenChannel.send("typing");
    await until(() => atJane.length === 3);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(atWrongKey).toEqual([]);
    expect(atStale).toEqual([]);
    wrongKey.close();
    stale.close();

    // Too large for a live message.
    await expect(karstenChannel.send("blob", "x".repeat(20_000))).rejects.toThrow(/at most/);

    // The server throttles a flood (40 messages per 10 s and device).
    let refused = 0;
    for (let i = 0; i < 45; i++) {
      await karstenChannel.send("typing").catch(() => { refused += 1; });
    }
    expect(refused).toBeGreaterThan(0);

    karstenChannel.close();
    janeChannel.close();
    await expect(karstenChannel.send("typing")).rejects.toThrow(/closed/);
  });
});
