/**
 * Sealed and default-key *fields* in a `$publicinfos` document (the design of
 * the MindooMail gateway configuration, mindoomail-gateway
 * docs/config-and-outbox.md §1.1): one admin-signed document in `directory`
 * that everybody can open, whose secret part is stored twice, as an
 * `_encrypted` field (tenant `default` key, members) and as a sealed value
 * (`tenant.sealValue`, the gateway's User-Key + the writer). Readers without a
 * key see only ciphertext; the document itself and the directory keep working.
 *
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
import { decryptEncryptedField, encryptEncryptedField } from "../core/crypto/encryptedFields";
import { readSealedValue } from "../core/userkeys/sealedValues";

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

describe("sealed and encrypted fields in a $publicinfos directory document (HTTP)", () => {
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

  test("members read the default-key field, the gateway the sealed field, $publicinfos holders neither", async () => {
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
    const secret = JSON.stringify({ gatewayUsername: gatewayName, domains: [DOMAIN], users: [{ username: janeUser.username, addresses: [ADDRESS] }] });
    const signing = { signingKeyPair: admin.userSigningKeyPair, signingKeyPassword: PASSWORD };
    const id = `mmailgwconf_${gatewayGrantId}`;
    const sealed = await karsten.sealValue!(new TextEncoder().encode(secret), [gatewayName], { strict: true, includeSelf: true });
    expect(sealed.to).toHaveLength(2);
    // No names in the sealed value: the server can read the document.
    expect(JSON.stringify(sealed)).not.toMatch(/mail-gateway|karsten/i);
    const karstenDirectory = await openDb(karsten, "directory");
    await karstenDirectory.createDocument({
      id,
      assumeUniqueId: true,
      decryptionKeyId: PUBLIC_INFOS_KEY_ID,
      initialValues: {
        form: "mindoomail",
        type: "gatewayconfig",
        formatVersion: 3,
        revision: 1,
        config_encrypted: await encryptEncryptedField(karsten, secret),
        config_sealed: sealed,
      },
      ...signing,
    });
    await pushDirectory();
    // The writer opens both.
    const own = (await karstenDirectory.getDocument(id)).getData();
    expect(await decryptEncryptedField(karsten, own, "config_encrypted")).toBe(secret);
    expect(new TextDecoder().decode((await karsten.openSealedValue!(readSealedValue(own.config_sealed)!))!)).toBe(secret);

    // Jane (default key): the encrypted field yes, the sealed one no.
    const janeData = (await (await pull(jane, "directory")).getDocument(id)).getData();
    expect(await decryptEncryptedField(jane, janeData, "config_encrypted")).toBe(secret);
    expect(await jane.openSealedValue!(readSealedValue(janeData.config_sealed)!)).toBeNull();

    // The gateway ($publicinfos + its User-Key): the sealed field yes, the encrypted one no.
    const gatewayData = (await (await pull(gateway.tenant, "directory")).getDocument(id)).getData();
    expect(await decryptEncryptedField(gateway.tenant, gatewayData, "config_encrypted")).toBeNull();
    expect(new TextDecoder().decode((await gateway.tenant.openSealedValue!(readSealedValue(gatewayData.config_sealed)!))!)).toBe(secret);

    // A $publicinfos-only member (what the sync server holds) reads the document but neither field.
    const probe = await joinPublicInfosOnly(karsten, admin, tenantId, `cn=probe/o=${tenantId}`, pushDirectory);
    const probeDirectory = await pull(probe.tenant, "directory");
    expect(await probeDirectory.getAllDocumentIds()).toContain(id);
    expect(await probeDirectory.listInaccessibleDocuments!()).toEqual([]);
    const probeData = (await probeDirectory.getDocument(id)).getData();
    expect(JSON.stringify(probeData)).not.toContain(ADDRESS);
    expect(JSON.stringify(probeData)).not.toContain(DOMAIN);
    expect(await decryptEncryptedField(probe.tenant, probeData, "config_encrypted")).toBeNull();
    expect(await probe.tenant.openSealedValue!(readSealedValue(probeData.config_sealed)!)).toBeNull();
    const probeDir = (await probe.tenant.openDirectory()) as MindooTenantDirectory;
    expect(await probeDir.isAccessControlActive!()).toBe(true);

    // Raw server store: neither the address nor the domain in plaintext.
    expect(filesContaining(dataDir, ADDRESS)).toEqual([]);
    expect(filesContaining(dataDir, DOMAIN)).toEqual([]);
  });
});
