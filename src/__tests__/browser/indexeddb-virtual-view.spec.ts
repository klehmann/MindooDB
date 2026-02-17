import { expect, test } from "@playwright/test";

import {
  startTempSyncServer,
  type BrowserSyncServer,
} from "./fixtures/tempSyncServer";

test.describe("MindooDB browser virtual view with IndexedDB store", () => {
  let server: BrowserSyncServer;

  test.beforeAll(async () => {
    server = await startTempSyncServer({
      tenantId: "indexeddb-virtual-view-tenant",
    });
  });

  test.afterAll(async () => {
    await server.stop();
  });

  test("updates categories and sorting after document changes", async ({
    page,
  }) => {
    await page.goto(server.context.testPageUrl);

    const result = await page.evaluate(
      async ({ browserBundleUrl }) => {
        const bundle = await import(browserBundleUrl);
        const browserModule = bundle.browserModule;
        const {
          BaseMindooTenantFactory,
          IndexedDBContentAddressedStoreFactory,
          KeyBag,
          PUBLIC_INFOS_KEY_ID,
          createCryptoAdapter,
          VirtualViewFactory,
          ColumnSorting,
        } = browserModule;

        const prefix =
          "vv-test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        const cryptoAdapter = createCryptoAdapter();
        const storeFactory = new IndexedDBContentAddressedStoreFactory(prefix);
        const factory = new BaseMindooTenantFactory(storeFactory, cryptoAdapter);

        const user = await factory.createUserId(
          "CN=virtual-view-user/O=mindoo",
          "user-password"
        );
        const adminUser = await factory.createUserId(
          "CN=admin/O=mindoo",
          "admin-password"
        );
        const keyBag = new KeyBag(
          user.userEncryptionKeyPair.privateKey,
          "user-password",
          cryptoAdapter
        );

        const tenantId = "virtual-view-idb-tenant";
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
        const db = await tenant.openDB("employees");

        const createEmployee = async (
          name: string,
          department: string
        ): Promise<string> => {
          const doc = await db.createDocument();
          await db.changeDoc(
            doc,
            async (d: { getData: () => Record<string, unknown> }) => {
              const data = d.getData();
              data.name = name;
              data.department = department;
            }
          );
          return doc.getId();
        };

        const aliceId = await createEmployee("Alice", "Sales");
        const bobId = await createEmployee("Bob", "Sales");
        await createEmployee("Charlie", "Engineering");

        const view = await VirtualViewFactory.createView()
          .addCategoryColumn("department", {
            sorting: ColumnSorting.ASCENDING,
          })
          .addSortedColumn("name", ColumnSorting.ASCENDING)
          .withDB("employees", db)
          .buildAndUpdate();

        const collectView = (): {
          categories: string[];
          docsByCategory: Record<string, string[]>;
        } => {
          const root = view.getRoot();
          const categories = root
            .getChildCategories()
            .map((cat: { getCategoryValue: () => unknown }) =>
              String(cat.getCategoryValue())
            );
          const docsByCategory: Record<string, string[]> = {};

          for (const categoryEntry of root.getChildCategories()) {
            const categoryName = String(categoryEntry.getCategoryValue());
            docsByCategory[categoryName] = categoryEntry
              .getChildDocuments()
              .map(
                (doc: { getColumnValue: (name: string) => unknown }) =>
                  String(doc.getColumnValue("name"))
              );
          }

          return { categories, docsByCategory };
        };

        const initialState = collectView();

        const bobDoc = await db.getDocument(bobId);
        await db.changeDoc(
          bobDoc,
          async (d: { getData: () => Record<string, unknown> }) => {
            const data = d.getData();
            data.name = "Aaron";
            data.department = "Engineering";
          }
        );

        const aliceDoc = await db.getDocument(aliceId);
        await db.changeDoc(
          aliceDoc,
          async (d: { getData: () => Record<string, unknown> }) => {
            const data = d.getData();
            data.name = "Zoe";
          }
        );

        await view.update();
        const updatedState = collectView();

        // Clean up IndexedDB databases
        const store = db.getStore();
        if (store.clearAllLocalData) {
          await store.clearAllLocalData();
        }

        return { initialState, updatedState };
      },
      { browserBundleUrl: server.context.browserBundleUrl }
    );

    expect(result.initialState.categories).toEqual([
      "Engineering",
      "Sales",
    ]);
    expect(result.initialState.docsByCategory.Engineering).toEqual([
      "Charlie",
    ]);
    expect(result.initialState.docsByCategory.Sales).toEqual([
      "Alice",
      "Bob",
    ]);

    expect(result.updatedState.categories).toEqual([
      "Engineering",
      "Sales",
    ]);
    expect(result.updatedState.docsByCategory.Engineering).toEqual([
      "Aaron",
      "Charlie",
    ]);
    expect(result.updatedState.docsByCategory.Sales).toEqual(["Zoe"]);
  });

  test("IndexedDB store data survives page reload", async ({ page }) => {
    await page.goto(server.context.testPageUrl);

    const prefix =
      "vv-persist-" +
      Date.now() +
      "-" +
      Math.random().toString(36).slice(2);
    const tenantId = "vv-persist-tenant-" + Date.now();

    // Phase 1: Create documents via MindooDB and store them in IndexedDB
    const phase1 = await page.evaluate(
      async ({ browserBundleUrl, prefix, tenantId }) => {
        const bundle = await import(browserBundleUrl);
        const browserModule = bundle.browserModule;
        const {
          BaseMindooTenantFactory,
          IndexedDBContentAddressedStoreFactory,
          KeyBag,
          PUBLIC_INFOS_KEY_ID,
          createCryptoAdapter,
        } = browserModule;

        const cryptoAdapter = createCryptoAdapter();
        const storeFactory = new IndexedDBContentAddressedStoreFactory(prefix);
        const factory = new BaseMindooTenantFactory(storeFactory, cryptoAdapter);

        const user = await factory.createUserId(
          "CN=persist-user/O=mindoo",
          "user-password"
        );
        const adminUser = await factory.createUserId(
          "CN=admin/O=mindoo",
          "admin-password"
        );
        const keyBag = new KeyBag(
          user.userEncryptionKeyPair.privateKey,
          "user-password",
          cryptoAdapter
        );

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
        const db = await tenant.openDB("persist-employees");

        const createEmployee = async (name: string, department: string) => {
          const doc = await db.createDocument();
          await db.changeDoc(
            doc,
            async (d: { getData: () => Record<string, unknown> }) => {
              const data = d.getData();
              data.name = name;
              data.department = department;
            }
          );
        };

        await createEmployee("Alice", "Sales");
        await createEmployee("Bob", "Engineering");

        const docCount = (await db.getAllDocumentIds()).length;
        const storeIds = await db.getStore().getAllIds();

        return {
          docCount,
          storeEntryCount: storeIds.length,
        };
      },
      {
        browserBundleUrl: server.context.browserBundleUrl,
        prefix,
        tenantId,
      }
    );

    expect(phase1.docCount).toBe(2);
    expect(phase1.storeEntryCount).toBeGreaterThan(0);

    // Navigate away and back
    await page.goto("about:blank");
    await page.goto(server.context.testPageUrl);

    // Phase 2: Verify raw store data survived the page navigation
    const phase2 = await page.evaluate(
      async ({ browserBundleUrl, prefix }) => {
        const bundle = await import(browserBundleUrl);
        const { IndexedDBContentAddressedStore } = bundle.browserModule;

        const store = new IndexedDBContentAddressedStore(
          "persist-employees",
          undefined,
          { basePath: prefix }
        );
        const ids = await store.getAllIds();
        const entries = await store.getEntries(ids.slice(0, 3));

        // Clean up
        await store.clearAllLocalData();

        const dirStore = new IndexedDBContentAddressedStore(
          "directory",
          undefined,
          { basePath: prefix }
        );
        await dirStore.clearAllLocalData();

        return {
          storeEntryCount: ids.length,
          hasEntries: ids.length > 0,
          sampleEntriesHaveData: entries.every(
            (e: any) => e.encryptedData && e.encryptedData.length > 0
          ),
        };
      },
      { browserBundleUrl: server.context.browserBundleUrl, prefix }
    );

    expect(phase2.hasEntries).toBe(true);
    expect(phase2.storeEntryCount).toBeGreaterThan(0);
    expect(phase2.sampleEntriesHaveData).toBe(true);
  });
});
