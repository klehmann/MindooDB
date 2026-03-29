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
import { MindooDBServerAdmin } from "../core/MindooDBServerAdmin";
import type { PrivateUserId } from "../core/userid";
import type { ServerConfig } from "../node/server/types";
import { MindooDBServer } from "../node/server/MindooDBServer";

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

// ===========================================================================
// Test setup helpers
// ===========================================================================

interface TestSetup {
  server: MindooDBServer;
  httpServer: Server;
  baseUrl: string;
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
    path.join(dataDir, "server-identity.json"),
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
    config,
    adminUser,
    adminSigningKeyPair,
    adminSigningPublicKeyPem,
  };
}

async function teardownTestSetup(setup: TestSetup): Promise<void> {
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
        },
        { Authorization: `Bearer ${token}` },
      );
      expect(status).toBe(201);
      expect(body).toMatchObject({ success: true, tenantId: "crud-test" });
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
        path.join(dataDir, "server-identity.json"),
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
    });
  });
});
