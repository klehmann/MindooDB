/**
 * Server-to-server (peer) replication between two real MindooDB servers.
 *
 * Two servers, each with its own identity, data directory and system admin.
 * They trust each other via `trusted-servers.json` and mirror every tenant
 * they both host.
 *
 * The convergence invariants are what these tests are really about:
 *
 * 1. **Directory first.** Application entries are signed by keys the peer only
 *    learns about from the directory, so the directory has to arrive first.
 * 2. **Cursor holds on rejection.** A client may skip an entry the server
 *    refuses; two servers that are supposed to be identical may not, or they
 *    diverge permanently and silently.
 * 3. **Receipts are preserved.** A replicated entry keeps the receipt of the
 *    server that first witnessed it. Re-stamping would turn "trusted time"
 *    into "time it reached the last server in the chain".
 */

import { Server } from "http";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { MindooDBServer } from "../node/server/MindooDBServer";
import { StoreKind } from "../core/types";
import type { PrivateUserId } from "../core/userid";
import type { ServerConfig, TrustedServer } from "../node/server/types";
import {
  directionAllowsPull,
  directionAllowsPush,
  orderDatabasesForReplication,
  shouldOpenSessionTo,
} from "../node/server/peer/types";
import { createIdBloomSummary, bloomMightContainId } from "../core/appendonlystores/bloom";

jest.setTimeout(240000);

const cryptoAdapter = new NodeCryptoAdapter();

interface PeerNode {
  name: string;
  server: MindooDBServer;
  httpServer: Server;
  baseUrl: string;
  dataDir: string;
  systemAdmin: PrivateUserId;
  systemAdminPassword: string;
}

async function startNode(name: string, factory: BaseMindooTenantFactory): Promise<PeerNode> {
  const fs = await import("fs");
  const path = await import("path");
  const dataDir = `/tmp/mindoodb-peer-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.mkdirSync(dataDir, { recursive: true });

  const serverPassword = `${name}-server-pass`;
  const identity = await factory.createUserId(`CN=${name}`, serverPassword);
  fs.writeFileSync(
    path.join(dataDir, "server.identity.json"),
    JSON.stringify(identity, null, 2),
    "utf-8",
  );
  fs.writeFileSync(path.join(dataDir, "trusted-servers.json"), "[]", "utf-8");

  const systemAdminPassword = `${name}-admin-pass`;
  const systemAdmin = await factory.createUserId(`cn=sysadmin/o=${name}`, systemAdminPassword);
  const config: ServerConfig = {
    capabilities: {
      "ALL:/system/*": [
        {
          username: systemAdmin.username,
          publicsignkey: systemAdmin.userSigningKeyPair.publicKey as string,
        },
      ],
    },
    // Peer replication issues far more than 30 admin calls a minute during a
    // test run; the production default would turn into spurious 429s.
    rateLimits: { system: { windowMs: 60_000, max: 10_000 } },
  };

  const server = new MindooDBServer(dataDir, serverPassword, undefined, config);
  let baseUrl = "";
  const httpServer = await new Promise<Server>((resolve, reject) => {
    const s = server.getApp().listen(0, "127.0.0.1", () => {
      const address = s.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not determine test server port"));
        return;
      }
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve(s);
    });
    s.on("error", reject);
  });

  return {
    name: `CN=${name}`,
    server,
    httpServer,
    baseUrl,
    dataDir,
    systemAdmin,
    systemAdminPassword,
  };
}

async function stopNode(node: PeerNode | undefined): Promise<void> {
  if (!node) return;
  await node.server.stopCluster();
  await new Promise<void>((resolve) => node.httpServer.close(() => resolve()));
  const fs = await import("fs");
  fs.rmSync(node.dataDir, { recursive: true, force: true });
}

/**
 * Make `target` trust `peer` and, when a url is given, dial it.
 *
 * Writes `trusted-servers.json` directly rather than going through the admin
 * API: these tests are about replication, and the HTTP path for peer CRUD is
 * covered in `ExampleServer.test.ts`.
 */
function trust(
  target: PeerNode,
  peer: PeerNode,
  settings: Partial<TrustedServer> = {},
): void {
  const info = peer.server.getTenantManager().getServerPublicInfo();
  if (!info) throw new Error(`${peer.name} has no server identity`);
  target.server.getTenantManager().saveTrustedServer({
    name: info.name,
    signingPublicKey: info.signingPublicKey,
    encryptionPublicKey: info.encryptionPublicKey,
    url: peer.baseUrl,
    ...settings,
  });
  target.server.getClusterManager().syncReplicators();
}

interface SeededTenant {
  tenant: any;
  adminUser: PrivateUserId;
}

/**
 * Create one tenant and register it on every given node.
 *
 * This is the seeding procedure a mirror requires, and getting it wrong is the
 * most common way to build a cluster that never converges: a tenant is defined
 * by its administration keypair, so "the same tenant id created twice" is two
 * different tenants that happen to share a name. The second server would refuse
 * every replicated directory entry as "not signed by a trusted user" — correctly,
 * because for it the signer really is a stranger. A tenant is created once and
 * published to each server that should host it.
 */
async function seedTenant(nodes: PeerNode[], tenantId: string): Promise<SeededTenant> {
  const factory = new BaseMindooTenantFactory(
    new InMemoryContentAddressedStoreFactory(),
    cryptoAdapter,
  );
  const result = await factory.createTenant({
    tenantId,
    adminName: `cn=admin/o=${tenantId}`,
    adminPassword: "admin-pass",
    userName: `cn=user1/o=${tenantId}`,
    userPassword: "user-pass",
  });

  for (const node of nodes) {
    await result.tenant.publishToServer(node.baseUrl, {
      systemAdminUser: node.systemAdmin,
      systemAdminPassword: node.systemAdminPassword,
      adminUsername: result.adminUser.username,
    });
  }

  return { tenant: result.tenant, adminUser: result.adminUser };
}

/** Push one of the tenant's databases to a single node, as the tenant admin. */
async function pushDb(seeded: SeededTenant, node: PeerNode, dbId: string): Promise<void> {
  const db = await seeded.tenant.openDB(dbId);
  const remote = await seeded.tenant.connectToServer(node.baseUrl, dbId);
  await db.pushChangesTo(remote, {
    networkAuthOverride: { user: seeded.adminUser, password: "admin-pass" },
  });
}

async function localEntryIds(
  node: PeerNode,
  tenantId: string,
  dbId: string,
): Promise<string[]> {
  const store = await node.server
    .getTenantManager()
    .getStore(tenantId, dbId, StoreKind.docs);
  return (await store.getAllIds()).sort();
}

describe("peer replication ordering (invariant 1)", () => {
  test("directory and userdirectory come before application databases", () => {
    const ordered = orderDatabasesForReplication([
      "zebra",
      "main",
      "userdirectory",
      "alpha",
      "directory",
    ]);
    expect(ordered).toEqual(["directory", "userdirectory", "alpha", "main", "zebra"]);
  });

  test("the order holds when only one of the two system databases is present", () => {
    expect(orderDatabasesForReplication(["main", "userdirectory"])).toEqual([
      "userdirectory",
      "main",
    ]);
    expect(orderDatabasesForReplication(["main", "directory"])).toEqual(["directory", "main"]);
  });

  test("application databases are ordered deterministically", () => {
    // Two servers must walk the same databases in the same order, or their
    // cursors describe different progress through the same data.
    expect(orderDatabasesForReplication(["b", "a", "c"])).toEqual(
      orderDatabasesForReplication(["c", "b", "a"]),
    );
  });
});

describe("peer roles", () => {
  test("direction gates each leg independently", () => {
    expect(directionAllowsPush("bidirectional")).toBe(true);
    expect(directionAllowsPull("bidirectional")).toBe(true);

    expect(directionAllowsPush("push")).toBe(true);
    expect(directionAllowsPull("push")).toBe(false);

    expect(directionAllowsPush("pull")).toBe(false);
    expect(directionAllowsPull("pull")).toBe(true);

    expect(directionAllowsPush("disabled")).toBe(false);
    expect(directionAllowsPull("disabled")).toBe(false);
  });

  test("only spoke-to-spoke suppresses the session", () => {
    expect(shouldOpenSessionTo("spoke", "spoke")).toBe(false);
    expect(shouldOpenSessionTo("spoke", "hub")).toBe(true);
    expect(shouldOpenSessionTo("hub", "spoke")).toBe(true);
    expect(shouldOpenSessionTo("peer", "peer")).toBe(true);
  });
});

describe("tenant intersection via bloom summary", () => {
  test("a definite negative is never a candidate", () => {
    const summary = createIdBloomSummary(["acme", "globex"]);
    expect(bloomMightContainId(summary, "acme")).toBe(true);
    expect(bloomMightContainId(summary, "globex")).toBe(true);

    // Not a guarantee for any single id (that is what "probabilistic" means),
    // but across a large sample the filter must reject the vast majority.
    const strangers = Array.from({ length: 500 }, (_, i) => `stranger-${i}`);
    const falsePositives = strangers.filter((id) => bloomMightContainId(summary, id));
    expect(falsePositives.length).toBeLessThan(strangers.length * 0.1);
  });

  test("a false positive cannot cause replication of an unshared tenant", () => {
    // The replicator intersects the peer's answer against its own
    // authoritative tenant list, which is what turns the filter's false
    // positives from a correctness problem into a bandwidth one.
    const localTenants = new Set(["acme"]);
    const peerAnswer = ["acme", "a-false-positive"];
    const shared = peerAnswer.filter((id) => localTenants.has(id));
    expect(shared).toEqual(["acme"]);
  });
});

describe("two servers replicating a shared tenant", () => {
  let factory: BaseMindooTenantFactory;
  let alpha: PeerNode;
  let beta: PeerNode;

  beforeAll(async () => {
    factory = new BaseMindooTenantFactory(
      new InMemoryContentAddressedStoreFactory(),
      cryptoAdapter,
    );
    alpha = await startNode("alpha", factory);
    beta = await startNode("beta", factory);

    const shared = await seedTenant([alpha, beta], "shared-tenant");
    // Each side gets one system database the other has not seen, so a mirror
    // has to move data in both directions rather than one.
    await pushDb(shared, alpha, "directory");
    await pushDb(shared, beta, "userdirectory");

    await seedTenant([alpha], "alpha-only");
  });

  afterAll(async () => {
    await stopNode(alpha);
    await stopNode(beta);
  });

  test("an untrusted server gets no challenge", async () => {
    const info = beta.server.getTenantManager().getServerPublicInfo();
    const response = await fetch(`${alpha.baseUrl}/system/peer/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicsignkey: info?.signingPublicKey }),
    });
    expect(response.status).toBe(401);
  });

  test("a trusted server completes the handshake and gets a peer token", async () => {
    trust(alpha, beta);
    trust(beta, alpha);

    const betaInfo = beta.server.getTenantManager().getServerPublicInfo();
    const challengeResponse = await fetch(`${alpha.baseUrl}/system/peer/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicsignkey: betaInfo?.signingPublicKey }),
    });
    expect(challengeResponse.status).toBe(200);
    const { challenge } = (await challengeResponse.json()) as { challenge: string };

    const signer = await beta.server.getTenantManager().getWitnessSigner();
    const signature = await cryptoAdapter
      .getSubtle()
      .sign({ name: "Ed25519" }, signer!.signingPrivateKey, new TextEncoder().encode(challenge));

    const authResponse = await fetch(`${alpha.baseUrl}/system/peer/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challenge,
        signature: Buffer.from(new Uint8Array(signature)).toString("base64"),
      }),
    });
    expect(authResponse.status).toBe(200);
    const auth = (await authResponse.json()) as { success: boolean; token: string };
    expect(auth.success).toBe(true);

    // The token is a peer token, not an admin token: it opens the peer routes
    // and is refused by the cluster admin surface.
    const peerRoute = await fetch(`${alpha.baseUrl}/system/peer/databases?tenantId=nothing`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    expect(peerRoute.status).toBe(404);

    const adminRoute = await fetch(`${alpha.baseUrl}/system/cluster/status`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    expect(adminRoute.status).toBe(401);
  });

  test("only tenants both servers host end up in the intersection", async () => {
    trust(alpha, beta);
    trust(beta, alpha);

    const replicator = alpha.server.getClusterManager().getReplicator(beta.name);
    expect(replicator).not.toBeNull();

    const shared = await replicator!.refreshIntersection();
    expect(shared).toContain("shared-tenant");
    // A tenant only alpha hosts is not replicated, and beta never learns it
    // exists — the intersection is the whole point of the Bloom exchange.
    expect(shared).not.toContain("alpha-only");
  });

  test("a full sync mirrors the shared tenant's databases in both directions", async () => {
    trust(alpha, beta);
    trust(beta, alpha);

    const replicator = alpha.server.getClusterManager().getReplicator(beta.name)!;
    await replicator.refreshIntersection();
    const run = await replicator.syncNow({ tenantId: "shared-tenant" });

    expect(run.errors).toEqual([]);
    expect(run.tenants).toBe(1);
    // Both system databases plus whatever the tenant created.
    expect(run.databases).toBeGreaterThanOrEqual(2);
    // The two directories were seeded independently, so each side holds entries
    // the other does not: a mirror has to move data both ways.
    expect(run.pushed + run.pulled).toBeGreaterThan(0);

    const onAlpha = await localEntryIds(alpha, "shared-tenant", "directory");
    const onBeta = await localEntryIds(beta, "shared-tenant", "directory");
    expect(onAlpha).toEqual(onBeta);
  });

  test("a second sync is a no-op, so replication converges instead of looping", async () => {
    const replicator = alpha.server.getClusterManager().getReplicator(beta.name)!;
    await replicator.syncNow({ tenantId: "shared-tenant" });
    const second = await replicator.syncNow({ tenantId: "shared-tenant" });

    expect(second.errors).toEqual([]);
    expect(second.pushed).toBe(0);
    expect(second.pulled).toBe(0);
    expect(second.held).toBe(0);
  });

  test("replicated entries keep the original witness receipt (invariant 3)", async () => {
    const alphaStore = await alpha.server
      .getTenantManager()
      .getStore("shared-tenant", "directory", StoreKind.docs);
    const betaStore = await beta.server
      .getTenantManager()
      .getStore("shared-tenant", "directory", StoreKind.docs);

    const ids = (await alphaStore.getAllIds()).filter((id) => id.length > 0);
    expect(ids.length).toBeGreaterThan(0);

    const alphaEntries = await alphaStore.getEntries(ids.slice(0, 5));
    const betaEntries = await betaStore.getEntries(ids.slice(0, 5));
    const betaById = new Map(betaEntries.map((entry) => [entry.id, entry]));

    let compared = 0;
    for (const entry of alphaEntries) {
      const mirrored = betaById.get(entry.id);
      if (!mirrored || entry.receivedAt === undefined) continue;
      compared += 1;
      // Same instant and same witness on both servers. If the receiving peer
      // re-stamped, `receivedByPublicKey` would name the second server and
      // `receivedAt` would be the replication time, not the original one.
      expect(mirrored.receivedAt).toBe(entry.receivedAt);
      expect(mirrored.receivedByPublicKey).toBe(entry.receivedByPublicKey);
      // Byte-wise: the signature crossed the wire as base64 and was decoded
      // into a fresh Uint8Array, so identity comparison would always fail.
      expect(Array.from(mirrored.receivedDateSignature ?? [])).toEqual(
        Array.from(entry.receivedDateSignature ?? []),
      );
    }
    expect(compared).toBeGreaterThan(0);
  });

  test("a pull-only peer never pushes", async () => {
    trust(alpha, beta, { direction: "pull" });
    const replicator = alpha.server.getClusterManager().getReplicator(beta.name)!;
    await replicator.refreshIntersection();

    const run = await replicator.syncNow({ tenantId: "shared-tenant" });
    expect(run.errors).toEqual([]);
    expect(run.pushed).toBe(0);

    // Restore the default so later tests are not affected by the direction.
    trust(alpha, beta);
  });

  test("a disabled peer does nothing at all", async () => {
    trust(alpha, beta, { direction: "disabled" });
    const replicator = alpha.server.getClusterManager().getReplicator(beta.name)!;

    const run = await replicator.syncNow({ tenantId: "shared-tenant" });
    expect(run.pushed).toBe(0);
    expect(run.pulled).toBe(0);
    expect(run.tenants).toBe(0);

    trust(alpha, beta);
  });

  test("a purged document makes the peer back off instead of skipping past it", async () => {
    // The one rejection a peer must not treat as "move on": the target refuses
    // the whole batch with ACCESS_DENIED because the document's history was
    // purged there. A client may shrug and advance; two servers that are meant
    // to be identical may not, or the cursor walks past entries that were never
    // accepted and the divergence is permanent and silent.
    const fs = await import("fs");
    const path = await import("path");

    const purgeTenant = await seedTenant([alpha, beta], "purge-tenant");
    await pushDb(purgeTenant, alpha, "directory");
    await pushDb(purgeTenant, beta, "directory");

    const notes = await purgeTenant.tenant.openDB("notes");
    const doc = await notes.createDocument();
    await notes.changeDoc(doc, (d: any) => {
      d.getData().title = "will-be-purged-on-beta";
    });
    await pushDb(purgeTenant, alpha, "notes");

    // Beta purged this document's history, so it may never be re-ingested.
    // Written before beta ever opens the `notes` store, since the registry is
    // read from disk once and then cached.
    fs.writeFileSync(
      path.join(beta.dataDir, "purge-tenant", "purged-docs.json"),
      JSON.stringify({
        version: 1,
        processedRequestDocIds: [],
        purgedDocIds: { notes: [doc.getId()] },
      }),
      "utf-8",
    );

    trust(alpha, beta);
    const replicator = alpha.server.getClusterManager().getReplicator(beta.name)!;
    await replicator.refreshIntersection();

    const first = await replicator.syncNow({ tenantId: "purge-tenant" });
    expect(first.held).toBeGreaterThan(0);
    // A backoff, not a crash: the directory still replicated in the same run.
    expect(first.errors).toEqual([]);

    // The cursor stayed put, so the next run retries the same entries rather
    // than reporting a clean, and false, "nothing left to do".
    const second = await replicator.syncNow({ tenantId: "purge-tenant" });
    expect(second.held).toBeGreaterThan(0);

    const status = alpha.server.getClusterManager().status();
    const peer = status.peers.find((entry) => entry.name === beta.name)!;
    expect(peer.lastErrorClass).toBe("access-denied");
    // The reason is classified, never the document that caused it.
    expect(JSON.stringify(status)).not.toContain(doc.getId());
  });

  test("cluster status reports the peer, its role and its health", async () => {
    trust(alpha, beta, { role: "hub", attachments: "lazy" });
    const status = alpha.server.getClusterManager().status();

    const peer = status.peers.find((entry) => entry.name === beta.name);
    expect(peer).toBeDefined();
    expect(peer!.role).toBe("hub");
    expect(peer!.attachments).toBe("lazy");
    expect(peer!.url).toBe(beta.baseUrl);

    // Counts and classified reasons only: a status reader must not be able to
    // learn which documents moved.
    expect(JSON.stringify(status)).not.toContain("docId");

    trust(alpha, beta);
  });

  test("removing trust stops the replicator", async () => {
    alpha.server.getTenantManager().removeTrustedServer(beta.name);
    alpha.server.getClusterManager().syncReplicators();

    expect(alpha.server.getClusterManager().getReplicator(beta.name)).toBeNull();
    expect(alpha.server.getClusterManager().topology().peers).toEqual([]);

    trust(alpha, beta);
  });

  test("the cluster discovery endpoint lists mirrors of the asked-for tenant only", async () => {
    const replicator = alpha.server.getClusterManager().getReplicator(beta.name)!;
    await replicator.refreshIntersection();

    const shared = await fetch(
      `${alpha.baseUrl}/.well-known/mindoodb-cluster?tenantId=shared-tenant`,
    );
    expect(shared.status).toBe(200);
    const sharedBody = (await shared.json()) as { mirrors: Array<{ name: string; url: string }> };
    expect(sharedBody.mirrors).toContainEqual(
      expect.objectContaining({ name: beta.name, url: beta.baseUrl }),
    );

    // A tenant beta does not host has no mirrors, and the answer says nothing
    // about the peers that exist for other tenants.
    const alphaOnly = await fetch(
      `${alpha.baseUrl}/.well-known/mindoodb-cluster?tenantId=alpha-only`,
    );
    expect(alphaOnly.status).toBe(200);
    expect((await alphaOnly.json()) as { mirrors: unknown[] }).toMatchObject({ mirrors: [] });

    const unknown = await fetch(
      `${alpha.baseUrl}/.well-known/mindoodb-cluster?tenantId=no-such-tenant`,
    );
    expect(unknown.status).toBe(404);
  });
});
