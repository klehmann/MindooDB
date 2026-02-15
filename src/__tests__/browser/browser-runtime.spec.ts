import { expect, test } from "@playwright/test";

import { startTempSyncServer, type BrowserSyncServer } from "./fixtures/tempSyncServer";

test.describe("MindooDB browser runtime", () => {
  let server: BrowserSyncServer;

  test.beforeAll(async () => {
    server = await startTempSyncServer();
  });

  test.afterAll(async () => {
    await server.stop();
  });

  test("loads browser entrypoint and performs local document lifecycle", async ({ page }) => {
    await page.goto(server.context.testPageUrl);

    const result = await page.evaluate(async ({ browserBundleUrl }) => {
      const bundle = await import(browserBundleUrl);
      const browserModule = bundle.browserModule;
      const {
        BaseMindooTenantFactory,
        InMemoryContentAddressedStoreFactory,
        KeyBag,
        PUBLIC_INFOS_KEY_ID,
        createCryptoAdapter,
      } = browserModule;

      const cryptoAdapter = createCryptoAdapter();
      const storeFactory = new InMemoryContentAddressedStoreFactory();
      const factory = new BaseMindooTenantFactory(storeFactory, cryptoAdapter);

      const user = await factory.createUserId("CN=browser-local-user/O=mindoo", "user-password");
      const adminUser = await factory.createUserId("CN=admin/O=mindoo", "admin-password");
      const keyBag = new KeyBag(user.userEncryptionKeyPair.privateKey, "user-password");

      const tenantId = "browser-local-tenant";
      await keyBag.createTenantKey(tenantId);
      await keyBag.createDocKey(PUBLIC_INFOS_KEY_ID);
      const tenant = await factory.openTenant(
        tenantId,
        adminUser.userSigningKeyPair.publicKey,
        adminUser.userEncryptionKeyPair.publicKey,
        user,
        "user-password",
        keyBag
      );

      const db = await tenant.openDB("browser-local-db");
      const doc = await db.createDocument();

      await db.changeDoc(doc, async (mindooDoc: { getData: () => Record<string, unknown> }) => {
        const data = mindooDoc.getData();
        data.title = "from-browser-runtime";
        data.count = 1;
      });

      const ids = await db.getAllDocumentIds();
      const loadedDoc = await db.getDocument(ids[0]);
      const loadedData = loadedDoc.getData() as Record<string, unknown>;

      return {
        idsCount: ids.length,
        title: loadedData.title,
        count: loadedData.count,
      };
    }, { browserBundleUrl: server.context.browserBundleUrl });

    expect(result.idsCount).toBe(1);
    expect(result.title).toBe("from-browser-runtime");
    expect(result.count).toBe(1);
  });

  test("syncs entries from browser through real HTTP sync endpoint", async ({ page }) => {
    await page.goto(server.context.testPageUrl);

    const result = await page.evaluate(async (ctx) => {
      const importPemPrivateKeyInBrowser = async (
        subtle: SubtleCrypto,
        pem: string,
        algorithm: AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams,
        keyUsages: KeyUsage[]
      ): Promise<CryptoKey> => {
        const base64 = pem
          .replace(/-----BEGIN [A-Z ]+-----/g, "")
          .replace(/-----END [A-Z ]+-----/g, "")
          .replace(/\s+/g, "");

        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        return subtle.importKey("pkcs8", bytes.buffer, algorithm, true, keyUsages);
      };

      const bundle = await import(ctx.browserBundleUrl);
      const { browserModule, HttpTransport, ClientNetworkContentAddressedStore } = bundle;
      const { createCryptoAdapter } = browserModule;

      const cryptoAdapter = createCryptoAdapter();
      const subtle = cryptoAdapter.getSubtle();
      const signingPrivateKey = await importPemPrivateKeyInBrowser(
        subtle,
        ctx.userSigningPrivateKeyPem,
        "Ed25519",
        ["sign"]
      );

      const transport = new HttpTransport({
        baseUrl: ctx.syncBaseUrl,
        tenantId: ctx.tenantId,
        dbId: ctx.dbId,
        timeout: 10_000,
        retryAttempts: 1,
        retryDelayMs: 50,
      });

      const remoteStore = new ClientNetworkContentAddressedStore(
        ctx.dbId,
        transport,
        cryptoAdapter,
        ctx.username,
        signingPrivateKey,
        ctx.userEncryptionPrivateKeyPem
      );

      const beforeIds = await remoteStore.getAllIds();
      const entryId = `browser-entry-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const entry = {
        entryType: "doc_change",
        id: entryId,
        contentHash: `contenthash-${entryId}`,
        docId: "browser-doc-1",
        dependencyIds: [],
        createdAt: Date.now(),
        createdByPublicKey: ctx.userSigningPublicKeyPem,
        decryptionKeyId: "default",
        signature: new Uint8Array([1, 2, 3, 4]),
        originalSize: 4,
        encryptedSize: 4,
        encryptedData: new Uint8Array([10, 20, 30, 40]),
      };

      await remoteStore.putEntries([entry]);

      const afterIds = await remoteStore.getAllIds();
      const newEntries = await remoteStore.findNewEntries([]);
      const fetchedEntries = await remoteStore.getEntries([entryId]);

      return {
        beforeCount: beforeIds.length,
        afterContainsEntry: afterIds.includes(entryId),
        newEntriesContainsEntry: newEntries.some((candidate: { id: string }) => candidate.id === entryId),
        fetchedCount: fetchedEntries.length,
        fetchedPayload: Array.from(fetchedEntries[0].encryptedData),
        fetchedCreatedBy: fetchedEntries[0].createdByPublicKey,
      };
    }, server.context);

    expect(result.beforeCount).toBe(0);
    expect(result.afterContainsEntry).toBe(true);
    expect(result.newEntriesContainsEntry).toBe(true);
    expect(result.fetchedCount).toBe(1);
    expect(result.fetchedPayload).toEqual([10, 20, 30, 40]);
    expect(result.fetchedCreatedBy).toBe(server.context.userSigningPublicKeyPem);
  });
});
