import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { PrivateUserId, MindooTenant, MindooDB, MindooDoc, SigningKeyPair, AttachmentReference } from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

describe("Attachments", () => {
  let factory: BaseMindooTenantFactory;
  let storeFactory: InMemoryContentAddressedStoreFactory;
  let currentUser: PrivateUserId;
  let currentUserPassword: string;
  let keyBag: KeyBag;
  let tenant: MindooTenant;
  let db: MindooDB;
  let adminSigningKeyPair: SigningKeyPair;

  beforeEach(async () => {
    storeFactory = new InMemoryContentAddressedStoreFactory();
    factory = new BaseMindooTenantFactory(storeFactory, new NodeCryptoAdapter());
    currentUserPassword = "userpassword123";
    currentUser = await factory.createUserId("CN=testuser/O=testtenant", currentUserPassword);
    
    // Create KeyBag with user's encryption key
    keyBag = new KeyBag(
      currentUser.userEncryptionKeyPair.privateKey,
      currentUserPassword,
      factory.getCryptoAdapter()
    );

    // Create admin signing key pair
    const administrationKeyPassword = "adminpass123";
    adminSigningKeyPair = await factory.createSigningKeyPair(administrationKeyPassword);

    // Create tenant
    const tenantId = "test-tenant-attachments";
    const tenantEncryptionKeyPassword = "tenantkeypass123";
    tenant = await factory.createTenant(
      tenantId,
      adminSigningKeyPair.publicKey,
      tenantEncryptionKeyPassword,
      currentUser,
      currentUserPassword,
      keyBag
    );

    // Register the current user in the directory
    const directory = await tenant.openDirectory();
    const publicUser = factory.toPublicUserId(currentUser);
    await directory.registerUser(
      publicUser,
      adminSigningKeyPair.privateKey,
      administrationKeyPassword
    );

    // Open database
    db = await tenant.openDB("test-db");
  }, 30000); // Increase timeout for crypto operations

  describe("addAttachment", () => {
    it("should add attachment within changeDoc", async () => {
      // Create a document
      const doc = await db.createDocument();
      
      // Add attachment within changeDoc
      const testData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      let attachmentRef: AttachmentReference | undefined;
      
      await db.changeDoc(doc, async (d) => {
        attachmentRef = await d.addAttachment(testData, "test.bin", "application/octet-stream");
      });
      
      // Verify attachment was added
      expect(attachmentRef).toBeDefined();
      expect(attachmentRef!.fileName).toBe("test.bin");
      expect(attachmentRef!.mimeType).toBe("application/octet-stream");
      expect(attachmentRef!.size).toBe(10);
      
      // Reload document and verify attachment is present
      const reloadedDoc = await db.getDocument(doc.getId());
      const attachments = reloadedDoc.getAttachments();
      expect(attachments.length).toBe(1);
      expect(attachments[0].attachmentId).toBe(attachmentRef!.attachmentId);
    }, 30000);

    it("should throw error when addAttachment is called outside changeDoc", async () => {
      const doc = await db.createDocument();
      const testData = new Uint8Array([1, 2, 3, 4, 5]);
      
      await expect(doc.addAttachment(testData, "test.bin", "application/octet-stream"))
        .rejects.toThrow("addAttachment() can only be called within changeDoc() callback");
    }, 30000);

    it("should throw error when getData() is modified outside changeDoc", async () => {
      const doc = await db.createDocument();
      
      // Set initial data
      await db.changeDoc(doc, (d) => {
        d.getData().title = "Initial title";
        d.getData().count = 5;
      });
      
      // Get a fresh reference to the document
      const readonlyDoc = await db.getDocument(doc.getId());
      
      // Attempting to modify getData() on a document outside of changeDoc should throw
      expect(() => {
        readonlyDoc.getData().title = "Modified title";
      }).toThrow("Cannot modify property 'title' on read-only document. Use changeDoc() to modify documents.");
      
      // Deleting properties should also throw
      expect(() => {
        delete (readonlyDoc.getData() as Record<string, unknown>).title;
      }).toThrow("Cannot delete property 'title' on read-only document. Use changeDoc() to modify documents.");
      
      // Nested object modifications should also throw
      await db.changeDoc(readonlyDoc, (d) => {
        d.getData().nested = { value: 42 };
      });
      
      const docWithNested = await db.getDocument(doc.getId());
      expect(() => {
        (docWithNested.getData().nested as Record<string, unknown>).value = 100;
      }).toThrow("Cannot modify property 'value' on read-only document. Use changeDoc() to modify documents.");
      
      // Verify the original data is unchanged
      const finalDoc = await db.getDocument(doc.getId());
      expect(finalDoc.getData().title).toBe("Initial title");
      expect(finalDoc.getData().count).toBe(5);
      expect((finalDoc.getData().nested as Record<string, unknown>).value).toBe(42);
    }, 30000);

    it("should throw error when captured doc reference is used after callback completes", async () => {
      const doc = await db.createDocument();
      let capturedDoc: any;
      
      // Capture the doc reference from inside the callback
      await db.changeDoc(doc, async (d) => {
        capturedDoc = d;
        d.getData().title = "Initial title";
      });
      
      // Attempt to use the captured reference after callback - should throw
      expect(() => {
        capturedDoc.getData().title = "Modified after callback";
      }).toThrow("cannot be called after changeDoc() callback has completed");
      
      // Attachment methods should also throw
      await expect(capturedDoc.addAttachment(new Uint8Array([1, 2, 3]), "test.bin", "application/octet-stream"))
        .rejects.toThrow("cannot be called after changeDoc() callback has completed");
      
      await expect(capturedDoc.addAttachmentStream((async function*() { yield new Uint8Array([1]); })(), "test.bin", "application/octet-stream"))
        .rejects.toThrow("cannot be called after changeDoc() callback has completed");
    }, 30000);

    it("should add multiple attachments in one changeDoc call", async () => {
      const doc = await db.createDocument();
      
      const testData1 = new Uint8Array([1, 2, 3, 4, 5]);
      const testData2 = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
      let ref1: AttachmentReference | undefined;
      let ref2: AttachmentReference | undefined;
      
      await db.changeDoc(doc, async (d) => {
        ref1 = await d.addAttachment(testData1, "file1.bin", "application/octet-stream");
        ref2 = await d.addAttachment(testData2, "file2.bin", "application/octet-stream");
      });
      
      expect(ref1).toBeDefined();
      expect(ref2).toBeDefined();
      
      const reloadedDoc = await db.getDocument(doc.getId());
      const attachments = reloadedDoc.getAttachments();
      expect(attachments.length).toBe(2);
    }, 30000);
  });

  describe("getAttachment", () => {
    it("should retrieve attachment data correctly", async () => {
      const doc = await db.createDocument();
      const testData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      let attachmentId: string | undefined;
      
      await db.changeDoc(doc, async (d) => {
        const ref = await d.addAttachment(testData, "test.bin", "application/octet-stream");
        attachmentId = ref.attachmentId;
      });
      
      // Reload and retrieve attachment
      const reloadedDoc = await db.getDocument(doc.getId());
      const retrievedData = await reloadedDoc.getAttachment(attachmentId!);
      
      expect(retrievedData).toEqual(testData);
    }, 30000);

    it("should throw error for non-existent attachment", async () => {
      const doc = await db.createDocument();
      
      await expect(doc.getAttachment("non-existent-id"))
        .rejects.toThrow("Attachment non-existent-id not found");
    }, 30000);
  });

  describe("getAttachmentRange", () => {
    it("should retrieve byte range correctly", async () => {
      const doc = await db.createDocument();
      // Create data larger than one chunk to test range across chunks
      const testData = new Uint8Array(1000);
      for (let i = 0; i < testData.length; i++) {
        testData[i] = i % 256;
      }
      let attachmentId: string | undefined;
      
      await db.changeDoc(doc, async (d) => {
        const ref = await d.addAttachment(testData, "test.bin", "application/octet-stream");
        attachmentId = ref.attachmentId;
      });
      
      // Retrieve a range
      const reloadedDoc = await db.getDocument(doc.getId());
      const rangeData = await reloadedDoc.getAttachmentRange(attachmentId!, 100, 200);
      
      expect(rangeData.length).toBe(100);
      expect(rangeData).toEqual(testData.slice(100, 200));
    }, 30000);

    it("should throw error for invalid range", async () => {
      const doc = await db.createDocument();
      const testData = new Uint8Array([1, 2, 3, 4, 5]);
      let attachmentId: string | undefined;
      
      await db.changeDoc(doc, async (d) => {
        const ref = await d.addAttachment(testData, "test.bin", "application/octet-stream");
        attachmentId = ref.attachmentId;
      });
      
      const reloadedDoc = await db.getDocument(doc.getId());
      
      // End byte exceeds size
      await expect(reloadedDoc.getAttachmentRange(attachmentId!, 0, 100))
        .rejects.toThrow("End byte 100 exceeds attachment size 5");
      
      // Invalid range (start >= end)
      await expect(reloadedDoc.getAttachmentRange(attachmentId!, 5, 3))
        .rejects.toThrow("Invalid byte range");
    }, 30000);
  });

  describe("removeAttachment", () => {
    it("should remove attachment within changeDoc", async () => {
      const doc = await db.createDocument();
      const testData = new Uint8Array([1, 2, 3, 4, 5]);
      let attachmentId: string | undefined;
      
      // Add attachment
      await db.changeDoc(doc, async (d) => {
        const ref = await d.addAttachment(testData, "test.bin", "application/octet-stream");
        attachmentId = ref.attachmentId;
      });
      
      // Verify it exists
      let reloadedDoc = await db.getDocument(doc.getId());
      expect(reloadedDoc.getAttachments().length).toBe(1);
      
      // Remove attachment
      await db.changeDoc(reloadedDoc, async (d) => {
        await d.removeAttachment(attachmentId!);
      });
      
      // Verify it's gone
      reloadedDoc = await db.getDocument(doc.getId());
      expect(reloadedDoc.getAttachments().length).toBe(0);
    }, 30000);

    it("should throw error when removeAttachment is called outside changeDoc", async () => {
      const doc = await db.createDocument();
      
      await expect(doc.removeAttachment("some-id"))
        .rejects.toThrow("removeAttachment() can only be called within changeDoc() callback");
    }, 30000);

    it("should throw error when removing non-existent attachment", async () => {
      const doc = await db.createDocument();
      
      await expect(db.changeDoc(doc, async (d) => {
        await d.removeAttachment("non-existent-id");
      })).rejects.toThrow("Attachment non-existent-id not found");
    }, 30000);
  });

  describe("appendToAttachment", () => {
    it("should append data to existing attachment", async () => {
      const doc = await db.createDocument();
      const initialData = new Uint8Array([1, 2, 3, 4, 5]);
      const appendData = new Uint8Array([6, 7, 8, 9, 10]);
      let attachmentId: string | undefined;
      
      // Add initial attachment
      await db.changeDoc(doc, async (d) => {
        const ref = await d.addAttachment(initialData, "test.bin", "application/octet-stream");
        attachmentId = ref.attachmentId;
      });
      
      // Append data
      let reloadedDoc = await db.getDocument(doc.getId());
      await db.changeDoc(reloadedDoc, async (d) => {
        await d.appendToAttachment(attachmentId!, appendData);
      });
      
      // Verify size increased
      reloadedDoc = await db.getDocument(doc.getId());
      const attachments = reloadedDoc.getAttachments();
      expect(attachments.length).toBe(1);
      expect(attachments[0].size).toBe(10); // 5 + 5
      
      // Verify full data can be retrieved
      const fullData = await reloadedDoc.getAttachment(attachmentId!);
      expect(fullData).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    }, 30000);

    it("should throw error when appendToAttachment is called outside changeDoc", async () => {
      const doc = await db.createDocument();
      const appendData = new Uint8Array([1, 2, 3]);
      
      await expect(doc.appendToAttachment("some-id", appendData))
        .rejects.toThrow("appendToAttachment() can only be called within changeDoc() callback");
    }, 30000);
  });

  describe("streamAttachment", () => {
    it("should stream all chunks from start", async () => {
      const doc = await db.createDocument();
      // Create data that spans multiple chunks
      const testData = new Uint8Array(1000);
      for (let i = 0; i < testData.length; i++) {
        testData[i] = i % 256;
      }
      let attachmentId: string | undefined;
      
      await db.changeDoc(doc, async (d) => {
        const ref = await d.addAttachment(testData, "test.bin", "application/octet-stream");
        attachmentId = ref.attachmentId;
      });
      
      // Stream and collect all chunks
      const reloadedDoc = await db.getDocument(doc.getId());
      const chunks: Uint8Array[] = [];
      for await (const chunk of reloadedDoc.streamAttachment(attachmentId!)) {
        chunks.push(chunk);
      }
      
      // Concatenate and verify
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      expect(totalLength).toBe(testData.length);
      
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      expect(result).toEqual(testData);
    }, 30000);

    it("should stream from offset", async () => {
      const doc = await db.createDocument();
      const testData = new Uint8Array(1000);
      for (let i = 0; i < testData.length; i++) {
        testData[i] = i % 256;
      }
      let attachmentId: string | undefined;
      
      await db.changeDoc(doc, async (d) => {
        const ref = await d.addAttachment(testData, "test.bin", "application/octet-stream");
        attachmentId = ref.attachmentId;
      });
      
      // Stream from offset 500
      const reloadedDoc = await db.getDocument(doc.getId());
      const chunks: Uint8Array[] = [];
      for await (const chunk of reloadedDoc.streamAttachment(attachmentId!, 500)) {
        chunks.push(chunk);
      }
      
      // Verify we got 500 bytes (from offset 500 to end at 1000)
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      expect(totalLength).toBe(500);
      
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      expect(result).toEqual(testData.slice(500));
    }, 30000);

    it("should support early break in streaming", async () => {
      const doc = await db.createDocument();
      const testData = new Uint8Array(10000); // Larger data
      for (let i = 0; i < testData.length; i++) {
        testData[i] = i % 256;
      }
      let attachmentId: string | undefined;
      
      await db.changeDoc(doc, async (d) => {
        const ref = await d.addAttachment(testData, "test.bin", "application/octet-stream");
        attachmentId = ref.attachmentId;
      });
      
      // Stream but break early after first chunk
      const reloadedDoc = await db.getDocument(doc.getId());
      let chunkCount = 0;
      for await (const chunk of reloadedDoc.streamAttachment(attachmentId!)) {
        chunkCount++;
        if (chunkCount >= 1) break; // Break after first chunk
      }
      
      expect(chunkCount).toBe(1);
    }, 30000);
  });

  describe("deterministic encryption deduplication", () => {
    it("should produce same contentHash for identical content", async () => {
      const doc1 = await db.createDocument();
      const doc2 = await db.createDocument();
      const testData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      
      // Add same data as attachments to two different documents
      await db.changeDoc(doc1, async (d) => {
        await d.addAttachment(testData, "file1.bin", "application/octet-stream");
      });
      
      await db.changeDoc(doc2, async (d) => {
        await d.addAttachment(testData, "file2.bin", "application/octet-stream");
      });
      
      // Get the attachment store and check for deduplication
      const attachmentStore = db.getAttachmentStore() || db.getStore();
      const allIds = await attachmentStore.getAllIds();
      
      // Filter to just attachment chunks
      const attachmentChunkIds = allIds.filter(id => id.includes('_a_'));
      
      // With two identical files, we should have two chunk entries
      // but they should reference the same content (deduplication)
      expect(attachmentChunkIds.length).toBe(2);
      
      // Get entries and verify they have the same contentHash
      const entries = await attachmentStore.getEntries(attachmentChunkIds);
      const contentHashes = entries.map(e => e.contentHash);
      expect(contentHashes[0]).toBe(contentHashes[1]); // Same content should have same hash
    }, 30000);
  });

  describe("getAttachments", () => {
    it("should return empty array for document without attachments", async () => {
      const doc = await db.createDocument();
      expect(doc.getAttachments()).toEqual([]);
    }, 30000);

    it("should return all attachments", async () => {
      const doc = await db.createDocument();
      
      await db.changeDoc(doc, async (d) => {
        await d.addAttachment(new Uint8Array([1, 2, 3]), "file1.txt", "text/plain");
        await d.addAttachment(new Uint8Array([4, 5, 6]), "file2.txt", "text/plain");
      });
      
      const reloadedDoc = await db.getDocument(doc.getId());
      const attachments = reloadedDoc.getAttachments();
      
      expect(attachments.length).toBe(2);
      expect(attachments.map(a => a.fileName).sort()).toEqual(["file1.txt", "file2.txt"]);
    }, 30000);

    it("should reflect pending changes inside changeDoc", async () => {
      const doc = await db.createDocument();
      
      // Add initial attachment
      await db.changeDoc(doc, async (d) => {
        await d.addAttachment(new Uint8Array([1, 2, 3]), "file1.txt", "text/plain");
      });
      
      // Inside changeDoc, getAttachments should show pending additions and respect removals
      const reloadedDoc = await db.getDocument(doc.getId());
      await db.changeDoc(reloadedDoc, async (d) => {
        // Current state should show 1 attachment
        expect(d.getAttachments().length).toBe(1);
        
        // Add another
        await d.addAttachment(new Uint8Array([4, 5, 6]), "file2.txt", "text/plain");
        
        // Should now show 2 attachments (including pending)
        expect(d.getAttachments().length).toBe(2);
      });
    }, 30000);
  });

  describe("large attachments", () => {
    it("should handle attachments larger than chunk size", async () => {
      const doc = await db.createDocument();
      
      // Create 1MB of data (larger than default 256KB chunk size)
      const testData = new Uint8Array(1024 * 1024);
      for (let i = 0; i < testData.length; i++) {
        testData[i] = i % 256;
      }
      
      let attachmentId: string | undefined;
      await db.changeDoc(doc, async (d) => {
        const ref = await d.addAttachment(testData, "large.bin", "application/octet-stream");
        attachmentId = ref.attachmentId;
      });
      
      // Reload and retrieve
      const reloadedDoc = await db.getDocument(doc.getId());
      const retrievedData = await reloadedDoc.getAttachment(attachmentId!);
      
      expect(retrievedData.length).toBe(testData.length);
      expect(retrievedData).toEqual(testData);
    }, 60000); // Longer timeout for large file
  });

  describe("addAttachmentStream", () => {
    // Helper: Create an async generator from Uint8Array chunks
    async function* chunksToStream(chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
      for (const chunk of chunks) {
        yield chunk;
      }
    }

    // Helper: Create an async generator from a Uint8Array with custom chunk size
    async function* dataToStream(data: Uint8Array, streamChunkSize: number): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < data.length; i += streamChunkSize) {
        yield data.slice(i, Math.min(i + streamChunkSize, data.length));
      }
    }

    it("should add attachment from stream within changeDoc", async () => {
      const doc = await db.createDocument();
      
      // Create test data as stream of small chunks
      const testData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const stream = chunksToStream([
        new Uint8Array([1, 2, 3]),
        new Uint8Array([4, 5, 6]),
        new Uint8Array([7, 8, 9, 10])
      ]);
      
      let attachmentRef: AttachmentReference | undefined;
      
      await db.changeDoc(doc, async (d) => {
        attachmentRef = await d.addAttachmentStream(stream, "streamed.bin", "application/octet-stream");
      });
      
      // Verify attachment was added
      expect(attachmentRef).toBeDefined();
      expect(attachmentRef!.fileName).toBe("streamed.bin");
      expect(attachmentRef!.mimeType).toBe("application/octet-stream");
      expect(attachmentRef!.size).toBe(10);
      
      // Verify data can be retrieved correctly
      const reloadedDoc = await db.getDocument(doc.getId());
      const retrievedData = await reloadedDoc.getAttachment(attachmentRef!.attachmentId);
      expect(retrievedData).toEqual(testData);
    }, 30000);

    it("should throw error when addAttachmentStream is called outside changeDoc", async () => {
      const doc = await db.createDocument();
      const stream = chunksToStream([new Uint8Array([1, 2, 3])]);
      
      await expect(doc.addAttachmentStream(stream, "test.bin", "application/octet-stream"))
        .rejects.toThrow("addAttachmentStream() can only be called within changeDoc() callback");
    }, 30000);

    it("should handle large streaming attachment larger than chunk size", async () => {
      const doc = await db.createDocument();
      
      // Create 1MB of data, stream in 64KB chunks (smaller than storage chunk size)
      const testData = new Uint8Array(1024 * 1024);
      for (let i = 0; i < testData.length; i++) {
        testData[i] = i % 256;
      }
      
      // Stream in 64KB chunks
      const stream = dataToStream(testData, 64 * 1024);
      
      let attachmentRef: AttachmentReference | undefined;
      await db.changeDoc(doc, async (d) => {
        attachmentRef = await d.addAttachmentStream(stream, "large-streamed.bin", "application/octet-stream");
      });
      
      expect(attachmentRef).toBeDefined();
      expect(attachmentRef!.size).toBe(testData.length);
      
      // Verify data integrity
      const reloadedDoc = await db.getDocument(doc.getId());
      const retrievedData = await reloadedDoc.getAttachment(attachmentRef!.attachmentId);
      expect(retrievedData.length).toBe(testData.length);
      expect(retrievedData).toEqual(testData);
    }, 60000);

    it("should handle stream chunks larger than storage chunk size", async () => {
      const doc = await db.createDocument();
      
      // Create 512KB of data, stream in 300KB chunks (larger than 256KB storage chunk size)
      const testData = new Uint8Array(512 * 1024);
      for (let i = 0; i < testData.length; i++) {
        testData[i] = i % 256;
      }
      
      // Stream in 300KB chunks (larger than storage chunk)
      const stream = dataToStream(testData, 300 * 1024);
      
      let attachmentRef: AttachmentReference | undefined;
      await db.changeDoc(doc, async (d) => {
        attachmentRef = await d.addAttachmentStream(stream, "large-chunks.bin", "application/octet-stream");
      });
      
      expect(attachmentRef).toBeDefined();
      expect(attachmentRef!.size).toBe(testData.length);
      
      // Verify data integrity
      const reloadedDoc = await db.getDocument(doc.getId());
      const retrievedData = await reloadedDoc.getAttachment(attachmentRef!.attachmentId);
      expect(retrievedData.length).toBe(testData.length);
      expect(retrievedData).toEqual(testData);
    }, 60000);

    it("should handle empty stream", async () => {
      const doc = await db.createDocument();
      
      // Empty stream
      const stream = chunksToStream([]);
      
      let attachmentRef: AttachmentReference | undefined;
      await db.changeDoc(doc, async (d) => {
        attachmentRef = await d.addAttachmentStream(stream, "empty.bin", "application/octet-stream");
      });
      
      expect(attachmentRef).toBeDefined();
      expect(attachmentRef!.size).toBe(0);
      expect(attachmentRef!.fileName).toBe("empty.bin");
    }, 30000);

    it("should handle single-byte stream chunks", async () => {
      const doc = await db.createDocument();
      
      // Stream data one byte at a time
      const testData = new Uint8Array([10, 20, 30, 40, 50]);
      const stream = dataToStream(testData, 1); // 1 byte at a time
      
      let attachmentRef: AttachmentReference | undefined;
      await db.changeDoc(doc, async (d) => {
        attachmentRef = await d.addAttachmentStream(stream, "tiny-chunks.bin", "application/octet-stream");
      });
      
      expect(attachmentRef).toBeDefined();
      expect(attachmentRef!.size).toBe(5);
      
      // Verify data
      const reloadedDoc = await db.getDocument(doc.getId());
      const retrievedData = await reloadedDoc.getAttachment(attachmentRef!.attachmentId);
      expect(retrievedData).toEqual(testData);
    }, 30000);

    it("should work with ReadableStream via async iteration", async () => {
      const doc = await db.createDocument();
      
      // Create a ReadableStream (simulating Web API)
      const testData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const readableStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
          controller.enqueue(new Uint8Array([6, 7, 8, 9, 10]));
          controller.close();
        }
      });
      
      let attachmentRef: AttachmentReference | undefined;
      await db.changeDoc(doc, async (d) => {
        // ReadableStream is AsyncIterable in modern environments
        attachmentRef = await d.addAttachmentStream(readableStream as unknown as AsyncIterable<Uint8Array>, "from-readable.bin", "application/octet-stream");
      });
      
      expect(attachmentRef).toBeDefined();
      expect(attachmentRef!.size).toBe(10);
      
      // Verify data
      const reloadedDoc = await db.getDocument(doc.getId());
      const retrievedData = await reloadedDoc.getAttachment(attachmentRef!.attachmentId);
      expect(retrievedData).toEqual(testData);
    }, 30000);

    it("should produce same result as addAttachment for same data", async () => {
      const testData = new Uint8Array(100 * 1024); // 100KB
      for (let i = 0; i < testData.length; i++) {
        testData[i] = i % 256;
      }
      
      // Add via regular method
      const doc1 = await db.createDocument();
      let ref1: AttachmentReference | undefined;
      await db.changeDoc(doc1, async (d) => {
        ref1 = await d.addAttachment(testData, "regular.bin", "application/octet-stream");
      });
      
      // Add via streaming method
      const doc2 = await db.createDocument();
      let ref2: AttachmentReference | undefined;
      await db.changeDoc(doc2, async (d) => {
        ref2 = await d.addAttachmentStream(dataToStream(testData, 10 * 1024), "streamed.bin", "application/octet-stream");
      });
      
      // Both should have same size
      expect(ref1!.size).toBe(ref2!.size);
      
      // Both should retrieve to same data
      const reloadedDoc1 = await db.getDocument(doc1.getId());
      const reloadedDoc2 = await db.getDocument(doc2.getId());
      const data1 = await reloadedDoc1.getAttachment(ref1!.attachmentId);
      const data2 = await reloadedDoc2.getAttachment(ref2!.attachmentId);
      
      expect(data1).toEqual(data2);
      expect(data1).toEqual(testData);
    }, 60000);
  });
});
