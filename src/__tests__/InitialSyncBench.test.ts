/**
 * Opt-in benchmark: first sync of an empty local replica against a local
 * MindooDBServer over HTTP.
 *
 * Device 1 founds a tenant, writes BENCH_DOCS documents with
 * BENCH_CHANGES changes each into `main` and pushes it. Device 2 joins as a
 * second device of the same person and pulls `main` into an empty store —
 * the same path a fresh Haven install takes.
 *
 * Reports request count per endpoint, bytes on the wire, and wall time split
 * into scan / getEntries (server + wire + client decrypt) / local putEntries /
 * local processing (syncStoreChanges). BENCH_LATENCY_MS adds a fixed delay
 * to every sync request to approximate a real network round trip.
 *
 *   BENCH=1 BENCH_DOCS=2000 BENCH_CHANGES=3 BENCH_LATENCY_MS=40 \
 *     npx jest --runInBand InitialSyncBench
 */
import fs from "fs";
import * as inspector from "inspector";
import * as zlib from "zlib";
import { Server } from "http";

import { IsolatedInMemoryStoreFactory } from "./_helpers/multiDevice";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { BaseMindooDB } from "../core/BaseMindooDB";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { ClientNetworkContentAddressedStore } from "../appendonlystores/network/ClientNetworkContentAddressedStore";
import { ServerNetworkContentAddressedStore } from "../appendonlystores/network/ServerNetworkContentAddressedStore";
import { BasicOnDiskContentAddressedStore } from "../node/appendonlystores/BasicOnDiskContentAddressedStore";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { MindooDBServer } from "../node/server/MindooDBServer";
import {
  DEFAULT_TENANT_KEY_ID,
  StoreKind,
  USER_DIRECTORY_DB_ID,
  type MindooTenant,
  type PrivateUserId,
} from "../core/types";
import type { ServerConfig } from "../node/server/types";

const RUN = process.env.BENCH === "1";
const DOCS = Number(process.env.BENCH_DOCS ?? 1000);
const CHANGES = Number(process.env.BENCH_CHANGES ?? 3);
const LATENCY_MS = Number(process.env.BENCH_LATENCY_MS ?? 0);
/** Writes a CPU profile of the measured section to this path. */
const PROFILE_PATH = process.env.BENCH_PROFILE;
/**
 * Local indexes on the receiving replica: "both" (summary buffer + full-text
 * index, the default), "summary" (summary buffer only, as in Haven for a
 * database without `fulltextSetup`) or "none".
 */
const INDEX_MODE = process.env.BENCH_INDEXES ?? "both";
const SUMMARY = INDEX_MODE !== "none";
const FULLTEXT = INDEX_MODE === "both";
const DB_ID = "main";

const PASSWORD = "bench-pass";
const SYSTEM_ADMIN_PASSWORD = "sysadmin-pass";
const SERVER_PASSWORD = "server-bench-pass";

type Stat = { calls: number; ms: number };
const stats = new Map<string, Stat>();
function record(name: string, ms: number): void {
  const s = stats.get(name) ?? { calls: 0, ms: 0 };
  s.calls++;
  s.ms += ms;
  stats.set(name, s);
}

/** Wrap an async prototype method so its calls and wall time are recorded. */
function timeMethod(proto: any, method: string, label: string): () => void {
  const original = proto[method];
  if (typeof original !== "function") return () => {};
  proto[method] = async function (this: unknown, ...args: unknown[]) {
    const t0 = performance.now();
    try {
      return await original.apply(this, args);
    } finally {
      record(label, performance.now() - t0);
    }
  };
  return () => {
    proto[method] = original;
  };
}

type WireStat = {
  requests: number;
  bytesUp: number;
  bytesDown: number;
  bytesOnWire: number;
  brotliIfCompressed?: number;
  ms: number;
};
const wire = new Map<string, WireStat>();
let wireEnabled = false;
let sampleMeta: unknown = null;

function installFetchProbe(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    if (!wireEnabled) return originalFetch(input, init);
    const url = typeof input === "string" ? input : input.url;
    // Last path segment names the endpoint; the one before it the store kind.
    const parts = new URL(url).pathname.split("/");
    const key = parts.slice(parts.length > 2 ? -2 : -1).join("/");
    if (LATENCY_MS > 0) await new Promise((r) => setTimeout(r, LATENCY_MS));
    const t0 = performance.now();
    const res = await originalFetch(input, init);
    const buf = await res.arrayBuffer();
    const s = wire.get(key) ?? { requests: 0, bytesUp: 0, bytesDown: 0, bytesOnWire: 0, ms: 0 };
    s.requests++;
    const body = init?.body;
    s.bytesUp += typeof body === "string" ? body.length : body?.byteLength ?? 0;
    s.ms += performance.now() - t0;
    s.bytesDown += buf.byteLength;
    // fetch() decodes br/gzip transparently; Content-Length is the encoded size.
    s.bytesOnWire += Number(res.headers.get("content-length") ?? buf.byteLength);
    if (key.endsWith("getEntriesBinary")) {
      // Octet-stream bodies are not compressed by the server today; measure
      // what brotli (dynamic quality, as for JSON) would make of them.
      s.brotliIfCompressed =
        (s.brotliIfCompressed ?? 0) +
        zlib.brotliCompressSync(new Uint8Array(buf), {
          params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
        }).byteLength;
    }
    if (key.endsWith("scanEntriesSince") && !sampleMeta) {
      sampleMeta = JSON.parse(new TextDecoder().decode(buf))?.entries?.[0] ?? null;
    }
    wire.set(key, s);
    return new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

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

async function pushDb(
  tenant: MindooTenant,
  baseUrl: string,
  dbId: string,
  auth?: { user: PrivateUserId; password: string },
): Promise<void> {
  const local = await tenant.openDB(dbId, dbId === "directory" ? { adminOnlyDb: true } : undefined);
  const remote = await tenant.connectToServer(baseUrl, dbId);
  const result = await local.pushChangesTo(remote, auth ? { networkAuthOverride: auth } : undefined);
  expect(result.cancelled).toBe(false);
}

async function pullDb(tenant: MindooTenant, baseUrl: string, dbId: string): Promise<void> {
  const local = await tenant.openDB(dbId, dbId === "directory" ? { adminOnlyDb: true } : undefined);
  const remote = await tenant.connectToServer(baseUrl, dbId);
  await local.pullChangesFrom(remote);
  await local.syncStoreChanges();
}

function sampleText(i: number, n: number): string {
  return `Doc ${i} rev ${n}: ` + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(6);
}

/** Written to stderr directly so `jest --silent` keeps the report readable. */
function report(text: string): void {
  process.stderr.write(`[bench] ${text}\n`);
}

const maybe = RUN ? describe : describe.skip;

maybe("initial sync benchmark", () => {
  jest.setTimeout(3_600_000);

  test(`empty replica pulls ${DOCS} docs x ${CHANGES} changes (latency ${LATENCY_MS} ms)`, async () => {
    const cryptoAdapter = new NodeCryptoAdapter();
    const dataDir = `/tmp/mindoodb-initial-sync-bench-${Date.now()}`;
    fs.mkdirSync(dataDir, { recursive: true });

    const bootstrapFactory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), cryptoAdapter);
    const serverIdentity = await bootstrapFactory.createUserId("CN=bench-server", SERVER_PASSWORD);
    fs.writeFileSync(`${dataDir}/server.identity.json`, JSON.stringify(serverIdentity, null, 2), "utf-8");
    fs.writeFileSync(`${dataDir}/trusted-servers.json`, "[]", "utf-8");
    const systemAdmin = await bootstrapFactory.createUserId("cn=sysadmin/o=bench", SYSTEM_ADMIN_PASSWORD);
    const config: ServerConfig = {
      capabilities: {
        "ALL:/system/*": [
          { username: systemAdmin.username, publicsignkey: systemAdmin.userSigningKeyPair.publicKey as string },
        ],
      },
      rateLimits: { sync: { windowMs: 60_000, max: 1_000_000 } },
    };

    const server = new MindooDBServer(dataDir, SERVER_PASSWORD, undefined, config);
    const { httpServer, baseUrl } = await startServer(server);
    const restoreFetch = installFetchProbe();

    try {
      const tenantId = `bench-${Date.now().toString(16)}`;
      const device1Factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), cryptoAdapter);
      const adminUser = await device1Factory.createUserId(`cn=admin/o=${tenantId}`, PASSWORD);
      const device1User = await device1Factory.createUserId(`cn=bench/o=${tenantId}`, PASSWORD);
      await device1Factory.ensureUserKeyPair(device1User, PASSWORD);
      const { tenant: device1Tenant } = await device1Factory.createTenant({
        tenantId,
        adminUser,
        adminPassword: PASSWORD,
        appUser: device1User,
        userPassword: PASSWORD,
      });
      device1Tenant.noteUserDirectoryFetched!();
      await device1Tenant.reconcileUserKeys!({ allowSelfCreate: true });

      // ── Seed ──────────────────────────────────────────────────────────
      const tSeed = performance.now();
      const mainDb = await device1Tenant.openDB(DB_ID);
      if (FULLTEXT) {
        // Synced `dbsetup`: the joining replica activates its full-text
        // index from it while the documents stream in.
        await mainDb.setFulltextSetup({ enabled: true });
      }
      for (let i = 0; i < DOCS; i++) {
        const doc = await mainDb.createDocument();
        for (let c = 0; c < CHANGES; c++) {
          await mainDb.changeDoc(doc, (d) => {
            const data = d.getData();
            data.title = `Document ${i}`;
            data.status = c % 2 === 0 ? "open" : "done";
            data.counter = c;
            data.body = sampleText(i, c);
          });
        }
      }
      report(`seeded ${DOCS} docs in ${((performance.now() - tSeed) / 1000).toFixed(1)} s`);

      await device1Tenant.publishToServer(baseUrl, {
        systemAdminUser: systemAdmin,
        systemAdminPassword: SYSTEM_ADMIN_PASSWORD,
        adminUsername: adminUser.username,
      });
      const adminAuth = { user: adminUser, password: PASSWORD };
      await pushDb(device1Tenant, baseUrl, "directory", adminAuth);
      await pushDb(device1Tenant, baseUrl, USER_DIRECTORY_DB_ID);
      const tPush = performance.now();
      await pushDb(device1Tenant, baseUrl, DB_ID);
      report(`pushed main in ${((performance.now() - tPush) / 1000).toFixed(1)} s`);

      // ── Device 2 joins ───────────────────────────────────────────────
      const device2Factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), cryptoAdapter);
      const device2User = await device2Factory.createUserId("", PASSWORD);
      await device2Factory.ensureUserKeyPair(device2User, PASSWORD);
      const joinRequest = device2Factory.createJoinRequest(device2User, { label: "Bench2" });
      await device1Tenant.approveJoinRequest(joinRequest, {
        adminSigningKey: adminUser.userSigningKeyPair.privateKey,
        adminPassword: PASSWORD,
        username: device1User.username,
        label: "Bench2",
        serverUrl: baseUrl,
      });
      await pushDb(device1Tenant, baseUrl, "directory", adminAuth);
      await pushDb(device1Tenant, baseUrl, USER_DIRECTORY_DB_ID);
      const deliveries = await device2Factory.discoverTenantsOnServer(baseUrl, {
        user: device2User,
        password: PASSWORD,
      });
      const delivery = deliveries.find((d) => d.tenantId === tenantId)!;
      const joined = await device2Factory.bootstrapTenantFromDelivery(delivery, {
        user: device2User,
        password: PASSWORD,
        serverUrl: baseUrl,
      });
      await pullDb(joined.tenant, baseUrl, "directory");
      await joined.tenant.reconcileKeyDistributionsForCurrentUser!();
      expect(await joined.tenant.hasDecryptionKey!(DEFAULT_TENANT_KEY_ID)).toBe(true);

      // ── Measured: initial pull of main into an empty replica ─────────
      const restores = [
        timeMethod(ClientNetworkContentAddressedStore.prototype, "scanEntriesSince", "client.scanEntriesSince"),
        timeMethod(ClientNetworkContentAddressedStore.prototype, "getEntries", "client.getEntries (wire+server+decrypt)"),
        timeMethod(ClientNetworkContentAddressedStore.prototype, "getIdBloomSummary", "client.getIdBloomSummary"),
        timeMethod(ClientNetworkContentAddressedStore.prototype, "getStoreHead", "client.getStoreHead"),
        timeMethod(ServerNetworkContentAddressedStore.prototype, "handleScanEntriesSince", "server.handleScanEntriesSince"),
        timeMethod(ServerNetworkContentAddressedStore.prototype, "handleGetEntriesSessionWrapped", "server.getEntriesSessionWrapped"),
        timeMethod(InMemoryContentAddressedStore.prototype, "putEntries", "local.putEntries"),
        timeMethod(BasicOnDiskContentAddressedStore.prototype, "getEntries", "server.disk.getEntries"),
        timeMethod(BasicOnDiskContentAddressedStore.prototype, "scanEntriesSince", "server.disk.scanEntriesSince"),
        timeMethod(ServerNetworkContentAddressedStore.prototype, "validateToken", "server.validateToken"),
        timeMethod(ServerNetworkContentAddressedStore.prototype, "resolveReaderEncryptionKey", "server.resolveReaderEncryptionKey"),
        timeMethod(ServerNetworkContentAddressedStore.prototype, "resolveRevokedKeyIds", "server.resolveRevokedKeyIds"),
        timeMethod(ServerNetworkContentAddressedStore.prototype, "wipeAllowedIds", "server.wipeAllowedIds"),
        timeMethod(InMemoryContentAddressedStore.prototype, "hasEntries", "local.hasEntries"),
        timeMethod(BaseMindooDB.prototype, "syncStoreChanges", "local.syncStoreChanges"),
      ];
      wire.clear();
      stats.clear();
      const profiler = PROFILE_PATH ? new inspector.Session() : null;
      if (profiler) {
        profiler.connect();
        await new Promise<void>((resolve) => profiler.post("Profiler.enable", () => resolve()));
        await new Promise<void>((resolve) => profiler.post("Profiler.start", () => resolve()));
      }
      wireEnabled = true;
      const t0 = performance.now();
      // Same sequence as Haven's syncDatabaseTargetToConnection (scope "full",
      // bidirectional): docs + attachments store, push before pull.
      const steps: Array<[string, number]> = [];
      const step = async <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
        const ts = performance.now();
        try {
          return await fn();
        } finally {
          steps.push([name, performance.now() - ts]);
        }
      };
      const local = await step("openDB", () => joined.tenant.openDB(DB_ID));
      // Document loads during and after the pull, split into cache hits and
      // materializations (the database's own performance hook).
      const loads = { hits: 0, misses: 0, automergeMs: 0, verifyMs: 0, decryptMs: 0, totalMs: 0 };
      (local as unknown as { performanceCallback?: unknown }).performanceCallback = {
        onDocumentLoad: (m: {
          cacheHit: boolean;
          automergeTime: number;
          signatureVerificationTime: number;
          decryptionTime: number;
          totalTime: number;
        }) => {
          if (m.cacheHit) {
            loads.hits++;
            return;
          }
          loads.misses++;
          loads.automergeMs += m.automergeTime;
          loads.verifyMs += m.signatureVerificationTime;
          loads.decryptMs += m.decryptionTime;
          loads.totalMs += m.totalTime;
        },
      };
      if (SUMMARY) {
        // Haven's cold-start pattern: summary buffer active before the pull.
        local.getSummaryStore();
      }
      await step("syncStoreChanges (pre)", () => local.syncStoreChanges());
      const remote = await step("connect docs", () =>
        joined.tenant.connectToServer(baseUrl, DB_ID, StoreKind.docs),
      );
      const remoteAttachments = await step("connect attachments", () =>
        joined.tenant.connectToServer(baseUrl, DB_ID, StoreKind.attachments),
      );
      await step("push docs (empty)", () => local.pushChangesTo(remote, { storeKind: StoreKind.docs }));
      await step("push attachments (empty)", () =>
        local.pushChangesTo(remoteAttachments, { storeKind: StoreKind.attachments }),
      );
      const tPull = performance.now();
      const result = await step("pull docs", () => local.pullChangesFrom(remote, { storeKind: StoreKind.docs }));
      const pullMs = performance.now() - tPull;
      await step("pull attachments", () =>
        local.pullChangesFrom(remoteAttachments, { storeKind: StoreKind.attachments }),
      );
      const tProc = performance.now();
      await local.syncStoreChanges();
      const tailMs = performance.now() - tProc;
      // Summary buffer and full-text index follow the changefeed in the
      // background; the replica is fully usable once they have caught up.
      const tIdx = performance.now();
      await (joined.tenant as { whenBackgroundIdle?: () => Promise<void> }).whenBackgroundIdle?.();
      if (SUMMARY) await local.getSummaryStore().update();
      if (FULLTEXT) await local.getFullTextIndex().update();
      const indexMs = performance.now() - tIdx;
      const tQuery = performance.now();
      const allIds = await local.getAllDocumentIds();
      const queryMs = performance.now() - tQuery;
      // First read of every document: what an app's first list view pays.
      const tRead = performance.now();
      for (const id of allIds) {
        await local.getDocument(id);
      }
      const readMs = performance.now() - tRead;
      const totalMs = performance.now() - t0;
      wireEnabled = false;
      restores.forEach((r) => r());
      if (profiler) {
        const profile = await new Promise<unknown>((resolve) =>
          profiler.post("Profiler.stop", (_err, result) => resolve(result?.profile)),
        );
        fs.writeFileSync(PROFILE_PATH!, JSON.stringify(profile));
        profiler.disconnect();
      }

      // The `dbsetup` document carrying the full-text setup is one more.
      expect(allIds.length).toBe(DOCS + (FULLTEXT ? 1 : 0));
      if (FULLTEXT) {
        const { hits } = await local.getFullTextIndex().search("Document");
        expect(hits.length).toBeGreaterThan(0);
      }

      const fmt = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
      const lines: string[] = [];
      lines.push(`docs=${DOCS} changes/doc=${CHANGES} latency=${LATENCY_MS}ms indexes=${INDEX_MODE}`);
      lines.push(`entries transferred=${result.transferredEntries} bytes=${result.transferredBytes}`);
      lines.push(`total=${fmt(totalMs)} pull=${fmt(pullMs)} tail syncStoreChanges=${fmt(tailMs)} indexes caught up after pull=${fmt(indexMs)} getAllDocumentIds=${fmt(queryMs)} first getDocument of all=${fmt(readMs)}`);
      lines.push(
        `document loads: ${loads.misses} materialized (${fmt(loads.totalMs)}: automerge ${fmt(loads.automergeMs)}, ` +
          `verify ${fmt(loads.verifyMs)}, decrypt ${fmt(loads.decryptMs)}), ${loads.hits} cache hits`,
      );
      lines.push("-- steps (Haven sequence) --");
      for (const [name, ms] of steps) lines.push(`${name.padEnd(30)} ${fmt(ms)}`);
      lines.push("-- wire (per endpoint) --");
      let totalReq = 0;
      let totalDown = 0;
      for (const [k, s] of [...wire.entries()].sort((a, b) => b[1].ms - a[1].ms)) {
        totalReq += s.requests;
        totalDown += s.bytesDown;
        lines.push(
          `${k.padEnd(40)} req=${String(s.requests).padStart(5)} up=${(s.bytesUp / 1024).toFixed(0).padStart(7)} KB down=${(s.bytesDown / 1024).toFixed(0).padStart(7)} KB wire=${(s.bytesOnWire / 1024).toFixed(0).padStart(7)} KB t=${fmt(s.ms)}` +
            (s.brotliIfCompressed ? ` (brotli would be ${(s.brotliIfCompressed / 1024).toFixed(0)} KB)` : ""),
        );
      }
      lines.push(`TOTAL requests=${totalReq} down=${(totalDown / 1024 / 1024).toFixed(2)} MB`);
      lines.push("-- method timings (cumulative, may overlap) --");
      for (const [k, s] of [...stats.entries()].sort((a, b) => b[1].ms - a[1].ms)) {
        lines.push(`${k.padEnd(45)} calls=${String(s.calls).padStart(5)} t=${fmt(s.ms)}`);
      }
      lines.push("-- sample scan metadata entry --");
      lines.push(JSON.stringify(sampleMeta, null, 1));
      report(lines.join("\n"));
    } finally {
      restoreFetch();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
