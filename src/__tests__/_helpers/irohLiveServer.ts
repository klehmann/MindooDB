import { mkdirSync, rmSync, writeFileSync } from "fs";
import { Server } from "http";
import { tmpdir } from "os";
import path from "path";

import { ClientNetworkContentAddressedStore } from "../../appendonlystores/network/ClientNetworkContentAddressedStore";
import { IrohNetworkTransport } from "../../core/appendonlystores/network/IrohNetworkTransport";
import { StoreKind } from "../../core/appendonlystores/types";
import { BaseMindooTenantFactory } from "../../core/BaseMindooTenantFactory";
import { decryptPrivateKey } from "../../core/crypto/privateKeyEncryption";
import type { MindooTenant, PrivateUserId } from "../../core/types";
import { NodeCryptoAdapter } from "../../node/crypto/NodeCryptoAdapter";
import { MindooDBServer } from "../../node/server/MindooDBServer";
import { createNativeIrohStreamIO, tryImportNumber0Iroh } from "../../node/server/nativeIrohStreamIO";
import type { ServerConfig } from "../../node/server/types";
import { IsolatedInMemoryStoreFactory } from "./multiDevice";

export const IROH_LIVE_ENV = "MINDOODB_IROH_LIVE";

/** Regular user database used for change-feed writes (directory is admin-only). */
export const IROH_LIVE_FEED_DB_ID = "feednotes";

export interface IrohLiveServerInfo {
  baseUrl: string;
  ticket: string;
  locator: string;
  endpointId?: string;
  tenantId: string;
  serverName: string;
  adminUsername: string;
  adminPassword: string;
}

export interface IrohLiveServer {
  info: IrohLiveServerInfo;
  server: MindooDBServer;
  tenant: MindooTenant;
  adminUser: PrivateUserId;
  systemAdmin: PrivateUserId;
  systemAdminPassword: string;
  crypto: NodeCryptoAdapter;
  stop: () => Promise<void>;
}

const SERVER_PASSWORD = "iroh-live-server-pass";
const SYSTEM_ADMIN_PASSWORD = "iroh-live-sysadmin-pass";
const ADMIN_PASSWORD = "iroh-live-admin-pass";
const USER_PASSWORD = "iroh-live-user-pass";

export async function canUseNativeIroh(): Promise<boolean> {
  return (await tryImportNumber0Iroh()) !== null;
}

export function skipIrohLiveUnlessEnabled(): boolean {
  return process.env[IROH_LIVE_ENV] !== "1";
}

export async function startIrohLiveServer(options?: {
  serverName?: string;
}): Promise<IrohLiveServer> {
  if (!(await canUseNativeIroh())) {
    throw new Error(
      "@number0/iroh is not installed. From mindoodb: pnpm add -D @number0/iroh",
    );
  }

  const crypto = new NodeCryptoAdapter();
  const dataDir = path.join(tmpdir(), `mindoodb-iroh-live-${Date.now()}`);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, "trusted-servers.json"), "[]", "utf-8");

  const bootstrap = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
  const serverIdentity = await bootstrap.createUserId(
    options?.serverName ?? "CN=iroh-live-server",
    SERVER_PASSWORD,
  );
  writeFileSync(path.join(dataDir, "server.identity.json"), JSON.stringify(serverIdentity, null, 2), "utf-8");

  const systemAdmin = await bootstrap.createUserId("cn=sysadmin/o=iroh-live", SYSTEM_ADMIN_PASSWORD);
  const config: ServerConfig = {
    capabilities: {
      "ALL:/system/*": [
        {
          username: systemAdmin.username,
          publicsignkey: systemAdmin.userSigningKeyPair.publicKey as string,
        },
      ],
    },
    iroh: { enabled: true, secretKeyPath: "iroh-secret.key" },
    rateLimits: { system: { windowMs: 60_000, max: 10_000 } },
  };

  const server = new MindooDBServer(dataDir, SERVER_PASSWORD, undefined, config);
  const httpServer = await listenHttp(server);
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind Iroh live test HTTP server");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  await server.startIrohIfEnabled();
  const irohStatus = server.getIrohStatus();
  if (!irohStatus.enabled || !irohStatus.ticket) {
    await closeHttp(httpServer);
    throw new Error("MindooDBServer Iroh listener did not publish a ticket");
  }

  const tenantId = `irohlive${Date.now().toString(16)}`;
  const factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
  const created = await factory.createTenant({
    tenantId,
    adminName: `cn=admin/o=${tenantId}`,
    adminPassword: ADMIN_PASSWORD,
    userName: `cn=user/o=${tenantId}`,
    userPassword: USER_PASSWORD,
  });
  await created.tenant.publishToServer(baseUrl, {
    systemAdminUser: systemAdmin,
    systemAdminPassword: SYSTEM_ADMIN_PASSWORD,
    adminUsername: created.adminUser.username,
  });

  const directory = await created.tenant.openDB("directory", { adminOnlyDb: true });
  await directory.syncStoreChanges();
  const httpRemote = await created.tenant.connectToServer(baseUrl, "directory");
  httpRemote.setSyncAuthOverride({
    username: created.adminUser.username,
    signingKey: await decryptUserSigningKey(crypto, created.adminUser, ADMIN_PASSWORD),
    signingPublicKey: created.adminUser.userSigningKeyPair.publicKey,
  });
  try {
    await directory.pushChangesTo(httpRemote);
  } finally {
    httpRemote.clearSyncAuthOverride();
  }

  const info: IrohLiveServerInfo = {
    baseUrl,
    ticket: irohStatus.ticket,
    locator: `iroh:${irohStatus.ticket}`,
    endpointId: irohStatus.endpointId,
    tenantId,
    serverName: serverIdentity.username,
    adminUsername: created.adminUser.username,
    adminPassword: ADMIN_PASSWORD,
  };

  return {
    info,
    server,
    tenant: created.tenant,
    adminUser: created.adminUser,
    systemAdmin,
    systemAdminPassword: SYSTEM_ADMIN_PASSWORD,
    crypto,
    stop: async () => {
      await server.stopIroh();
      await closeHttp(httpServer);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function touchLiveDirectory(live: IrohLiveServer): Promise<{ dbId: string }> {
  const directory = await live.tenant.openDB(IROH_LIVE_FEED_DB_ID);
  await directory.createDocument();
  await directory.syncStoreChanges();
  const httpRemote = await live.tenant.connectToServer(live.info.baseUrl, IROH_LIVE_FEED_DB_ID);
  httpRemote.setSyncAuthOverride({
    username: live.adminUser.username,
    signingKey: await decryptUserSigningKey(live.crypto, live.adminUser, live.info.adminPassword),
    signingPublicKey: live.adminUser.userSigningKeyPair.publicKey,
  });
  try {
    await directory.pushChangesTo(httpRemote);
  } finally {
    httpRemote.clearSyncAuthOverride();
  }
  return { dbId: IROH_LIVE_FEED_DB_ID };
}

export async function mintLiveAdminToken(live: IrohLiveServer): Promise<string> {
  const { store, io } = await connectIrohStore(live, "directory");
  try {
    await store.getCapabilities();
    const token = (store as unknown as { accessToken: string | null }).accessToken;
    if (!token) {
      throw new Error("failed to mint live admin token");
    }
    return token;
  } finally {
    await io.close?.();
  }
}

export async function connectIrohStore(
  live: IrohLiveServer,
  dbId: string,
  storeKind: StoreKind = StoreKind.docs,
): Promise<{
  store: ClientNetworkContentAddressedStore;
  io: Awaited<ReturnType<typeof createNativeIrohStreamIO>>;
}> {
  const clientDir = path.join(tmpdir(), `mindoodb-iroh-client-${Date.now()}-${Math.random()}`);
  mkdirSync(clientDir, { recursive: true });
  const io = await createNativeIrohStreamIO(clientDir, {
    enabled: true,
    secretKeyPath: "iroh-client.key",
  });
  const transport = new IrohNetworkTransport(io, live.info.ticket, {
    tenantId: live.info.tenantId,
    dbId,
    storeKind,
  });
  const store = new ClientNetworkContentAddressedStore(
    dbId,
    storeKind,
    transport,
    live.crypto,
    live.adminUser.username,
    await decryptUserSigningKey(live.crypto, live.adminUser, live.info.adminPassword),
    await decryptUserEncryptionKey(live.crypto, live.adminUser, live.info.adminPassword),
    undefined,
    live.adminUser.userSigningKeyPair.publicKey,
  );
  store.setSyncAuthOverride({
    username: live.adminUser.username,
    signingKey: await decryptUserSigningKey(live.crypto, live.adminUser, live.info.adminPassword),
    signingPublicKey: live.adminUser.userSigningKeyPair.publicKey,
  });
  return { store, io };
}

async function listenHttp(server: MindooDBServer): Promise<Server> {
  return new Promise((resolve, reject) => {
    const httpServer = server.getApp().listen(0, "127.0.0.1", () => resolve(httpServer));
    httpServer.on("error", reject);
  });
}

function closeHttp(httpServer: Server): Promise<void> {
  return new Promise((resolve) => {
    httpServer.close(() => resolve());
  });
}

export async function decryptUserSigningKey(
  crypto: NodeCryptoAdapter,
  user: PrivateUserId,
  password: string,
): Promise<CryptoKey> {
  const decrypted = await decryptPrivateKey(crypto, user.userSigningKeyPair.privateKey, password, "signing");
  return crypto.getSubtle().importKey("pkcs8", decrypted, { name: "Ed25519" }, false, ["sign"]);
}

async function decryptUserEncryptionKey(
  crypto: NodeCryptoAdapter,
  user: PrivateUserId,
  password: string,
): Promise<CryptoKey> {
  const decrypted = await decryptPrivateKey(
    crypto,
    user.userEncryptionKeyPair.privateKey,
    password,
    "encryption",
  );
  return crypto.getSubtle().importKey("pkcs8", decrypted, { name: "RSA-OAEP", hash: "SHA-256" }, false, [
    "decrypt",
  ]);
}
