/**
 * Two real MindooDBServer nodes mirroring over Iroh. Opt-in:
 *
 *   MINDOODB_IROH_LIVE=1 pnpm test:iroh
 */
import { StoreKind } from "../core/appendonlystores/types";
import {
  canUseNativeIroh,
  IROH_LIVE_FEED_DB_ID,
  skipIrohLiveUnlessEnabled,
  startIrohLiveServer,
  touchLiveDirectory,
  type IrohLiveServer,
} from "./_helpers/irohLiveServer";

const describeLive = skipIrohLiveUnlessEnabled() ? describe.skip : describe;

async function waitUntil(predicate: () => Promise<boolean> | boolean, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function storeIds(live: IrohLiveServer, tenantId: string, dbId: string): Promise<string[]> {
  const store = await live.server.getTenantManager().getStore(tenantId, dbId, StoreKind.docs);
  return (await store.getAllIds()).sort();
}

function trustIroh(target: IrohLiveServer, peer: IrohLiveServer): void {
  const info = peer.server.getTenantManager().getServerPublicInfo();
  if (!info) {
    throw new Error(`${peer.info.serverName} has no server identity`);
  }
  target.server.getTenantManager().saveTrustedServer({
    name: info.name,
    signingPublicKey: info.signingPublicKey,
    encryptionPublicKey: info.encryptionPublicKey,
    url: peer.info.locator,
  });
  target.server.getClusterManager().syncReplicators();
}

function peerName(live: IrohLiveServer): string {
  const name = live.server.getTenantManager().getServerPublicInfo()?.name;
  if (!name) {
    throw new Error(`${live.info.serverName} has no server identity`);
  }
  return name;
}

describeLive("Iroh live peer mesh", () => {
  jest.setTimeout(240_000);

  let west: IrohLiveServer;
  let east: IrohLiveServer;

  beforeAll(async () => {
    if (!(await canUseNativeIroh())) {
      throw new Error("@number0/iroh is not installed. From mindoodb: pnpm add -D @number0/iroh");
    }
    west = await startIrohLiveServer({ serverName: "CN=iroh-live-west" });
    east = await startIrohLiveServer({ serverName: "CN=iroh-live-east" });

    await west.tenant.publishToServer(east.info.baseUrl, {
      systemAdminUser: east.systemAdmin,
      systemAdminPassword: east.systemAdminPassword,
      adminUsername: west.adminUser.username,
    });

    trustIroh(west, east);
    trustIroh(east, west);
    west.server.startCluster();
    east.server.startCluster();
  });

  afterAll(async () => {
    await west?.server.stopCluster();
    await east?.server.stopCluster();
    await west?.stop();
    await east?.stop();
  });

  test("east mirrors west directory entries over Iroh", async () => {
    const westIds = await storeIds(west, west.info.tenantId, "directory");
    expect(westIds.length).toBeGreaterThan(0);

    const replicator = west.server.getClusterManager().getReplicator(peerName(east));
    expect(replicator).not.toBeNull();
    const shared = await replicator!.refreshIntersection();
    expect(shared).toContain(west.info.tenantId);

    const run = await replicator!.syncNow({ tenantId: west.info.tenantId });
    if (run.errors.length > 0) {
      throw new Error(
        `Iroh mesh sync failed: ${run.errors.join("; ")} status=${JSON.stringify(
          west.server.getClusterManager().status(),
        )}`,
      );
    }
    expect(run.pushed + run.pulled).toBeGreaterThan(0);

    await waitUntil(async () => {
      const eastIds = await storeIds(east, west.info.tenantId, "directory");
      return eastIds.length === westIds.length && eastIds.join() === westIds.join();
    });
  });

  test("a later write on west reaches east via the Iroh event feed", async () => {
    await waitUntil(() => west.server.getSyncEventListenerCount() > 1);
    const westListenersBefore = west.server.getSyncEventListenerCount();

    const before = (await storeIds(east, west.info.tenantId, IROH_LIVE_FEED_DB_ID).catch(() => [])).length;
    await touchLiveDirectory(west);

    await waitUntil(async () => {
      const eastIds = await storeIds(east, west.info.tenantId, IROH_LIVE_FEED_DB_ID).catch(() => []);
      return eastIds.length > before;
    });

    await east.server.stopCluster();
    await waitUntil(() => west.server.getSyncEventListenerCount() < westListenersBefore);
  });
});
