/**
 * End-to-end: the Cloudflare host under `wrangler dev` (local Miniflare, no
 * deployment) with real MindooDB clients.
 *
 * Two tenants are published through `/system/tenants`; tenant A syncs two
 * databases (each served by its own Durable Object) between two devices,
 * tenant B stays separate, and an SSE subscriber on the directory object
 * sees a write to another database.
 *
 * Opt-in because it needs wrangler/workerd:
 *   MINDOODB_CLOUDFLARE_TESTS=1 WRANGLER_BIN=/path/to/wrangler pnpm test CloudflareWorker
 */

import { IsolatedInMemoryStoreFactory } from "./_helpers/multiDevice";
import { findWrangler, startCloudflareWorker, type RunningWorker } from "./_helpers/cloudflareWorker";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { decryptPrivateKey } from "../core/crypto/privateKeyEncryption";
import { MindooDBServerAdmin } from "../core/MindooDBServerAdmin";
import { StoreKind, type EncryptedPrivateKey, type MindooTenant, type PrivateUserId } from "../core/types";

const enabled = process.env.MINDOODB_CLOUDFLARE_TESTS === "1" && findWrangler() !== null;
const describeWorker = enabled ? describe : describe.skip;

const SERVER_PASSWORD = "cf-server-pass";
const SYSADMIN_PASSWORD = "cf-sysadmin-pass";
const PASSWORD = "cf-user-pass";

async function push(tenant: MindooTenant, baseUrl: string, dbId: string, auth?: { user: PrivateUserId; password: string }) {
  const local = await tenant.openDB(dbId, dbId === "directory" ? { adminOnlyDb: true } : undefined);
  const remote = await tenant.connectToServer(baseUrl, dbId);
  const result = await local.pushChangesTo(remote, auth ? { networkAuthOverride: auth } : undefined);
  expect(result.cancelled).toBe(false);
}

async function pull(tenant: MindooTenant, baseUrl: string, dbId: string) {
  const local = await tenant.openDB(dbId, dbId === "directory" ? { adminOnlyDb: true } : undefined);
  const remote = await tenant.connectToServer(baseUrl, dbId);
  await local.pullChangesFrom(remote);
  await local.syncStoreChanges();
  return local;
}

async function titles(tenant: MindooTenant, dbId: string): Promise<string[]> {
  const db = await tenant.openDB(dbId);
  const result: string[] = [];
  for (const id of await db.getAllDocumentIds()) {
    result.push(String((await db.getDocument(id)).getData().title));
  }
  return result.sort();
}

async function addDoc(tenant: MindooTenant, dbId: string, title: string) {
  const db = await tenant.openDB(dbId);
  const doc = await db.createDocument();
  await db.changeDoc(doc, async (d) => {
    d.getData().title = title;
  });
}

/** Sync token for `user` from the tenant's auth endpoints (raw HTTP). */
async function tokenFor(baseUrl: string, tenantId: string, user: PrivateUserId, password: string): Promise<string> {
  const crypto = new NodeCryptoAdapter();
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${baseUrl}/${tenantId}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
  };
  const { challenge } = await post("/auth/challenge", {
    signingPublicKey: user.userSigningKeyPair.publicKey,
  });
  const keyBytes = await decryptPrivateKey(
    crypto,
    user.userSigningKeyPair.privateKey as EncryptedPrivateKey,
    password,
    "signing",
  );
  const subtle = crypto.getSubtle();
  const key = await subtle.importKey("pkcs8", keyBytes, { name: "Ed25519" }, false, ["sign"]);
  const signature = Buffer.from(
    await subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(challenge)),
  ).toString("base64");
  const { token } = await post("/auth/authenticate", { challenge, signature });
  return token;
}

describeWorker("MindooDB server on Cloudflare (wrangler dev)", () => {
  jest.setTimeout(300_000);

  const crypto = new NodeCryptoAdapter();
  let worker: RunningWorker;
  let sysadmin: PrivateUserId;

  beforeAll(async () => {
    const bootstrap = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    // Workers' PBKDF2 tops out at 100 000 iterations; the server identity
    // must be decryptable there.
    const globals = globalThis as { __MINDOODB_PBKDF2_ITERATIONS?: number };
    globals.__MINDOODB_PBKDF2_ITERATIONS = 100_000;
    const serverIdentity = await bootstrap.createUserId("CN=cf-test-server", SERVER_PASSWORD);
    delete globals.__MINDOODB_PBKDF2_ITERATIONS;
    sysadmin = await bootstrap.createUserId("cn=sysadmin/o=cf-test", SYSADMIN_PASSWORD);
    worker = await startCloudflareWorker({
      serverIdentity,
      serverPassword: SERVER_PASSWORD,
      systemAdmin: sysadmin,
    });
  });

  afterAll(async () => {
    await worker?.stop();
  });

  async function createPublishedTenant(tenantId: string) {
    const factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    const adminUser = await factory.createUserId(`cn=admin/o=${tenantId}`, PASSWORD);
    const appUser = await factory.createUserId(`cn=karsten/o=${tenantId}`, PASSWORD);
    await factory.ensureUserKeyPair(appUser, PASSWORD);
    const created = await factory.createTenant({
      tenantId,
      adminUser,
      adminPassword: PASSWORD,
      appUser,
      userPassword: PASSWORD,
    });
    created.tenant.noteUserDirectoryFetched!();
    await created.tenant.reconcileUserKeys!({ allowSelfCreate: true });
    await created.tenant.publishToServer(worker.baseUrl, {
      systemAdminUser: sysadmin,
      systemAdminPassword: SYSADMIN_PASSWORD,
      adminUsername: adminUser.username,
    });
    await push(created.tenant, worker.baseUrl, "directory", { user: adminUser, password: PASSWORD });
    return { ...created, factory };
  }

  test("two tenants, two databases each in its own object, two devices, change events", async () => {
    const suffix = Date.now().toString(16);
    const a = await createPublishedTenant(`cf-a-${suffix}`);
    const b = await createPublishedTenant(`cf-b-${suffix}`);
    const tenantA = a.tenant.getId();

    // Device 1 of tenant A writes to two databases, one document with an
    // attachment of several chunks.
    await addDoc(a.tenant, "notes", "a-note-1");
    const attachmentBytes = new Uint8Array(600 * 1024).map((_, i) => (i * 31) % 251);
    const notesA = await a.tenant.openDB("notes");
    const withAttachment = await notesA.createDocument();
    let attachmentId = "";
    await notesA.changeDoc(withAttachment, async (d) => {
      d.getData().title = "a-note-attachment";
      attachmentId = (await d.addAttachment(attachmentBytes, "blob.bin", "application/octet-stream")).attachmentId;
    });
    const localAttachments = notesA.getAttachmentStore();
    const remoteAttachmentsA = await a.tenant.connectToServer(worker.baseUrl, "notes", StoreKind.attachments);
    await remoteAttachmentsA.putEntries(await localAttachments.getEntries(await localAttachments.getAllIds()));
    await addDoc(a.tenant, "tasks", "a-task-1");
    await push(a.tenant, worker.baseUrl, "notes");
    await push(a.tenant, worker.baseUrl, "tasks");
    // Tenant B writes to a database of the same name.
    await addDoc(b.tenant, "notes", "b-note-1");
    await push(b.tenant, worker.baseUrl, "notes");

    // Device 2 of the same user starts empty and pulls everything.
    const device2Factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    const device2 = await device2Factory.openTenant(
      tenantA,
      a.adminUser.userSigningKeyPair.publicKey,
      a.adminUser.userEncryptionKeyPair.publicKey,
      a.appUser,
      PASSWORD,
      a.keyBag,
    );
    await pull(device2, worker.baseUrl, "directory");
    await pull(device2, worker.baseUrl, "notes");
    await pull(device2, worker.baseUrl, "tasks");
    expect(await titles(device2, "notes")).toEqual(["a-note-1", "a-note-attachment"]);
    const remoteAttachments2 = await device2.connectToServer(worker.baseUrl, "notes", StoreKind.attachments);
    const notes2 = await device2.openDB("notes");
    await notes2
      .getAttachmentStore()
      .putEntries(await remoteAttachments2.getEntries(await remoteAttachments2.getAllIds()));
    const copied = await (await notes2.getDocument(withAttachment.getId())).getAttachment(attachmentId);
    expect(copied.length).toBe(attachmentBytes.length);
    expect(Buffer.from(copied).equals(Buffer.from(attachmentBytes))).toBe(true);
    expect(await titles(device2, "tasks")).toEqual(["a-task-1"]);

    // A subscriber on the event stream, gated on `notes`.
    const token = await tokenFor(worker.baseUrl, tenantA, a.appUser, PASSWORD);
    const controller = new AbortController();
    const events = await fetch(`${worker.baseUrl}/${tenantA}/sync/docs/events?dbId=notes`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    expect(events.status).toBe(200);
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    const reader = events.body!.getReader();
    let received = "";
    const sawChange = (async () => {
      while (!/event: change\ndata: [^\n]*"dbId":"notes"/.test(received)) {
        const { value, done } = await reader.read();
        if (done) break;
        received += new TextDecoder().decode(value);
      }
    })();

    // Device 2 writes back; device 1 picks it up.
    await addDoc(device2, "notes", "a-note-2");
    await push(device2, worker.baseUrl, "notes");
    await Promise.race([sawChange, new Promise((resolve) => setTimeout(resolve, 15_000))]);
    controller.abort();
    expect(received).toContain("event: hello");
    expect(received).toMatch(/event: change\ndata: [^\n]*"dbId":"notes"/);

    await pull(a.tenant, worker.baseUrl, "notes");
    expect(await titles(a.tenant, "notes")).toEqual(["a-note-1", "a-note-2", "a-note-attachment"]);

    // Tenant B never sees tenant A's documents.
    await pull(b.tenant, worker.baseUrl, "notes");
    expect(await titles(b.tenant, "notes")).toEqual(["b-note-1"]);

    // Without a token the database objects refuse.
    const anonymous = await fetch(`${worker.baseUrl}/${tenantA}/sync/docs/getStoreHead`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dbId: "notes" }),
    });
    expect(anonymous.status).toBe(401);

    // Object-internal routes are not reachable from outside, even with the
    // marker header and a tenant named like the route.
    for (const path of ["/internal/wipe", "/internal/tenants/internal", "/internal/databases/register"]) {
      const probe = await fetch(`${worker.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-mindoodb-internal-call": "1" },
        body: JSON.stringify({ dbId: "x" }),
      });
      expect(probe.status).toBe(404);
      expect(await probe.text()).toContain("not found on server");
    }

    const info = await fetch(`${worker.baseUrl}/.well-known/mindoodb-tenants/${tenantA}/publicinfos-fingerprints`);
    expect(info.status).toBe(200);

    // System admin: both tenants are listed; deleting A wipes all of its
    // database objects, B is untouched.
    const admin = new MindooDBServerAdmin({
      serverUrl: worker.baseUrl,
      systemAdminUser: sysadmin,
      systemAdminPassword: SYSADMIN_PASSWORD,
      cryptoAdapter: crypto,
    });
    expect(await admin.listTenants()).toEqual(expect.arrayContaining([tenantA, b.tenant.getId()]));
    await admin.removeTenant(tenantA);
    expect(await admin.listTenants()).not.toContain(tenantA);
    const gone = await fetch(`${worker.baseUrl}/${tenantA}/sync/docs/getStoreHead`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ dbId: "notes" }),
    });
    expect(gone.status).toBe(404);
    await pull(b.tenant, worker.baseUrl, "notes");
    expect(await titles(b.tenant, "notes")).toEqual(["b-note-1"]);
  });
});
