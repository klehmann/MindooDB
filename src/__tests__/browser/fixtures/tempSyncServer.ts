import express from "express";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { Server } from "http";
import { build } from "esbuild";

import { InMemoryContentAddressedStoreFactory } from "../../../appendonlystores/InMemoryContentAddressedStoreFactory";
import { ClientNetworkContentAddressedStore } from "../../../appendonlystores/network/ClientNetworkContentAddressedStore";
import { HttpTransport } from "../../../appendonlystores/network/HttpTransport";
import { BaseMindooTenantFactory } from "../../../core/BaseMindooTenantFactory";
import { StoreKind } from "../../../core/appendonlystores/types";
import type { PrivateUserId } from "../../../core/userid";
import { decryptPrivateKey } from "../../../core/crypto/privateKeyEncryption";
import { NodeCryptoAdapter } from "../../../node/crypto/NodeCryptoAdapter";
import { MindooDBServer } from "../../../node/server/MindooDBServer";
import type { ServerConfig } from "../../../node/server/types";

export interface BrowserSyncServerContext {
  baseUrl: string;
  syncBaseUrl: string;
  testPageUrl: string;
  browserBundleUrl: string;
  tenantId: string;
  dbId: string;
  username: string;
  userSigningPublicKeyPem: string;
  userSigningPrivateKeyPem: string;
  userEncryptionPublicKeyPem: string;
  userEncryptionPrivateKeyPem: string;
}

export interface BrowserSyncServer {
  context: BrowserSyncServerContext;
  stop: () => Promise<void>;
}

interface StartServerOptions {
  tenantId?: string;
  dbId?: string;
  username?: string;
}

export async function startTempSyncServer(options: StartServerOptions = {}): Promise<BrowserSyncServer> {
  const tenantId = options.tenantId ?? "browser-sync-tenant";
  const dbId = options.dbId ?? "browser-sync-db";
  const username = options.username ?? "browser-user";

  const dataDir = mkdtempSync(path.join(tmpdir(), "mindoodb-browser-sync-"));
  const distDir = path.resolve(__dirname, "../../../../dist");
  const bundleDir = mkdtempSync(path.join(tmpdir(), "mindoodb-browser-bundle-"));
  const wrapperPath = path.join(bundleDir, "bundle-wrapper.ts");
  const bundlePath = path.join(bundleDir, "mindoodb-browser-bundle.js");

  writeFileSync(
    wrapperPath,
    [
      `import * as browserModule from ${JSON.stringify(path.resolve(distDir, "browser/index.js"))};`,
      `import { HttpTransport } from ${JSON.stringify(path.resolve(distDir, "appendonlystores/network/HttpTransport.js"))};`,
      `import { ClientNetworkContentAddressedStore } from ${JSON.stringify(path.resolve(distDir, "appendonlystores/network/ClientNetworkContentAddressedStore.js"))};`,
      "",
      "export { browserModule, HttpTransport, ClientNetworkContentAddressedStore };",
      "",
    ].join("\n")
  );

  await build({
    entryPoints: [wrapperPath],
    outfile: bundlePath,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2020"],
    sourcemap: false,
  });

  const cryptoAdapter = new NodeCryptoAdapter();
  const subtle = cryptoAdapter.getSubtle();
  const factory = new BaseMindooTenantFactory(
    new InMemoryContentAddressedStoreFactory(),
    cryptoAdapter,
  );
  const serverIdentity = await factory.createUserId("CN=browser-test-server", "browser-server-pass");
  writeFileSync(
    path.join(dataDir, "server.identity.json"),
    JSON.stringify(serverIdentity, null, 2),
    "utf-8",
  );
  const systemAdmin = await factory.createUserId("cn=browser-admin/o=test", "browser-admin-pass");
  const config: ServerConfig = {
    capabilities: {
      "ALL:/system/*": [
        {
          username: systemAdmin.username,
          publicsignkey: systemAdmin.userSigningKeyPair.publicKey as string,
        },
      ],
    },
  };

  const mindooServer = new MindooDBServer(dataDir, "browser-server-pass", undefined, config);
  const app = express();

  app.get("/__browser-test__/index.html", (_req, res) => {
    res.type("html").send(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>MindooDB Browser Test</title></head>
  <body><div id="app">mindoodb browser test page</div></body>
</html>`);
  });

  app.use("/__browser-test__", express.static(bundleDir));
  app.use("/__browser-test__/dist", express.static(distDir));
  app.use("/api", mindooServer.getApp());

  const httpServer = await new Promise<Server>((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start temporary sync server");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;
  const result = await factory.createTenant({
    tenantId,
    adminName: `cn=admin/o=${tenantId}`,
    adminPassword: "browser-tenant-admin-pass",
    userName: username,
    userPassword: "browser-user-pass",
  });
  await result.tenant.publishToServer(`${baseUrl}/api`, {
    systemAdminUser: systemAdmin,
    systemAdminPassword: "browser-admin-pass",
    adminUsername: result.adminUser.username,
  });
  const userSigningPublicKeyPem = result.appUser.userSigningKeyPair.publicKey;
  const userEncryptionPublicKeyPem = result.appUser.userEncryptionKeyPair.publicKey;
  const userSigningPrivateKeyPem = arrayBufferToPEM(
    await decryptPrivateKey(
      cryptoAdapter,
      result.appUser.userSigningKeyPair.privateKey,
      "browser-user-pass",
      "signing",
    ),
    "PRIVATE KEY",
  );
  const userEncryptionPrivateKeyPem = arrayBufferToPEM(
    await decryptPrivateKey(
      cryptoAdapter,
      result.appUser.userEncryptionKeyPair.privateKey,
      "browser-user-pass",
      "encryption",
    ),
    "PRIVATE KEY",
  );
  const directoryDb = await result.tenant.openDB("directory", { adminOnlyDb: true });
  await directoryDb.syncStoreChanges();
  const remote = new ClientNetworkContentAddressedStore(
    "directory",
    StoreKind.docs,
    new HttpTransport({
      baseUrl: `${baseUrl}/api/${tenantId}`,
      tenantId,
      dbId: "directory",
    }),
    cryptoAdapter,
    result.appUser.username,
    await decryptUserSigningKey(cryptoAdapter, result.appUser, "browser-user-pass"),
    userEncryptionPrivateKeyPem,
  );
  remote.setSyncAuthOverride({
    username: result.adminUser.username,
    signingKey: await decryptUserSigningKey(cryptoAdapter, result.adminUser, "browser-tenant-admin-pass"),
  });
  try {
    await directoryDb.pushChangesTo(remote);
  } finally {
    remote.clearSyncAuthOverride();
  }

  return {
    context: {
      baseUrl,
      syncBaseUrl: `${baseUrl}/api/${tenantId}`,
      testPageUrl: `${baseUrl}/__browser-test__/index.html`,
      browserBundleUrl: `${baseUrl}/__browser-test__/mindoodb-browser-bundle.js`,
      tenantId,
      dbId,
      username: result.appUser.username,
      userSigningPublicKeyPem,
      userSigningPrivateKeyPem,
      userEncryptionPublicKeyPem,
      userEncryptionPrivateKeyPem,
    },
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(bundleDir, { recursive: true, force: true });
    },
  };
}

function arrayBufferToPEM(buffer: ArrayBuffer, type: string): string {
  const base64 = Buffer.from(buffer).toString("base64");
  const lines = base64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----`;
}

async function decryptUserSigningKey(
  cryptoAdapter: NodeCryptoAdapter,
  user: PrivateUserId,
  password: string,
): Promise<CryptoKey> {
  const subtle = cryptoAdapter.getSubtle();
  const decrypted = await decryptPrivateKey(
    cryptoAdapter,
    user.userSigningKeyPair.privateKey,
    password,
    "signing",
  );
  return subtle.importKey(
    "pkcs8",
    decrypted,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}
