/**
 * Integration tests for the MindooDB Example Server.
 * 
 * These tests verify:
 * - Tenant registration via HTTP
 * - Client authentication (success and failure)
 * - Sync operations between clients and server
 * - API key protection
 */

import { Server } from "http";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import type { SigningKeyPair, EncryptionKeyPair } from "../core/types";

// Import from example server
import { MindooDBServer } from "../../examples/server/src/MindooDBServer";
import type { RegisterTenantRequest } from "../../examples/server/src/types";

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

describe("MindooDB Example Server", () => {
  let server: MindooDBServer;
  let httpServer: Server;
  let cryptoAdapter: NodeCryptoAdapter;
  let factory: BaseMindooTenantFactory;
  let baseUrl: string;
  const testPort = 3099; // Use a high port to avoid conflicts
  const testDataDir = `/tmp/mindoodb-test-${Date.now()}`;

  // Test keys - generated directly using subtle API
  let adminSigningKey: SigningKeyPair;
  let adminEncryptionKey: EncryptionKeyPair;
  let userSigningKeyPair: CryptoKeyPair;
  let userSigningPublicKeyPem: string;
  let userEncryptionKeyPair: CryptoKeyPair;
  let userEncryptionPublicKeyPem: string;
  const testUsername = "testuser";

  beforeAll(async () => {
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

    // Create and start server
    server = new MindooDBServer(testDataDir);
    baseUrl = `http://localhost:${testPort}`;

    // Start server
    await new Promise<void>((resolve) => {
      httpServer = server.getApp().listen(testPort, () => {
        console.log(`Test server started on port ${testPort}`);
        resolve();
      });
    });
  });

  afterAll(async () => {
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

  describe("Admin Endpoints", () => {
    describe("Tenant Registration", () => {
      test("should register a new tenant", async () => {
        const request: RegisterTenantRequest = {
          tenantId: "test-tenant-1",
          adminSigningPublicKey: adminSigningKey.publicKey,
          adminEncryptionPublicKey: adminEncryptionKey.publicKey,
          users: [
            {
              username: testUsername,
              signingPublicKey: userSigningPublicKeyPem,
              encryptionPublicKey: userEncryptionPublicKeyPem,
            },
          ],
        };

        const { status, body } = await httpRequest(
          `${baseUrl}/admin/register-tenant`,
          "POST",
          request
        );

        expect(status).toBe(201);
        expect(body).toMatchObject({
          success: true,
          tenantId: "test-tenant-1",
        });
      });

      test("should reject duplicate tenant registration", async () => {
        const request: RegisterTenantRequest = {
          tenantId: "test-tenant-1",
          adminSigningPublicKey: adminSigningKey.publicKey,
          adminEncryptionPublicKey: adminEncryptionKey.publicKey,
        };

        const { status, body } = await httpRequest(
          `${baseUrl}/admin/register-tenant`,
          "POST",
          request
        );

        expect(status).toBe(409);
        expect(body).toMatchObject({
          error: expect.stringContaining("already exists"),
        });
      });

      test("should reject registration with missing fields", async () => {
        const { status, body } = await httpRequest(
          `${baseUrl}/admin/register-tenant`,
          "POST",
          { tenantId: "incomplete-tenant" }
        );

        expect(status).toBe(400);
        expect(body).toMatchObject({
          error: expect.stringContaining("required"),
        });
      });
    });

    describe("List Tenants", () => {
      test("should list registered tenants", async () => {
        const { status, body } = await httpRequest(`${baseUrl}/admin/tenants`);

        expect(status).toBe(200);
        expect((body as { tenants: string[] }).tenants).toContain("test-tenant-1");
      });
    });
  });

  describe("Authentication", () => {
    const tenantId = "auth-test-tenant";

    beforeAll(async () => {
      // Register tenant for auth tests
      await httpRequest(`${baseUrl}/admin/register-tenant`, "POST", {
        tenantId,
        adminSigningPublicKey: adminSigningKey.publicKey,
        adminEncryptionPublicKey: adminEncryptionKey.publicKey,
        users: [
          {
            username: testUsername,
            signingPublicKey: userSigningPublicKeyPem,
            encryptionPublicKey: userEncryptionPublicKeyPem,
          },
        ],
      });
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
      // Register tenant for sync tests
      await httpRequest(`${baseUrl}/admin/register-tenant`, "POST", {
        tenantId,
        adminSigningPublicKey: adminSigningKey.publicKey,
        adminEncryptionPublicKey: adminEncryptionKey.publicKey,
        users: [
          {
            username: testUsername,
            signingPublicKey: userSigningPublicKeyPem,
            encryptionPublicKey: userEncryptionPublicKeyPem,
          },
        ],
      });

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

  describe("Dynamic User Registration", () => {
    // Note: Dynamic user registration via /admin/tenants/:tenantId/users has been removed.
    // Users are now managed via the admin-signed MindooTenantDirectory.
    // The server reads trusted users from the directory DB (when publicInfosKey is available)
    // or falls back to config.json users[] for testing.
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

      // Publish to server
      await result.tenant.publishToServer(baseUrl, {
        registerUsers: [localFactory.toPublicUserId(result.appUser)],
      });

      // Verify the tenant was registered
      const { status, body } = await httpRequest(`${baseUrl}/admin/tenants`);
      expect(status).toBe(200);
      const tenants = (body as { tenants: string[] }).tenants;
      expect(tenants).toContain("publish-test");
    }, 60000);
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
          `${baseUrl}/tenant_with_underscore/auth/challenge`,
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
          `${baseUrl}/admin/register-tenant`,
          "POST",
          {
            tenantId: "../../../etc",
            adminSigningPublicKey: adminSigningKey.publicKey,
            adminEncryptionPublicKey: adminEncryptionKey.publicKey,
          }
        );
        expect(status).toBe(400);
        expect(body).toMatchObject({
          error: expect.stringContaining("Invalid"),
        });
      });

      test("should reject dbId with path traversal in sync endpoints", async () => {
        // First get a valid auth token
        const tenantId = "security-test-tenant";
        await httpRequest(`${baseUrl}/admin/register-tenant`, "POST", {
          tenantId,
          adminSigningPublicKey: adminSigningKey.publicKey,
          adminEncryptionPublicKey: adminEncryptionKey.publicKey,
          users: [
            {
              username: testUsername,
              signingPublicKey: userSigningPublicKeyPem,
              encryptionPublicKey: userEncryptionPublicKeyPem,
            },
          ],
        });

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
      test("should not leak file paths in 500 errors", async () => {
        // Trying to trigger an internal error by accessing a corrupted tenant
        // The error message should be generic
        const { status, body } = await httpRequest(
          `${baseUrl}/admin/register-tenant`,
          "POST",
          {
            tenantId: "a".repeat(65),  // too long
            adminSigningPublicKey: "key",
            adminEncryptionPublicKey: "key",
          }
        );
        expect(status).toBe(400);
        // Should not contain any file path
        const bodyStr = JSON.stringify(body);
        expect(bodyStr).not.toContain("/Users/");
        expect(bodyStr).not.toContain("\\Users\\");
        expect(bodyStr).not.toContain("node_modules");
      });

      test("should return generic error for non-auth errors", async () => {
        const { status, body } = await httpRequest(
          `${baseUrl}/nonexistent-tenant/auth/challenge`,
          "POST",
          { username: "anyone" }
        );
        // Should not contain stack trace or file paths
        const bodyStr = JSON.stringify(body);
        expect(bodyStr).not.toContain(".ts:");
        expect(bodyStr).not.toContain(".js:");
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

    describe("Admin API Key Protection", () => {
      const apiKey = "test-admin-key-for-security";
      let securedBaseUrl: string;
      let securedServer: MindooDBServer;
      let securedHttpServer: import("http").Server;
      const securedPort = 3098;
      const securedDataDir = `/tmp/mindoodb-security-test-${Date.now()}`;

      beforeAll(async () => {
        process.env.MINDOODB_ADMIN_API_KEY = apiKey;
        securedServer = new MindooDBServer(securedDataDir);
        securedBaseUrl = `http://localhost:${securedPort}`;

        await new Promise<void>((resolve) => {
          securedHttpServer = securedServer.getApp().listen(securedPort, () => resolve());
        });
      });

      afterAll(async () => {
        delete process.env.MINDOODB_ADMIN_API_KEY;
        await new Promise<void>((resolve) => {
          securedHttpServer.close(() => resolve());
        });
        const fs = await import("fs");
        if (fs.existsSync(securedDataDir)) {
          fs.rmSync(securedDataDir, { recursive: true, force: true });
        }
      });

      test("should reject admin requests without API key", async () => {
        const { status } = await httpRequest(`${securedBaseUrl}/admin/tenants`);
        expect(status).toBe(401);
      });

      test("should reject admin requests with wrong API key", async () => {
        const { status } = await httpRequest(
          `${securedBaseUrl}/admin/tenants`,
          "GET",
          undefined,
          { "X-API-Key": "wrong-key" }
        );
        expect(status).toBe(401);
      });

      test("should accept admin requests with correct API key", async () => {
        const { status } = await httpRequest(
          `${securedBaseUrl}/admin/tenants`,
          "GET",
          undefined,
          { "X-API-Key": apiKey }
        );
        expect(status).toBe(200);
      });

      test("should accept tenant registration with correct API key", async () => {
        const { status } = await httpRequest(
          `${securedBaseUrl}/admin/register-tenant`,
          "POST",
          {
            tenantId: "api-key-test",
            adminSigningPublicKey: adminSigningKey.publicKey,
            adminEncryptionPublicKey: adminEncryptionKey.publicKey,
          },
          { "X-API-Key": apiKey }
        );
        expect(status).toBe(201);
      });

      test("should reject tenant registration without API key", async () => {
        const { status } = await httpRequest(
          `${securedBaseUrl}/admin/register-tenant`,
          "POST",
          {
            tenantId: "should-fail",
            adminSigningPublicKey: adminSigningKey.publicKey,
            adminEncryptionPublicKey: adminEncryptionKey.publicKey,
          }
        );
        expect(status).toBe(401);
      });
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
