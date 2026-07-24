/**
 * End-to-end tests for the convenience join flow:
 *   createTenant -> createJoinRequest -> approveJoinRequest -> joinTenant -> sync
 */

import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { encodeMindooURI, decodeMindooURI, isMindooURI } from "../core/uri/MindooURI";
import type {
  MindooTenant,
  JoinRequest,
  JoinResponse,
  CreateTenantResult,
} from "../core/types";
import {
  DEFAULT_TENANT_KEY_ID,
  PUBLIC_INFOS_KEY_ID,
} from "../core/types";
import type { PrivateUserId } from "../core/userid";

describe("Join Flow (convenience API)", () => {
  let factory: BaseMindooTenantFactory;
  let storeFactory: InMemoryContentAddressedStoreFactory;

  const tenantId = "acme";
  const adminName = "cn=admin/o=acme";
  const adminPassword = "admin-pass-123";
  const user1Name = "cn=alice/o=acme";
  const user1Password = "alice-pass-123";
  const user2Name = "cn=bob/o=acme";
  const user2Password = "bob-pass-456";
  const sharePassword = "shared-secret-789";

  function getDocKeyBundle(response: JoinResponse, keyId: string) {
    return response.encryptedDocKeys.find((entry) => entry.keyId === keyId);
  }

  beforeAll(() => {
    storeFactory = new InMemoryContentAddressedStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());
  });

  describe("createTenant", () => {
    let result: CreateTenantResult;

    it("should create a tenant with all required artifacts", async () => {
      result = await factory.createTenant({
        tenantId,
        adminName,
        adminPassword,
        userName: user1Name,
        userPassword: user1Password,
      });

      expect(result.tenant).toBeDefined();
      expect(result.adminUser).toBeDefined();
      expect(result.appUser).toBeDefined();
      expect(result.keyBag).toBeDefined();
      expect(result.tenant.getId()).toBe(tenantId);
      expect(result.adminUser.username).toBe(adminName);
      expect(result.appUser.username).toBe(user1Name);
    }, 60000);

    it("should have the admin registered in the directory (admin's public key is trusted)", async () => {
      // The app user should be registered
      const directory = await result.tenant.openDirectory();
      const keys = await directory.getUserPublicKeys(user1Name);
      expect(keys).not.toBeNull();
      expect(keys!.signingPublicKey).toBe(result.appUser.userSigningKeyPair.publicKey);
    }, 30000);

    it("should reject tenant ids that do not match server tenant id rules", async () => {
      await expect(
        factory.createTenant({
          tenantId: "Acme.Corp",
          adminName,
          adminPassword,
          userName: user1Name,
          userPassword: user1Password,
        }),
      ).rejects.toThrow(
        /tenantId must start with a letter or digit and contain only lowercase letters, digits, hyphens, and underscores/,
      );
    }, 30000);
  });

  describe("createJoinRequest", () => {
    let user2: PrivateUserId;

    beforeAll(async () => {
      user2 = await factory.createUserId(user2Name, user2Password);
    }, 30000);

    it("should create a JoinRequest object by default", () => {
      const request = factory.createJoinRequest(user2);
      expect(request.v).toBe(1);
      expect(request.username).toBe(user2Name);
      expect(request.signingPublicKey).toBe(user2.userSigningKeyPair.publicKey);
      expect(request.encryptionPublicKey).toBe(user2.userEncryptionKeyPair.publicKey);
    });

    it("should create a JoinRequest object with format='object'", () => {
      const request = factory.createJoinRequest(user2, { format: "object" });
      expect(request.v).toBe(1);
      expect(typeof request).toBe("object");
    });

    it("should create a mdb://join-request/... URI with format='uri'", () => {
      const uri = factory.createJoinRequest(user2, { format: "uri" });
      expect(typeof uri).toBe("string");
      expect(uri).toMatch(/^mdb:\/\/join-request\//);
      expect(isMindooURI(uri as string)).toBe(true);

      // Should round-trip
      const decoded = decodeMindooURI<JoinRequest>(uri as string);
      expect(decoded.type).toBe("join-request");
      expect(decoded.payload.username).toBe(user2Name);
    });
  });

  describe("full join flow (object format)", () => {
    let adminResult: CreateTenantResult;
    let user2: PrivateUserId;
    let joinRequest: JoinRequest;
    let joinResponse: JoinResponse;

    beforeAll(async () => {
      // Create a fresh storeFactory for this test suite to avoid conflicts
      const localStoreFactory = new InMemoryContentAddressedStoreFactory();
      const localFactory = new BaseMindooTenantFactory(localStoreFactory, new NodeCryptoAdapter());

      // Step 1: Admin creates tenant
      adminResult = await localFactory.createTenant({
        tenantId: "test-join-obj",
        adminName: "cn=admin/o=test-join-obj",
        adminPassword,
        userName: "cn=alice/o=test-join-obj",
        userPassword: user1Password,
      });

      // Step 2: User2 creates their identity and join request
      user2 = await localFactory.createUserId("cn=bob/o=test-join-obj", user2Password);
      joinRequest = localFactory.createJoinRequest(user2);

      // Step 3: Admin approves the join request
      joinResponse = await adminResult.tenant.approveJoinRequest(joinRequest, {
        adminSigningKey: adminResult.adminUser.userSigningKeyPair.privateKey,
        adminPassword,
        sharePassword,
      });

      // Step 4: User2 joins the tenant
      await localFactory.joinTenant(joinResponse, {
        user: user2,
        password: user2Password,
        sharePassword,
      });
    }, 120000);

    it("should produce a valid JoinResponse", () => {
      expect(joinResponse.v).toBe(2);
      expect(joinResponse.tenantId).toBe("test-join-obj");
      expect(joinResponse.adminSigningPublicKey).toBe(
        adminResult.adminUser.userSigningKeyPair.publicKey
      );
      expect(joinResponse.adminEncryptionPublicKey).toBe(
        adminResult.adminUser.userEncryptionKeyPair.publicKey
      );
      expect(getDocKeyBundle(joinResponse, DEFAULT_TENANT_KEY_ID)?.versions).toHaveLength(1);
      expect(getDocKeyBundle(joinResponse, PUBLIC_INFOS_KEY_ID)?.versions).toHaveLength(1);
    });

    it("should register user2 in the directory", async () => {
      const directory = await adminResult.tenant.openDirectory();
      const keys = await directory.getUserPublicKeys("cn=bob/o=test-join-obj");
      expect(keys).not.toBeNull();
      expect(keys!.signingPublicKey).toBe(user2.userSigningKeyPair.publicKey);
    });
  });

  describe("join response shared document keys", () => {
    it("should export all versions for selected key ids and omit unselected default", async () => {
      const localStoreFactory = new InMemoryContentAddressedStoreFactory();
      const localFactory = new BaseMindooTenantFactory(localStoreFactory, new NodeCryptoAdapter());
      const localTenantId = "test-join-selected-keys";
      const namedKeyId = "finance";
      const olderCreatedAt = 1000;
      const newerCreatedAt = 2000;

      const adminResult = await localFactory.createTenant({
        tenantId: localTenantId,
        adminName: `cn=admin/o=${localTenantId}`,
        adminPassword,
        userName: `cn=alice/o=${localTenantId}`,
        userPassword: user1Password,
      });
      await adminResult.keyBag.createDocKey(localTenantId, namedKeyId, olderCreatedAt);
      await adminResult.keyBag.createDocKey(localTenantId, namedKeyId, newerCreatedAt);

      const user2 = await localFactory.createUserId(`cn=bob/o=${localTenantId}`, user2Password);
      const joinRequest = localFactory.createJoinRequest(user2);
      const joinResponse = await adminResult.tenant.approveJoinRequest(joinRequest, {
        adminSigningKey: adminResult.adminUser.userSigningKeyPair.privateKey,
        adminPassword,
        sharePassword,
        sharedDocKeyIds: [namedKeyId],
      });

      expect(getDocKeyBundle(joinResponse, PUBLIC_INFOS_KEY_ID)?.versions).toHaveLength(1);
      expect(getDocKeyBundle(joinResponse, DEFAULT_TENANT_KEY_ID)).toBeUndefined();
      expect(getDocKeyBundle(joinResponse, namedKeyId)?.versions.map((version) => version.createdAt)).toEqual([
        newerCreatedAt,
        olderCreatedAt,
      ]);

      const joinResult = await localFactory.joinTenant(joinResponse, {
        user: user2,
        password: user2Password,
        sharePassword,
      });
      const importedDetails = await joinResult.keyBag.listKeyDetails();
      const importedNamedVersions = importedDetails
        .filter((detail) => detail.scopedKeyId === `doc:${localTenantId}:${namedKeyId}`)
        .map((detail) => detail.createdAt);

      expect(importedDetails.some((detail) => detail.scopedKeyId === `doc:${localTenantId}:${PUBLIC_INFOS_KEY_ID}`)).toBe(true);
      expect(importedDetails.some((detail) => detail.scopedKeyId === `doc:${localTenantId}:${DEFAULT_TENANT_KEY_ID}`)).toBe(false);
      expect(importedNamedVersions).toEqual([newerCreatedAt, olderCreatedAt]);
    }, 120000);
  });

  describe("full join flow (URI format)", () => {
    let adminResult: CreateTenantResult;
    let user2: PrivateUserId;

    beforeAll(async () => {
      const localStoreFactory = new InMemoryContentAddressedStoreFactory();
      const localFactory = new BaseMindooTenantFactory(localStoreFactory, new NodeCryptoAdapter());

      // Step 1: Admin creates tenant
      adminResult = await localFactory.createTenant({
        tenantId: "test-join-uri",
        adminName: "cn=admin/o=test-join-uri",
        adminPassword,
        userName: "cn=alice/o=test-join-uri",
        userPassword: user1Password,
      });

      // Step 2: User2 creates identity + join request URI
      user2 = await localFactory.createUserId("cn=bob/o=test-join-uri", user2Password);
      const joinRequestURI = localFactory.createJoinRequest(user2, { format: "uri" });

      // Step 3: Admin approves using the URI string directly, outputs as URI
      const joinResponseURI = await adminResult.tenant.approveJoinRequest(joinRequestURI, {
        adminSigningKey: adminResult.adminUser.userSigningKeyPair.privateKey,
        adminPassword,
        sharePassword,
        format: "uri",
      });

      expect(typeof joinResponseURI).toBe("string");
      expect(joinResponseURI).toMatch(/^mdb:\/\/join-response\//);

      // Step 4: User2 joins using the URI string directly
      const joinResult = await localFactory.joinTenant(joinResponseURI, {
        user: user2,
        password: user2Password,
        sharePassword,
      });

      expect(joinResult.tenant).toBeDefined();
      expect(joinResult.tenant.getId()).toBe("test-join-uri");
      expect(joinResult.keyBag).toBeDefined();
    }, 120000);

    it("should register user2 in the directory", async () => {
      const directory = await adminResult.tenant.openDirectory();
      const keys = await directory.getUserPublicKeys("cn=bob/o=test-join-uri");
      expect(keys).not.toBeNull();
      expect(keys!.signingPublicKey).toBe(user2.userSigningKeyPair.publicKey);
    });
  });

  describe("full join flow with document sync", () => {
    it("should allow both users to create, modify, and sync documents through a shared store", async () => {
      const localStoreFactory = new InMemoryContentAddressedStoreFactory();
      const localFactory = new BaseMindooTenantFactory(localStoreFactory, new NodeCryptoAdapter());

      // Admin creates tenant
      const adminResult = await localFactory.createTenant({
        tenantId: "test-join-sync",
        adminName: "cn=admin/o=test-join-sync",
        adminPassword,
        userName: "cn=alice/o=test-join-sync",
        userPassword: user1Password,
      });

      // User2 creates identity + join request
      const user2 = await localFactory.createUserId("cn=bob/o=test-join-sync", user2Password);
      const joinRequest = localFactory.createJoinRequest(user2);

      // Admin approves
      const joinResponse = await adminResult.tenant.approveJoinRequest(joinRequest, {
        adminSigningKey: adminResult.adminUser.userSigningKeyPair.privateKey,
        adminPassword,
        sharePassword,
      });

      // User2 joins
      const user2Result = await localFactory.joinTenant(joinResponse, {
        user: user2,
        password: user2Password,
        sharePassword,
      });

      // User1 creates a todo document
      const user1DB = await adminResult.tenant.openDB("todos");
      const todoDoc = await user1DB.createDocument();
      await user1DB.changeDoc(todoDoc, (doc) => {
        const data = doc.getData();
        data.title = "Buy groceries";
        data.done = false;
      });

      // Sync directory first so user2 knows all trusted public keys (alice, bob)
      const user1DirDB = await adminResult.tenant.openDB("directory");
      const user2DirDB = await user2Result.tenant.openDB("directory");
      await user2DirDB.pullChangesFrom(user1DirDB.getStore());
      await user2DirDB.syncStoreChanges();

      // User2 pulls todo changes via shared in-memory store
      const user2DB = await user2Result.tenant.openDB("todos");
      await user2DB.pullChangesFrom(user1DB.getStore());
      await user2DB.syncStoreChanges();

      // User2 should see the todo
      const user2Todo = await user2DB.getDocument(todoDoc.getId());
      expect(user2Todo.getData().title).toBe("Buy groceries");
      expect(user2Todo.getData().done).toBe(false);

      // User2 marks it done
      await user2DB.changeDoc(user2Todo, (doc) => {
        doc.getData().done = true;
      });

      // Sync directory back to user1 so user1 knows bob's signing key is trusted
      await user1DirDB.pullChangesFrom(user2DirDB.getStore());
      await user1DirDB.syncStoreChanges();

      // Push back to user1's store
      await user2DB.pushChangesTo(user1DB.getStore());
      await user1DB.syncStoreChanges();

      // User1 should see the change
      const user1TodoUpdated = await user1DB.getDocument(todoDoc.getId());
      expect(user1TodoUpdated.getData().done).toBe(true);
    }, 120000);
  });

  describe("error handling", () => {
    it("should reject joinTenant with wrong URI type", async () => {
      const user = await factory.createUserId("cn=test/o=acme", "test-pass");
      const requestURI = factory.createJoinRequest(user, { format: "uri" });

      await expect(
        factory.joinTenant(requestURI as string, {
          user,
          password: "test-pass",
          sharePassword: "wrong",
        })
      ).rejects.toThrow(/expected "join-response"/);
    }, 30000);

    it("should reject joinTenant with invalid URI", async () => {
      const user = await factory.createUserId("cn=test2/o=acme", "test-pass");

      await expect(
        factory.joinTenant("not-a-valid-uri", {
          user,
          password: "test-pass",
          sharePassword: "wrong",
        })
      ).rejects.toThrow(/expected a JoinResponse/);
    }, 30000);
  });

  describe("adminUsername in join response", () => {
    it("should include adminUsername when provided", async () => {
      const localStoreFactory = new InMemoryContentAddressedStoreFactory();
      const localFactory = new BaseMindooTenantFactory(localStoreFactory, new NodeCryptoAdapter());

      const result = await localFactory.createTenant({
        tenantId: "test-admin-username",
        adminName: "cn=admin/o=test",
        adminPassword,
        userName: "cn=alice/o=test",
        userPassword: user1Password,
      });

      const user = await localFactory.createUserId("cn=bob/o=test", user2Password);
      const joinRequest = localFactory.createJoinRequest(user);

      const response = await result.tenant.approveJoinRequest(joinRequest, {
        adminSigningKey: result.adminUser.userSigningKeyPair.privateKey,
        adminPassword,
        sharePassword,
        adminUsername: "cn=admin/o=test",
      });

      expect(response.adminUsername).toBe("cn=admin/o=test");
    }, 30000);

    it("should omit adminUsername when not provided", async () => {
      const localStoreFactory = new InMemoryContentAddressedStoreFactory();
      const localFactory = new BaseMindooTenantFactory(localStoreFactory, new NodeCryptoAdapter());

      const result = await localFactory.createTenant({
        tenantId: "test-no-admin-username",
        adminName: "cn=admin/o=test",
        adminPassword,
        userName: "cn=alice/o=test",
        userPassword: user1Password,
      });

      const user = await localFactory.createUserId("cn=bob/o=test", user2Password);
      const joinRequest = localFactory.createJoinRequest(user);

      const response = await result.tenant.approveJoinRequest(joinRequest, {
        adminSigningKey: result.adminUser.userSigningKeyPair.privateKey,
        adminPassword,
        sharePassword,
      });

      expect(response.adminUsername).toBeUndefined();
    }, 30000);

    it("should round-trip adminUsername through URI encoding", async () => {
      const localStoreFactory = new InMemoryContentAddressedStoreFactory();
      const localFactory = new BaseMindooTenantFactory(localStoreFactory, new NodeCryptoAdapter());

      const result = await localFactory.createTenant({
        tenantId: "test-admin-uri-rt",
        adminName: "cn=admin/o=test",
        adminPassword,
        userName: "cn=alice/o=test",
        userPassword: user1Password,
      });

      const user = await localFactory.createUserId("cn=bob/o=test", user2Password);
      const joinRequestURI = localFactory.createJoinRequest(user, { format: "uri" });

      const joinResponseURI = await result.tenant.approveJoinRequest(joinRequestURI, {
        adminSigningKey: result.adminUser.userSigningKeyPair.privateKey,
        adminPassword,
        sharePassword,
        adminUsername: "cn=admin/o=test",
        format: "uri",
      });

      expect(typeof joinResponseURI).toBe("string");
      expect(joinResponseURI).toMatch(/^mdb:\/\/join-response\//);

      const decoded = decodeMindooURI<JoinResponse>(joinResponseURI);
      expect(decoded.payload.adminUsername).toBe("cn=admin/o=test");
    }, 30000);
  });

  describe("second device for existing username", () => {
    it("should append a new device key pair when approving a join request for an already-registered username", async () => {
      const localStoreFactory = new InMemoryContentAddressedStoreFactory();
      const localFactory = new BaseMindooTenantFactory(localStoreFactory, new NodeCryptoAdapter());

      const result = await localFactory.createTenant({
        tenantId: "test-second-device",
        adminName: "cn=admin/o=test-second-device",
        adminPassword,
        userName: "cn=alice/o=test-second-device",
        userPassword: user1Password,
      });

      // First device joins as bob
      const device1 = await localFactory.createUserId("cn=bob/o=test-second-device", user2Password);
      const joinRequest1 = localFactory.createJoinRequest(device1, { label: "desktop" });
      const joinResponse1 = await result.tenant.approveJoinRequest(joinRequest1, {
        adminSigningKey: result.adminUser.userSigningKeyPair.privateKey,
        adminPassword,
        sharePassword,
      });
      await localFactory.joinTenant(joinResponse1, {
        user: device1,
        password: user2Password,
        sharePassword,
      });

      // Second device with the same username, different keys
      const device2 = await localFactory.createUserId("cn=bob/o=test-second-device", "device2-pass");
      const joinRequest2 = localFactory.createJoinRequest(device2, { label: "ipad" });
      const joinResponse2 = await result.tenant.approveJoinRequest(joinRequest2, {
        adminSigningKey: result.adminUser.userSigningKeyPair.privateKey,
        adminPassword,
        sharePassword,
      });
      const { tenant: device2Tenant } = await localFactory.joinTenant(joinResponse2, {
        user: device2,
        password: "device2-pass",
        sharePassword,
      });

      const directory = await result.tenant.openDirectory();
      const keyPairs = await directory.getUserKeyPairs!("cn=bob/o=test-second-device");
      expect(keyPairs).toHaveLength(2);
      const signingKeys = keyPairs.map((p) => p.signingPublicKey).sort();
      expect(signingKeys).toEqual(
        [device1.userSigningKeyPair.publicKey, device2.userSigningKeyPair.publicKey].sort(),
      );
      expect(keyPairs.map((p) => p.label).sort()).toEqual(["desktop", "ipad"]);

      // Pull directory onto device2 (join alone does not copy grant docs).
      const adminDirDB = await result.tenant.openDB("directory");
      const device2DirDB = await device2Tenant.openDB("directory");
      await device2DirDB.pullChangesFrom(adminDirDB.getStore());
      await device2DirDB.syncStoreChanges();

      // Second device must be able to open a non-directory DB (not only keys[0]).
      await expect(device2Tenant.openDB("shared-db")).resolves.toBeDefined();
    }, 120000);
  });
});
