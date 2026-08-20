import {
  addDevice,
  addPerson,
  makeTenant,
  syncAll,
  type DeviceHandle,
  type MultiDeviceFixture,
} from "./_helpers/multiDevice";
import {
  USER_DIRECTORY_DB_ID,
  isPendingUserKeyDocument,
  asUserKeyPayload,
  userKeyDocumentId,
} from "../core";
import { validateUserKeyDocument } from "../core/userkeys/validateUserKeyDocument";
import { createHash } from "crypto";

describe("userkey document lifecycle", () => {
  jest.setTimeout(180000);

  let fixture: MultiDeviceFixture;
  let alice1: DeviceHandle;

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-userkey-life" });
    alice1 = await addPerson(fixture, "alice", "laptop");
    await fixture.host.factory.ensureUserKeyPair!(alice1.user, alice1.password);
    await alice1.factory.ensureUserKeyPair!(alice1.user, alice1.password);
    await syncAll(fixture, "directory");
  });

  it("admin creates a pending document from the join public key; first wrap ends pending", async () => {
    const manager = fixture.host.tenant.getUserKeyManager();
    const doc = await manager.createPendingFromJoin({
      username: alice1.username,
      userPublicKey: alice1.user.userKeyPair!.publicKey,
      signingKeyPair: {
        publicKey: fixture.adminUser.userSigningKeyPair.publicKey,
        privateKey: fixture.adminUser.userSigningKeyPair.privateKey,
      },
      signingKeyPassword: fixture.adminPassword,
    });
    const payload = asUserKeyPayload(doc.getData())!;
    expect(payload.userKeys["1"].deviceWraps).toEqual({});
    expect(isPendingUserKeyDocument(payload)).toBe(true);

    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    alice1.tenant.noteUserDirectoryFetched!();
    const status = await alice1.tenant.reconcileUserKeys!({ allowSelfCreate: false });
    expect(status.pending).toBe(false);
    expect(status.state).toBe("approved");

    const after = await alice1.tenant.getUserKeyManager().resolveOwnUserKeyDocument();
    expect(isPendingUserKeyDocument(after!.payload)).toBe(false);
    expect(Object.keys(after!.payload.userKeys["1"].deviceWraps).length).toBe(1);
  });

  it("seals an already-stored wrap-less document whose public key matches this device", async () => {
    const dana = await addPerson(fixture, "dana", "desk");
    await dana.factory.ensureUserKeyPair!(dana.user, dana.password);
    await syncAll(fixture, "directory");
    const manager = fixture.host.tenant.getUserKeyManager();
    await manager.createPendingFromJoin({
      username: dana.username,
      userPublicKey: dana.user.userKeyPair!.publicKey,
      signingKeyPair: {
        publicKey: fixture.adminUser.userSigningKeyPair.publicKey,
        privateKey: fixture.adminUser.userSigningKeyPair.privateKey,
      },
      signingKeyPassword: fixture.adminPassword,
    });
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    dana.tenant.noteUserDirectoryFetched!();
    const status = await dana.tenant.reconcileUserKeys!({ allowSelfCreate: false });
    expect(status.state).toBe("approved");
    const after = await dana.tenant.getUserKeyManager().resolveOwnUserKeyDocument();
    expect(isPendingUserKeyDocument(after!.payload)).toBe(false);
    expect(Object.keys(after!.payload.userKeys["1"].deviceWraps).length).toBeGreaterThan(0);
  });

  it("adopts a wrap-less pending document onto this device's local pair", async () => {
    const bob = await addPerson(fixture, "bob", "phone");
    await bob.factory.ensureUserKeyPair!(bob.user, bob.password);
    await syncAll(fixture, "directory");
    const manager = fixture.host.tenant.getUserKeyManager();
    await manager.createPendingFromJoin({
      username: bob.username,
      userPublicKey: alice1.user.userKeyPair!.publicKey,
      signingKeyPair: {
        publicKey: fixture.adminUser.userSigningKeyPair.publicKey,
        privateKey: fixture.adminUser.userSigningKeyPair.privateKey,
      },
      signingKeyPassword: fixture.adminPassword,
    });
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    bob.tenant.noteUserDirectoryFetched!();
    const status = await bob.tenant.reconcileUserKeys!();
    expect(status.state).toBe("approved");
    const after = await bob.tenant.getUserKeyManager().resolveOwnUserKeyDocument();
    expect(after!.payload.userKeys["1"].publicKey).toBe(bob.user.userKeyPair!.publicKey);
    expect(Object.keys(after!.payload.userKeys["1"].deviceWraps).length).toBeGreaterThan(0);
  });

  it("legacy self-create is idempotent and does not mint a second document", async () => {
    const carol = await addPerson(fixture, "carol", "desk");
    await carol.factory.ensureUserKeyPair!(carol.user, carol.password);
    await syncAll(fixture, "directory");
    carol.tenant.noteUserDirectoryFetched!();
    const first = await carol.tenant.reconcileUserKeys!({ allowSelfCreate: true });
    expect(first.pending).toBe(false);
    const ids = await (await carol.tenant.openDB(USER_DIRECTORY_DB_ID)).getAllDocumentIds();
    const second = await carol.tenant.reconcileUserKeys!({ allowSelfCreate: true });
    expect(second.pending).toBe(false);
    const idsAfter = await (await carol.tenant.openDB(USER_DIRECTORY_DB_ID)).getAllDocumentIds();
    expect(idsAfter).toEqual(ids);
  });

  it("create on a tombstone restores instead of minting a new id", async () => {
    const dave = await addPerson(fixture, "dave", "one");
    await dave.factory.ensureUserKeyPair!(dave.user, dave.password);
    await syncAll(fixture, "directory");
    dave.tenant.noteUserDirectoryFetched!();
    await dave.tenant.reconcileUserKeys!({ allowSelfCreate: true });
    const resolved = await dave.tenant.getUserKeyManager().resolveOwnUserKeyDocument();
    const docId = resolved!.doc.getId();
    const db = await fixture.host.tenant.openDB(USER_DIRECTORY_DB_ID);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    await db.deleteDocument(docId, {
      signingKeyPair: fixture.adminUser.userSigningKeyPair,
      signingKeyPassword: fixture.adminPassword,
    });
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    dave.tenant.noteUserDirectoryFetched!();
    const restored = await dave.tenant.getUserKeyManager().ensureOwnUserKeyDocument({
      allowSelfCreate: true,
    });
    expect(restored!.doc.getId()).toBe(docId);
    expect(restored!.doc.isDeleted()).toBe(false);
  });

  it("lets the admin delete a published user-key document by username", async () => {
    const iris = await addPerson(fixture, "iris", "one");
    await iris.factory.ensureUserKeyPair!(iris.user, iris.password);
    await syncAll(fixture, "directory");
    iris.tenant.noteUserDirectoryFetched!();
    await iris.tenant.reconcileUserKeys!({ allowSelfCreate: true });
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    const before = await iris.tenant.getUserKeyManager().publishedUserKeyFor(iris.username);
    expect(before).not.toBeNull();

    await fixture.host.tenant.getUserKeyManager().deletePublishedUserKeyFor({
      username: iris.username,
      signingKeyPair: fixture.adminUser.userSigningKeyPair,
      signingKeyPassword: fixture.adminPassword,
    });
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    const after = await iris.tenant.getUserKeyManager().publishedUserKeyFor(iris.username);
    expect(after).toBeNull();
  });

  it("validate rejects a forged document signed by a stranger", async () => {
    const directory = await alice1.tenant.openDirectory();
    const hashes = await directory.getUsernameHashCandidates!(alice1.username);
    const result = await validateUserKeyDocument({
      payload: {
        form: "userdirectory",
        type: "userkey",
        schemaVersion: 1,
        username_hash: hashes[0],
        username_hash_v: 3,
        userKeys: { "1": { publicKey: "x", fingerprint: "aa", createdAt: 1, deviceWraps: {} } },
      },
      signerKey: fixture.host.user.userSigningKeyPair.publicKey,
      usernameHashCandidates: hashes,
      directory,
    });
    expect(result).toBeNull();
  });

  it("scan finds a document when the canonical id is occupied", async () => {
    const eve = await addPerson(fixture, "eve", "tab");
    await eve.factory.ensureUserKeyPair!(eve.user, eve.password);
    await syncAll(fixture, "directory");
    const directory = await fixture.host.tenant.openDirectory();
    const grants = await directory.findGrantAccessDocuments!(eve.username);
    const canonical = userKeyDocumentId(grants[0].getId());
    const db = await fixture.host.tenant.openDB(USER_DIRECTORY_DB_ID);
    await db.createDocument({
      id: canonical,
      assumeUniqueId: true,
      decryptionKeyId: "$publicinfos",
      signingKeyPair: fixture.adminUser.userSigningKeyPair,
      signingKeyPassword: fixture.adminPassword,
      initialValues: { form: "noise", type: "squat" },
    });
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    eve.tenant.noteUserDirectoryFetched!();
    await eve.tenant.reconcileUserKeys!({ allowSelfCreate: true });
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    const resolved = await eve.tenant.getUserKeyManager().resolveOwnUserKeyDocument();
    expect(resolved).not.toBeNull();
    expect(resolved!.doc.getId()).not.toBe(canonical);
    expect(asUserKeyPayload(resolved!.doc.getData())?.type).toBe("userkey");
  });

  it("self-creates against a legacy v1 grant username_hash", async () => {
    const gina = await addPerson(fixture, "gina", "desk");
    await gina.factory.ensureUserKeyPair!(gina.user, gina.password);
    const directory = await fixture.host.tenant.openDirectory();
    const grants = await directory.findGrantAccessDocuments!(gina.username);
    expect(grants.length).toBeGreaterThan(0);
    const legacyHash = createHash("sha256").update(gina.username.toLowerCase()).digest("hex");
    const directoryDB = await fixture.host.tenant.openDB("directory");
    await directoryDB.changeDoc(
      grants[0],
      (doc) => {
        const data = doc.getData();
        data.username_hash = legacyHash;
        delete data.username_hash_v;
      },
      {
        signingKeyPair: fixture.adminUser.userSigningKeyPair,
        signingKeyPassword: fixture.adminPassword,
      },
    );
    await syncAll(fixture, "directory");
    gina.tenant.noteUserDirectoryFetched!();
    const status = await gina.tenant.reconcileUserKeys!({ allowSelfCreate: true });
    expect(status.state).toBe("approved");
    const resolved = await gina.tenant.getUserKeyManager().resolveOwnUserKeyDocument();
    expect(resolved!.payload.username_hash).toBe(legacyHash);
  });

  it("does not rewrite an existing wrap or drop its device label", async () => {
    const hugo = await addPerson(fixture, "hugo", "abcdef");
    await hugo.factory.ensureUserKeyPair!(hugo.user, hugo.password);
    await syncAll(fixture, "directory");
    hugo.tenant.noteUserDirectoryFetched!();
    await hugo.tenant.reconcileUserKeys!({ allowSelfCreate: true });
    const first = await hugo.tenant.getUserKeyManager().resolveOwnUserKeyDocument();
    const wraps = first!.payload.userKeys["1"].deviceWraps;
    const fp = Object.keys(wraps)[0];
    expect(wraps[fp].label).toBe("abcdef");
    const approvedAt = wraps[fp].approvedAt;
    const wrappedKey = wraps[fp].wrappedKey;
    await hugo.tenant.reconcileUserKeys!({ allowSelfCreate: true });
    const second = await hugo.tenant.getUserKeyManager().resolveOwnUserKeyDocument();
    const again = second!.payload.userKeys["1"].deviceWraps[fp];
    expect(again.label).toBe("abcdef");
    expect(again.approvedAt).toBe(approvedAt);
    expect(again.wrappedKey).toBe(wrappedKey);
  });
});
