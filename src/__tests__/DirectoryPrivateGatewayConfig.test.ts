/**
 * Gateway configuration without plaintext for the sync server
 * (mindoomail-gateway docs/config-and-outbox.md §1.1), on a real server over
 * HTTP with access control on.
 *
 * The tenant admin writes two copies of the configuration into `directory`:
 * `mmailgwcfg_<grant>` encrypted with the tenant `default` key (members) and
 * `mmailgwseal_<grant>` sealed to the gateway's user key plus the writer
 * (gateway). The `directory` invariant is about the signer (the admin key),
 * not the encryption key, so the server must accept both; identities without
 * the key (the gateway for the member copy, a `$publicinfos`-only member for
 * both) must skip them cleanly while the directory keeps working. The legacy
 * `$publicinfos` copy `mmailgw_<grant>` is deleted and purged.
 */
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
  type MindooTenant,
  type MindooTenantDirectory,
  type PrivateUserId,
} from "../core/types";
import type { ServerConfig } from "../server/types";

const PASSWORD = "member-pass";
const SYSTEM_ADMIN_PASSWORD = "sysadmin-pass";
const SERVER_PASSWORD = "server-privcfg-pass";
const ADDRESS = "jane.secret@mail.privcfg.example";
const DOMAIN = "mail.privcfg.example";

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

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const bytes = Buffer.from(needle, "utf-8");
  const walk = (path: string) => {
    for (const name of fs.readdirSync(path)) {
      const full = `${path}/${name}`;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (fs.readFileSync(full).includes(bytes)) hits.push(full);
    }
  };
  walk(dir);
  return hits;
}

describe("private gateway configuration in directory (HTTP)", () => {
  jest.setTimeout(240000);
  const crypto = new NodeCryptoAdapter();
  let httpServer: Server;
  let baseUrl: string;
  let dataDir: string;
  let systemAdmin: PrivateUserId;

  beforeAll(async () => {
    const factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    dataDir = `/tmp/mindoodb-privcfg-http-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    fs.mkdirSync(dataDir, { recursive: true });
    const serverIdentity = await factory.createUserId("CN=privcfg-http-server", SERVER_PASSWORD);
    fs.writeFileSync(`${dataDir}/server.identity.json`, JSON.stringify(serverIdentity, null, 2), "utf-8");
    fs.writeFileSync(`${dataDir}/trusted-servers.json`, "[]", "utf-8");
    systemAdmin = await factory.createUserId("cn=sysadmin/o=privcfg-http", SYSTEM_ADMIN_PASSWORD);
    const config: ServerConfig = {
      capabilities: {
        "ALL:/system/*": [{ username: systemAdmin.username, publicsignkey: systemAdmin.userSigningKeyPair.publicKey as string }],
      },
    };
    ({ httpServer, baseUrl } = await startServer(new MindooDBServer(dataDir, SERVER_PASSWORD, undefined, config)));
  }, 60000);

  afterAll(async () => {
    if (httpServer) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    if (dataDir && fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const openDb = (tenant: MindooTenant, dbId: string) =>
    tenant.openDB(dbId, dbId === "directory" ? { adminOnlyDb: true } : undefined);

  async function pull(tenant: MindooTenant, dbId: string) {
    const local = await openDb(tenant, dbId);
    await local.pullChangesFrom(await tenant.connectToServer(baseUrl, dbId, StoreKind.docs));
    await local.syncStoreChanges();
    return local;
  }

  async function push(tenant: MindooTenant, dbId: string, auth?: { user: PrivateUserId; password: string }) {
    const local = await openDb(tenant, dbId);
    return local.pushChangesTo(
      await tenant.connectToServer(baseUrl, dbId, StoreKind.docs),
      auth ? { networkAuthOverride: auth } : undefined,
    );
  }

  /** A device that joined with `$publicinfos` only (like the mail gateway or the sync server). */
  async function joinPublicInfosOnly(
    founder: MindooTenant,
    admin: PrivateUserId,
    tenantId: string,
    name: string,
    pushDirectory: () => Promise<void>,
    grant: { depositPrefixes?: string[]; accessPrefixes?: string[] } = {},
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
      ...grant,
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
    await push(tenant, USER_DIRECTORY_DB_ID);
    return { tenant, user: joined.user };
  }

  test("admin writes a default-key copy and a sealed copy; readers without the key skip them; the legacy copy is purged", async () => {
    const tenantId = `privcfg-${Date.now().toString(16)}`;
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
      adminSigningKey: admin.userSigningKeyPair.privateKey,
      adminPassword: PASSWORD,
    });
    const adminAuth = { user: admin, password: PASSWORD };
    const pushDirectory = async () => {
      const result = await push(karsten, "directory", adminAuth);
      expect(result.rejectedEntries ?? []).toEqual([]);
      await push(karsten, USER_DIRECTORY_DB_ID);
    };
    await pushDirectory();
    // Jane: a member with the tenant default key.
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
    // The gateway: $publicinfos only, deposit/access prefixes as in production.
    const gatewayName = `cn=mail-gateway/o=${tenantId}`;
    const gateway = await joinPublicInfosOnly(karsten, admin, tenantId, gatewayName, pushDirectory, {
      depositPrefixes: ["mmail_"],
      accessPrefixes: ["mmailout_"],
    });
    expect(await gateway.tenant.hasDecryptionKey!(DEFAULT_TENANT_KEY_ID)).toBe(false);
    // Access control on, as in a production tenant.
    const directory = (await karsten.openDirectory()) as MindooTenantDirectory;
    await directory.setDefaultAccessPolicy!({ disableAllAccessChecksAndPolicies: false }, admin.userSigningKeyPair.privateKey, PASSWORD);
    await pushDirectory();
    await pull(karsten, USER_DIRECTORY_DB_ID);

    const gatewayGrantId = (await directory.findGrantAccessDocuments!(gatewayName)).find((doc) => !doc.isDeleted())!.getId();
    const fields = {
      form: "mindoomail",
      type: "gatewayconfig",
      gatewayUsername: gatewayName,
      domains: [DOMAIN],
      users: [{ username: janeUser.username, addresses: [ADDRESS] }],
    };
    const signing = { signingKeyPair: admin.userSigningKeyPair, signingKeyPassword: PASSWORD };
    const legacyId = `mmailgw_${gatewayGrantId}`;
    const cfgId = `mmailgwcfg_${gatewayGrantId}`;
    const sealId = `mmailgwseal_${gatewayGrantId}`;
    // Legacy copy ($publicinfos), as the gateway E2E wrote it so far.
    const karstenDirectory = await openDb(karsten, "directory");
    await karstenDirectory.createDocument({ id: legacyId, assumeUniqueId: true, decryptionKeyId: PUBLIC_INFOS_KEY_ID, initialValues: fields, ...signing });
    await pushDirectory();
    // A $publicinfos-only member (what the sync server holds) reads the legacy copy: the leak §1.1 removes.
    const probe = await joinPublicInfosOnly(karsten, admin, tenantId, `cn=probe/o=${tenantId}`, pushDirectory);
    const probeBefore = await pull(probe.tenant, "directory");
    expect((await probeBefore.getDocument(legacyId)).getData().users).toEqual(fields.users);
    // Format 2: member copy (default key) and gateway copy (sealed), both admin-signed.
    const v2 = { ...fields, formatVersion: 2, revision: 1, contentHash: "test-hash" };
    await karstenDirectory.createDocument({ id: cfgId, assumeUniqueId: true, decryptionKeyId: DEFAULT_TENANT_KEY_ID, initialValues: v2, ...signing });
    const sealed = await karstenDirectory.createDocument({
      id: sealId,
      assumeUniqueId: true,
      recipients: [gatewayName],
      recipientOptions: { strict: true, includeSelf: true },
      initialValues: v2,
      ...signing,
    });
    expect(sealed.isSealed()).toBe(true);
    // The server accepts both (pushDirectory asserts no rejected entries).
    await pushDirectory();

    // The writer (admin's own device, includeSelf) reads both back.
    expect((await karstenDirectory.getDocument(cfgId)).getData().revision).toBe(1);
    expect((await karstenDirectory.getDocument(sealId)).getData().revision).toBe(1);
    // Jane (default key): member copy yes, sealed copy skipped.
    const janeDirectory = await pull(jane, "directory");
    expect((await janeDirectory.getDocument(cfgId)).getData().users).toEqual(fields.users);
    expect(await janeDirectory.getAllDocumentIds()).not.toContain(sealId);
    expect((await janeDirectory.listInaccessibleDocuments!()).map((d) => d.docId)).toEqual([sealId]);
    // Gateway ($publicinfos + its user key): sealed copy yes, member copy skipped.
    const gatewayDirectory = await pull(gateway.tenant, "directory");
    const gatewayIds = await gatewayDirectory.getAllDocumentIds();
    expect(gatewayIds).toContain(sealId);
    expect(gatewayIds).not.toContain(cfgId);
    expect((await gatewayDirectory.getDocument(sealId)).getData().users).toEqual(fields.users);
    expect((await gatewayDirectory.listInaccessibleDocuments!()).map((d) => d.docId)).toEqual([cfgId]);
    // Id prefixes match on the `_` boundary: the legacy prefix does not list the new ids.
    expect(await gatewayDirectory.getAllDocumentIds({ idPrefix: "mmailgw" })).toEqual([legacyId]);
    expect(await gatewayDirectory.getAllDocumentIds({ idPrefix: "mmailgwseal_" })).toEqual([sealId]);
    // A $publicinfos-only member reads neither new copy; its directory still works.
    const probeDirectory = await pull(probe.tenant, "directory");
    expect(await probeDirectory.getAllDocumentIds({ idPrefix: "mmailgwcfg_" })).toEqual([]);
    expect(await probeDirectory.getAllDocumentIds({ idPrefix: "mmailgwseal_" })).toEqual([]);
    expect((await probeDirectory.listInaccessibleDocuments!()).map((d) => d.docId).sort()).toEqual([cfgId, sealId].sort());
    const probeDir = (await probe.tenant.openDirectory()) as MindooTenantDirectory;
    expect((await probeDir.findGrantAccessDocuments!(janeUser.username)).length).toBeGreaterThan(0);
    expect(await probeDir.isUserRevoked(janeUser.username)).toBe(false);
    const gatewayDir = (await gateway.tenant.openDirectory()) as MindooTenantDirectory;
    expect((await gatewayDir.findGrantAccessDocuments!(janeUser.username)).length).toBeGreaterThan(0);
    // Migration: delete and purge the legacy copy.
    await karstenDirectory.deleteDocument(legacyId, signing);
    await pushDirectory();
    await directory.publishDocHistoryPurge!(
      { v: 1, tenantId, requestId: `privcfg-${Date.now()}`, dbId: "directory", docIds: [legacyId], preparedByPublicKey: "" },
      admin.userSigningKeyPair.privateKey,
      PASSWORD,
    );
    await pushDirectory();
    const remoteDirectory = await karsten.connectToServer(baseUrl, "directory", StoreKind.docs);
    const gone = await waitFor(async () => (await remoteDirectory.findNewEntries([])).every((e) => e.docId !== legacyId));
    expect(gone).toBe(true);
    // The new copies are still there.
    const left = new Set((await remoteDirectory.findNewEntries([])).map((e) => e.docId));
    expect(left.has(cfgId) && left.has(sealId)).toBe(true);
    // A fresh $publicinfos-only member after the migration: no address, no domain
    // readable. The join itself proves the server's directory state still works.
    const fresh = await joinPublicInfosOnly(karsten, admin, tenantId, `cn=fresh/o=${tenantId}`, pushDirectory);
    const freshDirectory = await pull(fresh.tenant, "directory");
    for (const id of await freshDirectory.getAllDocumentIds()) {
      const json = JSON.stringify((await freshDirectory.getDocument(id)).getData());
      expect(json).not.toContain(ADDRESS);
      expect(json).not.toContain(DOMAIN);
    }
    expect((await freshDirectory.listInaccessibleDocuments!()).map((d) => d.docId).sort()).toEqual([cfgId, sealId].sort());
    // Raw server store: the address never appears in plaintext.
    expect(filesContaining(dataDir, ADDRESS)).toEqual([]);
  });
});
