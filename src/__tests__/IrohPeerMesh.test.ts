import { IrohPeerLink } from "../node/server/peer/IrohPeerLink";
import { listenForIrohPeers } from "../core/appendonlystores/network/IrohNetworkTransport";
import { createLoopbackIrohPair } from "../core/appendonlystores/network/IrohStreamIO";
import { createIdBloomSummary } from "../core/appendonlystores/bloom";
import {
  createMindooDBServerIrohHandler,
  IROH_CHANGE_FEED_HEARTBEAT_MS,
  resetIrohPeerUnauthLimiter,
  type IrohPeerAuthHost,
  type IrohPeerClusterHost,
  type IrohServerStore,
} from "../node/server/IrohServerRpc";
import { SyncEventBus } from "../node/server/SyncEventBus";
import type { PeerTokenPayload } from "../node/server/peer/PeerAuthService";

const PEER_TOKEN = "peer-jwt";
const PEER_NAME = "CN=peer";
const PEER_KEY = "peer-sign-pem";

function stubStore(): IrohServerStore {
  const missing = async () => {
    throw new Error("unexpected store method");
  };
  return {
    handleFindNewEntries: missing,
    handleFindNewEntriesForDoc: missing,
    handleFindEntries: missing,
    handleScanEntriesSince: missing,
    handleGetIdBloomSummary: missing,
    handleGetStoreHead: missing,
    handleGetCompactionStatus: missing,
    handleGetCapabilities: missing,
    handleGetEntries: missing,
    handleGetEntriesSessionWrapped: missing,
    handleGetEntryMetadata: missing,
    handlePutEntries: missing,
    handleHasEntries: missing,
    handleGetAllIds: missing,
    handleResolveDependencies: missing,
    handlePlanDocumentMaterialization: missing,
    handlePlanDocumentMaterializationBatch: missing,
    handlePlanAttachmentReadByWalkingMetadata: missing,
  };
}

function fakePeerAuth(): IrohPeerAuthHost {
  return {
    generateChallenge: async (publicsignkey) => {
      if (publicsignkey !== PEER_KEY) {
        throw new Error("Unknown peer");
      }
      return "chal-1";
    },
    authenticate: async (challenge, signature) => {
      if (challenge !== "chal-1" || signature[0] !== 7) {
        return { success: false, error: "Authentication failed" };
      }
      return { success: true, token: PEER_TOKEN };
    },
    validateToken: async (token) => {
      if (token !== PEER_TOKEN) {
        return null;
      }
      return {
        sub: PEER_NAME,
        publicsignkey: PEER_KEY,
        peer: true,
        iat: 1,
        exp: 9_999_999_999,
      } satisfies PeerTokenPayload;
    },
  };
}

function fakeCluster(seen: { tenants: string[]; syncs: unknown[] }): IrohPeerClusterHost {
  const intersection = new Set<string>();
  return {
    recordPeerIntersection: (_peer, tenantIds) => {
      intersection.clear();
      for (const id of tenantIds) {
        intersection.add(id);
      }
    },
    peerMaySeeTenant: (_peer, tenantId) => intersection.has(tenantId),
    listTenants: () => seen.tenants,
    listDatabases: (tenantId) => (tenantId === "acme" ? ["directory", "notes"] : []),
    requestSync: (_peer, scope) => {
      seen.syncs.push(scope);
    },
  };
}

function startMesh(options?: {
  tenants?: string[];
  rateLimit?: { windowMs: number; max: number };
}): {
  link: IrohPeerLink;
  bus: SyncEventBus;
  seen: { tenants: string[]; syncs: unknown[] };
  stop: () => Promise<void>;
} {
  const { a, b } = createLoopbackIrohPair();
  const bus = new SyncEventBus();
  const seen = { tenants: options?.tenants ?? ["acme", "secret"], syncs: [] as unknown[] };
  const handler = createMindooDBServerIrohHandler({
    getServerPublicInfo: () => ({
      name: "cn=home/o=mindoo",
      signingPublicKey: "sign-pem",
      encryptionPublicKey: "enc-pem",
    }),
    getClusterRole: () => "peer",
    listTenantPublicInfosFingerprints: async () => ["fp-1"],
    getAuthService: async () => ({
      generateChallenge: async () => "unused",
      authenticate: async () => ({ success: true, token: "tenant-jwt" }),
    }),
    getServerStore: async () => stubStore(),
    syncEventBus: bus,
    peerAuth: fakePeerAuth(),
    peerCluster: fakeCluster(seen),
    getPeerUnauthRateLimit: options?.rateLimit ? () => options.rateLimit! : undefined,
  });
  void listenForIrohPeers(b, handler);
  const link = new IrohPeerLink(a, "loopback:b");
  return {
    link,
    bus,
    seen,
    stop: () => link.close(),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Iroh peer mesh control plane", () => {
  const meshes: Array<{ stop: () => Promise<void> }> = [];

  beforeEach(() => {
    resetIrohPeerUnauthLimiter();
  });

  afterEach(async () => {
    await Promise.all(meshes.splice(0).map((mesh) => mesh.stop()));
  });

  function openMesh(options?: Parameters<typeof startMesh>[0]) {
    const mesh = startMesh(options);
    meshes.push(mesh);
    return mesh;
  }

  test("challenge plus authenticate returns a peer JWT", async () => {
    const { link } = openMesh();
    const challenge = (await link.rpc("peer.challenge", [PEER_KEY])) as { challenge: string };
    expect(challenge.challenge).toBe("chal-1");
    const auth = (await link.rpc("peer.authenticate", [challenge.challenge, new Uint8Array([7])])) as {
      success: boolean;
      token: string;
    };
    expect(auth).toEqual({ success: true, token: PEER_TOKEN });
  });

  test("unknown peer is not distinguishable from a failed handshake", async () => {
    const { link } = openMesh();
    await expect(link.rpc("peer.challenge", ["stranger"])).rejects.toThrow(/Unknown peer/);
  });

  test("tenant bloom intersects without leaking the full list", async () => {
    const { link } = openMesh();
    const bloom = createIdBloomSummary(["acme"]);
    const result = (await link.rpc("peer.tenantBloom", [PEER_TOKEN, bloom])) as { tenantIds: string[] };
    expect(result.tenantIds).toEqual(["acme"]);
    expect(result.tenantIds).not.toContain("secret");

    const databases = (await link.rpc("peer.listDatabases", [PEER_TOKEN, "acme"])) as {
      databases: string[];
    };
    expect(databases.databases).toEqual(["directory", "notes"]);
    await expect(link.rpc("peer.listDatabases", [PEER_TOKEN, "secret"])).rejects.toThrow(/Tenant not found/);
  });

  test("event feed skips the origin peer and tenants outside the intersection", async () => {
    const { link, bus } = openMesh();
    await link.rpc("peer.tenantBloom", [PEER_TOKEN, createIdBloomSummary(["acme"])]);

    const events: Array<{ tenantId: string; dbId: string }> = [];
    const abort = new AbortController();
    const subscribed = link.subscribeEvents(PEER_TOKEN, (event) => events.push(event), abort.signal);
    await waitFor(() => bus.listenerCount === 1);

    bus.publish({
      tenantId: "acme",
      dbId: "notes",
      storeKind: "docs",
      originPeer: PEER_NAME,
      maxReceiptOrder: 4,
    });
    bus.publish({
      tenantId: "secret",
      dbId: "notes",
      storeKind: "docs",
      maxReceiptOrder: 5,
    });
    bus.publish({
      tenantId: "acme",
      dbId: "notes",
      storeKind: "docs",
      maxReceiptOrder: 6,
    });
    await waitFor(() => events.length === 1);
    expect(events).toEqual([{ tenantId: "acme", dbId: "notes", storeKind: "docs", maxReceiptOrder: 6 }]);

    abort.abort();
    await subscribed;
    await waitFor(() => bus.listenerCount === 0);
  });

  test("heartbeats do not emit changes and timers stop on close", async () => {
    jest.useFakeTimers();
    try {
      const { link, bus } = openMesh();
      await link.rpc("peer.tenantBloom", [PEER_TOKEN, createIdBloomSummary(["acme"])]);

      const events: Array<{ tenantId: string; dbId: string }> = [];
      const abort = new AbortController();
      const subscribed = link.subscribeEvents(PEER_TOKEN, (event) => events.push(event), abort.signal);
      for (let i = 0; i < 40 && bus.listenerCount === 0; i += 1) {
        await Promise.resolve();
      }
      expect(bus.listenerCount).toBe(1);

      const timersWhileOpen = jest.getTimerCount();
      expect(timersWhileOpen).toBeGreaterThan(0);
      await jest.advanceTimersByTimeAsync(IROH_CHANGE_FEED_HEARTBEAT_MS);
      expect(events).toEqual([]);

      abort.abort();
      await subscribed;
      for (let i = 0; i < 40 && bus.listenerCount > 0; i += 1) {
        await Promise.resolve();
      }
      expect(bus.listenerCount).toBe(0);
      expect(jest.getTimerCount()).toBeLessThan(timersWhileOpen);
    } finally {
      jest.useRealTimers();
    }
  });

  test("unauthenticated peer calls are rate limited", async () => {
    const { link } = openMesh({ rateLimit: { windowMs: 60_000, max: 2 } });
    await link.rpc("peer.challenge", [PEER_KEY]);
    await link.rpc("peer.challenge", [PEER_KEY]);
    await expect(link.rpc("peer.challenge", [PEER_KEY])).rejects.toThrow(/Too many peer requests/);
  });

  test("peer.sync accepts a hint after the bloom handshake", async () => {
    const { link, seen } = openMesh();
    await link.rpc("peer.tenantBloom", [PEER_TOKEN, createIdBloomSummary(["acme"])]);
    await expect(link.rpc("peer.sync", [PEER_TOKEN, { tenantId: "acme" }])).resolves.toEqual({
      accepted: true,
    });
    expect(seen.syncs).toEqual([{ tenantId: "acme" }]);
  });
});
