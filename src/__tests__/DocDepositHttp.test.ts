/**
 * `doc_deposit` on a real server over HTTP (docs/accesscontrol.md §6.10).
 *
 * A mail gateway joins the tenant with `$publicinfos` only. The person's mail
 * database is read-gated (`denyDocRead` + a `doc_read` allow for its owner),
 * and the gateway holds a `doc_deposit` allow on `mailbox_*`. The built-in
 * personal databases (`mmail_<grantDocId>`, §6.11) get the same without any
 * configured policy; see the last block. It may push
 * documents sealed to someone else, with attachments in the create entry,
 * but it may not pull, list or change anything there.
 */
import { docIdMatchesPrefixes, validateAclRule } from "../core/accesscontrol/types";
import fs from "fs";
import { Server } from "http";

import { IsolatedInMemoryStoreFactory } from "./_helpers/multiDevice";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { MindooDBServer } from "../node/server/MindooDBServer";
import {
  DEFAULT_TENANT_KEY_ID,
  PUBLIC_INFOS_KEY_ID,
  StoreKind,
  USER_DIRECTORY_DB_ID,
  type MindooDB,
  type MindooTenant,
  type MindooTenantDirectory,
  type PrivateUserId,
} from "../core/types";
import type { ServerConfig } from "../server/types";

const PASSWORD = "member-pass";
const SYSTEM_ADMIN_PASSWORD = "sysadmin-pass";
const SERVER_PASSWORD = "server-deposit-pass";
const DENIED = /denied|ACCESS_DENIED|deposit sealed documents only|not allowed/i;
/** Generic doc_deposit tests use a database outside the built-in personal prefixes. */
const MAILDB = "mailbox_jane";

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

describe("doc_deposit on a real server (HTTP)", () => {
  jest.setTimeout(240000);
  const crypto = new NodeCryptoAdapter();
  let httpServer: Server;
  let baseUrl: string;
  let dataDir: string;
  let systemAdmin: PrivateUserId;

  beforeEach(async () => {
    const factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    dataDir = `/tmp/mindoodb-deposit-http-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    fs.mkdirSync(dataDir, { recursive: true });
    const serverIdentity = await factory.createUserId("CN=deposit-http-server", SERVER_PASSWORD);
    fs.writeFileSync(`${dataDir}/server.identity.json`, JSON.stringify(serverIdentity, null, 2), "utf-8");
    fs.writeFileSync(`${dataDir}/trusted-servers.json`, "[]", "utf-8");
    systemAdmin = await factory.createUserId("cn=sysadmin/o=deposit-http", SYSTEM_ADMIN_PASSWORD);
    const config: ServerConfig = {
      capabilities: {
        "ALL:/system/*": [{ username: systemAdmin.username, publicsignkey: systemAdmin.userSigningKeyPair.publicKey as string }],
      },
    };
    ({ httpServer, baseUrl } = await startServer(new MindooDBServer(dataDir, SERVER_PASSWORD, undefined, config)));
  }, 60000);

  afterEach(async () => {
    if (httpServer) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    if (dataDir && fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const openDb = (tenant: MindooTenant, dbId: string) =>
    tenant.openDB(dbId, dbId === "directory" ? { adminOnlyDb: true } : undefined);

  async function pull(tenant: MindooTenant, dbId: string, withAttachments = false) {
    const local = await openDb(tenant, dbId);
    await local.pullChangesFrom(await tenant.connectToServer(baseUrl, dbId, StoreKind.docs));
    if (withAttachments) {
      await local.pullChangesFrom(await tenant.connectToServer(baseUrl, dbId, StoreKind.attachments), {
        storeKind: StoreKind.attachments,
      });
    }
    await local.syncStoreChanges();
    return local;
  }

  async function push(tenant: MindooTenant, dbId: string, auth?: { user: PrivateUserId; password: string }) {
    const local = await openDb(tenant, dbId);
    const docs = await local.pushChangesTo(
      await tenant.connectToServer(baseUrl, dbId, StoreKind.docs),
      auth ? { networkAuthOverride: auth } : undefined,
    );
    const attachments = await local.pushChangesTo(await tenant.connectToServer(baseUrl, dbId, StoreKind.attachments), {
      storeKind: StoreKind.attachments,
    });
    return { docs, attachments };
  }

  /** A member device that joined like the MindooMail bridge: `$publicinfos` only. */
  async function joinPublicInfosOnly(
    founder: MindooTenant,
    admin: PrivateUserId,
    tenantId: string,
    name: string,
    pushDirectory: () => Promise<void>,
    depositPrefixes?: string[],
    accessPrefixes?: string[],
  ) {
    const deviceFactory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    const user = await deviceFactory.createUserId(name, PASSWORD);
    await deviceFactory.ensureUserKeyPair(user, PASSWORD);
    await founder.approveJoinRequest(deviceFactory.createJoinRequest(user, { label: name }), {
      adminSigningKey: admin.userSigningKeyPair.privateKey,
      adminPassword: PASSWORD,
      adminUsername: admin.username,
      label: name,
      username: name,
      sharedDocKeyIds: [PUBLIC_INFOS_KEY_ID],
      ...(depositPrefixes ? { depositPrefixes } : {}),
      ...(accessPrefixes ? { accessPrefixes } : {}),
    });
    await pushDirectory();
    const delivery = (await deviceFactory.discoverTenantsOnServer(baseUrl, { user, password: PASSWORD })).find(
      (d) => d.tenantId === tenantId,
    )!;
    const joined = await deviceFactory.bootstrapTenantFromDelivery(delivery, { user, password: PASSWORD });
    const tenant = joined.tenant;
    await pull(tenant, "directory");
    await pull(tenant, USER_DIRECTORY_DB_ID);
    tenant.noteUserDirectoryFetched!();
    await tenant.reconcileUserKeys!({ allowSelfCreate: false });
    // Publish this device's wrap of its user key, so others can seal to it.
    await push(tenant, USER_DIRECTORY_DB_ID);
    return { tenant, user: joined.user, factory: deviceFactory, delivery };
  }

  async function setup(options: { acl?: boolean; gatewayDepositPrefixes?: string[]; gatewayAccessPrefixes?: string[] } = {}) {
    const acl = options.acl ?? true;
    const tenantId = `deposit-${Date.now().toString(16)}`;
    const founderFactory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    const admin = await founderFactory.createUserId(`cn=admin/o=${tenantId}`, PASSWORD);
    const karstenUser = await founderFactory.createUserId(`cn=karsten/o=${tenantId}`, PASSWORD);
    await founderFactory.ensureUserKeyPair(karstenUser, PASSWORD);
    const { tenant: karsten } = await founderFactory.createTenant({
      tenantId,
      adminUser: admin,
      adminPassword: PASSWORD,
      appUser: karstenUser,
      userPassword: PASSWORD,
    });
    karsten.noteUserDirectoryFetched!();
    await karsten.reconcileUserKeys!({ allowSelfCreate: true });
    await karsten.publishToServer(baseUrl, {
      systemAdminUser: systemAdmin,
      systemAdminPassword: SYSTEM_ADMIN_PASSWORD,
      adminUsername: admin.username,
      // Trust the server as witness, or its receipts are quarantined once access control is on.
      adminSigningKey: admin.userSigningKeyPair.privateKey,
      adminPassword: PASSWORD,
    });
    const adminAuth = { user: admin, password: PASSWORD };
    const pushDirectory = async () => {
      await push(karsten, "directory", adminAuth);
      await push(karsten, USER_DIRECTORY_DB_ID);
    };
    await pushDirectory();

    // Jane: a person with the tenant key, owner of mmail_jane.
    const janeFactory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    const janeUser = await janeFactory.createUserId(`cn=jane/o=${tenantId}`, PASSWORD);
    await janeFactory.ensureUserKeyPair(janeUser, PASSWORD);
    await karsten.approveJoinRequest(janeFactory.createJoinRequest(janeUser, { label: "Jane" }), {
      adminSigningKey: admin.userSigningKeyPair.privateKey,
      adminPassword: PASSWORD,
      adminUsername: admin.username,
      label: "Jane",
      username: janeUser.username,
      serverUrl: baseUrl,
    });
    await pushDirectory();
    const janeDelivery = (await janeFactory.discoverTenantsOnServer(baseUrl, { user: janeUser, password: PASSWORD })).find(
      (d) => d.tenantId === tenantId,
    )!;
    const jane = (await janeFactory.bootstrapTenantFromDelivery(janeDelivery, { user: janeUser, password: PASSWORD, serverUrl: baseUrl }))
      .tenant;
    await push(jane, USER_DIRECTORY_DB_ID);
    expect(await jane.hasDecryptionKey!(DEFAULT_TENANT_KEY_ID)).toBe(true);

    const gatewayName = `cn=mail-gateway/o=${tenantId}`;
    const gateway = await joinPublicInfosOnly(karsten, admin, tenantId, gatewayName, pushDirectory, options.gatewayDepositPrefixes, options.gatewayAccessPrefixes);
    expect(await gateway.tenant.hasDecryptionKey!(DEFAULT_TENANT_KEY_ID)).toBe(false);

    // Access control: mmail_* is read-gated; Jane reads hers, the gateway deposits.
    const directory = (await karsten.openDirectory()) as MindooTenantDirectory;
    const adminKey = admin.userSigningKeyPair.privateKey;
    const grantId = async (username: string) =>
      (await directory.findGrantAccessDocuments!(username)).find((doc) => !doc.isDeleted())!.getId();
    const janeMail = `mmail_${await grantId(janeUser.username)}`;
    const karstenMail = `mmail_${await grantId(karstenUser.username)}`;
    const janeOutbox = `mmailout_${await grantId(janeUser.username)}`;
    const base = { tenantId, admin, karsten, karstenUser, jane, janeUser, gateway, gatewayName, directory, adminKey, pushDirectory, janeMail, karstenMail, janeOutbox };
    if (!acl) {
      for (const tenant of [gateway.tenant, jane, karsten]) {
        await pull(tenant, "directory");
        await pull(tenant, USER_DIRECTORY_DB_ID);
      }
      return base;
    }
    await directory.setDefaultAccessPolicy!({ disableAllAccessChecksAndPolicies: false }, adminKey, PASSWORD);
    await directory.setDatabaseAccessPolicy!(MAILDB, { denyDocRead: true }, adminKey, PASSWORD);
    await directory.createAccessRule!(
      { ruleId: "jane_reads_her_mail", type: "doc_read", dbid: MAILDB, action: "allow", usernames: [janeUser.username] },
      adminKey,
      PASSWORD,
    );
    await directory.createAccessRule!(
      { ruleId: "gateway_deposits_mail", type: "doc_deposit", dbid: "mailbox_*", action: "allow", usernames: [gatewayName], maxRecipients: 1 },
      adminKey,
      PASSWORD,
    );
    await pushDirectory();
    for (const tenant of [gateway.tenant, jane]) {
      await pull(tenant, "directory");
      await pull(tenant, USER_DIRECTORY_DB_ID);
    }
    return base;
  }

  async function depositFor(db: MindooDB, recipient: string, extra: Record<string, unknown> = {}, idPrefix = "memo") {
    return db.createDocument({
      idPrefix,
      recipients: [recipient],
      recipientOptions: { includeSelf: false, strict: true },
      initialValues: { type: "message", subject: "Hello Jane", ...extra },
      attachments: [{ data: new TextEncoder().encode("PDF bytes"), fileName: "invoice.pdf", mimeType: "application/pdf" }],
    });
  }

  test("the gateway deposits a sealed document with an attachment; Jane reads it, the gateway cannot read back", async () => {
    const t = await setup();
    const gatewayDb = await openDb(t.gateway.tenant, MAILDB);
    const doc = await depositFor(gatewayDb, t.janeUser.username);
    const pushed = await push(t.gateway.tenant, MAILDB);
    expect(pushed.docs.rejectedEntries ?? []).toHaveLength(0);
    expect(pushed.attachments.rejectedEntries ?? []).toHaveLength(0);
    expect(pushed.docs.transferredEntries).toBe(1);

    // Pull, list and fetch are refused for the depositor.
    const gatewayRemote = await t.gateway.tenant.connectToServer(baseUrl, MAILDB, StoreKind.docs);
    await expect(gatewayRemote.findNewEntries([])).rejects.toThrow(DENIED);
    await expect(gatewayRemote.getAllIds()).rejects.toThrow(DENIED);
    await expect(gatewayRemote.getEntries([doc.getId()])).rejects.toThrow(DENIED);
    const gatewayAttachments = await t.gateway.tenant.connectToServer(baseUrl, MAILDB, StoreKind.attachments);
    await expect(gatewayAttachments.findNewEntries([])).rejects.toThrow(DENIED);
    // A full pull fails cleanly: no prefetched page left behind as an unhandled rejection.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(gatewayDb.pullChangesFrom(gatewayRemote)).rejects.toThrow(DENIED);
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);

    // Jane reads the document and its attachment.
    const janeDb = await pull(t.jane, MAILDB, true);
    const received = await janeDb.getDocument(doc.getId());
    expect(received.getData().subject).toBe("Hello Jane");
    expect(received.isSealed()).toBe(true);
    const [attachment] = received.getAttachments();
    expect(attachment?.fileName).toBe("invoice.pdf");
    expect(new TextDecoder().decode(await received.getAttachment(attachment!.attachmentId))).toBe("PDF bytes");

    // Another member without any rule cannot even open it.
    const other = await joinPublicInfosOnly(t.karsten, t.admin, t.tenantId, `cn=someone/o=${t.tenantId}`, t.pushDirectory);
    await expect(pull(other.tenant, MAILDB)).rejects.toThrow(/does not have read access/);
  });

  test("only sealed creates within the recipient bound pass; changes, other keys and too many readers are refused", async () => {
    const t = await setup();
    const gatewayDb = await openDb(t.gateway.tenant, MAILDB);

    // Change of its own deposit (possible locally right after the create).
    const doc = await depositFor(gatewayDb, t.janeUser.username);
    await gatewayDb.changeDoc(doc, (d) => {
      d.getData().subject = "rewritten";
    });
    // Not sealed: the gateway's only shared key.
    await gatewayDb.createDocument({ decryptionKeyId: PUBLIC_INFOS_KEY_ID, initialValues: { subject: "plain" } });
    // Two readers, the rule allows one.
    const karstenName = (await t.karsten.getCurrentUserId()).username;
    await gatewayDb.createDocument({
      recipients: [t.janeUser.username, karstenName],
      recipientOptions: { includeSelf: false },
      initialValues: { subject: "two readers" },
    });

    const pushed = await push(t.gateway.tenant, MAILDB);
    const reasons = (pushed.docs.rejectedEntries ?? []).map((r) => `${r.rejectionClass}: ${r.reason}`);
    expect(reasons).toHaveLength(3);
    expect(reasons.every((r) => r.startsWith("policy: "))).toBe(true);
    expect(reasons.some((r) => /not push doc_change/.test(r))).toBe(true);
    expect(reasons.some((r) => /sealed with their own key/.test(r))).toBe(true);
    expect(reasons.some((r) => /1 to 1 recipient wraps \(has 2\)/.test(r))).toBe(true);

    const janeDb = await pull(t.jane, MAILDB);
    const ids = await janeDb.getAllDocumentIds();
    expect(ids).toEqual([doc.getId()]);
    expect((await janeDb.getDocument(doc.getId())).getData().subject).toBe("Hello Jane");
  });

  test("a second deposit of the same document id is answered as exists", async () => {
    const t = await setup();
    const id = "memo_gwdeadbeef";
    const first = await openDb(t.gateway.tenant, MAILDB);
    await first.createDocument({ id, assumeUniqueId: true, recipients: [t.janeUser.username], recipientOptions: { includeSelf: false }, initialValues: { n: 1 } });
    expect((await push(t.gateway.tenant, MAILDB)).docs.rejectedEntries ?? []).toHaveLength(0);

    // Same id from a device that lost its local copy.
    const again = await joinPublicInfosOnly(t.karsten, t.admin, t.tenantId, `cn=mail-gateway-3/o=${t.tenantId}`, t.pushDirectory);
    await t.directory.createAccessRule!(
      { ruleId: "gateway3_deposits", type: "doc_deposit", dbid: "mailbox_*", action: "allow", usernames: [`cn=mail-gateway-3/o=${t.tenantId}`] },
      t.adminKey,
      PASSWORD,
    );
    await t.pushDirectory();
    await pull(again.tenant, "directory");
    const second = await openDb(again.tenant, MAILDB);
    await second.createDocument({ id, assumeUniqueId: true, recipients: [t.janeUser.username], recipientOptions: { includeSelf: false }, initialValues: { n: 2 } });
    const pushed = await push(again.tenant, MAILDB);
    expect((pushed.docs.rejectedEntries ?? []).map((r) => r.rejectionClass)).toEqual(["exists"]);

    const janeDb = await pull(t.jane, MAILDB);
    expect((await janeDb.getDocument(id)).getData().n).toBe(1);
  });

  test("without a deposit rule the database stays closed, and readers are unaffected", async () => {
    const t = await setup();
    // Karsten has neither doc_read on mmail_jane nor doc_deposit.
    await pull(t.karsten, "directory");
    await expect(openDb(t.karsten, MAILDB).then((db) => db.createDocument({ initialValues: { x: 1 } }))).rejects.toThrow(
      /read access/i,
    );
    // Jane writes and syncs her own mail database normally.
    const janeDb = await openDb(t.jane, MAILDB);
    const own = await janeDb.createDocument({ recipients: [], initialValues: { subject: "draft" } });
    await janeDb.changeDoc(own, (d) => {
      d.getData().subject = "draft, edited";
    });
    expect((await push(t.jane, MAILDB)).docs.rejectedEntries ?? []).toHaveLength(0);
  });

  test("a document sealed to someone else lands as inaccessible, without errors", async () => {
    const t = await setup();
    const gatewayDb = await openDb(t.gateway.tenant, MAILDB);
    const karstenName = (await t.karsten.getCurrentUserId()).username;
    const wrongReader = await depositFor(gatewayDb, karstenName);
    const right = await depositFor(gatewayDb, t.janeUser.username, { subject: "for Jane" });
    expect((await push(t.gateway.tenant, MAILDB)).docs.rejectedEntries ?? []).toHaveLength(0);

    const janeDb = await pull(t.jane, MAILDB);
    expect(await janeDb.getAllDocumentIds()).toEqual([right.getId()]);
    const hidden = (await janeDb.listInaccessibleDocuments!()).map((row) => row.docId);
    expect(hidden).toContain(wrongReader.getId());
  });

  test("a deposit rule with docIdPrefixes takes only those ids (a proposal box)", async () => {
    const t = await setup();
    await t.directory.setDatabaseAccessPolicy!("proposals", { denyDocRead: true }, t.adminKey, PASSWORD);
    await t.directory.createAccessRule!(
      {
        ruleId: "gateway_proposes",
        type: "doc_deposit",
        dbid: "proposals",
        action: "allow",
        usernames: [t.gatewayName],
        maxRecipients: 1,
        docIdPrefixes: ["proposal_"],
      },
      t.adminKey,
      PASSWORD,
    );
    await t.pushDirectory();
    await pull(t.gateway.tenant, "directory");
    const box = await openDb(t.gateway.tenant, "proposals");
    const ok = await depositFor(box, t.janeUser.username, { type: "proposal" }, "proposal");
    await depositFor(box, t.janeUser.username, { type: "other" }, "other");
    const rejected = (await push(t.gateway.tenant, "proposals")).docs.rejectedEntries ?? [];
    expect(rejected.length).toBeGreaterThan(0);
    for (const r of rejected) expect(r.reason).toMatch(/must start with "proposal_"/);
    expect(rejected.some((r) => r.id.startsWith(ok.getId()))).toBe(false);
  });

  test("docIdPrefixes is validated and only allowed on doc_deposit rules", () => {
    expect(() =>
      validateAclRule({ type: "doc_read", dbid: "x", action: "allow", users_hashes: ["h"], docIdPrefixes: ["a_"] }),
    ).toThrow(/only valid on doc_deposit/);
    expect(() =>
      validateAclRule({ type: "doc_deposit", dbid: "x", action: "allow", users_hashes: ["h"], docIdPrefixes: ["bad prefix"] }),
    ).toThrow(/not a valid document-id prefix/);
    expect(docIdMatchesPrefixes("proposal_1", ["proposal_"])).toBe(true);
    expect(docIdMatchesPrefixes("other_1", ["proposal_"])).toBe(false);
    expect(docIdMatchesPrefixes("other_1", [])).toBe(true);
  });

  describe("built-in personal databases (mmail_<grantDocId>, §6.11), no configured policy", () => {
    test("the owner reads, a flagged gateway deposits, everyone else is out", async () => {
      const t = await setup({ acl: false, gatewayDepositPrefixes: ["mmail_"] });
      const gatewayDb = await openDb(t.gateway.tenant, t.janeMail);
      const doc = await depositFor(gatewayDb, t.janeUser.username);
      const pushed = await push(t.gateway.tenant, t.janeMail);
      expect(pushed.docs.rejectedEntries ?? []).toHaveLength(0);
      expect(pushed.attachments.rejectedEntries ?? []).toHaveLength(0);
      await expect(gatewayDb.pullChangesFrom(await t.gateway.tenant.connectToServer(baseUrl, t.janeMail, StoreKind.docs))).rejects.toThrow(DENIED);

      const janeDb = await pull(t.jane, t.janeMail, true);
      const received = await janeDb.getDocument(doc.getId());
      expect(received.getData().subject).toBe("Hello Jane");
      expect(received.getAttachments()).toHaveLength(1);

      // Karsten: a member with the tenant key, but not Jane.
      await expect(openDb(t.karsten, t.janeMail)).rejects.toThrow(/read access/);
      const karstenRemote = await t.karsten.connectToServer(baseUrl, t.janeMail, StoreKind.docs);
      await expect(karstenRemote.findNewEntries([])).rejects.toThrow(DENIED);
      // His own mailbox works as before.
      const own = await openDb(t.karsten, t.karstenMail);
      await own.createDocument({ recipients: [], initialValues: { subject: "mine" } });
      expect((await push(t.karsten, t.karstenMail)).docs.rejectedEntries ?? []).toHaveLength(0);
    });

    test("deposits into a mailbox must be messages (memo_ ids); the grant can change that", async () => {
      const t = await setup({ acl: false, gatewayDepositPrefixes: ["mmail_"] });
      const gatewayDb = await openDb(t.gateway.tenant, t.janeMail);
      // An "event" or a folder of Jane's cannot be planted by a depositor.
      await depositFor(gatewayDb, t.janeUser.username, { type: "event" }, "event");
      const refused = (await push(t.gateway.tenant, t.janeMail)).docs.rejectedEntries ?? [];
      expect(refused.length).toBeGreaterThan(0);
      expect(refused.map((r) => r.reason).join(" ")).toMatch(/must start with "memo_"/);

      // The admin allows another prefix on the gateway's grant.
      await t.directory.setGrantPersonalDatabaseRights!(t.gatewayName, { depositDocIdPrefixes: { mmail_: ["note_"] } }, t.adminKey, PASSWORD);
      await t.pushDirectory();
      const fresh = await openDb(t.gateway.tenant, t.janeMail);
      const note = await depositFor(fresh, t.janeUser.username, {}, "note");
      const pushed = (await push(t.gateway.tenant, t.janeMail)).docs.rejectedEntries ?? [];
      // Only the earlier event is still refused (now against "note_").
      expect(pushed.some((r) => r.id.startsWith(note.getId()))).toBe(false);
      expect(pushed.every((r) => r.id.startsWith("event_"))).toBe(true);
    });

    test("without depositPrefixes on its grant the gateway may not deposit", async () => {
      const t = await setup({ acl: false });
      await expect(openDb(t.gateway.tenant, t.janeMail)).rejects.toThrow(/read access/);
      const remote = await t.gateway.tenant.connectToServer(baseUrl, t.janeMail, StoreKind.docs);
      await expect(remote.hasEntries(["x"])).rejects.toThrow(DENIED);
    });

    test("a configured policy can tighten the rule but not loosen it", async () => {
      const t = await setup({ acl: false, gatewayDepositPrefixes: ["mmail_"] });
      await t.directory.setDefaultAccessPolicy!({ disableAllAccessChecksAndPolicies: false, personalDatabasePrefixes: ["notes_"] }, t.adminKey, PASSWORD);
      // Loosen: a doc_read allow for Karsten on Jane's mailbox changes nothing.
      await t.directory.createAccessRule!(
        { ruleId: "karsten_reads_jane", type: "doc_read", dbid: t.janeMail, action: "allow", usernames: [t.karstenUser.username] },
        t.adminKey,
        PASSWORD,
      );
      // Tighten: a doc_deposit deny for the gateway wins over its grant flag.
      await t.directory.createAccessRule!(
        { ruleId: "gateway_stop", type: "doc_deposit", dbid: "mmail_*", action: "deny", usernames: [t.gatewayName] },
        t.adminKey,
        PASSWORD,
      );
      await t.pushDirectory();
      for (const tenant of [t.gateway.tenant, t.karsten, t.jane]) await pull(tenant, "directory");

      const karstenRemote = await t.karsten.connectToServer(baseUrl, t.janeMail, StoreKind.docs);
      await expect(karstenRemote.findNewEntries([])).rejects.toThrow(DENIED);
      const gatewayRemote = await t.gateway.tenant.connectToServer(baseUrl, t.janeMail, StoreKind.docs);
      await expect(gatewayRemote.hasEntries(["x"])).rejects.toThrow(DENIED);
      // An added prefix is personal too: notes_<Jane's grant> is closed to Karsten.
      const janeNotes = t.janeMail.replace(/^mmail_/, "notes_");
      await expect(openDb(t.karsten, janeNotes)).rejects.toThrow(/read access/);
      const janeNotesDb = await openDb(t.jane, janeNotes);
      await janeNotesDb.createDocument({ recipients: [], initialValues: { n: 1 } });
      expect((await push(t.jane, janeNotes)).docs.rejectedEntries ?? []).toHaveLength(0);
    });

    test("an outbox (mmailout_): the owner writes, a service with accessPrefixes reads and answers, others are out", async () => {
      const t = await setup({ acl: false, gatewayDepositPrefixes: ["mmail_"], gatewayAccessPrefixes: ["mmailout_"] });
      const gatewayName = t.gatewayName;
      // Jane puts a message into her outbox, sealed to herself and the gateway.
      const janeOutboxDb = await openDb(t.jane, t.janeOutbox);
      const outgoing = await janeOutboxDb.createDocument({
        recipients: [gatewayName],
        recipientOptions: { strict: true },
        initialValues: { type: "outgoing", subject: "to the world" },
      });
      expect((await push(t.jane, t.janeOutbox)).docs.rejectedEntries ?? []).toHaveLength(0);

      // The gateway reads it and answers with a status document of its own.
      const gatewayDb = await pull(t.gateway.tenant, t.janeOutbox);
      expect((await gatewayDb.getDocument(outgoing.getId())).getData().subject).toBe("to the world");
      const status = await gatewayDb.createDocument({
        recipients: [t.janeUser.username],
        initialValues: { type: "outgoingstatus", outgoingDocId: outgoing.getId(), state: "sending" },
      });
      await gatewayDb.changeDoc(status, (d) => {
        d.getData().state = "sent";
      });
      expect((await push(t.gateway.tenant, t.janeOutbox)).docs.rejectedEntries ?? []).toHaveLength(0);
      const janeView = await pull(t.jane, t.janeOutbox);
      expect((await janeView.getDocument(status.getId())).getData().state).toBe("sent");

      // Karsten cannot open Jane's outbox; the gateway's access is per prefix (not her mailbox).
      await expect(openDb(t.karsten, t.janeOutbox)).rejects.toThrow(/read access/);
      const gatewayMailRemote = await t.gateway.tenant.connectToServer(baseUrl, t.janeMail, StoreKind.docs);
      await expect(gatewayMailRemote.findNewEntries([])).rejects.toThrow(DENIED);
    });
  });

  describe("hard delete in personal databases (purge requests, §6.11)", () => {
    async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 15000): Promise<T | undefined> {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const value = await probe();
        if (value !== undefined) return value;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return undefined;
    }

    async function serverEntriesOf(tenant: MindooTenant, dbId: string, docId: string) {
      const remote = await tenant.connectToServer(baseUrl, dbId, StoreKind.docs);
      return remote.findNewEntriesForDoc([], docId);
    }

    test("the owner purges a sent mail and its status; server and replicas drop them and refuse them back", async () => {
      const t = await setup({ acl: false, gatewayDepositPrefixes: ["mmail_"], gatewayAccessPrefixes: ["mmailout_"] });
      const janeOutboxDb = await openDb(t.jane, t.janeOutbox);
      const outgoing = await janeOutboxDb.createDocument({
        recipients: [t.gatewayName],
        recipientOptions: { strict: true },
        initialValues: { type: "outgoing", subject: "to the world" },
      });
      await push(t.jane, t.janeOutbox);
      const gatewayDb = await pull(t.gateway.tenant, t.janeOutbox);
      const status = await gatewayDb.createDocument({
        recipients: [t.janeUser.username],
        initialValues: { type: "outgoingstatus", outgoingDocId: outgoing.getId(), state: "sent" },
      });
      await push(t.gateway.tenant, t.janeOutbox);

      // Not deleted yet: refused locally and by the server.
      await expect(janeOutboxDb.requestPurgeOfDeletedDocuments([outgoing.getId()])).rejects.toThrow(/not deleted/);

      // Jane deletes her mail, the gateway its status; Jane requests the purge of both.
      await janeOutboxDb.deleteDocument(outgoing.getId());
      await push(t.jane, t.janeOutbox);
      await gatewayDb.deleteDocument(status.getId());
      await push(t.gateway.tenant, t.janeOutbox);
      await pull(t.jane, t.janeOutbox);
      const requestId = await janeOutboxDb.requestPurgeOfDeletedDocuments([outgoing.getId(), status.getId()]);
      expect(requestId.startsWith("purgereq_")).toBe(true);
      expect((await push(t.jane, t.janeOutbox)).docs.rejectedEntries ?? []).toHaveLength(0);

      // The server executes it.
      const gone = await waitFor(async () =>
        (await serverEntriesOf(t.jane, t.janeOutbox, outgoing.getId())).length === 0 &&
        (await serverEntriesOf(t.jane, t.janeOutbox, status.getId())).length === 0
          ? true
          : undefined,
      );
      expect(gone).toBe(true);

      // The gateway still holds the history: a re-push is refused as purged.
      const rePush = await gatewayDb.pushChangesTo(await t.gateway.tenant.connectToServer(baseUrl, t.janeOutbox, StoreKind.docs), {
        forceFullScan: true,
      } as never);
      void rePush;
      expect((await serverEntriesOf(t.jane, t.janeOutbox, status.getId())).length).toBe(0);

      // Replicas purge on their next pull (the request carries the server's receipt).
      await pull(t.gateway.tenant, t.janeOutbox);
      expect(await gatewayDb.getStore().findNewEntriesForDoc([], status.getId())).toEqual([]);
      expect(await gatewayDb.getStore().findNewEntriesForDoc([], outgoing.getId())).toEqual([]);
      await pull(t.jane, t.janeOutbox);
      expect(await janeOutboxDb.getStore().findNewEntriesForDoc([], outgoing.getId())).toEqual([]);
      // The request itself stays (it is what keeps the history out).
      expect(await janeOutboxDb.getAllDocumentIds()).toContain(requestId);
    });

    test("the service with accessPrefixes may purge; requests for live documents, changes and depositors are refused", async () => {
      const t = await setup({ acl: false, gatewayDepositPrefixes: ["mmail_"], gatewayAccessPrefixes: ["mmailout_"] });
      const janeOutboxDb = await openDb(t.jane, t.janeOutbox);
      const live = await janeOutboxDb.createDocument({ recipients: [t.gatewayName], initialValues: { type: "outgoing" } });
      const old = await janeOutboxDb.createDocument({ recipients: [t.gatewayName], initialValues: { type: "outgoing" } });
      await push(t.jane, t.janeOutbox);
      await janeOutboxDb.deleteDocument(old.getId());
      await push(t.jane, t.janeOutbox);

      // The gateway purges a deleted mail (the 30-day sweep).
      const gatewayDb = await pull(t.gateway.tenant, t.janeOutbox);
      await gatewayDb.requestPurgeOfDeletedDocuments([old.getId()]);
      expect((await push(t.gateway.tenant, t.janeOutbox)).docs.rejectedEntries ?? []).toHaveLength(0);
      expect(
        await waitFor(async () => ((await serverEntriesOf(t.jane, t.janeOutbox, old.getId())).length === 0 ? true : undefined)),
      ).toBe(true);

      // A forged request for a live document (bypassing the local check) is refused by the server.
      const forged = await gatewayDb.createDocument({
        idPrefix: "purgereq",
        decryptionKeyId: "$publicinfos",
        initialValues: { form: "purgerequest", docIds: [live.getId()], requestedAt: Date.now() },
      });
      const result = (await push(t.gateway.tenant, t.janeOutbox)).docs;
      expect((result.rejectedEntries ?? []).map((r) => r.reason).join(" ")).toMatch(/is not deleted/);
      expect((await serverEntriesOf(t.jane, t.janeOutbox, live.getId())).length).toBeGreaterThan(0);
      void forged;

      // A depositor (mmail_, deposit only) cannot purge: only sealed creates pass.
      const gatewayMail = await openDb(t.gateway.tenant, t.janeMail);
      await gatewayMail.createDocument({
        idPrefix: "purgereq",
        decryptionKeyId: "$publicinfos",
        initialValues: { form: "purgerequest", docIds: ["x"], requestedAt: Date.now() },
      });
      const depositResult = (await push(t.gateway.tenant, t.janeMail)).docs;
      expect((depositResult.rejectedEntries ?? []).length).toBeGreaterThan(0);
    });
  });
});
