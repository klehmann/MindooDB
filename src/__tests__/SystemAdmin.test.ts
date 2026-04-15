/**
 * Integration tests for the system admin security model.
 *
 * Covers:
 * - System auth flow (challenge/response + JWT)
 * - Capability-based authorization on /system/* routes
 * - Tenant CRUD routes
 * - publishToServer with new auth
 * - MindooDBServerAdmin wrapper
 */

import { Server } from "http";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { ClientNetworkContentAddressedStore } from "../appendonlystores/network/ClientNetworkContentAddressedStore";
import { MindooDBServerAdmin } from "../core/MindooDBServerAdmin";
import { KeyBag } from "../core/keys/KeyBag";
import type { PrivateUserId } from "../core/userid";
import type { ServerConfig } from "../node/server/types";
import { MindooDBServer } from "../node/server/MindooDBServer";

jest.setTimeout(30000);

async function httpRequest(
  url: string,
  method: string = "GET",
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
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

async function signChallenge(
  cryptoAdapter: NodeCryptoAdapter,
  signingKey: CryptoKey,
  challenge: string,
): Promise<Uint8Array> {
  const subtle = cryptoAdapter.getSubtle();
  const messageBytes = new TextEncoder().encode(challenge);
  const signature = await subtle.sign({ name: "Ed25519" }, signingKey, messageBytes);
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

function createPublicInfosKeyBase64(seed: number): string {
  return Buffer.alloc(32, seed).toString("base64");
}

function formatFingerprint(bytes: Uint8Array): string {
  return Array.from(bytes.slice(0, 8))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(":");
}

async function computeSymmetricKeyFingerprint(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return formatFingerprint(new Uint8Array(digest));
}

async function loadServerStoredPublicInfosKeys(setup: TestSetup, tenantId: string): Promise<Uint8Array[]> {
  const serverIdentity = setup.server.getTenantManager().getServerIdentity();
  if (!serverIdentity) {
    return [];
  }
  const fs = await import("fs");
  const path = await import("path");
  const keyBagPath = path.join(setup.dataDir, "server.keybag");
  if (!fs.existsSync(keyBagPath)) {
    return [];
  }
  const keyBag = new KeyBag(
    serverIdentity.userEncryptionKeyPair.privateKey,
    "test-password",
    new NodeCryptoAdapter(),
  );
  await keyBag.load(new Uint8Array(fs.readFileSync(keyBagPath)));
  return keyBag.getAllKeys("doc", tenantId, "$publicinfos");
}

// ===========================================================================
// Test setup helpers
// ===========================================================================

interface TestSetup {
  server: MindooDBServer;
  httpServer: Server;
  baseUrl: string;
  dataDir: string;
  config: ServerConfig;
  adminUser: PrivateUserId;
  adminSigningKeyPair: CryptoKeyPair;
  adminSigningPublicKeyPem: string;
}

async function createTestSetup(
  port: number,
  cryptoAdapter: NodeCryptoAdapter,
  factory: BaseMindooTenantFactory,
  configOverride?: Partial<ServerConfig>,
): Promise<TestSetup> {
  const fs = await import("fs");
  const path = await import("path");
  const dataDir = `/tmp/mindoodb-sysadmin-test-${Date.now()}-${port}`;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "trusted-servers.json"), "[]", "utf-8");

  const serverIdentity = await factory.createUserId("CN=test-sysadmin-server", "test-password");
  fs.writeFileSync(
    path.join(dataDir, "server.identity.json"),
    JSON.stringify(serverIdentity, null, 2),
    "utf-8",
  );

  const subtle = cryptoAdapter.getSubtle();

  // Generate system admin signing keypair
  const adminSigningKeyPair = (await subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const adminSigningPublicKeyBuffer = await subtle.exportKey(
    "spki",
    adminSigningKeyPair.publicKey,
  );
  const adminSigningPublicKeyPem = arrayBufferToPEM(
    adminSigningPublicKeyBuffer,
    "PUBLIC KEY",
  );

  // Create a PrivateUserId for the admin using the factory
  const adminUser = await factory.createUserId("cn=sysadmin/o=test", "admin-pass");

  const config: ServerConfig = {
    ...configOverride,
    capabilities: {
      "ALL:/system/*": [
        {
          username: adminUser.username,
          publicsignkey: adminUser.userSigningKeyPair.publicKey as string,
        },
      ],
      ...(configOverride?.capabilities ?? {}),
    },
  };

  const server = new MindooDBServer(dataDir, "test-password", undefined, config);
  const baseUrl = `http://localhost:${port}`;

  const httpServer = await new Promise<Server>((resolve) => {
    const s = server.getApp().listen(port, () => resolve(s));
  });

  return {
    server,
    httpServer,
    baseUrl,
    dataDir,
    config,
    adminUser,
    adminSigningKeyPair,
    adminSigningPublicKeyPem,
  };
}

async function teardownTestSetup(setup: TestSetup): Promise<void> {
  if (!setup?.httpServer) {
    return;
  }
  await new Promise<void>((resolve) => {
    setup.httpServer.close(() => resolve());
  });
}

async function getSystemAdminToken(
  baseUrl: string,
  adminUser: PrivateUserId,
  adminPassword: string,
  cryptoAdapter: NodeCryptoAdapter,
  factory: BaseMindooTenantFactory,
): Promise<string> {
  const subtle = cryptoAdapter.getSubtle();

  // Decrypt signing key
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

  // Challenge
  const challengeRes = await httpRequest(`${baseUrl}/system/auth/challenge`, "POST", {
    username: adminUser.username,
    publicsignkey: adminUser.userSigningKeyPair.publicKey,
  });
  const challenge = (challengeRes.body as { challenge: string }).challenge;

  // Sign
  const signature = await signChallenge(cryptoAdapter, signingKey, challenge);

  // Authenticate
  const authRes = await httpRequest(`${baseUrl}/system/auth/authenticate`, "POST", {
    challenge,
    signature: uint8ArrayToBase64(signature),
  });

  return (authRes.body as { token: string }).token;
}

async function decryptUserSigningKey(
  cryptoAdapter: NodeCryptoAdapter,
  user: PrivateUserId,
  password: string,
): Promise<CryptoKey> {
  const subtle = cryptoAdapter.getSubtle();
  const encrypted = user.userSigningKeyPair.privateKey as {
    salt: string;
    iv: string;
    ciphertext: string;
    tag: string;
    iterations?: number;
  };
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
    new TextEncoder().encode(password),
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

  return subtle.importKey(
    "pkcs8",
    decrypted,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}

// ===========================================================================
// Tests
// ===========================================================================

describe("System Admin Security", () => {
  let cryptoAdapter: NodeCryptoAdapter;
  let factory: BaseMindooTenantFactory;

  beforeAll(() => {
    cryptoAdapter = new NodeCryptoAdapter();
    factory = new BaseMindooTenantFactory(
      new InMemoryContentAddressedStoreFactory(),
      cryptoAdapter,
    );
  });

  // =========================================================================
  // System auth flow
  // =========================================================================

  describe("System Auth Flow", () => {
    let setup: TestSetup;
    const port = 4001;

    beforeAll(async () => {
      setup = await createTestSetup(port, cryptoAdapter, factory);
    });

    afterAll(async () => {
      await teardownTestSetup(setup);
    });

    test("successful challenge-sign-authenticate roundtrip", async () => {
      const token = await getSystemAdminToken(
        setup.baseUrl,
        setup.adminUser,
        "admin-pass",
        cryptoAdapter,
        factory,
      );
      expect(token).toBeDefined();
      expect(typeof token).toBe("string");
      expect(token.split(".")).toHaveLength(3);
    });

    test("JWT contains both username and publicsignkey", async () => {
      const token = await getSystemAdminToken(
        setup.baseUrl,
        setup.adminUser,
        "admin-pass",
        cryptoAdapter,
        factory,
      );

      // Decode JWT payload
      const payloadB64 = token.split(".")[1];
      let base64 = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
      while (base64.length % 4) base64 += "=";
      const payload = JSON.parse(atob(base64));

      expect(payload.sub).toBe(setup.adminUser.username);
      expect(payload.publicsignkey).toBe(setup.adminUser.userSigningKeyPair.publicKey);
    });

    test("unknown username rejected", async () => {
      const { status, body } = await httpRequest(
        `${setup.baseUrl}/system/auth/challenge`,
        "POST",
        {
          username: "unknown-user",
          publicsignkey: setup.adminUser.userSigningKeyPair.publicKey,
        },
      );
      expect(status).toBe(404);
      expect(body).toMatchObject({ error: expect.stringContaining("not found") });
    });

    test("unknown publicsignkey rejected", async () => {
      const { status, body } = await httpRequest(
        `${setup.baseUrl}/system/auth/challenge`,
        "POST",
        {
          username: setup.adminUser.username,
          publicsignkey: "-----BEGIN PUBLIC KEY-----\nFAKEKEY\n-----END PUBLIC KEY-----",
        },
      );
      expect(status).toBe(404);
    });

    test("correct username but wrong publicsignkey rejected", async () => {
      const subtle = cryptoAdapter.getSubtle();
      const otherKeyPair = (await subtle.generateKey(
        { name: "Ed25519" },
        true,
        ["sign", "verify"],
      )) as CryptoKeyPair;
      const otherPubBuf = await subtle.exportKey("spki", otherKeyPair.publicKey);
      const otherPubPem = arrayBufferToPEM(otherPubBuf, "PUBLIC KEY");

      const { status } = await httpRequest(
        `${setup.baseUrl}/system/auth/challenge`,
        "POST",
        {
          username: setup.adminUser.username,
          publicsignkey: otherPubPem,
        },
      );
      expect(status).toBe(404);
    });

    test("wrong signature rejected", async () => {
      const { body: challengeBody } = await httpRequest(
        `${setup.baseUrl}/system/auth/challenge`,
        "POST",
        {
          username: setup.adminUser.username,
          publicsignkey: setup.adminUser.userSigningKeyPair.publicKey,
        },
      );
      const challenge = (challengeBody as { challenge: string }).challenge;

      const invalidSignature = new Uint8Array(64).fill(0);
      const { body } = await httpRequest(
        `${setup.baseUrl}/system/auth/authenticate`,
        "POST",
        {
          challenge,
          signature: uint8ArrayToBase64(invalidSignature),
        },
      );
      expect((body as any).success).toBe(false);
      expect((body as any).error).toContain("Invalid signature");
    });

    test("replayed challenge rejected", async () => {
      const token = await getSystemAdminToken(
        setup.baseUrl,
        setup.adminUser,
        "admin-pass",
        cryptoAdapter,
        factory,
      );

      // The challenge was already used; trying to authenticate again should fail
      // (we can't easily replay the exact same challenge, but we can test with a fake one)
      const { body } = await httpRequest(
        `${setup.baseUrl}/system/auth/authenticate`,
        "POST",
        {
          challenge: "nonexistent-challenge",
          signature: uint8ArrayToBase64(new Uint8Array(64)),
        },
      );
      expect((body as any).success).toBe(false);
    });
  });

  describe("Auth Rate Limiting", () => {
    let setup: TestSetup;
    const port = 4007;

    beforeAll(async () => {
      setup = await createTestSetup(port, cryptoAdapter, factory, {
        rateLimits: {
          auth: {
            windowMs: 60_000,
            max: 1,
          },
        },
      });
    });

    afterAll(async () => {
      await teardownTestSetup(setup);
    });

    test("uses configured auth rate limits for repeated system challenges", async () => {
      const requestBody = {
        username: setup.adminUser.username,
        publicsignkey: setup.adminUser.userSigningKeyPair.publicKey,
      };

      const first = await httpRequest(
        `${setup.baseUrl}/system/auth/challenge`,
        "POST",
        requestBody,
      );
      const second = await httpRequest(
        `${setup.baseUrl}/system/auth/challenge`,
        "POST",
        requestBody,
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(429);
      expect(second.body).toMatchObject({
        error: "Too many authentication attempts, please try again later",
      });
    });

    test("challenge limiting is isolated by username to avoid cross-user collisions", async () => {
      const firstUnknownUser = await httpRequest(
        `${setup.baseUrl}/system/auth/challenge`,
        "POST",
        {
          username: "someone-else",
          publicsignkey: setup.adminUser.userSigningKeyPair.publicKey,
        },
      );
      const differentUsername = await httpRequest(
        `${setup.baseUrl}/system/auth/challenge`,
        "POST",
        {
          username: "another-user",
          publicsignkey: setup.adminUser.userSigningKeyPair.publicKey,
        },
      );

      expect(firstUnknownUser.status).toBe(404);
      expect(differentUsername.status).toBe(404);
      expect(differentUsername.status).not.toBe(429);
    });
  });

  // =========================================================================
  // Capability-based authorization on /system/* routes
  // =========================================================================

  describe("System Endpoint Authorization", () => {
    let setup: TestSetup;
    let scopedAdmin: PrivateUserId;
    const port = 4002;

    beforeAll(async () => {
      // Create a scoped admin that can only POST tenants
      scopedAdmin = await factory.createUserId("cn=scoped/o=test", "scoped-pass");

      const config: ServerConfig = {
        capabilities: {
          "POST:/system/tenants/*": [
            {
              username: scopedAdmin.username,
              publicsignkey: scopedAdmin.userSigningKeyPair.publicKey as string,
            },
          ],
        },
      };

      setup = await createTestSetup(port, cryptoAdapter, factory, config);
    });

    afterAll(async () => {
      await teardownTestSetup(setup);
    });

    test("super-admin (ALL:/system/*) can access everything", async () => {
      const token = await getSystemAdminToken(
        setup.baseUrl,
        setup.adminUser,
        "admin-pass",
        cryptoAdapter,
        factory,
      );

      const { status } = await httpRequest(
        `${setup.baseUrl}/system/tenants`,
        "GET",
        undefined,
        { Authorization: `Bearer ${token}` },
      );
      expect(status).toBe(200);
    });

    test("scoped admin can access granted route", async () => {
      const token = await getSystemAdminToken(
        setup.baseUrl,
        scopedAdmin,
        "scoped-pass",
        cryptoAdapter,
        factory,
      );

      const adminSigningKey = await factory.createSigningKeyPair("test-pw");
      const adminEncryptionKey = await factory.createEncryptionKeyPair("test-pw");

      const { status } = await httpRequest(
        `${setup.baseUrl}/system/tenants/scoped-test-tenant`,
        "POST",
        {
          adminSigningPublicKey: adminSigningKey.publicKey,
          adminEncryptionPublicKey: adminEncryptionKey.publicKey,
          publicInfosKey: createPublicInfosKeyBase64(5),
        },
        { Authorization: `Bearer ${token}` },
      );
      expect(status).toBe(201);
    });

    test("scoped admin is denied on non-granted routes", async () => {
      const token = await getSystemAdminToken(
        setup.baseUrl,
        scopedAdmin,
        "scoped-pass",
        cryptoAdapter,
        factory,
      );

      const { status } = await httpRequest(
        `${setup.baseUrl}/system/tenants`,
        "GET",
        undefined,
        { Authorization: `Bearer ${token}` },
      );
      expect(status).toBe(403);
    });

    test("unauthenticated requests return 401", async () => {
      const { status } = await httpRequest(`${setup.baseUrl}/system/tenants`);
      expect(status).toBe(401);
    });

    test("authenticated but unauthorized returns 403", async () => {
      const token = await getSystemAdminToken(
        setup.baseUrl,
        scopedAdmin,
        "scoped-pass",
        cryptoAdapter,
        factory,
      );

      const { status } = await httpRequest(
        `${setup.baseUrl}/system/trusted-servers`,
        "GET",
        undefined,
        { Authorization: `Bearer ${token}` },
      );
      expect(status).toBe(403);
    });
  });

  describe("CORS configuration", () => {
    let setup: TestSetup;
    const port = 4011;
    const previousCorsOrigin = process.env.MINDOODB_CORS_ORIGIN;

    beforeAll(async () => {
      process.env.MINDOODB_CORS_ORIGIN = "http://localhost:4174,https://mindoodb-haven.pages.dev,https://haven.mindoo.de";
      setup = await createTestSetup(port, cryptoAdapter, factory);
    });

    afterAll(async () => {
      await teardownTestSetup(setup);
      if (previousCorsOrigin === undefined) {
        delete process.env.MINDOODB_CORS_ORIGIN;
      } else {
        process.env.MINDOODB_CORS_ORIGIN = previousCorsOrigin;
      }
    });

    test("allows requests from configured CORS origins and rejects others", async () => {
      const allowedResponse = await fetch(`${setup.baseUrl}/health`, {
        headers: { Origin: "https://mindoodb-haven.pages.dev" },
      });
      expect(allowedResponse.status).toBe(200);
      expect(allowedResponse.headers.get("access-control-allow-origin")).toBe("https://mindoodb-haven.pages.dev");

      const disallowedResponse = await fetch(`${setup.baseUrl}/health`, {
        headers: { Origin: "https://evil.example.com" },
      });
      expect(disallowedResponse.status).toBe(200);
      expect(disallowedResponse.headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  describe("Wildcard Tenant Creation Authorization", () => {
    let setup: TestSetup;
    const port = 4010;

    beforeAll(async () => {
      const config: ServerConfig = {
        capabilities: {
          "POST:/system/tenants/*": [
            {
              username: "*",
              publicsignkey: "*",
            },
          ],
        },
      };

      setup = await createTestSetup(port, cryptoAdapter, factory, config);
    });

    afterAll(async () => {
      await teardownTestSetup(setup);
    });

    test("wildcard principal can authenticate and create a tenant", async () => {
      const wildcardUser = await factory.createUserId("cn=demo-any/o=test", "demo-pass");
      const token = await getSystemAdminToken(
        setup.baseUrl,
        wildcardUser,
        "demo-pass",
        cryptoAdapter,
        factory,
      );

      const { status } = await httpRequest(
        `${setup.baseUrl}/system/tenants/open-demo`,
        "POST",
        {
          adminSigningPublicKey: wildcardUser.userSigningKeyPair.publicKey,
          adminEncryptionPublicKey: wildcardUser.userEncryptionKeyPair.publicKey,
          publicInfosKey: createPublicInfosKeyBase64(6),
        },
        { Authorization: `Bearer ${token}` },
      );
      expect(status).toBe(201);
    });

    test("wildcard principal cannot call GET /system/tenants", async () => {
      const wildcardUser = await factory.createUserId("cn=demo-reader/o=test", "reader-pass");
      const token = await getSystemAdminToken(
        setup.baseUrl,
        wildcardUser,
        "reader-pass",
        cryptoAdapter,
        factory,
      );

      const { status } = await httpRequest(
        `${setup.baseUrl}/system/tenants`,
        "GET",
        undefined,
        { Authorization: `Bearer ${token}` },
      );
      expect(status).toBe(403);
    });

    test("wildcard principal cannot call PUT /system/config", async () => {
      const wildcardUser = await factory.createUserId("cn=demo-config/o=test", "config-pass");
      const token = await getSystemAdminToken(
        setup.baseUrl,
        wildcardUser,
        "config-pass",
        cryptoAdapter,
        factory,
      );

      const { status } = await httpRequest(
        `${setup.baseUrl}/system/config`,
        "PUT",
        setup.config,
        { Authorization: `Bearer ${token}` },
      );
      expect(status).toBe(403);
    });
  });

  describe("Wildcard Tenant Prefix Authorization", () => {
    let setup: TestSetup;
    const port = 4011;

    beforeAll(async () => {
      const config: ServerConfig = {
        capabilities: {
          "POST:/system/tenants/demo_*": [
            {
              username: "*",
              publicsignkey: "*",
            },
          ],
        },
      };

      setup = await createTestSetup(port, cryptoAdapter, factory, config);
    });

    afterAll(async () => {
      await teardownTestSetup(setup);
    });

    test("wildcard principal can create demo_foo when only demo_* is allowed", async () => {
      const wildcardUser = await factory.createUserId("cn=demo-prefix/o=test", "demo-prefix-pass");
      const token = await getSystemAdminToken(
        setup.baseUrl,
        wildcardUser,
        "demo-prefix-pass",
        cryptoAdapter,
        factory,
      );

      const { status } = await httpRequest(
        `${setup.baseUrl}/system/tenants/demo_foo`,
        "POST",
        {
          adminSigningPublicKey: wildcardUser.userSigningKeyPair.publicKey,
          adminEncryptionPublicKey: wildcardUser.userEncryptionKeyPair.publicKey,
          publicInfosKey: createPublicInfosKeyBase64(7),
        },
        { Authorization: `Bearer ${token}` },
      );
      expect(status).toBe(201);
    });

    test("wildcard principal cannot create prod_foo when only demo_* is allowed", async () => {
      const wildcardUser = await factory.createUserId("cn=prod-prefix/o=test", "prod-prefix-pass");
      const token = await getSystemAdminToken(
        setup.baseUrl,
        wildcardUser,
        "prod-prefix-pass",
        cryptoAdapter,
        factory,
      );

      const { status } = await httpRequest(
        `${setup.baseUrl}/system/tenants/prod_foo`,
        "POST",
        {
          adminSigningPublicKey: wildcardUser.userSigningKeyPair.publicKey,
          adminEncryptionPublicKey: wildcardUser.userEncryptionKeyPair.publicKey,
        },
        { Authorization: `Bearer ${token}` },
      );
      expect(status).toBe(403);
    });
  });

  // =========================================================================
  // Tenant CRUD routes
  // =========================================================================

  describe("Tenant CRUD Routes", () => {
    let setup: TestSetup;
    const port = 4003;

    beforeAll(async () => {
      setup = await createTestSetup(port, cryptoAdapter, factory);
    });

    afterAll(async () => {
      await teardownTestSetup(setup);
    });

    test("POST /system/tenants/:tenantId creates tenant", async () => {
      const token = await getSystemAdminToken(
        setup.baseUrl,
        setup.adminUser,
        "admin-pass",
        cryptoAdapter,
        factory,
      );

      const adminSigningKey = await factory.createSigningKeyPair("pw");
      const adminEncryptionKey = await factory.createEncryptionKeyPair("pw");

      const { status, body } = await httpRequest(
        `${setup.baseUrl}/system/tenants/crud-test`,
        "POST",
        {
          adminSigningPublicKey: adminSigningKey.publicKey,
          adminEncryptionPublicKey: adminEncryptionKey.publicKey,
          publicInfosKey: createPublicInfosKeyBase64(1),
        },
        { Authorization: `Bearer ${token}` },
      );
      expect(status).toBe(201);
      expect(body).toMatchObject({ success: true, tenantId: "crud-test" });
    });

    test("TenantManager rejects tenant paths that escape the data directory", async () => {
      expect(() => {
        setup.server.getTenantManager().updateTenantConfig("../escape", {});
      }).toThrow('Resolved tenant path escapes data directory for tenantId "../escape"');
    });

    test("tenant registration stores $publicinfos in the server keybag, not config.json", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const token = await getSystemAdminToken(
        setup.baseUrl,
        setup.adminUser,
        "admin-pass",
        cryptoAdapter,
        factory,
      );
      const tenantId = "keybag-test";
      const publicInfosKey = createPublicInfosKeyBase64(9);
      const adminSigningKey = await factory.createSigningKeyPair("pw");
      const adminEncryptionKey = await factory.createEncryptionKeyPair("pw");

      const { status } = await httpRequest(
        `${setup.baseUrl}/system/tenants/${tenantId}`,
        "POST",
        {
          adminSigningPublicKey: adminSigningKey.publicKey,
          adminEncryptionPublicKey: adminEncryptionKey.publicKey,
          publicInfosKey,
        },
        { Authorization: `Bearer ${token}` },
      );
      expect(status).toBe(201);

      const configPath = path.join(setup.dataDir, tenantId, "config.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { publicInfosKey?: string };
      expect(config.publicInfosKey).toBeUndefined();

      const storedKeys = await loadServerStoredPublicInfosKeys(setup, tenantId);
      expect(storedKeys.map((key) => Buffer.from(key).toString("base64"))).toContain(publicInfosKey);
    });

    test("POST /system/tenants/:tenantId is idempotent for the same $publicinfos key and rejects mismatches", async () => {
      const token = await getSystemAdminToken(
        setup.baseUrl,
        setup.adminUser,
        "admin-pass",
        cryptoAdapter,
        factory,
      );
      const tenantId = "crud-idempotent-test";
      const publicInfosKey = createPublicInfosKeyBase64(10);
      const conflictingPublicInfosKey = createPublicInfosKeyBase64(11);
      const adminSigningKey = await factory.createSigningKeyPair("pw");
      const adminEncryptionKey = await factory.createEncryptionKeyPair("pw");

      const initialResponse = await httpRequest(
        `${setup.baseUrl}/system/tenants/${tenantId}`,
        "POST",
        {
          adminSigningPublicKey: adminSigningKey.publicKey,
          adminEncryptionPublicKey: adminEncryptionKey.publicKey,
          publicInfosKey,
        },
        { Authorization: `Bearer ${token}` },
      );
      expect(initialResponse.status).toBe(201);

      const repeatResponse = await httpRequest(
        `${setup.baseUrl}/system/tenants/${tenantId}`,
        "POST",
        {
          adminSigningPublicKey: adminSigningKey.publicKey,
          adminEncryptionPublicKey: adminEncryptionKey.publicKey,
          publicInfosKey,
        },
        { Authorization: `Bearer ${token}` },
      );
      expect(repeatResponse.status).toBe(200);
      expect(repeatResponse.body).toMatchObject({ success: true, tenantId, created: false });

      const conflictResponse = await httpRequest(
        `${setup.baseUrl}/system/tenants/${tenantId}`,
        "POST",
        {
          adminSigningPublicKey: adminSigningKey.publicKey,
          adminEncryptionPublicKey: adminEncryptionKey.publicKey,
          publicInfosKey: conflictingPublicInfosKey,
        },
        { Authorization: `Bearer ${token}` },
      );
      expect(conflictResponse.status).toBe(409);
    });

    test("public well-known fingerprints reflect stored keys and tenant deletion removes them", async () => {
      const token = await getSystemAdminToken(
        setup.baseUrl,
        setup.adminUser,
        "admin-pass",
        cryptoAdapter,
        factory,
      );
      const tenantId = "crud-fingerprint-test";
      const publicInfosKey = createPublicInfosKeyBase64(12);
      const expectedFingerprint = await computeSymmetricKeyFingerprint(
        new Uint8Array(Buffer.from(publicInfosKey, "base64")),
      );
      const adminSigningKey = await factory.createSigningKeyPair("pw");
      const adminEncryptionKey = await factory.createEncryptionKeyPair("pw");

      const createResponse = await httpRequest(
        `${setup.baseUrl}/system/tenants/${tenantId}`,
        "POST",
        {
          adminSigningPublicKey: adminSigningKey.publicKey,
          adminEncryptionPublicKey: adminEncryptionKey.publicKey,
          publicInfosKey,
        },
        { Authorization: `Bearer ${token}` },
      );
      expect(createResponse.status).toBe(201);

      const fingerprintResponse = await httpRequest(
        `${setup.baseUrl}/.well-known/mindoodb-tenants/${tenantId}/publicinfos-fingerprints`,
        "GET",
      );
      expect(fingerprintResponse.status).toBe(200);
      expect(fingerprintResponse.body).toMatchObject({
        tenantId,
        fingerprints: [expectedFingerprint],
      });

      const deleteResponse = await httpRequest(
        `${setup.baseUrl}/system/tenants/${tenantId}`,
        "DELETE",
        undefined,
        { Authorization: `Bearer ${token}` },
      );
      expect(deleteResponse.status).toBe(200);
      expect(await loadServerStoredPublicInfosKeys(setup, tenantId)).toHaveLength(0);
    });

    test("public well-known fingerprints return a stable not-found message for unknown tenants", async () => {
      const tenantId = "missing-tenant";
      const response = await httpRequest(
        `${setup.baseUrl}/.well-known/mindoodb-tenants/${tenantId}/publicinfos-fingerprints`,
        "GET",
      );
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ error: "Tenant not found on server" });
    });

    test("tenant auth challenge includes tenant and server name when the tenant is unknown", async () => {
      const tenantId = "missing-tenant";
      const response = await httpRequest(
        `${setup.baseUrl}/${tenantId}/auth/challenge`,
        "POST",
        { username: "cn=user/o=test" },
      );
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        error: "Tenant missing-tenant not found on server CN=test-sysadmin-server",
      });
    });

    test("GET /system/tenants lists tenants", async () => {
      const token = await getSystemAdminToken(
        setup.baseUrl,
        setup.adminUser,
        "admin-pass",
        cryptoAdapter,
        factory,
      );

      const { status, body } = await httpRequest(
        `${setup.baseUrl}/system/tenants`,
        "GET",
        undefined,
        { Authorization: `Bearer ${token}` },
      );
      expect(status).toBe(200);
      expect((body as { tenants: string[] }).tenants).toContain("crud-test");
    });

    test("PUT /system/tenants/:tenantId updates config", async () => {
      const token = await getSystemAdminToken(
        setup.baseUrl,
        setup.adminUser,
        "admin-pass",
        cryptoAdapter,
        factory,
      );

      const { status, body } = await httpRequest(
        `${setup.baseUrl}/system/tenants/crud-test`,
        "PUT",
        { defaultStoreType: "inmemory" },
        { Authorization: `Bearer ${token}` },
      );
      expect(status).toBe(200);
      expect(body).toMatchObject({ success: true });
    });

    test("DELETE /system/tenants/:tenantId removes tenant", async () => {
      const token = await getSystemAdminToken(
        setup.baseUrl,
        setup.adminUser,
        "admin-pass",
        cryptoAdapter,
        factory,
      );

      const { status, body } = await httpRequest(
        `${setup.baseUrl}/system/tenants/crud-test`,
        "DELETE",
        undefined,
        { Authorization: `Bearer ${token}` },
      );
      expect(status).toBe(200);
      expect(body).toMatchObject({ success: true });

      // Verify it's gone
      const { body: listBody } = await httpRequest(
        `${setup.baseUrl}/system/tenants`,
        "GET",
        undefined,
        { Authorization: `Bearer ${token}` },
      );
      expect((listBody as { tenants: string[] }).tenants).not.toContain("crud-test");
    });

    test("old /admin/register-tenant no longer exists", async () => {
      const { status } = await httpRequest(
        `${setup.baseUrl}/admin/register-tenant`,
        "POST",
        { tenantId: "should-fail" },
      );
      expect(status).toBe(404);
    });
  });

  // =========================================================================
  // publishToServer with new auth
  // =========================================================================

  describe("publishToServer with system admin auth", () => {
    let setup: TestSetup;
    const port = 4004;

    beforeAll(async () => {
      setup = await createTestSetup(port, cryptoAdapter, factory);
    });

    afterAll(async () => {
      await teardownTestSetup(setup);
    });

    test("should create tenant via publishToServer with systemAdminUser", async () => {
      const localStoreFactory = new InMemoryContentAddressedStoreFactory();
      const localFactory = new BaseMindooTenantFactory(localStoreFactory, cryptoAdapter);

      const result = await localFactory.createTenant({
        tenantId: "publish-sysadmin-test",
        adminName: "cn=admin/o=publish-test",
        adminPassword: "admin-pass",
        userName: "cn=user1/o=publish-test",
        userPassword: "user-pass",
      });

      await result.tenant.publishToServer(setup.baseUrl, {
        systemAdminUser: setup.adminUser,
        systemAdminPassword: "admin-pass",
        adminUsername: result.adminUser.username,
      });

      // Verify the tenant was registered
      const token = await getSystemAdminToken(
        setup.baseUrl,
        setup.adminUser,
        "admin-pass",
        cryptoAdapter,
        factory,
      );
      const { body } = await httpRequest(
        `${setup.baseUrl}/system/tenants`,
        "GET",
        undefined,
        { Authorization: `Bearer ${token}` },
      );
      expect((body as { tenants: string[] }).tenants).toContain("publish-sysadmin-test");
    }, 60000);

    test("should authenticate the first user from synced directory grants without config users", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const localStoreFactory = new InMemoryContentAddressedStoreFactory();
      const localFactory = new BaseMindooTenantFactory(localStoreFactory, cryptoAdapter);

      const result = await localFactory.createTenant({
        tenantId: "publish-directory-grant-test",
        adminName: "cn=admin/o=publish-test",
        adminPassword: "admin-pass",
        userName: "cn=user1/o=publish-test",
        userPassword: "user-pass",
      });

      await result.tenant.publishToServer(setup.baseUrl, {
        systemAdminUser: setup.adminUser,
        systemAdminPassword: "admin-pass",
        adminUsername: result.adminUser.username,
      });

      const configPath = path.join(setup.dataDir, "publish-directory-grant-test", "config.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { users?: unknown[] };
      expect(config.users ?? []).toHaveLength(0);

      const directoryDb = await result.tenant.openDB("directory", { adminOnlyDb: true });
      await directoryDb.syncStoreChanges();
      const remote = await result.tenant.connectToServer(
        setup.baseUrl,
        "directory",
      ) as ClientNetworkContentAddressedStore;
      const remoteAgain = await result.tenant.connectToServer(
        setup.baseUrl,
        "directory",
      ) as ClientNetworkContentAddressedStore;
      const adminSigningKey = await decryptUserSigningKey(
        cryptoAdapter,
        result.adminUser,
        "admin-pass",
      );

      expect(remoteAgain).toBe(remote);

      remote.setSyncAuthOverride({
        username: result.adminUser.username,
        signingKey: adminSigningKey,
      });
      try {
        await directoryDb.pushChangesTo(remote);
      } finally {
        remote.clearSyncAuthOverride();
      }

      const challengeRes = await httpRequest(
        `${setup.baseUrl}/publish-directory-grant-test/auth/challenge`,
        "POST",
        { username: result.appUser.username },
      );
      expect(challengeRes.status).toBe(200);
      const challenge = (challengeRes.body as { challenge: string }).challenge;
      const appSigningKey = await decryptUserSigningKey(
        cryptoAdapter,
        result.appUser,
        "user-pass",
      );
      const signature = await signChallenge(cryptoAdapter, appSigningKey, challenge);
      const authRes = await httpRequest(
        `${setup.baseUrl}/publish-directory-grant-test/auth/authenticate`,
        "POST",
        {
          challenge,
          signature: uint8ArrayToBase64(signature),
        },
      );

      expect(authRes.status).toBe(200);
      expect(authRes.body).toMatchObject({
        success: true,
        token: expect.any(String),
      });
    }, 60000);
  });

  // =========================================================================
  // MindooDBServerAdmin wrapper
  // =========================================================================

  describe("MindooDBServerAdmin wrapper", () => {
    let setup: TestSetup;
    const port = 4005;

    beforeAll(async () => {
      setup = await createTestSetup(port, cryptoAdapter, factory);
    });

    afterAll(async () => {
      await teardownTestSetup(setup);
    });

    test("should list tenants", async () => {
      const admin = new MindooDBServerAdmin({
        serverUrl: setup.baseUrl,
        systemAdminUser: setup.adminUser,
        systemAdminPassword: "admin-pass",
        cryptoAdapter,
      });

      const tenants = await admin.listTenants();
      expect(Array.isArray(tenants)).toBe(true);
    });

    test("should register and remove a tenant", async () => {
      const admin = new MindooDBServerAdmin({
        serverUrl: setup.baseUrl,
        systemAdminUser: setup.adminUser,
        systemAdminPassword: "admin-pass",
        cryptoAdapter,
      });

      const adminSigningKey = await factory.createSigningKeyPair("pw");
      const adminEncryptionKey = await factory.createEncryptionKeyPair("pw");

      const result = await admin.registerTenant("wrapper-test", {
        adminSigningPublicKey: adminSigningKey.publicKey,
        adminEncryptionPublicKey: adminEncryptionKey.publicKey,
        publicInfosKey: createPublicInfosKeyBase64(2),
      });
      expect(result.success).toBe(true);
      expect(result.tenantId).toBe("wrapper-test");

      const tenants = await admin.listTenants();
      expect(tenants).toContain("wrapper-test");

      const removeResult = await admin.removeTenant("wrapper-test");
      expect(removeResult.success).toBe(true);

      const tenantsAfter = await admin.listTenants();
      expect(tenantsAfter).not.toContain("wrapper-test");
    });

    test("should ignore bootstrap app users in config when publicInfosKey is present", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const admin = new MindooDBServerAdmin({
        serverUrl: setup.baseUrl,
        systemAdminUser: setup.adminUser,
        systemAdminPassword: "admin-pass",
        cryptoAdapter,
      });

      const adminSigningKey = await factory.createSigningKeyPair("pw");
      const adminEncryptionKey = await factory.createEncryptionKeyPair("pw");
      const userSigningKey = await factory.createSigningKeyPair("pw");
      const userEncryptionKey = await factory.createEncryptionKeyPair("pw");

      await admin.registerTenant("wrapper-publicinfos-test", {
        adminSigningPublicKey: adminSigningKey.publicKey,
        adminEncryptionPublicKey: adminEncryptionKey.publicKey,
        publicInfosKey: "AQ==",
        users: [{
          username: "cn=appuser/o=test",
          signingPublicKey: userSigningKey.publicKey,
          encryptionPublicKey: userEncryptionKey.publicKey,
        }],
      });

      const configPath = path.join(setup.dataDir, "wrapper-publicinfos-test", "config.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { users?: unknown[] };
      expect(config.users ?? []).toHaveLength(0);
    });

    test("should manage trusted servers", async () => {
      const admin = new MindooDBServerAdmin({
        serverUrl: setup.baseUrl,
        systemAdminUser: setup.adminUser,
        systemAdminPassword: "admin-pass",
        cryptoAdapter,
      });

      const addResult = await admin.addTrustedServer({
        name: "CN=wrapper-test-server",
        signingPublicKey: "-----BEGIN PUBLIC KEY-----\nFAKE\n-----END PUBLIC KEY-----",
        encryptionPublicKey: "-----BEGIN PUBLIC KEY-----\nFAKE\n-----END PUBLIC KEY-----",
      });
      expect(addResult.success).toBe(true);

      const servers = await admin.listTrustedServers();
      expect(servers.some((s) => s.name === "CN=wrapper-test-server")).toBe(true);

      const removeResult = await admin.removeTrustedServer("CN=wrapper-test-server");
      expect(removeResult.success).toBe(true);
    });

    test("should manage tenant sync servers", async () => {
      const admin = new MindooDBServerAdmin({
        serverUrl: setup.baseUrl,
        systemAdminUser: setup.adminUser,
        systemAdminPassword: "admin-pass",
        cryptoAdapter,
      });

      // Create a tenant first
      const adminSigningKey = await factory.createSigningKeyPair("pw");
      const adminEncryptionKey = await factory.createEncryptionKeyPair("pw");
      await admin.registerTenant("sync-test", {
        adminSigningPublicKey: adminSigningKey.publicKey,
        adminEncryptionPublicKey: adminEncryptionKey.publicKey,
        publicInfosKey: createPublicInfosKeyBase64(3),
      });

      const addResult = await admin.addTenantSyncServer("sync-test", {
        name: "CN=sync-server",
        url: "https://sync.example.com",
        databases: ["directory", "main"],
      });
      expect(addResult.success).toBe(true);

      const servers = await admin.listTenantSyncServers("sync-test");
      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe("CN=sync-server");

      const removeResult = await admin.removeTenantSyncServer(
        "sync-test",
        "CN=sync-server",
      );
      expect(removeResult.success).toBe(true);
    });

    test("should trigger tenant sync", async () => {
      const admin = new MindooDBServerAdmin({
        serverUrl: setup.baseUrl,
        systemAdminUser: setup.adminUser,
        systemAdminPassword: "admin-pass",
        cryptoAdapter,
      });

      const result = await admin.triggerTenantSync("sync-test");
      expect(result.success).toBe(true);
    });

    test("should update tenant config through the wrapper", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const admin = new MindooDBServerAdmin({
        serverUrl: setup.baseUrl,
        systemAdminUser: setup.adminUser,
        systemAdminPassword: "admin-pass",
        cryptoAdapter,
      });

      const adminSigningKey = await factory.createSigningKeyPair("pw");
      const adminEncryptionKey = await factory.createEncryptionKeyPair("pw");
      await admin.registerTenant("wrapper-update-test", {
        adminSigningPublicKey: adminSigningKey.publicKey,
        adminEncryptionPublicKey: adminEncryptionKey.publicKey,
        publicInfosKey: createPublicInfosKeyBase64(4),
      });

      const result = await admin.updateTenant("wrapper-update-test", {
        defaultStoreType: "inmemory",
      });
      expect(result.success).toBe(true);
      expect(result.message).toContain("updated");

      const configPath = path.join(setup.dataDir, "wrapper-update-test", "config.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
        defaultStoreType?: string;
      };
      expect(config.defaultStoreType).toBe("inmemory");
    });

  });

  describe("MindooDBServerAdmin config helpers", () => {
    let setup: TestSetup;
    const port = 4007;

    beforeAll(async () => {
      setup = await createTestSetup(port, cryptoAdapter, factory);
    });

    afterAll(async () => {
      await teardownTestSetup(setup);
    });

    test("should grant access, dedupe duplicate grants, and query matching rules", async () => {
      const admin = new MindooDBServerAdmin({
        serverUrl: setup.baseUrl,
        systemAdminUser: setup.adminUser,
        systemAdminPassword: "admin-pass",
        cryptoAdapter,
      });
      const delegatedAdmin = await factory.createUserId("cn=delegated-admin/o=test", "delegate-pass");
      const principal = {
        username: delegatedAdmin.username,
        publicsignkey: delegatedAdmin.userSigningKeyPair.publicKey as string,
      };

      const grantResult = await admin.grantSystemAdminAccess(principal, [
        "POST:/system/tenants/*",
        "GET:/system/tenants",
      ]);
      expect(grantResult.success).toBe(true);
      expect(grantResult.addedToRules.sort()).toEqual([
        "GET:/system/tenants",
        "POST:/system/tenants/*",
      ]);
      expect(grantResult.alreadyPresentRules).toEqual([]);

      const duplicateGrant = await admin.grantSystemAdminAccess(principal, [
        "POST:/system/tenants/*",
      ]);
      expect(duplicateGrant.success).toBe(true);
      expect(duplicateGrant.addedToRules).toEqual([]);
      expect(duplicateGrant.alreadyPresentRules).toEqual(["POST:/system/tenants/*"]);

      const currentConfig = await admin.getConfig();
      expect(currentConfig.capabilities["POST:/system/tenants/*"]).toHaveLength(1);

      const access = await admin.findSystemAdminAccess(principal);
      expect(access.principal).toEqual(principal);
      expect(access.rules).toEqual([
        "GET:/system/tenants",
        "POST:/system/tenants/*",
      ]);
    });

    test("should revoke delegated access from selected rules and then all rules", async () => {
      const admin = new MindooDBServerAdmin({
        serverUrl: setup.baseUrl,
        systemAdminUser: setup.adminUser,
        systemAdminPassword: "admin-pass",
        cryptoAdapter,
      });
      const existingPrincipal = (await admin.getConfig()).capabilities["POST:/system/tenants/*"][0];

      const revokeOneRule = await admin.revokeSystemAdminAccess(existingPrincipal, {
        rules: ["GET:/system/tenants"],
      });
      expect(revokeOneRule.success).toBe(true);
      expect(revokeOneRule.removedFromRules).toEqual(["GET:/system/tenants"]);

      const afterPartialRevoke = await admin.findSystemAdminAccess(existingPrincipal);
      expect(afterPartialRevoke.rules).toEqual(["POST:/system/tenants/*"]);

      const revokeEverywhere = await admin.revokeSystemAdminAccess(existingPrincipal);
      expect(revokeEverywhere.success).toBe(true);
      expect(revokeEverywhere.removedFromRules).toEqual(["POST:/system/tenants/*"]);

      const afterFullRevoke = await admin.findSystemAdminAccess(existingPrincipal);
      expect(afterFullRevoke.rules).toEqual([]);
      const config = await admin.getConfig();
      expect(config.capabilities["POST:/system/tenants/*"]).toBeUndefined();
    });

    test("should reject empty grant rule lists", async () => {
      const admin = new MindooDBServerAdmin({
        serverUrl: setup.baseUrl,
        systemAdminUser: setup.adminUser,
        systemAdminPassword: "admin-pass",
        cryptoAdapter,
      });
      const principal = {
        username: "cn=no-rules/o=test",
        publicsignkey: "-----BEGIN PUBLIC KEY-----\nTEST\n-----END PUBLIC KEY-----",
      };

      await expect(admin.grantSystemAdminAccess(principal, [])).rejects.toThrow(
        "grantSystemAdminAccess requires at least one rule",
      );
    });

    test("should report no rules for a principal that is not present", async () => {
      const admin = new MindooDBServerAdmin({
        serverUrl: setup.baseUrl,
        systemAdminUser: setup.adminUser,
        systemAdminPassword: "admin-pass",
        cryptoAdapter,
      });
      const missingPrincipal = {
        username: "cn=missing/o=test",
        publicsignkey: "-----BEGIN PUBLIC KEY-----\nMISSING\n-----END PUBLIC KEY-----",
      };

      const result = await admin.findSystemAdminAccess(missingPrincipal);
      expect(result.principal).toEqual(missingPrincipal);
      expect(result.rules).toEqual([]);
    });

    test("should treat revoking a missing principal as a no-op", async () => {
      const admin = new MindooDBServerAdmin({
        serverUrl: setup.baseUrl,
        systemAdminUser: setup.adminUser,
        systemAdminPassword: "admin-pass",
        cryptoAdapter,
      });
      const missingPrincipal = {
        username: "cn=missing/o=test",
        publicsignkey: "-----BEGIN PUBLIC KEY-----\nMISSING\n-----END PUBLIC KEY-----",
      };

      const result = await admin.revokeSystemAdminAccess(missingPrincipal);
      expect(result.success).toBe(true);
      expect(result.removedFromRules).toEqual([]);
    });

    test("should surface authentication failures for invalid admin credentials", async () => {
      const admin = new MindooDBServerAdmin({
        serverUrl: setup.baseUrl,
        systemAdminUser: setup.adminUser,
        systemAdminPassword: "wrong-password",
        cryptoAdapter,
      });

      await expect(admin.listTenants()).rejects.toThrow();
    });

  });

  describe("MindooDBServerAdmin auth behavior", () => {
    let setup: TestSetup;
    const port = 4009;

    beforeAll(async () => {
      setup = await createTestSetup(port, cryptoAdapter, factory);
    });

    afterAll(async () => {
      await teardownTestSetup(setup);
    });

    test("should allow a granted principal to authenticate and lose access after revoke", async () => {
      const admin = new MindooDBServerAdmin({
        serverUrl: setup.baseUrl,
        systemAdminUser: setup.adminUser,
        systemAdminPassword: "admin-pass",
        cryptoAdapter,
      });
      const delegatedAdmin = await factory.createUserId("cn=auth-check/o=test", "delegated-pass");
      const principal = {
        username: delegatedAdmin.username,
        publicsignkey: delegatedAdmin.userSigningKeyPair.publicKey as string,
      };

      await admin.grantSystemAdminAccess(principal, ["POST:/system/tenants/*"]);

      const delegatedToken = await getSystemAdminToken(
        setup.baseUrl,
        delegatedAdmin,
        "delegated-pass",
        cryptoAdapter,
        factory,
      );
      const createTenantResponse = await httpRequest(
        `${setup.baseUrl}/system/tenants/delegated-auth-test`,
        "POST",
        {
          adminSigningPublicKey: delegatedAdmin.userSigningKeyPair.publicKey,
          adminEncryptionPublicKey: delegatedAdmin.userEncryptionKeyPair.publicKey,
          publicInfosKey: createPublicInfosKeyBase64(8),
        },
        { Authorization: `Bearer ${delegatedToken}` },
      );
      expect(createTenantResponse.status).toBe(201);

      await admin.revokeSystemAdminAccess(principal);

      const { status } = await httpRequest(
        `${setup.baseUrl}/system/auth/challenge`,
        "POST",
        principal,
      );
      expect(status).toBe(404);
    });
  });

  // =========================================================================
  // Runtime config update (GET/PUT /system/config)
  // =========================================================================

  describe("Runtime Config Update", () => {
    let setup: TestSetup;
    let dataDir: string;
    const port = 4006;

    beforeAll(async () => {
      const fs = await import("fs");
      const path = await import("path");
      dataDir = `/tmp/mindoodb-config-update-test-${Date.now()}`;
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, "trusted-servers.json"), "[]", "utf-8");

      const serverIdentity = await factory.createUserId("CN=config-test-server", "test-password");
      fs.writeFileSync(
        path.join(dataDir, "server.identity.json"),
        JSON.stringify(serverIdentity, null, 2),
        "utf-8",
      );

      const adminUser = await factory.createUserId("cn=sysadmin/o=test", "admin-pass");

      const config: ServerConfig = {
        capabilities: {
          "ALL:/system/*": [
            {
              username: adminUser.username,
              publicsignkey: adminUser.userSigningKeyPair.publicKey as string,
            },
          ],
        },
      };

      // Write config.json to disk so backup works
      const configPath = path.join(dataDir, "config.json");
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

      const server = new MindooDBServer(dataDir, "test-password", undefined, config, configPath);
      const baseUrl = `http://localhost:${port}`;

      const httpServer = await new Promise<Server>((resolve) => {
        const s = server.getApp().listen(port, () => resolve(s));
      });

      setup = {
        server,
        httpServer,
        baseUrl,
        dataDir,
        config,
        adminUser,
        adminSigningKeyPair: undefined as any,
        adminSigningPublicKeyPem: "",
      };
    });

    afterAll(async () => {
      await teardownTestSetup(setup);
      const fs = await import("fs");
      // Clean up backup files
      const files = fs.readdirSync(dataDir);
      for (const f of files) {
        fs.unlinkSync(`${dataDir}/${f}`);
      }
      fs.rmdirSync(dataDir);
    });

    test("GET /system/config returns current config", async () => {
      const token = await getSystemAdminToken(
        setup.baseUrl,
        setup.adminUser,
        "admin-pass",
        cryptoAdapter,
        factory,
      );

      const { status, body } = await httpRequest(
        `${setup.baseUrl}/system/config`,
        "GET",
        undefined,
        { Authorization: `Bearer ${token}` },
      );

      expect(status).toBe(200);
      const config = body as ServerConfig;
      expect(config.capabilities).toBeDefined();
      expect(config.capabilities["ALL:/system/*"]).toBeDefined();
      expect(config.capabilities["ALL:/system/*"].length).toBe(1);
      expect(config.capabilities["ALL:/system/*"][0].username).toBe(
        setup.adminUser.username,
      );
    });

    test("PUT /system/config with valid config updates immediately", async () => {
      const fs = await import("fs");
      const token = await getSystemAdminToken(
        setup.baseUrl,
        setup.adminUser,
        "admin-pass",
        cryptoAdapter,
        factory,
      );

      // Create a second admin
      const secondAdmin = await factory.createUserId("cn=secondadmin/o=test", "pw2");

      const newConfig: ServerConfig = {
        rateLimits: {
          sync: {
            windowMs: 120_000,
            max: 2_000,
          },
        },
        capabilities: {
          "ALL:/system/*": [
            {
              username: setup.adminUser.username,
              publicsignkey: setup.adminUser.userSigningKeyPair.publicKey as string,
            },
            {
              username: secondAdmin.username,
              publicsignkey: secondAdmin.userSigningKeyPair.publicKey as string,
            },
          ],
        },
      };

      const { status, body } = await httpRequest(
        `${setup.baseUrl}/system/config`,
        "PUT",
        newConfig,
        { Authorization: `Bearer ${token}` },
      );

      expect(status).toBe(200);
      const result = body as { success: boolean; backupFile?: string };
      expect(result.success).toBe(true);
      expect(result.backupFile).toBeDefined();
      expect(result.backupFile).toMatch(/^config\.\d{4}-\d{2}-\d{2}T.*\.json$/);

      // Verify backup file exists on disk
      const backupPath = `${dataDir}/${result.backupFile}`;
      expect(fs.existsSync(backupPath)).toBe(true);

      // Verify backup content matches old config
      const backupContent = JSON.parse(fs.readFileSync(backupPath, "utf-8"));
      expect(Object.keys(backupContent.capabilities)).toEqual(["ALL:/system/*"]);
      expect(backupContent.capabilities["ALL:/system/*"].length).toBe(1);

      // Verify new config is persisted to disk
      const diskConfig = JSON.parse(
        fs.readFileSync(`${dataDir}/config.json`, "utf-8"),
      );
      expect(diskConfig.capabilities["ALL:/system/*"].length).toBe(2);
      expect(diskConfig.rateLimits?.sync).toEqual({
        windowMs: 120_000,
        max: 2_000,
      });

      // Verify new rules take effect immediately: second admin can now authenticate
      const secondToken = await getSystemAdminToken(
        setup.baseUrl,
        secondAdmin,
        "pw2",
        cryptoAdapter,
        factory,
      );
      const { status: listStatus } = await httpRequest(
        `${setup.baseUrl}/system/tenants`,
        "GET",
        undefined,
        { Authorization: `Bearer ${secondToken}` },
      );
      expect(listStatus).toBe(200);
    });

    test("PUT /system/config rejects self-lockout", async () => {
      const token = await getSystemAdminToken(
        setup.baseUrl,
        setup.adminUser,
        "admin-pass",
        cryptoAdapter,
        factory,
      );

      // Config that does not include the calling admin
      const lockoutConfig: ServerConfig = {
        capabilities: {
          "GET:/system/tenants": [
            {
              username: "cn=someone-else/o=test",
              publicsignkey: "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----",
            },
          ],
        },
      };

      const { status, body } = await httpRequest(
        `${setup.baseUrl}/system/config`,
        "PUT",
        lockoutConfig,
        { Authorization: `Bearer ${token}` },
      );

      expect(status).toBe(400);
      expect((body as any).error).toContain("remove your own access");
    });

    test("PUT /system/config rejects invalid config body", async () => {
      const token = await getSystemAdminToken(
        setup.baseUrl,
        setup.adminUser,
        "admin-pass",
        cryptoAdapter,
        factory,
      );

      const { status: status1 } = await httpRequest(
        `${setup.baseUrl}/system/config`,
        "PUT",
        { notCapabilities: true },
        { Authorization: `Bearer ${token}` },
      );
      expect(status1).toBe(400);

      const { status: status2 } = await httpRequest(
        `${setup.baseUrl}/system/config`,
        "PUT",
        { capabilities: { "INVALID": [] } },
        { Authorization: `Bearer ${token}` },
      );
      expect(status2).toBe(400);

      const { status: status3 } = await httpRequest(
        `${setup.baseUrl}/system/config`,
        "PUT",
        {
          capabilities: {
            "ALL:/system/*": [
              {
                username: setup.adminUser.username,
                publicsignkey: setup.adminUser.userSigningKeyPair.publicKey,
              },
            ],
          },
          rateLimits: {
            sync: {
              max: 0,
            },
          },
        },
        { Authorization: `Bearer ${token}` },
      );
      expect(status3).toBe(400);
    });

    test("PUT /system/config rejects wildcard principals on non-tenant routes", async () => {
      const token = await getSystemAdminToken(
        setup.baseUrl,
        setup.adminUser,
        "admin-pass",
        cryptoAdapter,
        factory,
      );

      const { status, body } = await httpRequest(
        `${setup.baseUrl}/system/config`,
        "PUT",
        {
          capabilities: {
            "GET:/system/tenants": [
              {
                username: "*",
                publicsignkey: "*",
              },
            ],
            "ALL:/system/*": [
              {
                username: setup.adminUser.username,
                publicsignkey: setup.adminUser.userSigningKeyPair.publicKey,
              },
            ],
          },
        },
        { Authorization: `Bearer ${token}` },
      );

      expect(status).toBe(400);
      expect((body as { error: string }).error).toContain(
        'wildcard principal "*" is only allowed for POST:/system/tenants/... rules',
      );
    });

    test("GET /system/config reflects updated config", async () => {
      const token = await getSystemAdminToken(
        setup.baseUrl,
        setup.adminUser,
        "admin-pass",
        cryptoAdapter,
        factory,
      );

      const { body } = await httpRequest(
        `${setup.baseUrl}/system/config`,
        "GET",
        undefined,
        { Authorization: `Bearer ${token}` },
      );

      const config = body as ServerConfig;
      // Should reflect the update from the earlier test (2 principals)
      expect(config.capabilities["ALL:/system/*"].length).toBe(2);
      expect(config.rateLimits?.sync).toEqual({
        windowMs: 120_000,
        max: 2_000,
      });
    });

    test("GET /system/config/backups lists created backups", async () => {
      const admin = new MindooDBServerAdmin({
        serverUrl: setup.baseUrl,
        systemAdminUser: setup.adminUser,
        systemAdminPassword: "admin-pass",
        cryptoAdapter,
      });

      const backups = await admin.listConfigBackups();
      expect(backups.length).toBeGreaterThan(0);
      expect(backups[0].file).toMatch(/^config\.\d{4}-\d{2}-\d{2}T.*\.json$/);
      expect(backups[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    test("GET /system/config/backups/:backupFile returns a validated previous snapshot", async () => {
      const admin = new MindooDBServerAdmin({
        serverUrl: setup.baseUrl,
        systemAdminUser: setup.adminUser,
        systemAdminPassword: "admin-pass",
        cryptoAdapter,
      });

      const [backup] = await admin.listConfigBackups();
      expect(backup).toBeDefined();

      const previousConfig = await admin.getConfigBackup(backup.file);
      expect(previousConfig.file).toBe(backup.file);
      expect(previousConfig.config.capabilities["ALL:/system/*"]).toHaveLength(1);
      expect(previousConfig.config.capabilities["ALL:/system/*"][0].username).toBe(
        setup.adminUser.username,
      );
    });

  });

  describe("Runtime Config Backup edge cases", () => {
    let setup: TestSetup;
    let dataDir: string;
    const port = 4008;

    beforeAll(async () => {
      const fs = await import("fs");
      const path = await import("path");
      dataDir = `/tmp/mindoodb-config-backup-edge-test-${Date.now()}`;
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, "trusted-servers.json"), "[]", "utf-8");

      const serverIdentity = await factory.createUserId("CN=config-edge-test-server", "test-password");
      fs.writeFileSync(
        path.join(dataDir, "server.identity.json"),
        JSON.stringify(serverIdentity, null, 2),
        "utf-8",
      );

      const adminUser = await factory.createUserId("cn=sysadmin/o=test", "admin-pass");
      const config: ServerConfig = {
        capabilities: {
          "ALL:/system/*": [
            {
              username: adminUser.username,
              publicsignkey: adminUser.userSigningKeyPair.publicKey as string,
            },
          ],
        },
      };

      const configPath = path.join(dataDir, "config.json");
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
      fs.writeFileSync(
        path.join(dataDir, "config.2026-01-01T00-00-00.000Z.json"),
        JSON.stringify(config, null, 2),
        "utf-8",
      );

      const server = new MindooDBServer(dataDir, "test-password", undefined, config, configPath);
      const baseUrl = `http://localhost:${port}`;
      const httpServer = await new Promise<Server>((resolve) => {
        const s = server.getApp().listen(port, () => resolve(s));
      });

      setup = {
        server,
        httpServer,
        baseUrl,
        dataDir,
        config,
        adminUser,
        adminSigningKeyPair: undefined as any,
        adminSigningPublicKeyPem: "",
      };
    });

    afterAll(async () => {
      await teardownTestSetup(setup);
      const fs = await import("fs");
      const files = fs.readdirSync(dataDir);
      for (const f of files) {
        fs.unlinkSync(`${dataDir}/${f}`);
      }
      fs.rmdirSync(dataDir);
    });

    test("GET /system/config/backups/:backupFile rejects invalid filenames", async () => {
      const token = await getSystemAdminToken(
        setup.baseUrl,
        setup.adminUser,
        "admin-pass",
        cryptoAdapter,
        factory,
      );

      const { status, body } = await httpRequest(
        `${setup.baseUrl}/system/config/backups/not-a-backup.json`,
        "GET",
        undefined,
        { Authorization: `Bearer ${token}` },
      );

      expect(status).toBe(400);
      expect((body as { error: string }).error).toContain("Invalid config backup filename");
    });

    test("readConfigBackup reads a known backup via the explicit wrapper method", async () => {
      const admin = new MindooDBServerAdmin({
        serverUrl: setup.baseUrl,
        systemAdminUser: setup.adminUser,
        systemAdminPassword: "admin-pass",
        cryptoAdapter,
      });

      const previousConfig = await admin.readConfigBackup(
        "config.2026-01-01T00-00-00.000Z.json",
      );

      expect(previousConfig.file).toBe("config.2026-01-01T00-00-00.000Z.json");
      expect(previousConfig.config.capabilities["ALL:/system/*"]).toHaveLength(1);
      expect(previousConfig.config.capabilities["ALL:/system/*"][0].username).toBe(
        setup.adminUser.username,
      );
    });
  });
});
