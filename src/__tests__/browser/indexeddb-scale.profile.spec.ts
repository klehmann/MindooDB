import { test } from "@playwright/test";

import {
  startTempSyncServer,
  type BrowserSyncServer,
} from "./fixtures/tempSyncServer";

const RUN_PROFILE = process.env.RUN_INDEXEDDB_PROFILE === "1";

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

test.describe("IndexedDB scale profile", () => {
  let server: BrowserSyncServer;

  test.beforeAll(async () => {
    server = await startTempSyncServer({
      tenantId: "indexeddb-scale-profile-tenant",
    });
  });

  test.afterAll(async () => {
    await server.stop();
  });

  test.skip(!RUN_PROFILE, "Set RUN_INDEXEDDB_PROFILE=1 to run profiling.");

  test("profiles browser store and DB hot paths", async ({ page }) => {
    test.setTimeout(10 * 60 * 1000);
    await page.goto(server.context.testPageUrl);
    const dataset = {
      rawStoreDocCount: readPositiveIntEnv("PROFILE_RAW_STORE_DOCS", 2000),
      rawStoreEntriesPerDoc: readPositiveIntEnv("PROFILE_RAW_STORE_ENTRIES_PER_DOC", 5),
      rawStoreBatchSize: readPositiveIntEnv("PROFILE_RAW_STORE_BATCH_SIZE", 200),
      rawStorePlanDocSample: readPositiveIntEnv("PROFILE_RAW_STORE_PLAN_SAMPLE", 100),
      realDbDocCount: readPositiveIntEnv("PROFILE_REAL_DB_DOCS", 300),
      realDbChangesPerDoc: readPositiveIntEnv("PROFILE_REAL_DB_CHANGES_PER_DOC", 2),
      deepHistoryChanges: readPositiveIntEnv("PROFILE_DEEP_HISTORY_CHANGES", 250),
    };

    const result = await page.evaluate(
      async ({ browserBundleUrl, dataset }) => {
        const bundle = await import(browserBundleUrl);
        const browserModule = bundle.browserModule;
        const {
          BaseMindooTenantFactory,
          IndexedDBContentAddressedStore,
          IndexedDBContentAddressedStoreFactory,
          KeyBag,
          PUBLIC_INFOS_KEY_ID,
          createCryptoAdapter,
        } = browserModule;

        const summarize = (values: number[]) => {
          if (values.length === 0) {
            return { count: 0, min: 0, avg: 0, max: 0, p95: 0 };
          }
          const sorted = [...values].sort((a, b) => a - b);
          const sum = values.reduce((acc, value) => acc + value, 0);
          const p95Index = Math.min(
            sorted.length - 1,
            Math.floor(sorted.length * 0.95)
          );
          return {
            count: values.length,
            min: Number(sorted[0].toFixed(2)),
            avg: Number((sum / values.length).toFixed(2)),
            max: Number(sorted[sorted.length - 1].toFixed(2)),
            p95: Number(sorted[p95Index].toFixed(2)),
          };
        };

        type DocumentLoadMetric = {
          docId: string;
          cacheHit: boolean;
          metadataEntriesScanned: number;
          replayEntriesLoaded: number;
          snapshotUsed: boolean;
          cacheCheckTime: number;
          storeQueryTime: number;
          entryLoadTime: number;
          signatureVerificationTime: number;
          decryptionTime: number;
          automergeTime: number;
          totalTime: number;
        };

        const summarizeDocumentLoadField = (
          metrics: DocumentLoadMetric[],
          field: keyof DocumentLoadMetric
        ) =>
          summarize(
            metrics
              .map((entry) => entry[field])
              .filter((value): value is number => typeof value === "number")
          );

        const createStoreEntry = (
          docId: string,
          id: string,
          contentHash: string,
          dependencyIds: string[],
          entryType: string,
          createdAt: number
        ) => {
          const encryptedData = new Uint8Array([10, 20, 30, 40, 50]);
          return {
            entryType,
            id,
            contentHash,
            docId,
            dependencyIds,
            createdAt,
            createdByPublicKey: "profile-public-key",
            decryptionKeyId: "default",
            signature: new Uint8Array([1, 2, 3, 4]),
            originalSize: 4,
            encryptedSize: encryptedData.length,
            encryptedData,
          };
        };

        const profileRawStore = async () => {
          const prefix = `profile-store-${Date.now()}`;
          const store = new IndexedDBContentAddressedStore(
            "raw-profile-db",
            undefined,
            { basePath: prefix }
          );
          const sampleDocIds: string[] = [];
          let createdAt = Date.now();

          try {
            for (
              let batchStart = 0;
              batchStart < dataset.rawStoreDocCount;
              batchStart += dataset.rawStoreBatchSize
            ) {
              const batch: Array<Record<string, unknown>> = [];
              const batchEnd = Math.min(
                dataset.rawStoreDocCount,
                batchStart + dataset.rawStoreBatchSize
              );
              for (let i = batchStart; i < batchEnd; i++) {
                const docId = `raw-doc-${i}`;
                if (sampleDocIds.length < dataset.rawStorePlanDocSample) {
                  sampleDocIds.push(docId);
                }
                let previousId = `${docId}-create`;
                batch.push(
                  createStoreEntry(
                    docId,
                    previousId,
                    `${previousId}-hash`,
                    [],
                    "doc_create",
                    createdAt++
                  )
                );
                for (let changeIdx = 1; changeIdx < dataset.rawStoreEntriesPerDoc; changeIdx++) {
                  const entryId = `${docId}-change-${changeIdx}`;
                  batch.push(
                    createStoreEntry(
                      docId,
                      entryId,
                      `${entryId}-hash`,
                      [previousId],
                      "doc_change",
                      createdAt++
                    )
                  );
                  previousId = entryId;
                }
              }
              await store.putEntries(batch as any);
            }

            const planStart = performance.now();
            const plan = await store.planDocumentMaterializationBatch(
              sampleDocIds,
              { includeDiagnostics: true }
            );
            const planMs = performance.now() - planStart;

            const idsStart = performance.now();
            const ids = await store.getAllIds();
            const getAllIdsMs = performance.now() - idsStart;

            const bloomStart = performance.now();
            const bloom = await store.getIdBloomSummary?.();
            const bloomMs = performance.now() - bloomStart;

            return {
              docCount: dataset.rawStoreDocCount,
              entryCount: ids.length,
              samplePlannedDocs: plan.plans.length,
              planBatchMs: Number(planMs.toFixed(2)),
              getAllIdsMs: Number(getAllIdsMs.toFixed(2)),
              bloomSummaryMs: Number(bloomMs.toFixed(2)),
              bloomTotalIds: bloom?.totalIds ?? 0,
            };
          } finally {
            await store.clearAllLocalData();
          }
        };

        const profileRealDb = async () => {
          const prefix = `profile-db-${Date.now()}`;
          const cryptoAdapter = createCryptoAdapter();
          const storeFactory = new IndexedDBContentAddressedStoreFactory(prefix);
          const factory = new BaseMindooTenantFactory(storeFactory, cryptoAdapter);

          const user = await factory.createUserId(
            "CN=profile-user/O=mindoo",
            "user-password"
          );
          const adminUser = await factory.createUserId(
            "CN=profile-admin/O=mindoo",
            "admin-password"
          );
          const keyBag = new KeyBag(
            user.userEncryptionKeyPair.privateKey,
            "user-password",
            cryptoAdapter
          );

          const tenantId = `profile-tenant-${Date.now()}`;
          await keyBag.createTenantKey(tenantId);
          await keyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
          const tenant = await factory.openTenant(
            tenantId,
            adminUser.userSigningKeyPair.publicKey,
            adminUser.userEncryptionKeyPair.publicKey,
            user,
            "user-password",
            keyBag
          );
          const directory = await tenant.openDirectory();
          await directory.registerUser(
            factory.toPublicUserId(user),
            adminUser.userSigningKeyPair.privateKey,
            "admin-password"
          );

          const setupDb = await tenant.openDB("profile-db", {
            documentCacheConfig: {
              maxEntries: 64,
              iteratePrefetchWindowDocs: 0,
            },
          });

          const docIds: string[] = [];
          const hotPathTimestamps: number[] = [];
          for (let i = 0; i < dataset.realDbDocCount; i++) {
            const doc = await setupDb.createDocument();
            docIds.push(doc.getId());
            for (let changeIdx = 0; changeIdx < dataset.realDbChangesPerDoc; changeIdx++) {
              await setupDb.changeDoc(doc, (d: { getData: () => Record<string, unknown> }) => {
                const data = d.getData();
                data.index = i;
                data.changeIdx = changeIdx;
              });
            }
          }

          const deepDoc = await setupDb.createDocument();
          const deepDocId = deepDoc.getId();
          for (let i = 0; i < dataset.deepHistoryChanges; i++) {
            await setupDb.changeDoc(
              deepDoc,
              (d: { getData: () => Record<string, unknown> }) => {
                const data = d.getData();
                data.version = i;
                data.payload = `v-${i}`;
              }
            );
            if (
              i === Math.floor(dataset.deepHistoryChanges / 4) ||
              i === Math.floor(dataset.deepHistoryChanges / 2) ||
              i === Math.floor((dataset.deepHistoryChanges * 3) / 4)
            ) {
              hotPathTimestamps.push(Date.now());
            }
          }

          await setupDb.syncStoreChanges();

          const reopenMetrics = {
            documentLoads: [] as DocumentLoadMetric[],
            syncOps: [] as Array<Record<string, unknown>>,
            historyOps: [] as Array<Record<string, unknown>>,
          };

          const reopenFactory = new BaseMindooTenantFactory(
            new IndexedDBContentAddressedStoreFactory(prefix),
            cryptoAdapter
          );
          const reopenTenant = await reopenFactory.openTenant(
            tenantId,
            adminUser.userSigningKeyPair.publicKey,
            adminUser.userEncryptionKeyPair.publicKey,
            user,
            "user-password",
            keyBag
          );
          const startupStart = performance.now();
          const db = await reopenTenant.openDB("profile-db", {
            documentCacheConfig: {
              maxEntries: 64,
              iteratePrefetchWindowDocs: 0,
            },
            performanceCallback: {
              onDocumentLoad: (metrics: DocumentLoadMetric) => {
                reopenMetrics.documentLoads.push(metrics);
              },
              onSyncOperation: (metrics: Record<string, unknown>) => {
                reopenMetrics.syncOps.push(metrics);
              },
              onHistoryOperation: (metrics: Record<string, unknown>) => {
                reopenMetrics.historyOps.push(metrics);
              },
            },
          });
          const startupMs = performance.now() - startupStart;

          const documentLoadCountBeforeLatestLoad = reopenMetrics.documentLoads.length;
          const latestDocLoadStart = performance.now();
          const deepDocLoaded = await db.getDocument(deepDocId);
          const latestDocLoadMs = performance.now() - latestDocLoadStart;
          const latestDocLoadMetric =
            reopenMetrics.documentLoads
              .slice(documentLoadCountBeforeLatestLoad)
              .find((entry) => entry.docId === deepDocId) ?? null;

          const historyPageStart = performance.now();
          const historyPage = await db.getDocumentHistoryPage(deepDocId, {
            limit: 50,
          });
          const historyPageMs = performance.now() - historyPageStart;

          const timestampStart = performance.now();
          const historicalDoc = await db.getDocumentAtTimestamp(
            deepDocId,
            hotPathTimestamps[Math.floor(hotPathTimestamps.length / 2)] ?? Date.now()
          );
          const timestampMs = performance.now() - timestampStart;

          const iterateMetadataStart = performance.now();
          let iteratedMetadataDocs = 0;
          for await (const _result of db.iterateChangeMetadataSince(null)) {
            iteratedMetadataDocs++;
          }
          const iterateMetadataMs = performance.now() - iterateMetadataStart;

          const iterateStart = performance.now();
          let iteratedDocs = 0;
          for await (const _result of db.iterateChangesSince(null)) {
            iteratedDocs++;
          }
          const iterateMs = performance.now() - iterateStart;

          const latestLoadDurations = reopenMetrics.documentLoads.map(
            (entry) => Number(entry.totalTime ?? 0)
          );
          const cacheMissDocumentLoads = reopenMetrics.documentLoads.filter(
            (entry) => !entry.cacheHit
          );
          const syncOpDurations = reopenMetrics.syncOps
            .filter((entry) => typeof entry.time === "number")
            .map((entry) => Number(entry.time));
          const historyOpDurations = reopenMetrics.historyOps
            .filter((entry) => typeof entry.time === "number")
            .map((entry) => Number(entry.time));

          const store = db.getStore() as {
            planDocumentMaterializationBatch: (
              docIds: string[],
              options?: Record<string, unknown>
            ) => Promise<{ plans: Array<{ docId: string }> }>;
            clearAllLocalData?: () => Promise<void>;
          };
          const sampleDocIds = docIds.slice(0, Math.min(100, docIds.length));
          const batchPlanStart = performance.now();
          const batchPlan = await store.planDocumentMaterializationBatch(
            sampleDocIds,
            { includeDiagnostics: true }
          );
          const batchPlanMs = performance.now() - batchPlanStart;

          try {
            return {
              docCount: dataset.realDbDocCount + 1,
              latestStateMetadataDocsIterated: iteratedMetadataDocs,
              latestStateDocsIterated: iteratedDocs,
              startupMs: Number(startupMs.toFixed(2)),
              iterateMetadataMs: Number(iterateMetadataMs.toFixed(2)),
              iterateMs: Number(iterateMs.toFixed(2)),
              latestDocLoadMs: Number(latestDocLoadMs.toFixed(2)),
              historyPageMs: Number(historyPageMs.toFixed(2)),
              timestampMs: Number(timestampMs.toFixed(2)),
              batchPlanMs: Number(batchPlanMs.toFixed(2)),
              batchPlanDocs: batchPlan.plans.length,
              deepDocDeleted: historicalDoc?.isDeleted?.() ?? null,
              deepDocLatestVersion:
                (deepDocLoaded.getData() as Record<string, unknown>).version ?? null,
              historyPageSize: historyPage.entries.length,
              documentLoadSummary: summarize(latestLoadDurations),
              documentLoadStageSummary: {
                metadataEntriesScanned: summarizeDocumentLoadField(
                  reopenMetrics.documentLoads,
                  "metadataEntriesScanned"
                ),
                replayEntriesLoaded: summarizeDocumentLoadField(
                  reopenMetrics.documentLoads,
                  "replayEntriesLoaded"
                ),
                cacheCheckTime: summarizeDocumentLoadField(
                  reopenMetrics.documentLoads,
                  "cacheCheckTime"
                ),
                storeQueryTime: summarizeDocumentLoadField(
                  reopenMetrics.documentLoads,
                  "storeQueryTime"
                ),
                entryLoadTime: summarizeDocumentLoadField(
                  reopenMetrics.documentLoads,
                  "entryLoadTime"
                ),
                signatureVerificationTime: summarizeDocumentLoadField(
                  reopenMetrics.documentLoads,
                  "signatureVerificationTime"
                ),
                decryptionTime: summarizeDocumentLoadField(
                  reopenMetrics.documentLoads,
                  "decryptionTime"
                ),
                automergeTime: summarizeDocumentLoadField(
                  reopenMetrics.documentLoads,
                  "automergeTime"
                ),
              },
              cacheMissDocumentLoadStageSummary: {
                metadataEntriesScanned: summarizeDocumentLoadField(
                  cacheMissDocumentLoads,
                  "metadataEntriesScanned"
                ),
                replayEntriesLoaded: summarizeDocumentLoadField(
                  cacheMissDocumentLoads,
                  "replayEntriesLoaded"
                ),
                cacheCheckTime: summarizeDocumentLoadField(
                  cacheMissDocumentLoads,
                  "cacheCheckTime"
                ),
                storeQueryTime: summarizeDocumentLoadField(
                  cacheMissDocumentLoads,
                  "storeQueryTime"
                ),
                entryLoadTime: summarizeDocumentLoadField(
                  cacheMissDocumentLoads,
                  "entryLoadTime"
                ),
                signatureVerificationTime: summarizeDocumentLoadField(
                  cacheMissDocumentLoads,
                  "signatureVerificationTime"
                ),
                decryptionTime: summarizeDocumentLoadField(
                  cacheMissDocumentLoads,
                  "decryptionTime"
                ),
                automergeTime: summarizeDocumentLoadField(
                  cacheMissDocumentLoads,
                  "automergeTime"
                ),
              },
              latestDocLoadBreakdown: latestDocLoadMetric
                ? {
                    cacheHit: latestDocLoadMetric.cacheHit,
                    snapshotUsed: latestDocLoadMetric.snapshotUsed,
                    metadataEntriesScanned: latestDocLoadMetric.metadataEntriesScanned,
                    replayEntriesLoaded: latestDocLoadMetric.replayEntriesLoaded,
                    cacheCheckTime: Number(latestDocLoadMetric.cacheCheckTime.toFixed(2)),
                    storeQueryTime: Number(latestDocLoadMetric.storeQueryTime.toFixed(2)),
                    entryLoadTime: Number(latestDocLoadMetric.entryLoadTime.toFixed(2)),
                    signatureVerificationTime: Number(
                      latestDocLoadMetric.signatureVerificationTime.toFixed(2)
                    ),
                    decryptionTime: Number(
                      latestDocLoadMetric.decryptionTime.toFixed(2)
                    ),
                    automergeTime: Number(latestDocLoadMetric.automergeTime.toFixed(2)),
                    totalTime: Number(latestDocLoadMetric.totalTime.toFixed(2)),
                  }
                : null,
              syncOpSummary: summarize(syncOpDurations),
              historyOpSummary: summarize(historyOpDurations),
              syncOpKinds: Array.from(
                new Set(reopenMetrics.syncOps.map((entry) => String(entry.operation)))
              ).sort(),
            };
          } finally {
            await store.clearAllLocalData?.();
          }
        };

        const rawStore = await profileRawStore();
        const realDb = await profileRealDb();
        return { dataset, rawStore, realDb };
      },
      {
        browserBundleUrl: server.context.browserBundleUrl,
        dataset,
      }
    );

    console.log(
      `\nIndexedDB profile baseline:\n${JSON.stringify(result, null, 2)}\n`
    );
  });
});
