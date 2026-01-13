import { InMemoryAppendOnlyStoreFactory } from "../appendonlystores/InMemoryAppendOnlyStoreFactory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { RSAEncryption } from "../core/crypto/RSAEncryption";
import { AuthenticationService } from "../core/appendonlystores/network/AuthenticationService";
import { ClientNetworkAppendOnlyStore } from "../appendonlystores/network/ClientNetworkAppendOnlyStore";
import { ServerNetworkAppendOnlyStore } from "../appendonlystores/network/ServerNetworkAppendOnlyStore";
import type { NetworkTransport } from "../core/appendonlystores/network/NetworkTransport";
import type { NetworkEncryptedChange, AuthResult } from "../core/appendonlystores/network/types";
import type { MindooDocChange, MindooDocChangeHashes, MindooTenantDirectory, EncryptedPrivateKey } from "../core/types";
import type { PublicUserId } from "../core/userid";
import type { AppendOnlyStore } from "../core/appendonlystores/types";

/**
 * Mock NetworkTransport that connects directly to a ServerNetworkAppendOnlyStore
 * without actual network calls. Used for testing the client-server interaction.
 */
class MockNetworkTransport implements NetworkTransport {
  private server: ServerNetworkAppendOnlyStore;

  constructor(server: ServerNetworkAppendOnlyStore) {
    this.server = server;
  }

  async requestChallenge(username: string): Promise<string> {
    return this.server.handleChallengeRequest(username);
  }

  async authenticate(challenge: string, signature: Uint8Array): Promise<AuthResult> {
    return this.server.handleAuthenticate(challenge, signature);
  }

  async findNewChanges(token: string, haveChangeHashes: string[]): Promise<MindooDocChangeHashes[]> {
    return this.server.handleFindNewChanges(token, haveChangeHashes);
  }

  async findNewChangesForDoc(token: string, haveChangeHashes: string[], docId: string): Promise<MindooDocChangeHashes[]> {
    return this.server.handleFindNewChangesForDoc(token, haveChangeHashes, docId);
  }

  async getChanges(token: string, changeHashes: MindooDocChangeHashes[]): Promise<NetworkEncryptedChange[]> {
    return this.server.handleGetChanges(token, changeHashes);
  }

  async pushChanges(token: string, changes: MindooDocChange[]): Promise<void> {
    return this.server.handlePushChanges(token, changes);
  }

  async getAllChangeHashes(token: string): Promise<string[]> {
    return this.server.handleGetAllChangeHashes(token);
  }
}

describe("Network Sync", () => {
  let cryptoAdapter: NodeCryptoAdapter;

  beforeAll(() => {
    cryptoAdapter = new NodeCryptoAdapter();
  });

  describe("RSAEncryption", () => {
    let rsaEncryption: RSAEncryption;
    let publicKey: string;
    let privateKey: string;

    beforeAll(async () => {
      rsaEncryption = new RSAEncryption(cryptoAdapter);
      
      // Generate RSA key pair for testing
      const subtle = cryptoAdapter.getSubtle();
      const keyPair = await subtle.generateKey(
        {
          name: "RSA-OAEP",
          modulusLength: 3072,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["encrypt", "decrypt"]
      );

      // Export keys to PEM format
      const publicKeyBuffer = await subtle.exportKey("spki", keyPair.publicKey);
      const privateKeyBuffer = await subtle.exportKey("pkcs8", keyPair.privateKey);
      
      publicKey = arrayBufferToPEM(publicKeyBuffer, "PUBLIC KEY");
      privateKey = arrayBufferToPEM(privateKeyBuffer, "PRIVATE KEY");
    });

    test("should encrypt and decrypt small data", async () => {
      const originalData = new TextEncoder().encode("Hello, World!");
      
      const encrypted = await rsaEncryption.encrypt(originalData, publicKey);
      expect(encrypted.length).toBeGreaterThan(originalData.length);
      
      const decrypted = await rsaEncryption.decrypt(encrypted, privateKey);
      expect(new TextDecoder().decode(decrypted)).toBe("Hello, World!");
    });

    test("should encrypt and decrypt large data (hybrid encryption)", async () => {
      // Create data larger than RSA can handle directly (> 318 bytes for 3072-bit key)
      const originalData = new Uint8Array(10000);
      cryptoAdapter.getRandomValues(originalData);
      
      const encrypted = await rsaEncryption.encrypt(originalData, publicKey);
      expect(encrypted.length).toBeGreaterThan(originalData.length);
      
      const decrypted = await rsaEncryption.decrypt(encrypted, privateKey);
      expect(decrypted).toEqual(originalData);
    });

    test("should produce different ciphertext for same plaintext (random IV)", async () => {
      const originalData = new TextEncoder().encode("Same data");
      
      const encrypted1 = await rsaEncryption.encrypt(originalData, publicKey);
      const encrypted2 = await rsaEncryption.encrypt(originalData, publicKey);
      
      // Ciphertexts should be different due to random AES key and IV
      expect(encrypted1).not.toEqual(encrypted2);
      
      // But both should decrypt to the same value
      const decrypted1 = await rsaEncryption.decrypt(encrypted1, privateKey);
      const decrypted2 = await rsaEncryption.decrypt(encrypted2, privateKey);
      expect(decrypted1).toEqual(decrypted2);
    });
  });

  describe("AuthenticationService", () => {
    let authService: AuthenticationService;
    let mockDirectory: MockTenantDirectory;
    let userSigningKey: CryptoKeyPair;
    let userPublicKeyPem: string;

    beforeAll(async () => {
      // Create user signing key pair
      const subtle = cryptoAdapter.getSubtle();
      userSigningKey = await subtle.generateKey(
        { name: "Ed25519" },
        true,
        ["sign", "verify"]
      ) as CryptoKeyPair;

      // Export public key to PEM
      const publicKeyBuffer = await subtle.exportKey("spki", userSigningKey.publicKey);
      userPublicKeyPem = arrayBufferToPEM(publicKeyBuffer, "PUBLIC KEY");
    });

    beforeEach(() => {
      // Create mock directory with the test user
      mockDirectory = new MockTenantDirectory();
      mockDirectory.addUser("testuser", userPublicKeyPem, "dummy-encryption-key");
      
      authService = new AuthenticationService(
        cryptoAdapter,
        mockDirectory,
        "test-tenant",
        { challengeExpirationMs: 60000, tokenExpirationMs: 3600000 }
      );
    });

    test("should generate unique challenges", async () => {
      const challenge1 = await authService.generateChallenge("testuser");
      const challenge2 = await authService.generateChallenge("testuser");
      
      expect(challenge1).toBeDefined();
      expect(challenge2).toBeDefined();
      expect(challenge1).not.toBe(challenge2);
      
      // Should be UUID v7 format
      expect(challenge1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    test("should authenticate with valid signature", async () => {
      const challenge = await authService.generateChallenge("testuser");
      
      // Sign the challenge
      const subtle = cryptoAdapter.getSubtle();
      const signatureBuffer = await subtle.sign(
        { name: "Ed25519" },
        userSigningKey.privateKey,
        new TextEncoder().encode(challenge)
      );
      const signature = new Uint8Array(signatureBuffer);
      
      const result = await authService.authenticate(challenge, signature);
      
      expect(result.success).toBe(true);
      expect(result.token).toBeDefined();
      expect(result.error).toBeUndefined();
    });

    test("should reject invalid signature", async () => {
      const challenge = await authService.generateChallenge("testuser");
      
      // Use random bytes as signature
      const invalidSignature = cryptoAdapter.getRandomValues(new Uint8Array(64));
      
      const result = await authService.authenticate(challenge, invalidSignature);
      
      expect(result.success).toBe(false);
      expect(result.token).toBeUndefined();
      expect(result.error).toBeDefined();
    });

    test("should reject expired challenge", async () => {
      // Create auth service with very short expiration
      const shortExpiryAuthService = new AuthenticationService(
        cryptoAdapter,
        mockDirectory,
        "test-tenant",
        { challengeExpirationMs: 1, tokenExpirationMs: 3600000 }
      );
      
      const challenge = await shortExpiryAuthService.generateChallenge("testuser");
      
      // Wait for challenge to expire
      await sleep(10);
      
      const subtle = cryptoAdapter.getSubtle();
      const signatureBuffer = await subtle.sign(
        { name: "Ed25519" },
        userSigningKey.privateKey,
        new TextEncoder().encode(challenge)
      );
      
      const result = await shortExpiryAuthService.authenticate(challenge, new Uint8Array(signatureBuffer));
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("expired");
    });

    test("should reject challenge reuse (single-use)", async () => {
      const challenge = await authService.generateChallenge("testuser");
      
      const subtle = cryptoAdapter.getSubtle();
      const signatureBuffer = await subtle.sign(
        { name: "Ed25519" },
        userSigningKey.privateKey,
        new TextEncoder().encode(challenge)
      );
      const signature = new Uint8Array(signatureBuffer);
      
      // First authentication should succeed
      const result1 = await authService.authenticate(challenge, signature);
      expect(result1.success).toBe(true);
      
      // Second authentication with same challenge should fail
      const result2 = await authService.authenticate(challenge, signature);
      expect(result2.success).toBe(false);
      expect(result2.error).toContain("used");
    });

    test("should validate issued tokens", async () => {
      const challenge = await authService.generateChallenge("testuser");
      
      const subtle = cryptoAdapter.getSubtle();
      const signatureBuffer = await subtle.sign(
        { name: "Ed25519" },
        userSigningKey.privateKey,
        new TextEncoder().encode(challenge)
      );
      
      const result = await authService.authenticate(challenge, new Uint8Array(signatureBuffer));
      expect(result.token).toBeDefined();
      
      const payload = await authService.validateToken(result.token!);
      expect(payload).not.toBeNull();
      expect(payload!.sub).toBe("testuser");
      expect(payload!.tenantId).toBe("test-tenant");
    });

    test("should reject tokens for revoked users", async () => {
      const challenge = await authService.generateChallenge("testuser");
      
      const subtle = cryptoAdapter.getSubtle();
      const signatureBuffer = await subtle.sign(
        { name: "Ed25519" },
        userSigningKey.privateKey,
        new TextEncoder().encode(challenge)
      );
      
      const result = await authService.authenticate(challenge, new Uint8Array(signatureBuffer));
      expect(result.token).toBeDefined();
      
      // Revoke the user
      mockDirectory.revokeUserForTest("testuser");
      
      // Token validation should fail now
      const payload = await authService.validateToken(result.token!);
      expect(payload).toBeNull();
    });
  });

  describe("ClientNetworkAppendOnlyStore as Pure Remote Proxy", () => {
    let serverStore: AppendOnlyStore;
    let serverHandler: ServerNetworkAppendOnlyStore;
    let clientStore: ClientNetworkAppendOnlyStore;
    let mockDirectory: MockTenantDirectory;
    let userSigningKeyPair: CryptoKeyPair;
    let userEncryptionKeyPair: CryptoKeyPair;
    let userSigningPublicKeyPem: string;
    let userEncryptionPublicKeyPem: string;
    let userEncryptionPrivateKeyPem: string;

    beforeAll(async () => {
      const subtle = cryptoAdapter.getSubtle();
      
      // Generate user signing key pair
      userSigningKeyPair = await subtle.generateKey(
        { name: "Ed25519" },
        true,
        ["sign", "verify"]
      ) as CryptoKeyPair;
      
      const signingPublicKeyBuffer = await subtle.exportKey("spki", userSigningKeyPair.publicKey);
      userSigningPublicKeyPem = arrayBufferToPEM(signingPublicKeyBuffer, "PUBLIC KEY");
      
      // Generate user encryption key pair
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
      
      const encryptionPublicKeyBuffer = await subtle.exportKey("spki", userEncryptionKeyPair.publicKey);
      userEncryptionPublicKeyPem = arrayBufferToPEM(encryptionPublicKeyBuffer, "PUBLIC KEY");
      
      const encryptionPrivateKeyBuffer = await subtle.exportKey("pkcs8", userEncryptionKeyPair.privateKey);
      userEncryptionPrivateKeyPem = arrayBufferToPEM(encryptionPrivateKeyBuffer, "PRIVATE KEY");
    });

    beforeEach(async () => {
      // Create server store
      const storeFactory = new InMemoryAppendOnlyStoreFactory();
      serverStore = storeFactory.createStore("test-db");
      
      // Create mock directory
      mockDirectory = new MockTenantDirectory();
      mockDirectory.addUser("testuser", userSigningPublicKeyPem, userEncryptionPublicKeyPem);
      
      // Create authentication service
      const authService = new AuthenticationService(
        cryptoAdapter,
        mockDirectory,
        "test-tenant"
      );
      
      // Create server handler
      serverHandler = new ServerNetworkAppendOnlyStore(
        serverStore,
        mockDirectory,
        authService,
        cryptoAdapter
      );
      
      // Create mock transport
      const mockTransport = new MockNetworkTransport(serverHandler);
      
      // Create client store (no local store - pure remote proxy)
      clientStore = new ClientNetworkAppendOnlyStore(
        "test-db",
        mockTransport,
        cryptoAdapter,
        "testuser",
        userSigningKeyPair.privateKey,
        userEncryptionPrivateKeyPem
      );
    });

    test("should find new changes from remote", async () => {
      // Add changes to server store
      const change1 = createMockChange("doc1", "hash1", 1000);
      const change2 = createMockChange("doc1", "hash2", 2000, ["hash1"]);
      await serverStore.append(change1);
      await serverStore.append(change2);
      
      // Query via client store
      const newChanges = await clientStore.findNewChanges([]);
      
      expect(newChanges.length).toBe(2);
      expect(newChanges.map(c => c.changeHash)).toContain("hash1");
      expect(newChanges.map(c => c.changeHash)).toContain("hash2");
    });

    test("should find new changes excluding already known hashes", async () => {
      // Add changes to server store
      const change1 = createMockChange("doc1", "hash1", 1000);
      const change2 = createMockChange("doc1", "hash2", 2000, ["hash1"]);
      await serverStore.append(change1);
      await serverStore.append(change2);
      
      // Query with hash1 already known
      const newChanges = await clientStore.findNewChanges(["hash1"]);
      
      expect(newChanges.length).toBe(1);
      expect(newChanges[0].changeHash).toBe("hash2");
    });

    test("should get changes and decrypt them", async () => {
      // Add change to server store
      const change = createMockChange("doc1", "hash1", 1000);
      await serverStore.append(change);
      
      // Find and get changes
      const newChanges = await clientStore.findNewChanges([]);
      const retrievedChanges = await clientStore.getChanges(newChanges);
      
      expect(retrievedChanges.length).toBe(1);
      expect(retrievedChanges[0].changeHash).toBe("hash1");
      expect(retrievedChanges[0].docId).toBe("doc1");
      // Payload should be decrypted
      expect(retrievedChanges[0].payload).toEqual(change.payload);
    });

    test("should push changes to remote", async () => {
      // Server should be empty initially
      const initialHashes = await serverStore.getAllChangeHashes();
      expect(initialHashes.length).toBe(0);
      
      // Push a change via client store (must use trusted user's public key)
      const change = createMockChange("doc1", "hash1", 1000, [], userSigningPublicKeyPem);
      await clientStore.append(change);
      
      // Server should now have the change
      const finalHashes = await serverStore.getAllChangeHashes();
      expect(finalHashes.length).toBe(1);
      expect(finalHashes).toContain("hash1");
    });

    test("should get all change hashes from remote", async () => {
      // Add changes to server store
      await serverStore.append(createMockChange("doc1", "hash1", 1000));
      await serverStore.append(createMockChange("doc1", "hash2", 2000));
      await serverStore.append(createMockChange("doc2", "hash3", 3000));
      
      // Query via client store
      const allHashes = await clientStore.getAllChangeHashes();
      
      expect(allHashes.length).toBe(3);
      expect(allHashes).toContain("hash1");
      expect(allHashes).toContain("hash2");
      expect(allHashes).toContain("hash3");
    });

    test("should find new changes for specific document", async () => {
      // Add changes for multiple documents
      await serverStore.append(createMockChange("doc1", "hash1", 1000));
      await serverStore.append(createMockChange("doc2", "hash2", 2000));
      await serverStore.append(createMockChange("doc1", "hash3", 3000));
      
      // Query for doc1 only
      const doc1Changes = await clientStore.findNewChangesForDoc([], "doc1");
      
      expect(doc1Changes.length).toBe(2);
      expect(doc1Changes.map(c => c.changeHash)).toContain("hash1");
      expect(doc1Changes.map(c => c.changeHash)).toContain("hash3");
    });

    test("should cache authentication token", async () => {
      // Add a change to server
      await serverStore.append(createMockChange("doc1", "hash1", 1000));
      
      // Multiple calls should reuse token
      await clientStore.findNewChanges([]);
      await clientStore.getAllChangeHashes();
      await clientStore.findNewChanges([]);
      
      // If token caching works, we shouldn't get authentication errors
    });

    test("should re-authenticate after token clear", async () => {
      // Add changes
      await serverStore.append(createMockChange("doc1", "hash1", 1000));
      
      // Query first time
      await clientStore.findNewChanges([]);
      
      // Clear auth cache
      clientStore.clearAuthCache();
      
      // Add more changes
      await serverStore.append(createMockChange("doc1", "hash2", 2000, ["hash1"]));
      
      // Query again - should re-authenticate
      const changes = await clientStore.findNewChanges(["hash1"]);
      expect(changes.length).toBe(1);
    });
  });

  describe("Sync-Based Usage (Local + Remote Stores)", () => {
    let serverStore: AppendOnlyStore;
    let localStore: AppendOnlyStore;
    let serverHandler: ServerNetworkAppendOnlyStore;
    let remoteStore: ClientNetworkAppendOnlyStore;
    let mockDirectory: MockTenantDirectory;
    let userSigningKeyPair: CryptoKeyPair;
    let userEncryptionKeyPair: CryptoKeyPair;
    let userSigningPublicKeyPem: string;
    let userEncryptionPublicKeyPem: string;
    let userEncryptionPrivateKeyPem: string;

    beforeAll(async () => {
      const subtle = cryptoAdapter.getSubtle();
      
      // Generate user signing key pair
      userSigningKeyPair = await subtle.generateKey(
        { name: "Ed25519" },
        true,
        ["sign", "verify"]
      ) as CryptoKeyPair;
      
      const signingPublicKeyBuffer = await subtle.exportKey("spki", userSigningKeyPair.publicKey);
      userSigningPublicKeyPem = arrayBufferToPEM(signingPublicKeyBuffer, "PUBLIC KEY");
      
      // Generate user encryption key pair
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
      
      const encryptionPublicKeyBuffer = await subtle.exportKey("spki", userEncryptionKeyPair.publicKey);
      userEncryptionPublicKeyPem = arrayBufferToPEM(encryptionPublicKeyBuffer, "PUBLIC KEY");
      
      const encryptionPrivateKeyBuffer = await subtle.exportKey("pkcs8", userEncryptionKeyPair.privateKey);
      userEncryptionPrivateKeyPem = arrayBufferToPEM(encryptionPrivateKeyBuffer, "PRIVATE KEY");
    });

    beforeEach(async () => {
      // Create stores
      const storeFactory = new InMemoryAppendOnlyStoreFactory();
      serverStore = storeFactory.createStore("test-db");
      localStore = storeFactory.createStore("test-db");
      
      // Create mock directory
      mockDirectory = new MockTenantDirectory();
      mockDirectory.addUser("testuser", userSigningPublicKeyPem, userEncryptionPublicKeyPem);
      
      // Create authentication service
      const authService = new AuthenticationService(
        cryptoAdapter,
        mockDirectory,
        "test-tenant"
      );
      
      // Create server handler
      serverHandler = new ServerNetworkAppendOnlyStore(
        serverStore,
        mockDirectory,
        authService,
        cryptoAdapter
      );
      
      // Create mock transport
      const mockTransport = new MockNetworkTransport(serverHandler);
      
      // Create remote store (ClientNetworkAppendOnlyStore as pure remote proxy)
      remoteStore = new ClientNetworkAppendOnlyStore(
        "test-db",
        mockTransport,
        cryptoAdapter,
        "testuser",
        userSigningKeyPair.privateKey,
        userEncryptionPrivateKeyPem
      );
    });

    test("should pull changes from remote to local (simulates MindooDB.pullChangesFrom)", async () => {
      // Add changes to server
      await serverStore.append(createMockChange("doc1", "hash1", 1000));
      await serverStore.append(createMockChange("doc1", "hash2", 2000, ["hash1"]));
      await serverStore.append(createMockChange("doc2", "hash3", 3000));
      
      // Local should be empty
      expect((await localStore.getAllChangeHashes()).length).toBe(0);
      
      // Simulate MindooDB.pullChangesFrom logic:
      // 1. Get local hashes
      const localHashes = await localStore.getAllChangeHashes();
      
      // 2. Find new changes from remote
      const newChangeHashes = await remoteStore.findNewChanges(localHashes);
      
      // 3. Get the changes from remote
      const newChanges = await remoteStore.getChanges(newChangeHashes);
      
      // 4. Append to local
      for (const change of newChanges) {
        await localStore.append(change);
      }
      
      // Local should now have all changes
      const finalLocalHashes = await localStore.getAllChangeHashes();
      expect(finalLocalHashes.length).toBe(3);
      expect(finalLocalHashes).toContain("hash1");
      expect(finalLocalHashes).toContain("hash2");
      expect(finalLocalHashes).toContain("hash3");
    });

    test("should push changes from local to remote (simulates MindooDB.pushChangesTo)", async () => {
      // Add changes to local (must use trusted user's public key)
      await localStore.append(createMockChange("doc1", "hash1", 1000, [], userSigningPublicKeyPem));
      await localStore.append(createMockChange("doc1", "hash2", 2000, ["hash1"], userSigningPublicKeyPem));
      
      // Server should be empty
      expect((await serverStore.getAllChangeHashes()).length).toBe(0);
      
      // Simulate MindooDB.pushChangesTo logic:
      // 1. Get remote hashes
      const remoteHashes = await remoteStore.getAllChangeHashes();
      
      // 2. Find new changes in local that remote doesn't have
      const newChangeHashes = await localStore.findNewChanges(remoteHashes);
      
      // 3. Get the changes from local
      const newChanges = await localStore.getChanges(newChangeHashes);
      
      // 4. Push to remote
      for (const change of newChanges) {
        await remoteStore.append(change);
      }
      
      // Server should now have all changes
      const finalServerHashes = await serverStore.getAllChangeHashes();
      expect(finalServerHashes.length).toBe(2);
      expect(finalServerHashes).toContain("hash1");
      expect(finalServerHashes).toContain("hash2");
    });

    test("should handle bidirectional sync", async () => {
      // Add some changes to server (must use trusted user's public key)
      await serverStore.append(createMockChange("doc1", "server-hash1", 1000, [], userSigningPublicKeyPem));
      
      // Add some changes to local (must use trusted user's public key)
      await localStore.append(createMockChange("doc2", "local-hash1", 2000, [], userSigningPublicKeyPem));
      
      // Pull from server to local
      const localHashes = await localStore.getAllChangeHashes();
      const serverNewHashes = await remoteStore.findNewChanges(localHashes);
      const serverNewChanges = await remoteStore.getChanges(serverNewHashes);
      for (const change of serverNewChanges) {
        await localStore.append(change);
      }
      
      // Push from local to server
      const remoteHashes = await remoteStore.getAllChangeHashes();
      const localNewHashes = await localStore.findNewChanges(remoteHashes);
      const localNewChanges = await localStore.getChanges(localNewHashes);
      for (const change of localNewChanges) {
        await remoteStore.append(change);
      }
      
      // Both should now have both changes
      const finalLocalHashes = await localStore.getAllChangeHashes();
      const finalServerHashes = await serverStore.getAllChangeHashes();
      
      expect(finalLocalHashes.length).toBe(2);
      expect(finalServerHashes.length).toBe(2);
      
      expect(finalLocalHashes).toContain("server-hash1");
      expect(finalLocalHashes).toContain("local-hash1");
      expect(finalServerHashes).toContain("server-hash1");
      expect(finalServerHashes).toContain("local-hash1");
    });

    test("should only sync new changes (incremental sync)", async () => {
      // Initial sync: add change to both
      const change1 = createMockChange("doc1", "hash1", 1000);
      await serverStore.append(change1);
      await localStore.append(change1);
      
      // Add new change to server only
      const change2 = createMockChange("doc1", "hash2", 2000, ["hash1"]);
      await serverStore.append(change2);
      
      // Pull should only get the new change
      const localHashes = await localStore.getAllChangeHashes();
      const newChangeHashes = await remoteStore.findNewChanges(localHashes);
      
      expect(newChangeHashes.length).toBe(1);
      expect(newChangeHashes[0].changeHash).toBe("hash2");
    });
  });
});

// Helper functions

function arrayBufferToPEM(buffer: ArrayBuffer, type: string): string {
  const base64 = Buffer.from(buffer).toString("base64");
  const lines = base64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createMockChange(
  docId: string,
  changeHash: string,
  createdAt: number,
  deps: string[] = [],
  createdByPublicKey: string = "mock-public-key"
): MindooDocChange {
  return {
    type: "change",
    docId,
    changeHash,
    depsHashes: deps,
    createdAt,
    createdByPublicKey,
    decryptionKeyId: "default",
    signature: new Uint8Array([1, 2, 3, 4]),
    payload: new Uint8Array([10, 20, 30, 40]),
  };
}

/**
 * Mock MindooTenantDirectory for testing
 */
class MockTenantDirectory implements MindooTenantDirectory {
  private users: Map<string, { signingKey: string; encryptionKey: string; revoked: boolean }> = new Map();

  addUser(username: string, signingPublicKey: string, encryptionPublicKey: string): void {
    this.users.set(username, {
      signingKey: signingPublicKey,
      encryptionKey: encryptionPublicKey,
      revoked: false,
    });
  }

  // Test helper to revoke a user (not the interface method)
  revokeUserForTest(username: string): void {
    const user = this.users.get(username);
    if (user) {
      user.revoked = true;
    }
  }

  // Interface method - not used in tests
  async registerUser(
    _userId: PublicUserId,
    _administrationPrivateKey: EncryptedPrivateKey,
    _administrationPrivateKeyPassword: string
  ): Promise<void> {
    // Not needed for tests
  }

  // Interface method - not used in tests  
  async revokeUser(
    _username: string,
    _requestDataWipe: boolean,
    _administrationPrivateKey: EncryptedPrivateKey,
    _administrationPrivateKeyPassword: string
  ): Promise<void> {
    // Not needed for tests
  }

  async validatePublicSigningKey(publicKey: string): Promise<boolean> {
    for (const user of this.users.values()) {
      if (user.signingKey === publicKey && !user.revoked) {
        return true;
      }
    }
    return false;
  }

  async getUserPublicKeys(username: string): Promise<{ signingPublicKey: string; encryptionPublicKey: string } | null> {
    const user = this.users.get(username);
    if (!user || user.revoked) {
      return null;
    }
    return {
      signingPublicKey: user.signingKey,
      encryptionPublicKey: user.encryptionKey,
    };
  }

  async isUserRevoked(username: string): Promise<boolean> {
    const user = this.users.get(username);
    if (!user) {
      return true; // User doesn't exist = effectively revoked
    }
    return user.revoked;
  }
}
