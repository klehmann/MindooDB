/**
 * Integration tests for the MindooDB Example Server.
 *
 * These tests verify:
 * - Tenant registration via /system/* HTTP API (JWT auth)
 * - Client authentication (success and failure)
 * - Sync operations between clients and server
 * - System admin security model (capabilities-based)
 */

import { Server } from "http";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import type { EncryptionKeyPair, MindooDBServerInfo, SigningKeyPair } from "../core/types";
import type { PrivateUserId } from "../core/userid";
import type { ServerConfig } from "../node/server/types";

// Import from example server
import { MindooDBServer } from "../node/server/MindooDBServer";

// Helper to make HTTP requests
async function httpRequest(
  url: string,
  method: string = "GET",
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }

  return { status: response.status, body: responseBody };
}

// Shared helper: get system admin JWT token
async function getSystemAdminToken(
  baseUrl: string,
  adminUser: PrivateUserId,
  adminPassword: string,
  cryptoAdapter: NodeCryptoAdapter,
): Promise<string> {
  const subtle = cryptoAdapter.getSubtle();

  const encrypted = adminUser.userSigningKeyPair.privateKey as any;
  const salt = Buffer.from(encrypted.salt, "base64");
  const iv = Buffer.from(encrypted.iv, "base64");
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64");
  const tag = Buffer.from(encrypted.tag, "base64");
  const iterations = encrypted.iterations || 310000;

  const saltStringBytes = new TextEncoder().encode("signing");
  const combinedSalt = new Uint8Array(salt.length + saltStringBytes.length);
  combinedSalt.set(salt);
  combinedSalt.set(saltStringBytes, salt.length);

  const passwordKey = await subtle.importKey(
    "raw",
    new TextEncoder().encode(adminPassword),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  const derivedKey = await subtle.deriveKey(
    { name: "PBKDF2", salt: combinedSalt, iterations, hash: "SHA-256" },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const ciphertextWithTag = new Uint8Array(ciphertext.length + tag.length);
  ciphertextWithTag.set(ciphertext);
  ciphertextWithTag.set(tag, ciphertext.length);
  const decrypted = await subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    derivedKey,
    ciphertextWithTag,
  );

  const signingKey = await subtle.importKey(
    "pkcs8",
    decrypted,
    { name: "Ed25519" },
    false,
    ["sign"],
  );

  const challengeRes = await httpRequest(`${baseUrl}/system/auth/challenge`, "POST", {
    username: adminUser.username,
    publicsignkey: adminUser.userSigningKeyPair.publicKey,
  });
  const challenge = (challengeRes.body as { challenge: string }).challenge;
  const signature = await signChallenge(cryptoAdapter, signingKey, challenge);
  const authRes = await httpRequest(`${baseUrl}/system/auth/authenticate`, "POST", {
    challenge,
    signature: uint8ArrayToBase64(signature),
  });
  return (authRes.body as { token: string }).token;
}

describe("MindooDB Example Server", () => {
  let server: MindooDBServer;
  let httpServer: Server;
  let cryptoAdapter: NodeCryptoAdapter;
  let factory: BaseMindooTenantFactory;
  let baseUrl: string;
  let systemAdmin: PrivateUserId;
  let systemAdminToken: string;
  const testPort = 3099;
  const testDataDir = `/tmp/mindoodb-test-${Date.now()}`;

  // Test keys
  let adminSigningKey: SigningKeyPair;
  let adminEncryptionKey: EncryptionKeyPair;
  let userSigningKeyPair: CryptoKeyPair;
  let userSigningPublicKeyPem: string;
  let userEncryptionKeyPair: CryptoKeyPair;
  let userEncryptionPublicKeyPem: string;
  const testUsername = "testuser";

  beforeAll(async () => {
    console.time("ExampleServer.beforeAll.setup");
    cryptoAdapter = new NodeCryptoAdapter();
    factory = new BaseMindooTenantFactory(
      new InMemoryContentAddressedStoreFactory(),
      cryptoAdapter
    );

    const subtle = cryptoAdapter.getSubtle();

    // Generate admin keys using factory (we only need public keys for admin)
    adminSigningKey = await factory.createSigningKeyPair("admin-password");
    adminEncryptionKey = await factory.createEncryptionKeyPair("admin-password");

    // Generate user signing key pair directly (so we have access to private key)
    userSigningKeyPair = await subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"]
    ) as CryptoKeyPair;

    // Export signing public key to PEM
    const signingPublicKeyBuffer = await subtle.exportKey("spki", userSigningKeyPair.publicKey);
    userSigningPublicKeyPem = arrayBufferToPEM(signingPublicKeyBuffer, "PUBLIC KEY");

    // Generate user encryption key pair directly
    userEncryptionKeyPair = await subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 3072,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["encrypt", "decrypt"]
    ) as CryptoKeyPair;

    // Export encryption public key to PEM
    const encryptionPublicKeyBuffer = await subtle.exportKey("spki", userEncryptionKeyPair.publicKey);
    userEncryptionPublicKeyPem = arrayBufferToPEM(encryptionPublicKeyBuffer, "PUBLIC KEY");

    // Create system admin identity
    systemAdmin = await factory.createUserId("cn=sysadmin/o=test", "sysadmin-pass");

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

    server = new MindooDBServer(testDataDir, undefined, undefined, config);
    baseUrl = `http://localhost:${testPort}`;

    // Start server
    await new Promise<void>((resolve) => {
      httpServer = server.getApp().listen(testPort, () => {
        console.log(`Test server started on port ${testPort}`);
        resolve();
      });
    });

    // Get a system admin JWT for tests that need it
    systemAdminToken = await getSystemAdminToken(
      baseUrl,
      systemAdmin,
      "sysadmin-pass",
      cryptoAdapter,
    );
    console.timeEnd("ExampleServer.beforeAll.setup");
  }, 60000);

  afterAll(async () => {
    if (!httpServer) {
      return;
    }
    // Stop server
    await new Promise<void>((resolve) => {
      httpServer.close(() => {
        console.log("Test server stopped");
        resolve();
      });
    });

    // Clean up test data directory
    const fs = await import("fs");
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  describe("Health Check", () => {
    test("should return health status", async () => {
      const { status, body } = await httpRequest(`${baseUrl}/health`);

      expect(status).toBe(200);
      expect(body).toMatchObject({
        status: "ok",
      });
    });
  });

  describe("System Admin Endpoints", () => {
    describe("Tenant Registration", () => {
      test("should register a new tenant", async () => {
        const { status, body } = await httpRequest(
          `${baseUrl}/system/tenants/test-tenant-1`,
          "POST",
          {
            adminSigningPublicKey: adminSigningKey.publicKey,
            adminEncryptionPublicKey: adminEncryptionKey.publicKey,
            users: [
              {
                username: testUsername,
                signingPublicKey: userSigningPublicKeyPem,
                encryptionPublicKey: userEncryptionPublicKeyPem,
              },
            ],
          },
          { Authorization: `Bearer ${systemAdminToken}` },
        );

        expect(status).toBe(201);
        expect(body).toMatchObject({
          success: true,
          tenantId: "test-tenant-1",
        });
      });

      test("should reject duplicate tenant registration", async () => {
        const { status, body } = await httpRequest(
          `${baseUrl}/system/tenants/test-tenant-1`,
          "POST",
          {
            adminSigningPublicKey: adminSigningKey.publicKey,
            adminEncryptionPublicKey: adminEncryptionKey.publicKey,
          },
          { Authorization: `Bearer ${systemAdminToken}` },
        );

        expect(status).toBe(409);
        expect(body).toMatchObject({
          error: expect.stringContaining("already exists"),
        });
      });

      test("should reject registration with missing fields", async () => {
        const { status, body } = await httpRequest(
          `${baseUrl}/system/tenants/incomplete-tenant`,
          "POST",
          {},
          { Authorization: `Bearer ${systemAdminToken}` },
        );

        expect(status).toBe(400);
        expect(body).toMatchObject({
          error: expect.stringContaining("required"),
        });
      });
    });

    describe("List Tenants", () => {
      test("should list registered tenants", async () => {
        const { status, body } = await httpRequest(
          `${baseUrl}/system/tenants`,
          "GET",
          undefined,
          { Authorization: `Bearer ${systemAdminToken}` },
        );

        expect(status).toBe(200);
        expect((body as { tenants: string[] }).tenants).toContain("test-tenant-1");
      });
    });
  });

  describe("Authentication", () => {
    const tenantId = "auth-test-tenant";

    beforeAll(async () => {
      await httpRequest(
        `${baseUrl}/system/tenants/${tenantId}`,
        "POST",
        {
          adminSigningPublicKey: adminSigningKey.publicKey,
          adminEncryptionPublicKey: adminEncryptionKey.publicKey,
          users: [
            {
              username: testUsername,
              signingPublicKey: userSigningPublicKeyPem,
              encryptionPublicKey: userEncryptionPublicKeyPem,
            },
          ],
        },
        { Authorization: `Bearer ${systemAdminToken}` },
      );
    });

    test("should issue challenge for registered user", async () => {
      const { status, body } = await httpRequest(
        `${baseUrl}/${tenantId}/auth/challenge`,
        "POST",
        { username: testUsername }
      );

      expect(status).toBe(200);
      expect((body as { challenge: string }).challenge).toBeDefined();
      expect(typeof (body as { challenge: string }).challenge).toBe("string");
    });

    test("should reject challenge for unknown user", async () => {
      const { status, body } = await httpRequest(
        `${baseUrl}/${tenantId}/auth/challenge`,
        "POST",
        { username: "unknown-user" }
      );

      expect(status).toBe(404);
      expect(body).toMatchObject({
        error: expect.stringContaining("not found"),
      });
    });

    test("should authenticate with valid signature", async () => {
      // Get challenge
      const challengeResponse = await httpRequest(
        `${baseUrl}/${tenantId}/auth/challenge`,
        "POST",
        { username: testUsername }
      );
      const challenge = (challengeResponse.body as { challenge: string }).challenge;

      // Sign challenge
      const signature = await signChallenge(cryptoAdapter, userSigningKeyPair.privateKey, challenge);

      // Authenticate
      const { status, body } = await httpRequest(
        `${baseUrl}/${tenantId}/auth/authenticate`,
        "POST",
        {
          challenge,
          signature: uint8ArrayToBase64(signature),
        }
      );

      expect(status).toBe(200);
      expect((body as { success: boolean }).success).toBe(true);
      expect((body as { token: string }).token).toBeDefined();
    });

    test("should reject authentication with invalid signature", async () => {
      // Get challenge
      const challengeResponse = await httpRequest(
        `${baseUrl}/${tenantId}/auth/challenge`,
        "POST",
        { username: testUsername }
      );
      const challenge = (challengeResponse.body as { challenge: string }).challenge;

      // Create invalid signature
      const invalidSignature = new Uint8Array(64).fill(0);

      // Authenticate
      const { status, body } = await httpRequest(
        `${baseUrl}/${tenantId}/auth/authenticate`,
        "POST",
        {
          challenge,
          signature: uint8ArrayToBase64(invalidSignature),
        }
      );

      expect(status).toBe(200); // Auth endpoint returns 200 with success: false
      expect((body as { success: boolean }).success).toBe(false);
    });
  });

  describe("Sync Operations", () => {
    const tenantId = "sync-test-tenant";
    let authToken: string;

    beforeAll(async () => {
      await httpRequest(
        `${baseUrl}/system/tenants/${tenantId}`,
        "POST",
        {
          adminSigningPublicKey: adminSigningKey.publicKey,
          adminEncryptionPublicKey: adminEncryptionKey.publicKey,
          users: [
            {
              username: testUsername,
              signingPublicKey: userSigningPublicKeyPem,
              encryptionPublicKey: userEncryptionPublicKeyPem,
            },
          ],
        },
        { Authorization: `Bearer ${systemAdminToken}` },
      );

      // Authenticate to get token
      const challengeResponse = await httpRequest(
        `${baseUrl}/${tenantId}/auth/challenge`,
        "POST",
        { username: testUsername }
      );
      const challenge = (challengeResponse.body as { challenge: string }).challenge;
      const signature = await signChallenge(cryptoAdapter, userSigningKeyPair.privateKey, challenge);

      const authResponse = await httpRequest(
        `${baseUrl}/${tenantId}/auth/authenticate`,
        "POST",
        {
          challenge,
          signature: uint8ArrayToBase64(signature),
        }
      );
      authToken = (authResponse.body as { token: string }).token;
    });

    test("should get all IDs from empty store", async () => {
      const { status, body } = await httpRequest(
        `${baseUrl}/${tenantId}/sync/getAllIds?dbId=test-db`,
        "GET",
        undefined,
        { Authorization: `Bearer ${authToken}` }
      );

      expect(status).toBe(200);
      expect((body as { ids: string[] }).ids).toEqual([]);
    });

    test("should find no new entries in empty store", async () => {
      const { status, body } = await httpRequest(
        `${baseUrl}/${tenantId}/sync/findNewEntries`,
        "POST",
        { dbId: "test-db", haveIds: [] },
        { Authorization: `Bearer ${authToken}` }
      );

      expect(status).toBe(200);
      expect((body as { entries: unknown[] }).entries).toEqual([]);
    });

    test("should reject sync without auth token", async () => {
      const { status } = await httpRequest(
        `${baseUrl}/${tenantId}/sync/getAllIds?dbId=test-db`,
        "GET"
      );

      expect(status).toBe(401);
    });

    test("should reject sync with invalid token", async () => {
      const { status } = await httpRequest(
        `${baseUrl}/${tenantId}/sync/getAllIds?dbId=test-db`,
        "GET",
        undefined,
        { Authorization: "Bearer invalid-token" }
      );

      expect(status).toBe(401);
    });
  });

  describe("publishToServer convenience method", () => {
    test("should register a tenant via publishToServer", async () => {
      const localStoreFactory = new InMemoryContentAddressedStoreFactory();
      const localFactory = new BaseMindooTenantFactory(localStoreFactory, cryptoAdapter);

      // Create a tenant with the convenience API
      const result = await localFactory.createTenant({
        tenantId: "publish-test",
        adminName: "cn=admin/o=publish-test",
        adminPassword: "admin-pass",
        userName: "cn=user1/o=publish-test",
        userPassword: "user-pass",
      });

      await result.tenant.publishToServer(baseUrl, {
        systemAdminUser: systemAdmin,
        systemAdminPassword: "sysadmin-pass",
        registerUsers: [localFactory.toPublicUserId(result.appUser)],
      });

      const { status, body } = await httpRequest(
        `${baseUrl}/system/tenants`,
        "GET",
        undefined,
        { Authorization: `Bearer ${systemAdminToken}` },
      );
      expect(status).toBe(200);
      const tenants = (body as { tenants: string[] }).tenants;
      expect(tenants).toContain("publish-test");
    }, 60000);

    test("should allow bootstrap directory push with admin networkAuthOverride", async () => {
      // Purpose: verify bootstrap-deadlock resolution by proving that only a
      // per-sync admin override can perform the first directory grant push.
      const localStoreFactory = new InMemoryContentAddressedStoreFactory();
      const localFactory = new BaseMindooTenantFactory(localStoreFactory, cryptoAdapter);

      // Isolate this scenario in its own server instance/data dir so it can
      // control bootstrap state without affecting other tests.
      const isolatedDataDir = `/tmp/mindoodb-bootstrap-${Date.now()}`;
      const isolatedPort = 3107;
      const isolatedBaseUrl = `http://localhost:${isolatedPort}`;
      const isolatedServerPassword = "server-bootstrap-pass";
      const isolatedServerUsername = "CN=server-bootstrap";

      const fs = await import("fs");
      fs.mkdirSync(isolatedDataDir, { recursive: true });

      const serverIdentity = await localFactory.createUserId(
        isolatedServerUsername,
        isolatedServerPassword
      );
      fs.writeFileSync(
        `${isolatedDataDir}/server.identity.json`,
        JSON.stringify(serverIdentity, null, 2),
        "utf-8"
      );
      fs.writeFileSync(`${isolatedDataDir}/trusted-servers.json`, "[]", "utf-8");

      // Create isolated system admin
      const isolatedSystemAdmin = await localFactory.createUserId(
        "cn=bootstrap-admin/o=test",
        "bootstrap-admin-pass",
      );
      const isolatedConfig: ServerConfig = {
        capabilities: {
          "ALL:/system/*": [
            {
              username: isolatedSystemAdmin.username,
              publicsignkey: isolatedSystemAdmin.userSigningKeyPair.publicKey as string,
            },
          ],
        },
      };

      const isolatedServer = new MindooDBServer(
        isolatedDataDir,
        isolatedServerPassword,
        undefined,
        isolatedConfig,
      );
      const isolatedHttpServer = await new Promise<Server>((resolve) => {
        const s = isolatedServer.getApp().listen(isolatedPort, () => resolve(s));
      });

      try {
        const tenantId = `bootstrap-${Date.now()}`;
        const adminName = `cn=admin/o=${tenantId}`;
        const userName = `cn=user1/o=${tenantId}`;

        const result = await localFactory.createTenant({
          tenantId,
          adminName,
          adminPassword: "admin-pass",
          userName,
          userPassword: "user-pass",
        });

        await result.tenant.publishToServer(isolatedBaseUrl, {
          systemAdminUser: isolatedSystemAdmin,
          systemAdminPassword: "bootstrap-admin-pass",
          adminUsername: result.adminUser.username,
        });

        const directoryDb = await result.tenant.openDB("directory");
        const remoteDirectory = await result.tenant.connectToServer(isolatedBaseUrl, "directory");

        // Baseline: default app-user auth cannot bootstrap directory grants yet.
        await expect(directoryDb.pushChangesTo(remoteDirectory)).rejects.toThrow(
          /revoked|not found/i
        );

        // Bootstrap path: authenticate as admin for this one sync operation.
        await expect(
          directoryDb.pushChangesTo(remoteDirectory, {
            networkAuthOverride: {
              user: result.adminUser,
              password: "admin-pass",
            },
          })
        ).resolves.toMatchObject({ cancelled: false });

        // After bootstrap grants are in place, normal app-user sync should work.
        const db = await result.tenant.openDB("main");
        const remoteMain = await result.tenant.connectToServer(isolatedBaseUrl, "main");
        const doc = await db.createDocument();
        await db.changeDoc(doc, (d) => {
          d.getData().title = "bootstrap-check";
        });

        await expect(db.pushChangesTo(remoteMain)).resolves.toMatchObject({ cancelled: false });
      } finally {
        // Always tear down isolated resources, even if assertions fail.
        await new Promise<void>((resolve) => isolatedHttpServer.close(() => resolve()));
        fs.rmSync(isolatedDataDir, { recursive: true, force: true });
      }
    }, 120000);
  });

  describe("Tenant Not Found", () => {
    test("should return 404 for non-existent tenant", async () => {
      const { status, body } = await httpRequest(
        `${baseUrl}/nonexistent-tenant/auth/challenge`,
        "POST",
        { username: "anyone" }
      );

      expect(status).toBe(404);
      expect(body).toMatchObject({
        error: expect.stringContaining("not found"),
      });
    });
  });

  describe("Security", () => {
    describe("Path Traversal Prevention", () => {
      test("should reject tenantId with path traversal (../)", async () => {
        const { status } = await httpRequest(
          `${baseUrl}/../etc/auth/challenge`,
          "POST",
          { username: "anyone" }
        );
        // Express normalizes the path, so this becomes /etc/auth/challenge
        // which either hits 400 (invalid format) or 404 (not found)
        expect([400, 404]).toContain(status);
      });

      test("should reject tenantId with dots", async () => {
        const { status, body } = await httpRequest(
          `${baseUrl}/..test-tenant/auth/challenge`,
          "POST",
          { username: "anyone" }
        );
        expect(status).toBe(400);
        expect(body).toMatchObject({
          error: expect.stringContaining("Invalid"),
        });
      });

      test("should reject tenantId with special characters", async () => {
        const { status, body } = await httpRequest(
          `${baseUrl}/tenant.with.dot/auth/challenge`,
          "POST",
          { username: "anyone" }
        );
        expect(status).toBe(400);
        expect(body).toMatchObject({
          error: expect.stringContaining("Invalid"),
        });
      });

      test("should reject tenant registration with path traversal in tenantId", async () => {
        const { status, body } = await httpRequest(
          `${baseUrl}/system/tenants/../../../etc`,
          "POST",
          {
            adminSigningPublicKey: adminSigningKey.publicKey,
            adminEncryptionPublicKey: adminEncryptionKey.publicKey,
          },
          { Authorization: `Bearer ${systemAdminToken}` },
        );
        // Path traversal is neutralized by URL resolution (/../../../etc -> /etc), yielding 404
        expect([400, 403, 404]).toContain(status);
      });

      test("should reject dbId with path traversal in sync endpoints", async () => {
        const tenantId = "security-test-tenant";
        await httpRequest(
          `${baseUrl}/system/tenants/${tenantId}`,
          "POST",
          {
            adminSigningPublicKey: adminSigningKey.publicKey,
            adminEncryptionPublicKey: adminEncryptionKey.publicKey,
            users: [
              {
                username: testUsername,
                signingPublicKey: userSigningPublicKeyPem,
                encryptionPublicKey: userEncryptionPublicKeyPem,
              },
            ],
          },
          { Authorization: `Bearer ${systemAdminToken}` },
        );

        const challengeResponse = await httpRequest(
          `${baseUrl}/${tenantId}/auth/challenge`,
          "POST",
          { username: testUsername }
        );
        const challenge = (challengeResponse.body as { challenge: string }).challenge;
        const signature = await signChallenge(cryptoAdapter, userSigningKeyPair.privateKey, challenge);
        const authResponse = await httpRequest(
          `${baseUrl}/${tenantId}/auth/authenticate`,
          "POST",
          { challenge, signature: uint8ArrayToBase64(signature) }
        );
        const token = (authResponse.body as { token: string }).token;

        const { status, body } = await httpRequest(
          `${baseUrl}/${tenantId}/sync/findNewEntries`,
          "POST",
          { dbId: "../../../etc", haveIds: [] },
          { Authorization: `Bearer ${token}` }
        );
        expect(status).toBe(400);
        expect(body).toMatchObject({
          error: expect.stringContaining("must start with"),
        });
      });
    });

    describe("Error Sanitization", () => {
      test("should not leak file paths in errors", async () => {
        const { status, body } = await httpRequest(
          `${baseUrl}/system/tenants/${"a".repeat(65)}`,
          "POST",
          {
            adminSigningPublicKey: "key",
            adminEncryptionPublicKey: "key",
          },
          { Authorization: `Bearer ${systemAdminToken}` },
        );
        expect(status).toBe(400);
        const bodyStr = JSON.stringify(body);
        expect(bodyStr).not.toContain("/Users/");
        expect(bodyStr).not.toContain("\\Users\\");
        expect(bodyStr).not.toContain("node_modules");
      });
    });

    describe("Rate Limiting", () => {
      test("should return rate limit headers on responses", async () => {
        const response = await fetch(`${baseUrl}/health`);
        // Global rate limiter adds standard headers
        expect(response.headers.has("ratelimit-limit")).toBe(true);
        expect(response.headers.has("ratelimit-remaining")).toBe(true);
      });
    });

    describe("Security Headers", () => {
      test("should return security headers from helmet", async () => {
        const response = await fetch(`${baseUrl}/health`);
        // helmet sets several security headers
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      });
    });

    describe("Input Validation", () => {
      test("should reject oversized arrays in sync endpoints", async () => {
        const tenantId = "auth-test-tenant";

        // Get auth token
        const challengeResponse = await httpRequest(
          `${baseUrl}/${tenantId}/auth/challenge`,
          "POST",
          { username: testUsername }
        );
        const challenge = (challengeResponse.body as { challenge: string }).challenge;
        const signature = await signChallenge(cryptoAdapter, userSigningKeyPair.privateKey, challenge);
        const authResponse = await httpRequest(
          `${baseUrl}/${tenantId}/auth/authenticate`,
          "POST",
          { challenge, signature: uint8ArrayToBase64(signature) }
        );
        const token = (authResponse.body as { token: string }).token;

        // Create an array larger than MAX_PUT_ENTRIES (10000)
        const oversizedEntries = new Array(10001).fill({
          id: "x",
          entryType: "change",
          contentHash: "hash",
          docId: "doc",
          dependencyIds: [],
          createdAt: 0,
          createdByPublicKey: "key",
          decryptionKeyId: "kid",
          signature: "sig",
          originalSize: 0,
          encryptedSize: 0,
          encryptedData: "data",
        });

        const { status, body } = await httpRequest(
          `${baseUrl}/${tenantId}/sync/putEntries`,
          "POST",
          { dbId: "test-db", entries: oversizedEntries },
          { Authorization: `Bearer ${token}` }
        );
        expect(status).toBe(400);
        expect(body).toMatchObject({
          error: expect.stringContaining("at most"),
        });
      });
    });

    describe("Server Info Endpoint", () => {
      test("should return 503 when server has no identity", async () => {
        const { status, body } = await httpRequest(`${baseUrl}/.well-known/mindoodb-server-info`);
        expect(status).toBe(503);
        expect(body).toMatchObject({
          error: expect.stringContaining("not initialized"),
        });
      });
    });
  });
});

describe("Server Network Management", () => {
  let server: MindooDBServer;
  let httpServer: Server;
  let baseUrl: string;
  let cryptoAdapter: NodeCryptoAdapter;
  let factory: BaseMindooTenantFactory;
  let systemAdmin: PrivateUserId;
  let systemAdminToken: string;
  const testPort = 3097;
  const testDataDir = `/tmp/mindoodb-network-test-${Date.now()}`;

  beforeAll(async () => {
    console.time("ServerNetworkManagement.beforeAll.setup");
    cryptoAdapter = new NodeCryptoAdapter();
    factory = new BaseMindooTenantFactory(
      new InMemoryContentAddressedStoreFactory(),
      cryptoAdapter
    );

    // Generate and write a server identity so the well-known endpoint returns 200
    const fs = await import("fs");
    const path = await import("path");
    if (!fs.existsSync(testDataDir)) {
      fs.mkdirSync(testDataDir, { recursive: true });
    }
    const identity = await factory.createUserId("CN=test-network-server", "test-password");
    fs.writeFileSync(
      path.join(testDataDir, "server.identity.json"),
      JSON.stringify(identity, null, 2),
      "utf-8"
    );
    fs.writeFileSync(path.join(testDataDir, "trusted-servers.json"), "[]", "utf-8");

    systemAdmin = await factory.createUserId("cn=netadmin/o=test", "netadmin-pass");

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

    server = new MindooDBServer(testDataDir, "test-password", undefined, config);
    baseUrl = `http://localhost:${testPort}`;

    await new Promise<void>((resolve) => {
      httpServer = server.getApp().listen(testPort, () => resolve());
    });

    systemAdminToken = await getSystemAdminToken(
      baseUrl,
      systemAdmin,
      "netadmin-pass",
      cryptoAdapter,
    );

    const adminSigningKey = await factory.createSigningKeyPair("admin-password");
    const adminEncryptionKey = await factory.createEncryptionKeyPair("admin-password");
    await httpRequest(
      `${baseUrl}/system/tenants/network-test-tenant`,
      "POST",
      {
        adminSigningPublicKey: adminSigningKey.publicKey,
        adminEncryptionPublicKey: adminEncryptionKey.publicKey,
      },
      { Authorization: `Bearer ${systemAdminToken}` },
    );
    console.timeEnd("ServerNetworkManagement.beforeAll.setup");
  }, 60000);

  afterAll(async () => {
    if (!httpServer) {
      return;
    }
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    const fs = await import("fs");
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  describe("Well-known server info endpoint", () => {
    test("should return server info with name and public keys", async () => {
      const { status, body } = await httpRequest(`${baseUrl}/.well-known/mindoodb-server-info`);
      expect(status).toBe(200);
      const info = body as MindooDBServerInfo;
      expect(info.name).toBe("CN=test-network-server");
      expect(info.signingPublicKey).toContain("-----BEGIN PUBLIC KEY-----");
      expect(info.encryptionPublicKey).toContain("-----BEGIN PUBLIC KEY-----");
    });
  });

  describe("Per-tenant sync server API", () => {
    const tenantId = "network-test-tenant";

    test("GET should return empty array for tenant with no sync servers", async () => {
      const { status, body } = await httpRequest(
        `${baseUrl}/system/tenants/${tenantId}/sync-servers`,
        "GET",
        undefined,
        { Authorization: `Bearer ${systemAdminToken}` },
      );
      expect(status).toBe(200);
      expect((body as { servers: unknown[] }).servers).toEqual([]);
    });

    test("POST should add a sync server", async () => {
      const { status, body } = await httpRequest(
        `${baseUrl}/system/tenants/${tenantId}/sync-servers`,
        "POST",
        {
          name: "CN=remote-server-1",
          url: "https://s1.example.com",
          syncIntervalMs: 60000,
          databases: ["directory", "main"],
        },
        { Authorization: `Bearer ${systemAdminToken}` },
      );
      expect(status).toBe(201);
      expect(body).toMatchObject({ success: true });
    });

    test("GET should return the added sync server", async () => {
      const { status, body } = await httpRequest(
        `${baseUrl}/system/tenants/${tenantId}/sync-servers`,
        "GET",
        undefined,
        { Authorization: `Bearer ${systemAdminToken}` },
      );
      expect(status).toBe(200);
      const servers = (body as { servers: any[] }).servers;
      expect(servers).toHaveLength(1);
      expect(servers[0]).toMatchObject({
        name: "CN=remote-server-1",
        url: "https://s1.example.com",
        syncIntervalMs: 60000,
        databases: ["directory", "main"],
      });
    });

    test("POST should reject request without databases", async () => {
      const { status, body } = await httpRequest(
        `${baseUrl}/system/tenants/${tenantId}/sync-servers`,
        "POST",
        { name: "CN=no-dbs", url: "https://s2.example.com" },
        { Authorization: `Bearer ${systemAdminToken}` },
      );
      expect(status).toBe(400);
      expect(body).toMatchObject({
        error: expect.stringContaining("databases"),
      });
    });

    test("DELETE should remove a sync server", async () => {
      await httpRequest(
        `${baseUrl}/system/tenants/${tenantId}/sync-servers`,
        "POST",
        {
          name: "CN=to-delete",
          url: "https://delete-me.example.com",
          databases: ["main"],
        },
        { Authorization: `Bearer ${systemAdminToken}` },
      );

      const { status, body } = await httpRequest(
        `${baseUrl}/system/tenants/${tenantId}/sync-servers/${encodeURIComponent("CN=to-delete")}`,
        "DELETE",
        undefined,
        { Authorization: `Bearer ${systemAdminToken}` },
      );
      expect(status).toBe(200);
      expect(body).toMatchObject({ success: true });
    });
  });
});

// Helper functions

async function signChallenge(
  cryptoAdapter: NodeCryptoAdapter,
  signingKey: CryptoKey,
  challenge: string
): Promise<Uint8Array> {
  const subtle = cryptoAdapter.getSubtle();
  const messageBytes = new TextEncoder().encode(challenge);
  const signature = await subtle.sign(
    { name: "Ed25519" },
    signingKey,
    messageBytes
  );
  return new Uint8Array(signature);
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function arrayBufferToPEM(buffer: ArrayBuffer, type: string): string {
  const base64 = Buffer.from(buffer).toString("base64");
  const lines = base64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----`;
}
