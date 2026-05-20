import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { KeyBag } from "../core/keys/KeyBag";
import {
  type MindooDB,
  type MindooTenant,
  type PrivateUserId,
  PUBLIC_INFOS_KEY_ID,
} from "../core/types";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

describe("applyJsonPatch", () => {
  let factory: BaseMindooTenantFactory;
  let adminUser: PrivateUserId;
  let adminUserPassword: string;
  let currentUser: PrivateUserId;
  let currentUserPassword: string;
  let keyBag: KeyBag;
  let tenant: MindooTenant;
  let db: MindooDB;

  beforeEach(async () => {
    factory = new BaseMindooTenantFactory(new InMemoryContentAddressedStoreFactory(), new NodeCryptoAdapter());
    adminUserPassword = "adminpass123";
    adminUser = await factory.createUserId("CN=admin/O=jsonpatch", adminUserPassword);
    currentUserPassword = "userpassword123";
    currentUser = await factory.createUserId("CN=testuser/O=jsonpatch", currentUserPassword);
    keyBag = new KeyBag(currentUser.userEncryptionKeyPair.privateKey, currentUserPassword, factory.getCryptoAdapter());

    const tenantId = "test-tenant-jsonpatch";
    await keyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await keyBag.createTenantKey(tenantId);
    tenant = await factory.openTenant(
      tenantId,
      adminUser.userSigningKeyPair.publicKey,
      adminUser.userEncryptionKeyPair.publicKey,
      currentUser,
      currentUserPassword,
      keyBag,
    );

    const directory = await tenant.openDirectory();
    const publicUser = factory.toPublicUserId(currentUser);
    await directory.registerUser(publicUser, adminUser.userSigningKeyPair.privateKey, adminUserPassword);
    db = await tenant.openDB("test-db");
  }, 30000);

  afterEach(async () => {
    await (tenant as unknown as { disposeCacheManager?: () => Promise<void> }).disposeCacheManager?.();
  });

  it("applies stale-head list inserts without dropping concurrent document fields", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (draft) => {
      draft.getData().teamgrid = {
        workbook: {
          worksheetsById: {
            sheet_1: {
              rowOrder: ["row_1"],
            },
          },
        },
      };
    });
    const baseHeads = doc.getHeads();

    await db.changeDoc(doc, (draft) => {
      draft.getData().subject = "Concurrent rename";
    });

    const result = await db.applyJsonPatch(doc, {
      baseHeads,
      listInsert: [{
        path: ["teamgrid", "workbook", "worksheetsById", "sheet_1", "rowOrder"],
        index: 1,
        values: ["row_2"],
      }],
    });

    expect(result.data.subject).toBe("Concurrent rename");
    expect(
      ((result.data.teamgrid as any).workbook.worksheetsById.sheet_1.rowOrder as string[]),
    ).toEqual(["row_1", "row_2"]);
    expect(result.heads.length).toBeGreaterThan(0);
  }, 30000);

  it("creates the target array when listInsert points at a missing field", async () => {
    // Reproduces the TeamGrid scenario where a legacy worksheet document
    // pre-dates the `chartOrder` schema field. The in-memory clone has
    // been migrated to include `chartOrder: []`, but the persisted
    // Automerge document never had it. A `listInsert` against that field
    // must create the array on the fly rather than throwing
    // "Cannot apply JSON list operation to non-array value".
    const doc = await db.createDocument();
    await db.changeDoc(doc, (draft) => {
      draft.getData().teamgrid = {
        workbook: {
          worksheetsById: {
            sheet_1: {
              rowOrder: ["row_1"],
            },
          },
        },
      };
    });
    const baseHeads = doc.getHeads();

    const result = await db.applyJsonPatch(doc, {
      baseHeads,
      listInsert: [{
        path: ["teamgrid", "workbook", "worksheetsById", "sheet_1", "chartOrder"],
        index: 0,
        values: ["chart_1"],
      }],
    });

    expect(
      ((result.data.teamgrid as any).workbook.worksheetsById.sheet_1.chartOrder as string[]),
    ).toEqual(["chart_1"]);
  }, 30000);

  it("rejects listInsert when the target path resolves to a non-array value", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (draft) => {
      draft.getData().subject = "Has a string here";
    });
    const baseHeads = doc.getHeads();

    await expect(db.applyJsonPatch(doc, {
      baseHeads,
      listInsert: [{ path: ["subject"], index: 0, values: ["nope"] }],
    })).rejects.toThrow(/non-array value/);
  }, 30000);

  it("merges two stale-head list inserts into the same order array", async () => {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (draft) => {
      draft.getData().rowOrder = ["row_1"];
    });
    const baseHeads = doc.getHeads();

    await db.applyJsonPatch(doc, {
      baseHeads,
      listInsert: [{ path: ["rowOrder"], index: 1, values: ["row_2"] }],
    });

    const result = await db.applyJsonPatch(doc, {
      baseHeads,
      listInsert: [{ path: ["rowOrder"], index: 1, values: ["row_3"] }],
    });

    expect(result.data.rowOrder).toContain("row_1");
    expect(result.data.rowOrder).toContain("row_2");
    expect(result.data.rowOrder).toContain("row_3");
  }, 30000);
});
