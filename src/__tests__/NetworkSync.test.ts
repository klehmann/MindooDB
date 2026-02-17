import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { RSAEncryption } from "../core/crypto/RSAEncryption";
import { AuthenticationService } from "../core/appendonlystores/network/AuthenticationService";
import { ClientNetworkContentAddressedStore } from "../appendonlystores/network/ClientNetworkContentAddressedStore";
import { ServerNetworkContentAddressedStore } from "../appendonlystores/network/ServerNetworkContentAddressedStore";
import type { NetworkTransport } from "../core/appendonlystores/network/NetworkTransport";
import type { NetworkEncryptedEntry, AuthResult, NetworkSyncCapabilities } from "../core/appendonlystores/network/types";
import type {
  StoreEntry,
  StoreEntryMetadata,
  MindooTenantDirectory,
  EncryptedPrivateKey,
  MindooDoc,
  StoreEntryType,
  StoreScanCursor,
  StoreScanFilters,
  StoreScanResult,
  StoreIdBloomSummary,
  StoreCompactionStatus,
} from "../core/types";
import { bloomMightContainId } from "../core/appendonlystores/bloom";
import type { PublicUserId } from "../core/userid";
import type { ContentAddressedStore } from "../core/appendonlystores/types";

/**
 * Mock NetworkTransport that connects directly to a ServerNetworkContentAddressedStore
 * without actual network calls. Used for testing the client-server interaction.
 */
class MockNetworkTransport implements NetworkTransport {
  private server: ServerNetworkContentAddressedStore;

  constructor(server: ServerNetworkContentAddressedStore) {
    this.server = server;
  }

  async requestChallenge(username: string): Promise<string> {
    return this.server.handleChallengeRequest(username);
  }

  async authenticate(challenge: string, signature: Uint8Array): Promise<AuthResult> {
    return this.server.handleAuthenticate(challenge, signature);
  }

  async findNewEntries(token: string, haveIds: string[]): Promise<StoreEntryMetadata[]> {
    return this.server.handleFindNewEntries(token, haveIds);
  }

  async findNewEntriesForDoc(token: string, haveIds: string[], docId: string): Promise<StoreEntryMetadata[]> {
    return this.server.handleFindNewEntriesForDoc(token, haveIds, docId);
  }

  async findEntries(
    token: string,
    type: StoreEntryType,
    creationDateFrom: number | null,
    creationDateUntil: number | null
  ): Promise<StoreEntryMetadata[]> {
    return this.server.handleFindEntries(token, type, creationDateFrom, creationDateUntil);
  }

  async getEntries(token: string, ids: string[]): Promise<NetworkEncryptedEntry[]> {
    return this.server.handleGetEntries(token, ids);
  }

  async putEntries(token: string, entries: StoreEntry[]): Promise<void> {
    return this.server.handlePutEntries(token, entries);
  }

  async hasEntries(token: string, ids: string[]): Promise<string[]> {
    return this.server.handleHasEntries(token, ids);
  }

  async getAllIds(token: string): Promise<string[]> {
    return this.server.handleGetAllIds(token);
  }

  async resolveDependencies(token: string, startId: string, options?: Record<string, unknown>): Promise<string[]> {
    return this.server.handleResolveDependencies(token, startId, options);
  }

  async scanEntriesSince(
    token: string,
    cursor: StoreScanCursor | null,
    limit?: number,
    filters?: StoreScanFilters
  ): Promise<StoreScanResult> {
    return this.server.handleScanEntriesSince(token, cursor, limit, filters);
  }

  async getIdBloomSummary(token: string): Promise<StoreIdBloomSummary> {
    return this.server.handleGetIdBloomSummary(token);
  }

  async getCapabilities(token: string): Promise<NetworkSyncCapabilities> {
    return this.server.handleGetCapabilities(token);
  }

  async getCompactionStatus(token: string): Promise<StoreCompactionStatus> {
    return this.server.handleGetCompactionStatus(token);
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

  describe("ClientNetworkContentAddressedStore as Pure Remote Proxy", () => {
    let serverStore: ContentAddressedStore;
    let serverHandler: ServerNetworkContentAddressedStore;
    let clientStore: ClientNetworkContentAddressedStore;
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
      const storeFactory = new InMemoryContentAddressedStoreFactory();
      const { docStore } = storeFactory.createStore("test-db");
      serverStore = docStore;
      
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
      serverHandler = new ServerNetworkContentAddressedStore(
        serverStore,
        mockDirectory,
        authService,
        cryptoAdapter
      );
      
      // Create mock transport
      const mockTransport = new MockNetworkTransport(serverHandler);
      
      // Create client store (no local store - pure remote proxy)
      clientStore = new ClientNetworkContentAddressedStore(
        "test-db",
        mockTransport,
        cryptoAdapter,
        "testuser",
        userSigningKeyPair.privateKey,
        userEncryptionPrivateKeyPem
      );
    });

    test("should find new entries from remote", async () => {
      // Add entries to server store
      const entry1 = createMockEntry("doc1", "hash1", 1000);
      const entry2 = createMockEntry("doc1", "hash2", 2000, ["hash1"]);
      await serverStore.putEntries([entry1]);
      await serverStore.putEntries([entry2]);
      
      // Query via client store
      const newEntries = await clientStore.findNewEntries([]);
      
      expect(newEntries.length).toBe(2);
      expect(newEntries.map((e: StoreEntryMetadata) => e.id)).toContain("hash1");
      expect(newEntries.map((e: StoreEntryMetadata) => e.id)).toContain("hash2");
    });

    test("should find new entries excluding already known hashes", async () => {
      // Add entries to server store
      const entry1 = createMockEntry("doc1", "hash1", 1000);
      const entry2 = createMockEntry("doc1", "hash2", 2000, ["hash1"]);
      await serverStore.putEntries([entry1]);
      await serverStore.putEntries([entry2]);
      
      // Query with hash1 already known
      const newEntries = await clientStore.findNewEntries(["hash1"]);
      
      expect(newEntries.length).toBe(1);
      expect(newEntries[0].id).toBe("hash2");
    });

    test("should get entries and decrypt them", async () => {
      // Add entry to server store
      const entry = createMockEntry("doc1", "hash1", 1000);
      await serverStore.putEntries([entry]);
      
      // Find and get entries
      const newEntries = await clientStore.findNewEntries([]);
      const retrievedEntries = await clientStore.getEntries(newEntries.map((e: StoreEntryMetadata) => e.id));
      
      expect(retrievedEntries.length).toBe(1);
      expect(retrievedEntries[0].id).toBe("hash1");
      expect(retrievedEntries[0].docId).toBe("doc1");
      // Payload should be decrypted
      expect(retrievedEntries[0].encryptedData).toEqual(entry.encryptedData);
    });

    test("should push entries to remote", async () => {
      // Server should be empty initially
      const initialHashes = await serverStore.getAllIds();
      expect(initialHashes.length).toBe(0);
      
      // Push an entry via client store (must use trusted user's public key)
      const entry = createMockEntry("doc1", "hash1", 1000, [], userSigningPublicKeyPem);
      await clientStore.putEntries([entry]);
      
      // Server should now have the entry
      const finalHashes = await serverStore.getAllIds();
      expect(finalHashes.length).toBe(1);
      expect(finalHashes).toContain("hash1");
    });

    test("should get all entry hashes from remote", async () => {
      // Add entries to server store
      await serverStore.putEntries([createMockEntry("doc1", "hash1", 1000)]);
      await serverStore.putEntries([createMockEntry("doc1", "hash2", 2000)]);
      await serverStore.putEntries([createMockEntry("doc2", "hash3", 3000)]);
      
      // Query via client store
      const allHashes = await clientStore.getAllIds();
      
      expect(allHashes.length).toBe(3);
      expect(allHashes).toContain("hash1");
      expect(allHashes).toContain("hash2");
      expect(allHashes).toContain("hash3");
    });

    test("should scan entries via cursor from remote", async () => {
      await serverStore.putEntries([createMockEntry("doc1", "hash1", 1000)]);
      await serverStore.putEntries([createMockEntry("doc1", "hash2", 2000)]);
      await serverStore.putEntries([createMockEntry("doc2", "hash3", 3000)]);

      const page1 = await clientStore.scanEntriesSince!(null, 2);
      expect(page1.entries.length).toBe(2);
      expect(page1.hasMore).toBe(true);

      const page2 = await clientStore.scanEntriesSince!(page1.nextCursor, 2);
      expect(page2.entries.length).toBe(1);
      expect(page2.hasMore).toBe(false);
    });

    test("should get bloom summary from remote", async () => {
      await serverStore.putEntries([createMockEntry("doc1", "hash1", 1000)]);
      await serverStore.putEntries([createMockEntry("doc1", "hash2", 2000)]);

      const summary = await clientStore.getIdBloomSummary!();
      expect(summary.version).toBe("bloom-v1");
      expect(summary.totalIds).toBe(2);
      expect(bloomMightContainId(summary, "hash1")).toBe(true);
      expect(bloomMightContainId(summary, "hash2")).toBe(true);
    });

    test("should negotiate capabilities from remote", async () => {
      const caps = await clientStore.getCapabilities();
      expect(caps.protocolVersion).toBe("sync-v2");
      expect(caps.supportsCursorScan).toBe(true);
      expect(caps.supportsIdBloomSummary).toBe(true);
      expect(caps.supportsCompactionStatus).toBe(false);
    });

    test("should return fallback compaction status when remote does not expose it", async () => {
      const status = await clientStore.getCompactionStatus!();
      expect(status.enabled).toBe(false);
      expect(status.totalCompactions).toBe(0);
      expect(status.lastCompactionAt).toBeNull();
    });

    test("should fetch compaction status from remote when supported", async () => {
      const expected: StoreCompactionStatus = {
        enabled: true,
        compactionMinFiles: 32,
        compactionMaxBytes: 2048,
        totalCompactions: 3,
        totalCompactedFiles: 77,
        totalCompactedBytes: 100_000,
        totalCompactionDurationMs: 55,
        lastCompactionAt: Date.now(),
        lastCompactedFiles: 10,
        lastCompactedBytes: 12_000,
        lastCompactionDurationMs: 8,
      };
      (serverStore as ContentAddressedStore).getCompactionStatus = async () => expected;
      clientStore.clearAuthCache();

      const caps = await clientStore.getCapabilities();
      expect(caps.supportsCompactionStatus).toBe(true);
      const status = await clientStore.getCompactionStatus!();
      expect(status).toEqual(expected);
    });

    test("should find new entries for specific document", async () => {
      // Add entries for multiple documents
      await serverStore.putEntries([createMockEntry("doc1", "hash1", 1000)]);
      await serverStore.putEntries([createMockEntry("doc2", "hash2", 2000)]);
      await serverStore.putEntries([createMockEntry("doc1", "hash3", 3000)]);
      
      // Query for doc1 only
      const doc1Entries = await clientStore.findNewEntriesForDoc([], "doc1");
      
      expect(doc1Entries.length).toBe(2);
      expect(doc1Entries.map((e: StoreEntryMetadata) => e.id)).toContain("hash1");
      expect(doc1Entries.map((e: StoreEntryMetadata) => e.id)).toContain("hash3");
    });

    test("should cache authentication token", async () => {
      // Add an entry to server
      await serverStore.putEntries([createMockEntry("doc1", "hash1", 1000)]);
      
      // Multiple calls should reuse token
      await clientStore.findNewEntries([]);
      await clientStore.getAllIds();
      await clientStore.findNewEntries([]);
      
      // If token caching works, we shouldn't get authentication errors
    });

    test("should re-authenticate after token clear", async () => {
      // Add entries
      await serverStore.putEntries([createMockEntry("doc1", "hash1", 1000)]);
      
      // Query first time
      await clientStore.findNewEntries([]);
      
      // Clear auth cache
      clientStore.clearAuthCache();
      
      // Add more entries
      await serverStore.putEntries([createMockEntry("doc1", "hash2", 2000, ["hash1"])]);
      
      // Query again - should re-authenticate
      const entries = await clientStore.findNewEntries(["hash1"]);
      expect(entries.length).toBe(1);
    });
  });

  describe("Sync-Based Usage (Local + Remote Stores)", () => {
    let serverStore: ContentAddressedStore;
    let localStore: ContentAddressedStore;
    let serverHandler: ServerNetworkContentAddressedStore;
    let remoteStore: ClientNetworkContentAddressedStore;
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
      const storeFactory = new InMemoryContentAddressedStoreFactory();
      const serverStoreResult = storeFactory.createStore("test-db");
      const localStoreResult = storeFactory.createStore("test-db");
      serverStore = serverStoreResult.docStore;
      localStore = localStoreResult.docStore;
      
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
      serverHandler = new ServerNetworkContentAddressedStore(
        serverStore,
        mockDirectory,
        authService,
        cryptoAdapter
      );
      
      // Create mock transport
      const mockTransport = new MockNetworkTransport(serverHandler);
      
      // Create remote store (ClientNetworkContentAddressedStore as pure remote proxy)
      remoteStore = new ClientNetworkContentAddressedStore(
        "test-db",
        mockTransport,
        cryptoAdapter,
        "testuser",
        userSigningKeyPair.privateKey,
        userEncryptionPrivateKeyPem
      );
    });

    test("should pull entries from remote to local (simulates MindooDB.pullChangesFrom)", async () => {
      // Add entries to server
      await serverStore.putEntries([createMockEntry("doc1", "hash1", 1000)]);
      await serverStore.putEntries([createMockEntry("doc1", "hash2", 2000, ["hash1"])]);
      await serverStore.putEntries([createMockEntry("doc2", "hash3", 3000)]);
      
      // Local should be empty
      expect((await localStore.getAllIds()).length).toBe(0);
      
      // Simulate MindooDB.pullChangesFrom logic:
      // 1. Get local hashes
      const localHashes = await localStore.getAllIds();
      
      // 2. Find new entries from remote
      const newEntryMetadata = await remoteStore.findNewEntries(localHashes);
      
      // 3. Get the entries from remote
      const newEntries = await remoteStore.getEntries(newEntryMetadata.map((em: StoreEntryMetadata) => em.id));
      
      // 4. Put to local
      await localStore.putEntries(newEntries);
      
      // Local should now have all entries
      const finalLocalHashes = await localStore.getAllIds();
      expect(finalLocalHashes.length).toBe(3);
      expect(finalLocalHashes).toContain("hash1");
      expect(finalLocalHashes).toContain("hash2");
      expect(finalLocalHashes).toContain("hash3");
    });

    test("should push entries from local to remote (simulates MindooDB.pushChangesTo)", async () => {
      // Add entries to local (must use trusted user's public key)
      await localStore.putEntries([createMockEntry("doc1", "hash1", 1000, [], userSigningPublicKeyPem)]);
      await localStore.putEntries([createMockEntry("doc1", "hash2", 2000, ["hash1"], userSigningPublicKeyPem)]);
      
      // Server should be empty
      expect((await serverStore.getAllIds()).length).toBe(0);
      
      // Simulate MindooDB.pushChangesTo logic:
      // 1. Get remote hashes
      const remoteHashes = await remoteStore.getAllIds();
      
      // 2. Find new entries in local that remote doesn't have
      const newEntryMetadata = await localStore.findNewEntries(remoteHashes);
      
      // 3. Get the entries from local
      const newEntries = await localStore.getEntries(newEntryMetadata.map(em => em.id));
      
      // 4. Push to remote
      await remoteStore.putEntries(newEntries);
      
      // Server should now have all entries
      const finalServerHashes = await serverStore.getAllIds();
      expect(finalServerHashes.length).toBe(2);
      expect(finalServerHashes).toContain("hash1");
      expect(finalServerHashes).toContain("hash2");
    });

    test("should handle bidirectional sync", async () => {
      // Add some entries to server (must use trusted user's public key)
      await serverStore.putEntries([createMockEntry("doc1", "server-hash1", 1000, [], userSigningPublicKeyPem)]);
      
      // Add some entries to local (must use trusted user's public key)
      await localStore.putEntries([createMockEntry("doc2", "local-hash1", 2000, [], userSigningPublicKeyPem)]);
      
      // Pull from server to local
      const localHashes = await localStore.getAllIds();
      const serverNewMeta = await remoteStore.findNewEntries(localHashes);
      const serverNewEntries = await remoteStore.getEntries(serverNewMeta.map((em: StoreEntryMetadata) => em.id));
      await localStore.putEntries(serverNewEntries);
      
      // Push from local to server
      const remoteHashes = await remoteStore.getAllIds();
      const localNewMeta = await localStore.findNewEntries(remoteHashes);
      const localNewEntries = await localStore.getEntries(localNewMeta.map(em => em.id));
      await remoteStore.putEntries(localNewEntries);
      
      // Both should now have both entries
      const finalLocalHashes = await localStore.getAllIds();
      const finalServerHashes = await serverStore.getAllIds();
      
      expect(finalLocalHashes.length).toBe(2);
      expect(finalServerHashes.length).toBe(2);
      
      expect(finalLocalHashes).toContain("server-hash1");
      expect(finalLocalHashes).toContain("local-hash1");
      expect(finalServerHashes).toContain("server-hash1");
      expect(finalServerHashes).toContain("local-hash1");
    });

    test("should only sync new entries (incremental sync)", async () => {
      // Initial sync: add entry to both
      const entry1 = createMockEntry("doc1", "hash1", 1000);
      await serverStore.putEntries([entry1]);
      await localStore.putEntries([entry1]);
      
      // Add new entry to server only
      const entry2 = createMockEntry("doc1", "hash2", 2000, ["hash1"]);
      await serverStore.putEntries([entry2]);
      
      // Pull should only get the new entry
      const localHashes = await localStore.getAllIds();
      const newEntryMeta = await remoteStore.findNewEntries(localHashes);
      
      expect(newEntryMeta.length).toBe(1);
      expect(newEntryMeta[0].id).toBe("hash2");
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

function createMockEntry(
  docId: string,
  id: string,
  createdAt: number,
  deps: string[] = [],
  createdByPublicKey: string = "mock-public-key"
): StoreEntry {
  const encryptedData = new Uint8Array([10, 20, 30, 40]);
  // Simple mock content hash for testing
  const contentHash = `contenthash-${id}`;
  return {
    entryType: "doc_change",
    id,
    contentHash,
    docId,
    dependencyIds: deps,
    createdAt,
    createdByPublicKey,
    decryptionKeyId: "default",
    signature: new Uint8Array([1, 2, 3, 4]),
    originalSize: 3, // Simulated original size
    encryptedSize: encryptedData.length,
    encryptedData,
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

  // GDPR methods - not used in tests
  async requestDocHistoryPurge(
    _dbId: string,
    _docId: string,
    _reason: string | undefined,
    _administrationPrivateKey: EncryptedPrivateKey,
    _administrationPrivateKeyPassword: string
  ): Promise<void> {
    // Not needed for tests
  }

  async getRequestedDocHistoryPurges(): Promise<Array<{
    dbId: string;
    docId: string;
    reason?: string;
    requestedAt: number;
    purgeRequestDocId: string;
  }>> {
    return [];
  }

  // Tenant and DB settings methods - not used in tests
  async getTenantSettings(): Promise<MindooDoc | null> {
    return null;
  }

  async changeTenantSettings(
    _changeFunc: (doc: MindooDoc) => void | Promise<void>,
    _administrationPrivateKey: EncryptedPrivateKey,
    _administrationPrivateKeyPassword: string
  ): Promise<void> {
    // Not needed for tests
  }

  async getDBSettings(_dbId: string): Promise<MindooDoc | null> {
    return null;
  }

  async changeDBSettings(
    _dbId: string,
    _changeFunc: (doc: MindooDoc) => void | Promise<void>,
    _administrationPrivateKey: EncryptedPrivateKey,
    _administrationPrivateKeyPassword: string
  ): Promise<void> {
    // Not needed for tests
  }

  // Group management methods - not used in tests
  async getGroups(): Promise<string[]> {
    return [];
  }

  async getGroupMembers(_groupName: string): Promise<string[]> {
    return [];
  }

  async deleteGroup(
    _groupName: string,
    _administrationPrivateKey: EncryptedPrivateKey,
    _administrationPrivateKeyPassword: string
  ): Promise<void> {
    // Not needed for tests
  }

  async getUserNamesList(_username: string): Promise<string[]> {
    return [];
  }

  async addUsersToGroup(
    _groupName: string,
    _username: string[],
    _administrationPrivateKey: EncryptedPrivateKey,
    _administrationPrivateKeyPassword: string
  ): Promise<void> {
    // Not needed for tests
  }

  async removeUsersFromGroup(
    _groupName: string,
    _username: string[],
    _administrationPrivateKey: EncryptedPrivateKey,
    _administrationPrivateKeyPassword: string
  ): Promise<void> {
    // Not needed for tests
  }
}
