/**
 * Delegated administrators and deactivation by witness time
 * (docs/accesscontrol.md §6.13), end to end against a real server over HTTP.
 *
 * Cast: the root admin (the tenant's `administrationPublicKey`) on Karsten's
 * device, and Jane — a member who becomes a delegated admin with a dedicated
 * admin identity (`janeAdmin`). The server is the tenant's trusted witness.
 *
 * Directory writes are access rules (`acl_rule_*`), the simplest directory
 * document; whether a rule shows up in another replica's `listRules()` is what
 * "the entry counts there" means.
 */
import fs from "fs";
import { Server } from "http";

import { IsolatedInMemoryStoreFactory } from "./_helpers/multiDevice";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { BaseMindooTenant } from "../core/BaseMindooTenant";
import { BaseMindooTenantDirectory } from "../core/BaseMindooTenantDirectory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { MindooDBServer } from "../node/server/MindooDBServer";
import { StoreKind, USER_DIRECTORY_DB_ID, type MindooTenant, type PrivateUserId } from "../core/types";
import type { ServerConfig } from "../server/types";
import { setSemanticTimeSourceForTesting } from "../core/utils/timeSource";
import { aclAdminKeyDocIdForKey } from "../core/accesscontrol/adminKeys";
import { KeyBag } from "../core/keys/KeyBag";

const PASSWORD = "member-pass";
const SYSTEM_ADMIN_PASSWORD = "sysadmin-pass";
const SERVER_PASSWORD = "delegated-admins-pass";

async function startServer(server: MindooDBServer): Promise<{ httpServer: Server; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const httpServer = server.getApp().listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to determine test server port"));
        return;
      }
      resolve({ httpServer, baseUrl: `http://127.0.0.1:${address.port}` });
    });
    httpServer.on("error", reject);
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("delegated administrators (§6.13)", () => {
  jest.setTimeout(240000);
  let httpServer: Server;
  let baseUrl: string;
  let dataDir: string;
  let systemAdmin: PrivateUserId;
  const crypto = new NodeCryptoAdapter();

  beforeEach(async () => {
    const factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    dataDir = `/tmp/mindoodb-delegated-admins-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    fs.mkdirSync(dataDir, { recursive: true });
    const serverIdentity = await factory.createUserId("CN=delegated-admins-server", SERVER_PASSWORD);
    fs.writeFileSync(`${dataDir}/server.identity.json`, JSON.stringify(serverIdentity, null, 2), "utf-8");
    fs.writeFileSync(`${dataDir}/trusted-servers.json`, "[]", "utf-8");
    systemAdmin = await factory.createUserId("cn=sysadmin/o=delegated-admins", SYSTEM_ADMIN_PASSWORD);
    const config: ServerConfig = {
      capabilities: {
        "ALL:/system/*": [{ username: systemAdmin.username, publicsignkey: systemAdmin.userSigningKeyPair.publicKey as string }],
      },
    };
    ({ httpServer, baseUrl } = await startServer(new MindooDBServer(dataDir, SERVER_PASSWORD, undefined, config)));
  }, 60000);

  afterEach(async () => {
    setSemanticTimeSourceForTesting(null);
    if (httpServer) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    if (dataDir && fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function openDb(tenant: MindooTenant, dbId: string) {
    return tenant.openDB(dbId, dbId === "directory" ? { adminOnlyDb: true } : undefined);
  }

  async function setup() {
    const tenantId = `deladm-${Date.now().toString(16)}`;
    const founderFactory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    const rootUser = await founderFactory.createUserId(`cn=admin/o=${tenantId}`, PASSWORD);
    const karstenUser = await founderFactory.createUserId(`cn=karsten/o=${tenantId}`, PASSWORD);
    await founderFactory.ensureUserKeyPair(karstenUser, PASSWORD);
    const { tenant: karsten } = await founderFactory.createTenant({
      tenantId,
      adminUser: rootUser,
      adminPassword: PASSWORD,
      appUser: karstenUser,
      userPassword: PASSWORD,
    });
    karsten.noteUserDirectoryFetched!();
    await karsten.reconcileUserKeys!({ allowSelfCreate: true });
    await karsten.publishToServer(baseUrl, {
      systemAdminUser: systemAdmin,
      systemAdminPassword: SYSTEM_ADMIN_PASSWORD,
      adminUsername: rootUser.username,
      adminSigningKey: rootUser.userSigningKeyPair.privateKey,
      adminPassword: PASSWORD,
    });

    const rootAuth = { networkAuthOverride: { user: rootUser, password: PASSWORD } };
    const push = async (tenant: MindooTenant, dbId: string, auth?: { networkAuthOverride: { user: PrivateUserId; password: string } }) => {
      const local = await openDb(tenant, dbId);
      return local.pushChangesTo(await tenant.connectToServer(baseUrl, dbId, StoreKind.docs), auth);
    };
    const pull = async (tenant: MindooTenant, dbId: string) => {
      const local = await openDb(tenant, dbId);
      await local.pullChangesFrom(await tenant.connectToServer(baseUrl, dbId, StoreKind.docs));
      await local.syncStoreChanges();
    };
    await push(karsten, "directory", rootAuth);
    await push(karsten, USER_DIRECTORY_DB_ID);

    // Jane joins as a member.
    const janeFactory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    const janeUser = await janeFactory.createUserId(`cn=jane/o=${tenantId}`, PASSWORD);
    await janeFactory.ensureUserKeyPair(janeUser, PASSWORD);
    await karsten.approveJoinRequest(janeFactory.createJoinRequest(janeUser, { label: "Jane" }), {
      adminSigningKey: rootUser.userSigningKeyPair.privateKey,
      adminPassword: PASSWORD,
      adminUsername: rootUser.username,
      label: "Jane",
      serverUrl: baseUrl,
    });
    await push(karsten, "directory", rootAuth);
    await push(karsten, USER_DIRECTORY_DB_ID);
    const delivery = (await janeFactory.discoverTenantsOnServer(baseUrl, { user: janeUser, password: PASSWORD })).find(
      (d) => d.tenantId === tenantId,
    )!;
    const joined = await janeFactory.bootstrapTenantFromDelivery(delivery, { user: janeUser, password: PASSWORD, serverUrl: baseUrl });
    const jane = joined.tenant;
    await pull(jane, "directory");
    await pull(jane, USER_DIRECTORY_DB_ID);

    // Jane creates a dedicated admin identity and asks to become an admin.
    const janeAdmin = await janeFactory.createUserId(`cn=jane-admin/o=${tenantId}`, PASSWORD);
    const requestUri = janeFactory.createAdminRequest(janeAdmin, {
      tenantId,
      name: "Jane",
      label: "Laptop",
      format: "uri",
    }) as string;
    expect(requestUri.startsWith("mdb://admin-request/")).toBe(true);
    const responseUri = (await (karsten as BaseMindooTenant).approveAdminRequest(requestUri, {
      adminSigningKey: rootUser.userSigningKeyPair.privateKey,
      adminPassword: PASSWORD,
      serverUrl: baseUrl,
      format: "uri",
    })) as string;
    expect(responseUri.startsWith("mdb://admin-response/")).toBe(true);
    await push(karsten, "directory", rootAuth);
    await pull(jane, "directory");
    const response = await janeFactory.acceptAdminResponse(responseUri, { adminIdentity: janeAdmin, password: PASSWORD });
    expect(response.adminSigningPublicKey).toBe(rootUser.userSigningKeyPair.publicKey);
    expect(response.encryptedDocKeys.map((k) => k.keyId).sort()).toEqual(["$publicinfos", "default"]);

    const karstenDirectory = (await karsten.openDirectory()) as BaseMindooTenantDirectory;
    const janeDirectory = (await jane.openDirectory()) as BaseMindooTenantDirectory;
    const rootKey = rootUser.userSigningKeyPair.privateKey;
    const janeAdminKey = janeAdmin.userSigningKeyPair.privateKey;
    const janeAdminPub = janeAdmin.userSigningKeyPair.publicKey;

    return {
      tenantId,
      responseUri,
      rootUser,
      karsten,
      karstenUser,
      jane,
      janeUser: joined.user,
      janeAdmin,
      janeFactory,
      karstenDirectory,
      janeDirectory,
      rootKey,
      janeAdminKey,
      janeAdminPub,
      rootAuth,
      push,
      pull,
      /** Jane writes a rule with her admin key (locally). */
      async janeWritesRule(ruleId: string) {
        await janeDirectory.createAccessRule!(
          { ruleId, type: "doc_read", dbid: "main", action: "allow", users_hashes: ["$everyone"] },
          janeAdminKey,
          PASSWORD,
        );
      },
      async ruleIds(directory: BaseMindooTenantDirectory) {
        return (await directory.listRules()).map((r) => r.ruleId);
      },
      async pushJaneDirectory() {
        return push(jane, "directory");
      },
      async syncKarstenDirectory() {
        await pull(karsten, "directory");
      },
      async deactivateJane(validUntil: number) {
        await karstenDirectory.setAdminKeyValidity(janeAdminPub, { validUntil }, rootKey, PASSWORD);
        await push(karsten, "directory", rootAuth);
      },
    };
  }

  function policyRejections(result: { rejectedEntries?: Array<{ rejectionClass?: string; reason: string }> }) {
    return (result.rejectedEntries ?? []).filter((r) => r.rejectionClass === "policy");
  }

  test("a delegated admin's directory writes count everywhere once a witness stamped them", async () => {
    const t = await setup();
    const listed = await t.karstenDirectory.listAdminKeys();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: "Jane", label: "Laptop", status: "active", active: true, pending: false });

    await t.janeWritesRule("jane_rule");
    // Visible on Jane's own device before the push ...
    expect(await t.ruleIds(t.janeDirectory)).toContain("jane_rule");
    // ... and nowhere else.
    await t.syncKarstenDirectory();
    expect(await t.ruleIds(t.karstenDirectory)).not.toContain("jane_rule");

    const result = await t.pushJaneDirectory();
    expect(result.rejectedEntries ?? []).toHaveLength(0);
    await t.syncKarstenDirectory();
    expect(await t.ruleIds(t.karstenDirectory)).toContain("jane_rule");

    // The tenantsetup display list names the new admin.
    const { readTenantSetupAdministrators } = await import("../core/tenantSetup");
    const admins = await readTenantSetupAdministrators(await openDb(t.karsten, "directory"), t.karsten);
    expect(admins.map((a) => a.username)).toContain("Jane");
  });

  test("the root stays unchanged", async () => {
    const t = await setup();
    const rootPub = t.rootUser.userSigningKeyPair.publicKey;
    expect(await t.karstenDirectory.isAdminAt(rootPub, 0)).toBe(true);
    expect(await t.karstenDirectory.isAdminAt(rootPub, Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(await t.karstenDirectory.validatePublicSigningKey(rootPub)).toBe(true);
    await t.karstenDirectory.createAccessRule!(
      { ruleId: "root_rule", type: "doc_read", dbid: "main", action: "allow", users_hashes: ["$everyone"] },
      t.rootKey,
      PASSWORD,
    );
    expect((await t.push(t.karsten, "directory", t.rootAuth)).rejectedEntries ?? []).toHaveLength(0);
    await t.pull(t.jane, "directory");
    expect(await t.ruleIds(t.janeDirectory)).toContain("root_rule");
    // Join responses keep naming the root.
    expect((t.karsten as BaseMindooTenant).getAdministrationPublicKey()).toBe(rootPub);
  });

  test("a delegated admin cannot write admin keys or trusted witnesses", async () => {
    const t = await setup();
    const other = await t.janeFactory.createUserId(`cn=other/o=${t.tenantId}`, PASSWORD);
    await expect(
      t.janeDirectory.addAdminKey(
        {
          signingPublicKey: other.userSigningKeyPair.publicKey,
          encryptionPublicKey: other.userEncryptionKeyPair.publicKey,
          name: "Mallory",
        },
        t.janeAdminKey,
        PASSWORD,
      ),
    ).rejects.toThrow(/Only the root admin key/);
    await expect(
      t.janeDirectory.setAdminKeyValidity(t.janeAdminPub, { validUntil: null }, t.janeAdminKey, PASSWORD),
    ).rejects.toThrow(/Only the root admin key/);
    await expect(
      t.janeDirectory.addTrustedWitness!({ witnessPublicKey: other.userSigningKeyPair.publicKey }, t.janeAdminKey, PASSWORD),
    ).rejects.toThrow(/Only the root admin key/);

    // Bypassing the API: the directory database refuses the write itself.
    const directoryDb = await openDb(t.jane, "directory");
    const docId = await aclAdminKeyDocIdForKey(other.userSigningKeyPair.publicKey, crypto.getSubtle());
    await expect(
      directoryDb.createDocument({
        id: docId,
        signingKeyPair: t.janeAdmin.userSigningKeyPair,
        signingKeyPassword: PASSWORD,
        decryptionKeyId: "$publicinfos",
      }),
    ).rejects.toThrow(/root admin key/);
  });

  test("the exceptions of the root apply to delegated admins", async () => {
    const t = await setup();
    const karstenGrant = (await t.karstenDirectory.findGrantAccessDocuments(t.karstenUser.username)).find((doc) => !doc.isDeleted())!;
    const personalDb = `mmail_${karstenGrant.getId()}`;
    // Reading someone else's personal database (and so a tenant backup).
    expect((await t.karstenDirectory.evaluateDbAccessModeForSigningKey({ dbid: personalDb, signingKey: t.janeAdminPub })).mode).toBe(
      "read",
    );
    // Jane's own user key only may deposit (mail), not read.
    expect(
      (await t.karstenDirectory.evaluateDbAccessModeForSigningKey({ dbid: personalDb, signingKey: t.janeUser.userSigningKeyPair.publicKey }))
        .mode,
    ).not.toBe("read");

    // On the server: the admin key authenticates without a grant and reads the
    // personal database. The admin response carries the keys to open the tenant.
    const karstenMail = await openDb(t.karsten, personalDb);
    const mail = await karstenMail.createDocument();
    await karstenMail.changeDoc(mail, (d) => {
      d.getData().subject = "hello";
    });
    expect((await t.push(t.karsten, personalDb)).rejectedEntries ?? []).toHaveLength(0);
    const adminBag = new KeyBag(t.janeAdmin.userEncryptionKeyPair.privateKey, PASSWORD, crypto);
    await t.janeFactory.acceptAdminResponse(t.responseUri, { adminIdentity: t.janeAdmin, password: PASSWORD, keyBag: adminBag });
    expect(await adminBag.get("doc", t.tenantId, "default")).toBeTruthy();
    const adminTenant = await t.janeFactory.openTenant(
      t.tenantId,
      t.rootUser.userSigningKeyPair.publicKey,
      t.rootUser.userEncryptionKeyPair.publicKey,
      t.janeAdmin,
      PASSWORD,
      adminBag,
    );
    const asAdmin = await adminTenant.connectToServer(baseUrl, personalDb, StoreKind.docs);
    expect((await asAdmin.findNewEntries([])).some((e) => e.docId === mail.getId())).toBe(true);
    const asJaneRemote = await t.jane.connectToServer(baseUrl, personalDb, StoreKind.docs);
    await expect(asJaneRemote.findNewEntries([])).rejects.toThrow();

    // `$admin` in rules.
    await t.karstenDirectory.setDefaultAccessPolicy!(
      { disableAllAccessChecksAndPolicies: false, denyDocRead: true },
      t.rootKey,
      PASSWORD,
    );
    await t.karstenDirectory.createAccessRule!(
      { ruleId: "admins_read_secret", type: "doc_read", dbid: "secret", action: "allow", users_hashes: ["$admin"] },
      t.rootKey,
      PASSWORD,
    );
    const asJaneAdmin = await t.karstenDirectory.evaluateAccessForSigningKey({
      op: "doc_read",
      dbid: "secret",
      signingKey: t.janeAdminPub,
      trustedTime: Number.MAX_SAFE_INTEGER,
    });
    expect(asJaneAdmin.allowed).toBe(true);
    const asJane = await t.karstenDirectory.evaluateAccessForSigningKey({
      op: "doc_read",
      dbid: "secret",
      signingKey: t.janeUser.userSigningKeyPair.publicKey,
      trustedTime: Number.MAX_SAFE_INTEGER,
    });
    expect(asJane.allowed).toBe(false);

    // Deactivated, the same key is an ordinary key again.
    await t.deactivateJane(Date.now());
    await sleep(20);
    expect((await t.karstenDirectory.evaluateDbAccessModeForSigningKey({ dbid: personalDb, signingKey: t.janeAdminPub })).mode).not.toBe(
      "read",
    );
  });

  test("an entry written offline before the deactivation and pushed after it is refused", async () => {
    const t = await setup();
    await t.janeWritesRule("before_deactivation");
    expect((await t.pushJaneDirectory()).rejectedEntries ?? []).toHaveLength(0);
    const insideWindow = Date.now();

    // Jane writes offline; her entry's createdAt lies before the deactivation.
    await t.janeWritesRule("offline_backdated");
    const deactivatedAt = Date.now();
    await t.deactivateJane(deactivatedAt);
    await sleep(20);

    // The server judges at its own clock, not at createdAt.
    const rejected = policyRejections(await t.pushJaneDirectory());
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[0]!.reason).toMatch(/not a tenant administrator/);

    await t.syncKarstenDirectory();
    const ids = await t.ruleIds(t.karstenDirectory);
    expect(ids).not.toContain("offline_backdated");
    // No retroactive effect: what Jane had pushed before the deactivation stays.
    expect(ids).toContain("before_deactivation");
    // Validity in witness time.
    expect(await t.karstenDirectory.isAdminAt(t.janeAdminPub, insideWindow)).toBe(true);
    expect(await t.karstenDirectory.isAdminAt(t.janeAdminPub, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect((await t.karstenDirectory.listAdminKeys())[0]).toMatchObject({ status: "ended", active: false });

    // Once Jane learns about the end, her own device refuses to sign as admin.
    await t.pull(t.jane, "directory");
    await expect(t.janeWritesRule("after_end")).rejects.toThrow(/Signing key pair mismatch/);
  });

  test("an entry relayed peer to peer without a witness stamp does not count", async () => {
    const t = await setup();
    await t.janeWritesRule("p2p_rule");
    // Peer sync: Karsten's replica takes Jane's directory entries directly.
    const karstenDirDb = await openDb(t.karsten, "directory");
    const janeDirDb = await openDb(t.jane, "directory");
    await karstenDirDb.pullChangesFrom(janeDirDb);
    await karstenDirDb.syncStoreChanges();
    expect(await t.ruleIds(t.karstenDirectory)).not.toContain("p2p_rule");

    // The peer ingest check refuses such an entry outright.
    const unstamped = (await janeDirDb.getStore().findNewEntries([])).find(
      (e) => e.createdByPublicKey === t.janeAdminPub && e.receivedAt === undefined,
    )!;
    expect(unstamped).toBeDefined();
    const [full] = await janeDirDb.getStore().getEntries([unstamped.id]);
    expect(await karstenDirDb.violatesBuiltinWriteInvariant(full!)).toBe(true);
  });

  test("a deactivation in the future ends the admin at that time", async () => {
    const t = await setup();
    const endsAt = Date.now() + 4000;
    await t.deactivateJane(endsAt);
    await t.pull(t.jane, "directory");
    expect((await t.karstenDirectory.listAdminKeys())[0]).toMatchObject({ status: "ending", active: true, validUntil: endsAt });

    await t.janeWritesRule("while_active");
    expect((await t.pushJaneDirectory()).rejectedEntries ?? []).toHaveLength(0);
    // Written before the end, pushed after it.
    await t.janeWritesRule("pushed_too_late");

    await sleep(Math.max(0, endsAt - Date.now()) + 300);
    expect(policyRejections(await t.pushJaneDirectory()).length).toBeGreaterThan(0);
    await expect(t.janeWritesRule("after_end")).rejects.toThrow(/Signing key pair mismatch/);

    await t.syncKarstenDirectory();
    const ids = await t.ruleIds(t.karstenDirectory);
    expect(ids).toContain("while_active");
    expect(ids).not.toContain("pushed_too_late");
    expect((await t.karstenDirectory.listAdminKeys())[0]).toMatchObject({ status: "ended" });
  });

  test("reactivation starts a new window; the gap stays a gap", async () => {
    const t = await setup();
    await t.janeWritesRule("before_gap");
    expect((await t.pushJaneDirectory()).rejectedEntries ?? []).toHaveLength(0);
    await t.deactivateJane(Date.now());
    await sleep(50);
    const gapTime = Date.now();
    await sleep(50);

    await t.karstenDirectory.setAdminKeyValidity(t.janeAdminPub, { validUntil: null }, t.rootKey, PASSWORD);
    await t.push(t.karsten, "directory", t.rootAuth);
    await t.pull(t.jane, "directory");
    expect((await t.karstenDirectory.listAdminKeys())[0]).toMatchObject({ status: "active", active: true });

    await t.janeWritesRule("after_reactivation");
    expect(policyRejections(await t.pushJaneDirectory())).toHaveLength(0);

    await t.syncKarstenDirectory();
    const ids = await t.ruleIds(t.karstenDirectory);
    expect(ids).toContain("before_gap");
    expect(ids).toContain("after_reactivation");
    // An entry a witness stamped inside the gap would be judged at its stamp: no admin then.
    expect(await t.karstenDirectory.isAdminAt(t.janeAdminPub, gapTime)).toBe(false);
    expect(await t.karstenDirectory.isAdminAt(t.janeAdminPub, Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});
