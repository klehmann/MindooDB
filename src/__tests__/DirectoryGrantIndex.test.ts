/**
 * findGrantAccessDocuments answers from an index of grant documents by
 * username_hash instead of scanning the whole directory on every call.
 *
 * The scan made every token check load every grant document. With more
 * grants than a database's document cache holds (128 by default) the LRU
 * evicted each document before it was needed again, so each sync request
 * rebuilt every grant from its changes (seconds at 150 users).
 *
 * The test compares the index with the former full scan (reimplemented here
 * from the public changefeed) after each step: registration of more users
 * than the cache holds, full and single-key revocation, a wipe request and a
 * re-registration. The access answers built on it (keys, revocation, trust)
 * are compared too.
 */

import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import type {
  EncryptedPrivateKey,
  MindooTenantDirectory,
  PrivateUserId,
  PublicUserId,
} from "../core/types";

const PASSWORD = "grant-index-pass";
/** More grants than DEFAULT_MAX_CACHED_DOCS (128), so the old scan thrashed. */
const USERS = 140;

describe("directory grant index", () => {
  jest.setTimeout(600_000);

  const crypto = new NodeCryptoAdapter();
  const subtle = crypto.getSubtle();
  let admin: PrivateUserId;
  let directory: MindooTenantDirectory;
  let directoryDb: Awaited<ReturnType<Awaited<ReturnType<BaseMindooTenantFactory["createTenant"]>>["tenant"]["openDB"]>>;
  const users: Array<{ username: string; signingKeys: string[] }> = [];

  async function newSigningKey(): Promise<string> {
    const pair = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const spki = Buffer.from(await subtle.exportKey("spki", pair.publicKey)).toString("base64");
    return `-----BEGIN PUBLIC KEY-----\n${spki}\n-----END PUBLIC KEY-----`;
  }

  async function register(username: string, signingKey: string): Promise<void> {
    await directory.registerUser(
      {
        username,
        userSigningPublicKey: signingKey,
        userEncryptionPublicKey: admin.userEncryptionKeyPair.publicKey,
      } as PublicUserId,
      admin.userSigningKeyPair.privateKey as EncryptedPrivateKey,
      PASSWORD,
    );
  }

  /**
   * The former implementation: walk every document and match form, type and
   * hash. One walk serves all lookups of a check (grants by hash, in order).
   */
  async function scanGrants(): Promise<Array<{ id: string; hash: string }>> {
    const grants: Array<{ id: string; hash: string }> = [];
    for await (const { doc } of directoryDb.iterateChangesSince(null)) {
      const data = doc.getData();
      if (data.form === "useroperation" && data.type === "grantaccess" && typeof data.username_hash === "string") {
        grants.push({ id: doc.getId(), hash: data.username_hash });
      }
    }
    return grants;
  }

  async function expectIndexMatchesScan(): Promise<void> {
    const grants = await scanGrants();
    const candidatesOf = (directory as unknown as { usernameHashCandidates(name: string): Promise<string[]> })
      .usernameHashCandidates.bind(directory);
    for (const user of users) {
      const candidates = new Set([...(await candidatesOf(user.username)), user.username]);
      const indexed = (await directory.findGrantAccessDocuments!(user.username)).map((doc) => doc.getId());
      expect(indexed).toEqual(grants.filter((grant) => candidates.has(grant.hash)).map((grant) => grant.id));
    }
    expect(await directory.findGrantAccessDocuments!("cn=nobody/o=grant-index")).toEqual([]);
  }

  beforeAll(async () => {
    const factory = new BaseMindooTenantFactory(new InMemoryContentAddressedStoreFactory(), crypto);
    admin = await factory.createUserId("cn=admin/o=grant-index", PASSWORD);
    const appUser = await factory.createUserId("cn=app/o=grant-index", PASSWORD);
    const created = await factory.createTenant({
      tenantId: "grant-index",
      adminUser: admin,
      adminPassword: PASSWORD,
      appUser,
      userPassword: PASSWORD,
    });
    directory = await created.tenant.openDirectory();
    directoryDb = await created.tenant.openDB("directory", { adminOnlyDb: true });

    for (let i = 0; i < USERS; i++) {
      const username = `cn=user${i}/o=grant-index`;
      const signingKey = await newSigningKey();
      await register(username, signingKey);
      users.push({ username, signingKeys: [signingKey] });
    }
  });

  test("lookups match the full scan for more grants than the document cache holds", async () => {
    await expectIndexMatchesScan();
    const first = users[0];
    expect(await directory.getUserPublicKeys(first.username)).toEqual(
      expect.objectContaining({ signingPublicKey: first.signingKeys[0] }),
    );
    expect(await directory.isUserRevoked(first.username)).toBe(false);
    expect(await directory.validatePublicSigningKey(first.signingKeys[0])).toBe(true);
  });

  test("a lookup reads only the matching grants, never the whole directory", async () => {
    await directory.findGrantAccessDocuments!(users[0].username);
    const fullScans = jest.spyOn(directoryDb, "iterateChangesSince");
    const loads = jest.spyOn(directoryDb, "getDocument");
    try {
      for (const user of users.slice(0, 20)) {
        expect(await directory.findGrantAccessDocuments!(user.username)).toHaveLength(1);
      }
      expect(fullScans.mock.calls.filter(([cursor]) => cursor === null)).toHaveLength(0);
      expect(loads).toHaveBeenCalledTimes(20);
    } finally {
      fullScans.mockRestore();
      loads.mockRestore();
    }
  });

  test("revocation, wipe and re-registration keep index and scan identical", async () => {
    const adminKey = admin.userSigningKeyPair.privateKey as EncryptedPrivateKey;

    // Full revocation of one user, single-key revocation with wipe of another.
    const revoked = users[3];
    await directory.revokeUser(revoked.username, {}, adminKey, PASSWORD);

    const twoDevices = users[7];
    const secondKey = await newSigningKey();
    await register(twoDevices.username, secondKey);
    twoDevices.signingKeys.push(secondKey);
    await directory.revokeUser(
      twoDevices.username,
      { signingKeys: [twoDevices.signingKeys[0]], requestDataWipe: true },
      adminKey,
      PASSWORD,
    );

    await expectIndexMatchesScan();
    expect(await directory.isUserRevoked(revoked.username)).toBe(true);
    expect(await directory.validatePublicSigningKey(revoked.signingKeys[0])).toBe(false);
    expect(await directory.validatePublicSigningKey(twoDevices.signingKeys[0])).toBe(false);
    expect(await directory.validatePublicSigningKey(secondKey)).toBe(true);
    expect(await directory.getWipeGrantDocId!(twoDevices.signingKeys[0])).toEqual(expect.any(String));

    // The revoked user comes back with a new key.
    const newKey = await newSigningKey();
    await register(revoked.username, newKey);
    revoked.signingKeys.push(newKey);
    await expectIndexMatchesScan();
    expect(await directory.isUserRevoked(revoked.username)).toBe(false);
    expect(await directory.validatePublicSigningKey(newKey)).toBe(true);
  });
});
