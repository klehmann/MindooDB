import { expect, test } from "@playwright/test";

import { startTempSyncServer, type BrowserSyncServer } from "./fixtures/tempSyncServer";

test.describe("MindooDB browser virtual view", () => {
  let server: BrowserSyncServer;

  test.beforeAll(async () => {
    server = await startTempSyncServer({ tenantId: "browser-virtual-view-tenant" });
  });

  test.afterAll(async () => {
    await server.stop();
  });

  test("updates categories and sorting after document changes", async ({ page }) => {
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
        VirtualViewFactory,
        ColumnSorting,
      } = browserModule;

      const cryptoAdapter = createCryptoAdapter();
      const storeFactory = new InMemoryContentAddressedStoreFactory();
      const factory = new BaseMindooTenantFactory(storeFactory, cryptoAdapter);

      const user = await factory.createUserId("CN=virtual-view-user/O=mindoo", "user-password");
      const adminUser = await factory.createUserId("CN=admin/O=mindoo", "admin-password");
      const keyBag = new KeyBag(user.userEncryptionKeyPair.privateKey, "user-password");

      const tenantId = "virtual-view-tenant";
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

      const createEmployee = async (name: string, department: string): Promise<string> => {
        const doc = await db.createDocument();
        await db.changeDoc(doc, async (d: { getData: () => Record<string, unknown> }) => {
          const data = d.getData();
          data.name = name;
          data.department = department;
        });
        return doc.getId();
      };

      const aliceId = await createEmployee("Alice", "Sales");
      const bobId = await createEmployee("Bob", "Sales");
      await createEmployee("Charlie", "Engineering");

      const view = await VirtualViewFactory.createView()
        .addCategoryColumn("department", { sorting: ColumnSorting.ASCENDING })
        .addSortedColumn("name", ColumnSorting.ASCENDING)
        .withDB("employees", db)
        .buildAndUpdate();

      const collectView = (): { categories: string[]; docsByCategory: Record<string, string[]> } => {
        const root = view.getRoot();
        const categories = root.getChildCategories().map((cat: { getCategoryValue: () => unknown }) =>
          String(cat.getCategoryValue())
        );
        const docsByCategory: Record<string, string[]> = {};

        for (const categoryEntry of root.getChildCategories()) {
          const categoryName = String(categoryEntry.getCategoryValue());
          docsByCategory[categoryName] = categoryEntry
            .getChildDocuments()
            .map((doc: { getColumnValue: (name: string) => unknown }) => String(doc.getColumnValue("name")));
        }

        return { categories, docsByCategory };
      };

      const initialState = collectView();

      const bobDoc = await db.getDocument(bobId);
      await db.changeDoc(bobDoc, async (d: { getData: () => Record<string, unknown> }) => {
        const data = d.getData();
        data.name = "Aaron";
        data.department = "Engineering";
      });

      const aliceDoc = await db.getDocument(aliceId);
      await db.changeDoc(aliceDoc, async (d: { getData: () => Record<string, unknown> }) => {
        const data = d.getData();
        data.name = "Zoe";
      });

      await view.update();
      const updatedState = collectView();

      return { initialState, updatedState };
    }, { browserBundleUrl: server.context.browserBundleUrl });

    expect(result.initialState.categories).toEqual(["Engineering", "Sales"]);
    expect(result.initialState.docsByCategory.Engineering).toEqual(["Charlie"]);
    expect(result.initialState.docsByCategory.Sales).toEqual(["Alice", "Bob"]);

    expect(result.updatedState.categories).toEqual(["Engineering", "Sales"]);
    expect(result.updatedState.docsByCategory.Engineering).toEqual(["Aaron", "Charlie"]);
    expect(result.updatedState.docsByCategory.Sales).toEqual(["Zoe"]);
  });
});
