/**
 * Delegation of personal databases (docs/accesscontrol.md §6.11, "Delegation")
 * and deposit keys (docs/userkeys.md §6.8) on a real server over HTTP.
 *
 * Jane publishes a `pbox_` record in `userdirectory`; the server lets the
 * delegates it lists sync her mailbox, calendar and contacts with the right
 * it names, and lets a delegate with "send" create sending jobs in her outbox.
 * The mail gateway reads her deposit keys from the same record and seals
 * deliveries to them, so every member of her mailbox group reads them.
 *
 * Setup copied from DocDepositHttp.test.ts:
 *
 * A mail gateway joins the tenant with `$publicinfos` only. The person's mail
 * database is read-gated (`denyDocRead` + a `doc_read` allow for its owner),
 * and the gateway holds a `doc_deposit` allow on `mailbox_*`. The built-in
 * personal databases (`mmail_<grantDocId>`, §6.11) get the same without any
 * configured policy; see the last block. It may push
 * documents sealed to someone else, with attachments in the create entry,
 * but it may not pull, list or change anything there.
 */
import { docIdMatchesPrefixes, effectiveCalendarShareDefault, effectiveCalendarShareMax, effectiveFreeBusyWeeksAhead, validateAclRule } from "../core/accesscontrol/types";
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

describe("delegation of personal databases on a real server (HTTP)", () => {
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
    const janeBusy = `mbusy_${await grantId(janeUser.username)}`;
    const base = { tenantId, admin, karsten, karstenUser, jane, janeUser, gateway, gatewayName, directory, adminKey, pushDirectory, janeMail, karstenMail, janeOutbox, janeBusy };
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


  async function grantOf(t: Awaited<ReturnType<typeof setup>>, username: string): Promise<string> {
    return (await t.directory.findGrantAccessDocuments!(username)).find((doc) => !doc.isDeleted())!.getId();
  }

  async function publish(t: Awaited<ReturnType<typeof setup>>, delegates: Array<{ grant: string; rights: Record<string, "read" | "edit" | "send"> }>, depositKeys?: Record<string, { publicKey: string; fingerprint: string }>) {
    await t.jane.publishPersonalShares!({ delegates, ...(depositKeys ? { depositKeys } : {}) });
    await push(t.jane, USER_DIRECTORY_DB_ID);
    await pull(t.karsten, USER_DIRECTORY_DB_ID);
  }

  const rejectedOf = (result: { docs: { rejectedEntries?: Array<{ reason: string }> } }) =>
    (result.docs.rejectedEntries ?? []).map((r) => r.reason);

  test("read, edit and removal: the server follows Jane's record", async () => {
    const t = await setup({ acl: false });
    const karstenGrant = await grantOf(t, t.karstenUser.username);
    const janeDb = await openDb(t.jane, t.janeMail);
    const mine = await janeDb.createDocument({ recipients: [], initialValues: { subject: "Jane's own" } });
    expect(rejectedOf(await push(t.jane, t.janeMail))).toEqual([]);

    // Without a record Karsten is out.
    const remote = await t.karsten.connectToServer(baseUrl, t.janeMail, StoreKind.docs);
    await expect(remote.findNewEntries([])).rejects.toThrow(DENIED);

    // Read: pull works, pushes are refused.
    await publish(t, [{ grant: karstenGrant, rights: { mmail_: "read" } }]);
    const karstenDirectory = (await t.karsten.openDirectory()) as MindooTenantDirectory;
    expect((await karstenDirectory.listPersonalSharesDelegatedTo!(karstenGrant)).map((r) => r.grant)).toEqual([await grantOf(t, t.janeUser.username)]);
    const karstenDb = await pull(t.karsten, t.janeMail);
    // Sealed to Jane alone: synced, not readable (keys come from the group, not the record).
    expect(await karstenDb.getAllDocumentIds()).not.toContain(mine.getId());
    await karstenDb.createDocument({ recipients: [t.janeUser.username], initialValues: { subject: "from the delegate" } });
    const refused = rejectedOf(await push(t.karsten, t.janeMail));
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.join(" ")).toMatch(/may read .* but not write/);

    // Edit: pushes are accepted.
    await publish(t, [{ grant: karstenGrant, rights: { mmail_: "edit" } }]);
    expect(rejectedOf(await push(t.karsten, t.janeMail))).toEqual([]);

    // Calendar and contacts are separate rights.
    await expect(t.karsten.connectToServer(baseUrl, `mcal_${await grantOf(t, t.janeUser.username)}`, StoreKind.docs).then((r) => r.findNewEntries([]))).rejects.toThrow(DENIED);

    // Removed: out again.
    await publish(t, []);
    await expect(remote.findNewEntries([])).rejects.toThrow(DENIED);
  });

  test("a record that someone else publishes for Jane counts for nothing", async () => {
    const t = await setup({ acl: false });
    const janeGrant = await grantOf(t, t.janeUser.username);
    const karstenGrant = await grantOf(t, t.karstenUser.username);
    // Karsten writes a record naming Jane's grant and himself as delegate.
    const userdir = await openDb(t.karsten, USER_DIRECTORY_DB_ID);
    await userdir.createDocument({
      idPrefix: "pbox",
      decryptionKeyId: PUBLIC_INFOS_KEY_ID,
      initialValues: {
        form: "personalshares",
        grant: janeGrant,
        revision: 99,
        depositKeys: {},
        delegates: [{ grant: karstenGrant, rights: { mmail_: "edit" } }],
        writtenAt: Date.now(),
      },
    });
    await push(t.karsten, USER_DIRECTORY_DB_ID);
    expect(await t.directory.getPersonalShares!(janeGrant)).toBeNull();
    const remote = await t.karsten.connectToServer(baseUrl, t.janeMail, StoreKind.docs);
    await expect(remote.findNewEntries([])).rejects.toThrow(DENIED);
  });

  test("send on behalf: only sending jobs in the outbox, nothing else", async () => {
    const t = await setup({ acl: false });
    const karstenGrant = await grantOf(t, t.karstenUser.username);
    await publish(t, [{ grant: karstenGrant, rights: { mmailout_: "send" } }]);
    const outbox = await pull(t.karsten, t.janeOutbox);
    await outbox.createDocument({ idPrefix: "mout", recipients: [t.janeUser.username], initialValues: { type: "outgoing", subject: "for Jane" } });
    expect(rejectedOf(await push(t.karsten, t.janeOutbox))).toEqual([]);
    await outbox.createDocument({ idPrefix: "mauto", recipients: [t.janeUser.username], initialValues: { type: "autoreply" } });
    const refused = rejectedOf(await push(t.karsten, t.janeOutbox));
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.join(" ")).toMatch(/may only write mout_ documents/);
    // The send right is not a mailbox right.
    const remote = await t.karsten.connectToServer(baseUrl, t.janeMail, StoreKind.docs);
    await expect(remote.findNewEntries([])).rejects.toThrow(DENIED);
  });

  test('mailDelegation "off" ignores the records', async () => {
    const t = await setup({ acl: false });
    const karstenGrant = await grantOf(t, t.karstenUser.username);
    await publish(t, [{ grant: karstenGrant, rights: { mmail_: "read" } }]);
    await t.directory.setDefaultAccessPolicy!({ disableAllAccessChecksAndPolicies: true, mailDelegation: "off" }, t.adminKey, PASSWORD);
    await t.pushDirectory();
    const remote = await t.karsten.connectToServer(baseUrl, t.janeMail, StoreKind.docs);
    await expect(remote.findNewEntries([])).rejects.toThrow(DENIED);
  });

  test("calendar (mcal_) takes invitation requests, contacts (mcon_) no deposits", async () => {
    const t = await setup({ acl: false, gatewayDepositPrefixes: ["mmail_", "mcal_", "mcon_"] });
    const janeGrant = await grantOf(t, t.janeUser.username);
    const janeCal = `mcal_${janeGrant}`;
    const janeCon = `mcon_${janeGrant}`;
    const gatewayCal = await openDb(t.gateway.tenant, janeCal);
    const invitation = await depositFor(gatewayCal, t.janeUser.username, { type: "invitation" }, "cinv");
    await depositFor(gatewayCal, t.janeUser.username, { type: "event" }, "event");
    const calRefused = (await push(t.gateway.tenant, janeCal)).docs.rejectedEntries ?? [];
    expect(calRefused.every((r) => r.id.startsWith("event_"))).toBe(true);
    expect(calRefused.map((r) => r.reason).join(" ")).toMatch(/must start with "cinv_"/);
    const janeCalDb = await pull(t.jane, janeCal);
    expect(await janeCalDb.getAllDocumentIds()).toEqual([invitation.getId()]);

    // A member's internal invitation lands in the calendar too, only as a request.
    const karstenCal = await openDb(t.karsten, janeCal);
    await karstenCal.createDocument({ idPrefix: "cinv", recipients: [t.janeUser.username], recipientOptions: { includeSelf: false, strict: true }, initialValues: { type: "invitation" } });
    expect(rejectedOf(await push(t.karsten, janeCal))).toEqual([]);

    // Contacts: the gateway's deposit right is the admin's choice; members never deposit.
    const karstenCon = await openDb(t.karsten, janeCon).catch((error: unknown) => error);
    expect(String(karstenCon)).toMatch(/read access/);
  });

  test("deposit keys: the gateway seals to Jane's published key, her delegate reads the delivery", async () => {
    const t = await setup({ acl: false, gatewayDepositPrefixes: ["mmail_"] });
    const janeGrant = await grantOf(t, t.janeUser.username);
    const karstenGrant = await grantOf(t, t.karstenUser.username);
    // Jane: mailbox group with Karsten, a deposit key, the record.
    const janeDb = await openDb(t.jane, t.janeMail);
    const group = await janeDb.createDocument({ recipients: [t.karstenUser.username], initialValues: { name: "Mailbox" } });
    const key = await janeDb.createDepositKey!(group.getId());
    expect(rejectedOf(await push(t.jane, t.janeMail))).toEqual([]);
    await publish(t, [{ grant: karstenGrant, rights: { mmail_: "read" } }], { mmail_: { publicKey: key.publicKeyPem, fingerprint: key.fingerprint } });

    // The gateway finds the key in the record ($publicinfos) and delivers.
    await pull(t.gateway.tenant, USER_DIRECTORY_DB_ID);
    const gatewayDirectory = (await t.gateway.tenant.openDirectory()) as MindooTenantDirectory;
    const record = await gatewayDirectory.getPersonalShares!(janeGrant);
    expect(record?.depositKeys.mmail_?.fingerprint).toBe(key.fingerprint);
    const gatewayDb = await openDb(t.gateway.tenant, t.janeMail);
    const memo = await gatewayDb.createDocument({
      idPrefix: "memo",
      recipients: [{ devicePem: record!.depositKeys.mmail_!.publicKey, label: "mailbox" }],
      recipientOptions: { includeSelf: false },
      initialValues: { type: "message", subject: "for the mailbox" },
    });
    expect(rejectedOf(await push(t.gateway.tenant, t.janeMail))).toEqual([]);

    // Jane and her delegate read it; the gateway and the server cannot.
    const janeView = await pull(t.jane, t.janeMail);
    expect((await janeView.getDocument(memo.getId())).getData().subject).toBe("for the mailbox");
    const karstenView = await pull(t.karsten, t.janeMail);
    expect((await karstenView.getDocument(memo.getId())).getData().subject).toBe("for the mailbox");
    const serverFiles = fs.readdirSync(dataDir, { recursive: true }) as string[];
    for (const file of serverFiles) {
      const full = `${dataDir}/${file}`;
      if (fs.statSync(full).isFile()) expect(fs.readFileSync(full).includes("for the mailbox")).toBe(false);
    }
  });
});
