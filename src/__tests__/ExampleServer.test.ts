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
