/**
 * End-to-end: HTTP peer replication between a Node server and the Cloudflare
 * host under `wrangler dev` (local, nothing deployed).
 *
 * 1. A write on the Node server reaches Cloudflare through Cloudflare's cron
 *    tick (Cloudflare pulls; the Node server only answers peer requests).
 * 2. A write on Cloudflare reaches the Node server right away (the database
 *    object reports it, the server object pushes).
 * 3. With replication started on Node too, a Node write reaches Cloudflare
 *    by the Node replicator's push, which authenticates on Cloudflare's tenant
 *    routes with a peer token.
 *
 * Opt-in like CloudflareWorker.test.ts:
 *   MINDOODB_CLOUDFLARE_TESTS=1 WRANGLER_BIN=/path/to/wrangler pnpm test CloudflarePeerReplication
 */

import fs from "fs";
import os from "os";
import path from "path";
import { Server } from "http";

import { IsolatedInMemoryStoreFactory } from "./_helpers/multiDevice";
import { findWrangler, startCloudflareWorker, type RunningWorker } from "./_helpers/cloudflareWorker";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { MindooDBServerAdmin } from "../core/MindooDBServerAdmin";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { MindooDBServer } from "../node/server/MindooDBServer";
import type { MindooTenant, PrivateUserId } from "../core/types";

const enabled = process.env.MINDOODB_CLOUDFLARE_TESTS === "1" && findWrangler() !== null;
const describeWorker = enabled ? describe : describe.skip;

const NODE_SERVER_PASSWORD = "node-peer-pass";
const CF_SERVER_PASSWORD = "cf-peer-pass";
const SYSADMIN_PASSWORD = "peer-sysadmin-pass";
const PASSWORD = "peer-user-pass";

async function push(tenant: MindooTenant, baseUrl: string, dbId: string, auth?: { user: PrivateUserId; password: string }) {
  const local = await tenant.openDB(dbId, dbId === "directory" ? { adminOnlyDb: true } : undefined);
  const remote = await tenant.connectToServer(baseUrl, dbId);
  const result = await local.pushChangesTo(remote, auth ? { networkAuthOverride: auth } : undefined);
  expect(result.cancelled).toBe(false);
}

async function pullTitles(tenant: MindooTenant, baseUrl: string, dbId: string): Promise<string[]> {
  const local = await tenant.openDB(dbId, dbId === "directory" ? { adminOnlyDb: true } : undefined);
  const remote = await tenant.connectToServer(baseUrl, dbId);
  await local.pullChangesFrom(remote);
  await local.syncStoreChanges();
  const titles: string[] = [];
  for (const id of await local.getAllDocumentIds()) {
    titles.push(String((await local.getDocument(id)).getData().title));
  }
  return titles.sort();
}

async function addDoc(tenant: MindooTenant, dbId: string, title: string) {
  const db = await tenant.openDB(dbId);
  const doc = await db.createDocument();
  await db.changeDoc(doc, async (d) => {
    d.getData().title = title;
  });
}

/** Retry `check` until it holds, calling `nudge` between attempts. */
async function eventually(check: () => Promise<boolean>, nudge: () => Promise<void> = async () => undefined) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("condition not met within 60 s");
    await nudge();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

describeWorker("peer replication Node <-> Cloudflare (wrangler dev)", () => {
  jest.setTimeout(300_000);

  const crypto = new NodeCryptoAdapter();
  const previousInsecure = process.env.MINDOODB_ALLOW_INSECURE_SYNC_URLS;
  let worker: RunningWorker;
  let nodeServer: MindooDBServer;
  let httpServer: Server;
  let nodeUrl: string;
  let dataDir: string;
  let sysadmin: PrivateUserId;

  beforeAll(async () => {
    process.env.MINDOODB_ALLOW_INSECURE_SYNC_URLS = "true";
    const bootstrap = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    sysadmin = await bootstrap.createUserId("cn=sysadmin/o=peer-test", SYSADMIN_PASSWORD);
    const globals = globalThis as { __MINDOODB_PBKDF2_ITERATIONS?: number };
    globals.__MINDOODB_PBKDF2_ITERATIONS = 100_000;
    const cfIdentity = await bootstrap.createUserId("CN=cf-peer", CF_SERVER_PASSWORD);
    delete globals.__MINDOODB_PBKDF2_ITERATIONS;
    const nodeIdentity = await bootstrap.createUserId("CN=node-peer", NODE_SERVER_PASSWORD);

    worker = await startCloudflareWorker({
      serverIdentity: cfIdentity,
      serverPassword: CF_SERVER_PASSWORD,
      systemAdmin: sysadmin,
      serverConfig: { cluster: { autoSync: true } },
      vars: { MINDOODB_ALLOW_INSECURE_SYNC_URLS: "true" },
    });

    // The Node server trusts Cloudflare (with its url, so it can replicate
    // later); Cloudflare learns about the Node server through its admin API.
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mindoodb-node-peer-"));
    fs.writeFileSync(path.join(dataDir, "server.identity.json"), JSON.stringify(nodeIdentity));
    fs.writeFileSync(
      path.join(dataDir, "trusted-servers.json"),
      JSON.stringify([
        {
          name: cfIdentity.username,
          signingPublicKey: cfIdentity.userSigningKeyPair.publicKey,
          encryptionPublicKey: cfIdentity.userEncryptionKeyPair.publicKey,
          url: worker.baseUrl,
        },
      ]),
    );
    nodeServer = new MindooDBServer(dataDir, NODE_SERVER_PASSWORD, undefined, {
      capabilities: {
        "ALL:/system/*": [
          { username: sysadmin.username, publicsignkey: sysadmin.userSigningKeyPair.publicKey as string },
        ],
      },
    });
    await new Promise<void>((resolve, reject) => {
      httpServer = nodeServer.getApp().listen(0, "127.0.0.1", () => {
        const address = httpServer.address();
        if (!address || typeof address === "string") {
          reject(new Error("no port"));
          return;
        }
        nodeUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });

    const cfAdmin = new MindooDBServerAdmin({
      serverUrl: worker.baseUrl,
      systemAdminUser: sysadmin,
      systemAdminPassword: SYSADMIN_PASSWORD,
      cryptoAdapter: crypto,
    });
    await cfAdmin.addTrustedServer({
      name: nodeIdentity.username,
      signingPublicKey: nodeIdentity.userSigningKeyPair.publicKey as string,
      encryptionPublicKey: nodeIdentity.userEncryptionKeyPair.publicKey as string,
      url: nodeUrl,
    });
  });

  afterAll(async () => {
    await nodeServer?.stopCluster();
    await new Promise<void>((resolve) => (httpServer ? httpServer.close(() => resolve()) : resolve()));
    await worker?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    if (previousInsecure === undefined) delete process.env.MINDOODB_ALLOW_INSECURE_SYNC_URLS;
    else process.env.MINDOODB_ALLOW_INSECURE_SYNC_URLS = previousInsecure;
  });

  test("both directions, cron pull and change push", async () => {
    const tenantId = `peer-${Date.now().toString(16)}`;
    const factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    const adminUser = await factory.createUserId(`cn=admin/o=${tenantId}`, PASSWORD);
    const appUser = await factory.createUserId(`cn=karsten/o=${tenantId}`, PASSWORD);
    await factory.ensureUserKeyPair(appUser, PASSWORD);
    const created = await factory.createTenant({
      tenantId,
      adminUser,
      adminPassword: PASSWORD,
      appUser,
      userPassword: PASSWORD,
    });
    const device1 = created.tenant;
    device1.noteUserDirectoryFetched!();
    await device1.reconcileUserKeys!({ allowSelfCreate: true });

    // Both servers host the tenant (replication only covers shared tenants);
    // the directory and data go to the Node server only.
    for (const url of [nodeUrl, worker.baseUrl]) {
      await device1.publishToServer(url, {
        systemAdminUser: sysadmin,
        systemAdminPassword: SYSADMIN_PASSWORD,
        adminUsername: adminUser.username,
      });
    }
    await push(device1, nodeUrl, "directory", { user: adminUser, password: PASSWORD });
    await addDoc(device1, "notes", "from-node-1");
    await push(device1, nodeUrl, "notes");

    // A second device that only talks to Cloudflare.
    const device2 = await new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto).openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      appUser,
      PASSWORD,
      created.keyBag,
    );

    // 1. Cloudflare pulls on its cron tick.
    await eventually(
      async () => {
        try {
          await pullTitles(device2, worker.baseUrl, "directory");
          return (await pullTitles(device2, worker.baseUrl, "notes")).includes("from-node-1");
        } catch {
          return false;
        }
      },
      () => worker.triggerCron(),
    );

    // 2. A write on Cloudflare is pushed to the Node server.
    await addDoc(device2, "notes", "from-cf-1");
    await push(device2, worker.baseUrl, "notes");
    await eventually(async () => (await pullTitles(device1, nodeUrl, "notes")).includes("from-cf-1"));

    // 3. The Node server replicates on its own and pushes into Cloudflare.
    nodeServer.startCluster();
    await addDoc(device1, "notes", "from-node-2");
    await push(device1, nodeUrl, "notes");
    await eventually(async () => (await pullTitles(device2, worker.baseUrl, "notes")).includes("from-node-2"));

    expect(await pullTitles(device2, worker.baseUrl, "notes")).toEqual(["from-cf-1", "from-node-1", "from-node-2"]);
    expect(await pullTitles(device1, nodeUrl, "notes")).toEqual(["from-cf-1", "from-node-1", "from-node-2"]);

    // The cluster admin surface on Cloudflare reports the link.
    const cfAdmin = new MindooDBServerAdmin({
      serverUrl: worker.baseUrl,
      systemAdminUser: sysadmin,
      systemAdminPassword: SYSADMIN_PASSWORD,
      cryptoAdapter: crypto,
    });
    const status = (await cfAdmin.getClusterStatus()) as { peers: Array<{ name: string }> };
    expect(status.peers.map((peer) => peer.name)).toEqual(["CN=node-peer"]);
    const action = (await cfAdmin.runClusterAction("sync", {})) as { jobId: string };
    expect(typeof action.jobId).toBe("string");
    const mirrors = await fetch(`${worker.baseUrl}/.well-known/mindoodb-cluster?tenantId=${tenantId}`);
    expect((await mirrors.json()).mirrors).toEqual([
      expect.objectContaining({ name: "CN=node-peer", url: nodeUrl }),
    ]);
  });
});
