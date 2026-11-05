import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { RpcContentAddressedStoreFactory, type StoreRpcClientTransport } from "../core/appendonlystores/rpc/RpcContentAddressedStore";
import { StoreRpcServer } from "../core/appendonlystores/rpc/StoreRpcServer";
import { SqliteContentAddressedStoreFactory } from "../core/appendonlystores/sqlite/SqliteContentAddressedStore";
import { createMemorySqliteBackend } from "../core/appendonlystores/sqlite/SqliteDriver";
import { PUBLIC_INFOS_KEY_ID, type PrivateUserId } from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

/**
 * A whole tenant on RPC stores backed by SQLite, as in Haven's native app:
 * the client side only sees the RPC factory, all data lives behind the server.
 */
function createServerAndTransport(): StoreRpcClientTransport {
  const toServer = new Map<string, Uint8Array>();
  const toClient = new Map<string, Uint8Array>();
  const sqliteFactory = new SqliteContentAddressedStoreFactory(() => createMemorySqliteBackend());
  const server = new StoreRpcServer({
    createFactory: () => sqliteFactory,
    bytes: {
      async take(id) {
        const bytes = toServer.get(id) ?? null;
        toServer.delete(id);
        return bytes;
      },
      async offer(id, bytes) {
        toClient.set(id, bytes);
      },
    },
  });
  return {
    async call(request) {
      return JSON.parse(JSON.stringify((await server.handle(JSON.parse(JSON.stringify(request)))) ?? null));
    },
    async sendBytes(id, bytes) {
      toServer.set(id, bytes.slice());
    },
    async receiveBytes(id) {
      const bytes = toClient.get(id)!;
      toClient.delete(id);
      return bytes;
    },
  };
}

describe("tenant on RPC stores", () => {
  test("creates, changes and reads documents and attachments", async () => {
    const transport = createServerAndTransport();
    const factory = new BaseMindooTenantFactory(
      new RpcContentAddressedStoreFactory(transport, { scope: "tenant-rpc" }),
      new NodeCryptoAdapter(),
    );
    const adminPassword = "adminpass123";
    const admin: PrivateUserId = await factory.createUserId("CN=admin/O=rpc", adminPassword);
    const userPassword = "userpass123";
    const user: PrivateUserId = await factory.createUserId("CN=user/O=rpc", userPassword);
    const keyBag = new KeyBag(user.userEncryptionKeyPair.privateKey, userPassword, factory.getCryptoAdapter());
    const tenantId = "rpc-tenant";
    await keyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await keyBag.createTenantKey(tenantId);
    const tenant = await factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      user,
      userPassword,
      keyBag,
    );
    const directory = await tenant.openDirectory();
    await directory.registerUser(factory.toPublicUserId(user), admin.userSigningKeyPair.privateKey, adminPassword);
    const db = await tenant.openDB("notes", { attachmentConfig: { chunkSizeBytes: 1024 } });

    const doc = await db.createDocument();
    const payload = new Uint8Array(10_000).map((_, i) => (i * 31) % 251);
    let attachmentId = "";
    await db.changeDoc(doc, async (d) => {
      d.getData().title = "hello";
      const ref = await d.addAttachment(payload, "data.bin", "application/octet-stream");
      attachmentId = ref.attachmentId;
    });
    for (let i = 0; i < 20; i += 1) {
      await db.changeDoc(doc, async (d) => {
        d.getData().counter = i;
      });
    }

    const reloaded = await db.getDocument(doc.getId());
    expect(reloaded.getData().title).toBe("hello");
    expect(reloaded.getData().counter).toBe(19);
    expect(Array.from(await reloaded.getAttachment(attachmentId))).toEqual(Array.from(payload));
    expect(await db.getAllDocumentIds()).toContain(doc.getId());

    // Freeing one attachment's local copy (Haven's unpin, upload cleanup)
    // deletes exactly its chunks, through the RPC into SQLite.
    let keptId = "";
    let keptLastChunkId = "";
    const keptPayload = new Uint8Array(3_000).map((_, i) => (i * 7) % 251);
    await db.changeDoc(await db.getDocument(doc.getId()), async (d) => {
      const ref = await d.addAttachment(keptPayload, "kept.bin", "application/octet-stream");
      keptId = ref.attachmentId;
      keptLastChunkId = ref.lastChunkId;
    });
    const attachmentStore = db.getAttachmentStore();
    expect(typeof attachmentStore.deleteEntriesForAttachment).toBe("function");
    const freedRef = (await db.getDocument(doc.getId())).getAttachments().find((a) => a.attachmentId === attachmentId)!;
    const freedChain = await attachmentStore.resolveDependencies(freedRef.lastChunkId, { includeStart: true });
    expect(freedChain).toHaveLength(Math.ceil(payload.length / 1024));
    const docEntriesBefore = (await db.getStore().getAllIds()).length;

    expect(await attachmentStore.deleteEntriesForAttachment!(doc.getId(), attachmentId)).toBe(freedChain.length);
    expect(await attachmentStore.hasEntries(freedChain)).toEqual([]);
    expect(await attachmentStore.deleteEntriesForAttachment!(doc.getId(), attachmentId)).toBe(0);
    const keptChain = await attachmentStore.resolveDependencies(keptLastChunkId, { includeStart: true });
    expect(await attachmentStore.hasEntries(keptChain)).toEqual(keptChain);
    expect((await db.getStore().getAllIds()).length).toBe(docEntriesBefore);
    const afterFree = await db.getDocument(doc.getId());
    expect(Array.from(await afterFree.getAttachment(keptId))).toEqual(Array.from(keptPayload));
    await (tenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
  }, 60000);
});
