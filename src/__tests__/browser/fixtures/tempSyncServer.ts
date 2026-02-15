import express from "express";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { Server } from "http";
import { build } from "esbuild";
import { writeFileSync } from "fs";

import { NodeCryptoAdapter } from "../../../node/crypto/NodeCryptoAdapter";
import { MindooDBServer } from "../../../../examples/server/src/MindooDBServer";

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

  const adminSigningKeyPair = await subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"]
  ) as CryptoKeyPair;
  const adminEncryptionKeyPair = await subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"]
  ) as CryptoKeyPair;

  const userSigningKeyPair = await subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"]
  ) as CryptoKeyPair;
  const userEncryptionKeyPair = await subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"]
  ) as CryptoKeyPair;

  const adminSigningPublicKeyPem = arrayBufferToPEM(
    await subtle.exportKey("spki", adminSigningKeyPair.publicKey),
    "PUBLIC KEY"
  );
  const adminEncryptionPublicKeyPem = arrayBufferToPEM(
    await subtle.exportKey("spki", adminEncryptionKeyPair.publicKey),
    "PUBLIC KEY"
  );
  const userSigningPublicKeyPem = arrayBufferToPEM(
    await subtle.exportKey("spki", userSigningKeyPair.publicKey),
    "PUBLIC KEY"
  );
  const userSigningPrivateKeyPem = arrayBufferToPEM(
    await subtle.exportKey("pkcs8", userSigningKeyPair.privateKey),
    "PRIVATE KEY"
  );
  const userEncryptionPublicKeyPem = arrayBufferToPEM(
    await subtle.exportKey("spki", userEncryptionKeyPair.publicKey),
    "PUBLIC KEY"
  );
  const userEncryptionPrivateKeyPem = arrayBufferToPEM(
    await subtle.exportKey("pkcs8", userEncryptionKeyPair.privateKey),
    "PRIVATE KEY"
  );

  const mindooServer = new MindooDBServer(dataDir);
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

  const registerResponse = await fetch(`${baseUrl}/api/admin/register-tenant`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tenantId,
      adminSigningPublicKey: adminSigningPublicKeyPem,
      adminEncryptionPublicKey: adminEncryptionPublicKeyPem,
      users: [
        {
          username,
          signingPublicKey: userSigningPublicKeyPem,
          encryptionPublicKey: userEncryptionPublicKeyPem,
        },
      ],
    }),
  });

  if (!registerResponse.ok) {
    const errorBody = await registerResponse.text();
    throw new Error(
      `Failed to register tenant on temporary sync server: ${registerResponse.status} ${errorBody}`
    );
  }

  return {
    context: {
      baseUrl,
      syncBaseUrl: `${baseUrl}/api/${tenantId}`,
      testPageUrl: `${baseUrl}/__browser-test__/index.html`,
      browserBundleUrl: `${baseUrl}/__browser-test__/mindoodb-browser-bundle.js`,
      tenantId,
      dbId,
      username,
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
