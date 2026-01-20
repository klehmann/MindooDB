import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { PrivateUserId, MindooTenant, MindooDB, MindooDoc, ProcessChangesCursor, SigningKeyPair, PUBLIC_INFOS_KEY_ID } from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

interface PerformanceMetrics {
  phase: string;
  duration: number;
  memoryBefore: NodeJS.MemoryUsage | null;
  memoryAfter: NodeJS.MemoryUsage | null;
  details?: Record<string, any>;
}

interface DetailedMetrics {
  createDoc: {
    total: number;
    perDoc: number[];
    avg: number;
    min: number;
    max: number;
  };
  changeDoc: {
    total: number;
    perDoc: number[];
    avg: number;
    min: number;
    max: number;
  };
  sync: {
    total: number;
    findNewEntries: number;
    processDocuments: number;
    perDocument: number[];
  };
  iterate: {
    total: number;
    binarySearch: number;
    perDocument: number[];
    avg: number;
    min: number;
    max: number;
  };
}

function getMemoryUsage(): NodeJS.MemoryUsage | null {
  if (typeof process !== 'undefined' && process.memoryUsage) {
    return process.memoryUsage();
  }
  return null;
}

function formatMemory(mem: NodeJS.MemoryUsage | null): string {
  if (!mem) return 'N/A';
  return `heapUsed: ${(mem.heapUsed / 1024 / 1024).toFixed(2)}MB, heapTotal: ${(mem.heapTotal / 1024 / 1024).toFixed(2)}MB, rss: ${(mem.rss / 1024 / 1024).toFixed(2)}MB`;
}

function calculateStats(timings: number[]): { avg: number; min: number; max: number; total: number } {
  if (timings.length === 0) {
    return { avg: 0, min: 0, max: 0, total: 0 };
  }
  const total = timings.reduce((a, b) => a + b, 0);
  return {
    total,
    avg: total / timings.length,
    min: Math.min(...timings),
    max: Math.max(...timings),
  };
}

describe("Performance Profiling", () => {
  let factory: BaseMindooTenantFactory;
  let storeFactory: InMemoryContentAddressedStoreFactory;
  let adminUser: PrivateUserId;
  let adminUserPassword: string;
  let adminKeyBag: KeyBag;
  let adminSigningKeyPair: SigningKeyPair;
  let adminSigningKeyPassword: string;
  let tenant: MindooTenant;
  let tenantId: string;
  let tenantEncryptionKeyPassword: string;

  beforeEach(async () => {
    storeFactory = new InMemoryContentAddressedStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());
    
    adminUserPassword = "adminpass123";
    adminUser = await factory.createUserId("CN=admin/O=testtenant", adminUserPassword);
    
    adminSigningKeyPassword = "adminsigningpass123";
    adminSigningKeyPair = await factory.createSigningKeyPair(adminSigningKeyPassword);
    
    const adminEncryptionKeyPair = await factory.createEncryptionKeyPair("adminencpass123");
    
    tenantEncryptionKeyPassword = "tenantkeypass123";
    const tenantEncryptionKey = await factory.createSymmetricEncryptedPrivateKey(tenantEncryptionKeyPassword);
    
    const publicInfosKey = await factory.createSymmetricEncryptedPrivateKey("publicinfospass123");
    
    const cryptoAdapter = new NodeCryptoAdapter();
    adminKeyBag = new KeyBag(
      adminUser.userEncryptionKeyPair.privateKey,
      adminUserPassword,
      cryptoAdapter
    );
    
    await adminKeyBag.decryptAndImportKey(PUBLIC_INFOS_KEY_ID, publicInfosKey, "publicinfospass123");
    
    tenantId = "test-tenant-perf";
    tenant = await factory.openTenantWithKeys(
      tenantId,
      tenantEncryptionKey,
      tenantEncryptionKeyPassword,
      adminSigningKeyPair.publicKey,
      adminEncryptionKeyPair.publicKey,
      adminUser,
      adminUserPassword,
      adminKeyBag
    );
    
    const directory = await tenant.openDirectory();
    const publicAdminUser = factory.toPublicUserId(adminUser);
    await directory.registerUser(
      publicAdminUser,
      adminSigningKeyPair.privateKey,
      adminSigningKeyPassword
    );
  }, 30000);

  it("should profile creating 1500 docs, sync, and iterateChangesSince", async () => {
    const numDocs = 1500;
    const metrics: PerformanceMetrics[] = [];
    const detailedMetrics: Partial<DetailedMetrics> = {
      createDoc: { total: 0, perDoc: [], avg: 0, min: 0, max: 0 },
      changeDoc: { total: 0, perDoc: [], avg: 0, min: 0, max: 0 },
      sync: { total: 0, findNewEntries: 0, processDocuments: 0, perDocument: [] },
      iterate: { total: 0, binarySearch: 0, perDocument: [], avg: 0, min: 0, max: 0 },
    };

    const db = await tenant.openDB("test-db");
    
    // Phase 1: Create documents
    console.log("\n=== PHASE 1: Creating Documents ===");
    const createStart = performance.now();
    const createMemoryBefore = getMemoryUsage();
    
    const createDocTimings: number[] = [];
    const changeDocTimings: number[] = [];
    const createdDocIds: string[] = [];
    
    for (let i = 0; i < numDocs; i++) {
      // Time document creation
      const createDocStart = performance.now();
      const doc = await db.createDocument();
      createDocTimings.push(performance.now() - createDocStart);
      
      const docId = doc.getId();
      createdDocIds.push(docId);
      
      // Time document modification
      const changeDocStart = performance.now();
      await db.changeDoc(doc, (d) => {
        const data = d.getData();
        data.index = i;
        data.timestamp = Date.now();
        data.value = `doc-${i}`;
      });
      changeDocTimings.push(performance.now() - changeDocStart);
      
      // Progress indicator
      if ((i + 1) % 100 === 0) {
        console.log(`Created ${i + 1}/${numDocs} documents`);
      }
    }
    
    const createEnd = performance.now();
    const createMemoryAfter = getMemoryUsage();
    const createDuration = createEnd - createStart;
    
    detailedMetrics.createDoc = {
      ...calculateStats(createDocTimings),
      perDoc: createDocTimings,
    };
    
    detailedMetrics.changeDoc = {
      ...calculateStats(changeDocTimings),
      perDoc: changeDocTimings,
    };
    
    metrics.push({
      phase: "create-documents",
      duration: createDuration,
      memoryBefore: createMemoryBefore,
      memoryAfter: createMemoryAfter,
      details: {
        numDocs,
        createDocStats: detailedMetrics.createDoc,
        changeDocStats: detailedMetrics.changeDoc,
      },
    });
    
    console.log(`\nCreated ${numDocs} documents in ${createDuration.toFixed(2)}ms`);
    console.log(`  Create doc: avg=${detailedMetrics.createDoc!.avg.toFixed(2)}ms, min=${detailedMetrics.createDoc!.min.toFixed(2)}ms, max=${detailedMetrics.createDoc!.max.toFixed(2)}ms`);
    console.log(`  Change doc: avg=${detailedMetrics.changeDoc!.avg.toFixed(2)}ms, min=${detailedMetrics.changeDoc!.min.toFixed(2)}ms, max=${detailedMetrics.changeDoc!.max.toFixed(2)}ms`);
    console.log(`  Memory: ${formatMemory(createMemoryAfter)}`);
    
    // Phase 2: Sync (incremental update)
    console.log("\n=== PHASE 2: Syncing Store Changes ===");
    const syncStart = performance.now();
    const syncMemoryBefore = getMemoryUsage();
    
    await db.syncStoreChanges();
    
    const syncEnd = performance.now();
    const syncMemoryAfter = getMemoryUsage();
    const syncDuration = syncEnd - syncStart;
    
    metrics.push({
      phase: "sync-store-changes",
      duration: syncDuration,
      memoryBefore: syncMemoryBefore,
      memoryAfter: syncMemoryAfter,
    });
    
    console.log(`Synced store changes in ${syncDuration.toFixed(2)}ms`);
    console.log(`  Memory: ${formatMemory(syncMemoryAfter)}`);
    
    // Phase 3: Iterate changes since
    console.log("\n=== PHASE 3: Iterating Changes Since ===");
    const iterateStart = performance.now();
    const iterateMemoryBefore = getMemoryUsage();
    
    const iterateDocTimings: number[] = [];
    let docCount = 0;
    let firstDocTime = 0;
    
    for await (const { doc, cursor } of db.iterateChangesSince(null)) {
      const docStart = performance.now();
      
      // Simulate processing the document
      const docId = doc.getId();
      const data = doc.getData();
      const isDeleted = doc.isDeleted();
      
      if (docCount === 0) {
        firstDocTime = performance.now() - iterateStart;
      }
      
      iterateDocTimings.push(performance.now() - docStart);
      docCount++;
      
      // Progress indicator
      if (docCount % 100 === 0) {
        console.log(`Iterated ${docCount}/${numDocs} documents`);
      }
    }
    
    const iterateEnd = performance.now();
    const iterateMemoryAfter = getMemoryUsage();
    const iterateDuration = iterateEnd - iterateStart;
    
    detailedMetrics.iterate = {
      ...calculateStats(iterateDocTimings),
      perDocument: iterateDocTimings,
      total: iterateDuration,
      binarySearch: 0, // Would need internal access to measure
    };
    
    metrics.push({
      phase: "iterate-changes-since",
      duration: iterateDuration,
      memoryBefore: iterateMemoryBefore,
      memoryAfter: iterateMemoryAfter,
      details: {
        docCount,
        firstDocTime,
        iterateStats: detailedMetrics.iterate,
      },
    });
    
    console.log(`Iterated ${docCount} documents in ${iterateDuration.toFixed(2)}ms`);
    console.log(`  First doc time: ${firstDocTime.toFixed(2)}ms`);
    console.log(`  Per doc: avg=${detailedMetrics.iterate!.avg.toFixed(2)}ms, min=${detailedMetrics.iterate!.min.toFixed(2)}ms, max=${detailedMetrics.iterate!.max.toFixed(2)}ms`);
    console.log(`  Memory: ${formatMemory(iterateMemoryAfter)}`);
    
    // Summary Report
    console.log("\n=== PERFORMANCE SUMMARY ===");
    console.log(`Total time: ${(createDuration + syncDuration + iterateDuration).toFixed(2)}ms`);
    console.log(`\nBreakdown:`);
    console.log(`  Create ${numDocs} docs: ${createDuration.toFixed(2)}ms (${((createDuration / (createDuration + syncDuration + iterateDuration)) * 100).toFixed(1)}%)`);
    console.log(`  Sync: ${syncDuration.toFixed(2)}ms (${((syncDuration / (createDuration + syncDuration + iterateDuration)) * 100).toFixed(1)}%)`);
    console.log(`  Iterate: ${iterateDuration.toFixed(2)}ms (${((iterateDuration / (createDuration + syncDuration + iterateDuration)) * 100).toFixed(1)}%)`);
    
    console.log(`\nMemory Growth:`);
    if (createMemoryBefore && createMemoryAfter) {
      const heapGrowth = (createMemoryAfter.heapUsed - createMemoryBefore.heapUsed) / 1024 / 1024;
      console.log(`  After create: +${heapGrowth.toFixed(2)}MB`);
    }
    if (syncMemoryBefore && syncMemoryAfter) {
      const heapGrowth = (syncMemoryAfter.heapUsed - syncMemoryBefore.heapUsed) / 1024 / 1024;
      console.log(`  After sync: +${heapGrowth.toFixed(2)}MB`);
    }
    if (iterateMemoryBefore && iterateMemoryAfter) {
      const heapGrowth = (iterateMemoryAfter.heapUsed - iterateMemoryBefore.heapUsed) / 1024 / 1024;
      console.log(`  After iterate: +${heapGrowth.toFixed(2)}MB`);
    }
    
    // Throughput calculations
    console.log(`\nThroughput:`);
    console.log(`  Create: ${(numDocs / (createDuration / 1000)).toFixed(2)} docs/sec`);
    console.log(`  Iterate: ${(docCount / (iterateDuration / 1000)).toFixed(2)} docs/sec`);
    
    // Verify we got all documents
    expect(docCount).toBe(numDocs);
    
    // Store metrics for analysis (could write to file)
    const summary = {
      numDocs,
      totalTime: createDuration + syncDuration + iterateDuration,
      phases: metrics,
      detailed: detailedMetrics,
    };
    
    // Uncomment to write JSON report
    const fs = require('fs');
    fs.writeFileSync('performance-report.json', JSON.stringify(summary, null, 2));
    
  }, 300000); // 5 minute timeout
});
