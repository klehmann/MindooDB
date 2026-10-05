import {
  generateAttachmentChunkId,
  generateAttachmentId,
  generateDocId,
  generateFileUuid7,
  generateObjectId,
  generateRandomUuid,
  generateTenantId,
  parseAttachmentChunkId,
} from "../core/utils/idGeneration";

describe("idGeneration", () => {
  it("generates attachment ids as ObjectIds and parses new and legacy chunk ids", () => {
    const attachmentId = generateAttachmentId();
    expect(attachmentId).toMatch(/^[0-9a-f]{24}$/);

    const chunkId = generateAttachmentChunkId("cls_" + generateObjectId(), attachmentId);
    expect(parseAttachmentChunkId(chunkId)?.fileUuid7).toBe(attachmentId);

    const legacy = "doc1_a_01923f4e-7b2c-7d3e-8f40-123456789abc_" + generateObjectId();
    expect(parseAttachmentChunkId(legacy)).toMatchObject({
      docId: "doc1",
      fileUuid7: "01923f4e-7b2c-7d3e-8f40-123456789abc",
    });
  });

  it("generates RFC 4122 v4 random uuids", () => {
    const id = generateRandomUuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).not.toBe(generateRandomUuid());
  });

  it("generates v7 uuids carrying the current millisecond timestamp", () => {
    const before = Date.now();
    const id = generateFileUuid7();
    const after = Date.now();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const ms = parseInt(id.replace(/-/g, "").slice(0, 12), 16);
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
  });

  it("generates doc ids as 24-char lowercase ObjectIds with optional prefix", () => {
    const plain = generateDocId();
    expect(plain).toMatch(/^[0-9a-f]{24}$/);

    const prefixed = generateDocId("cls");
    expect(prefixed).toMatch(/^cls_[0-9a-f]{24}$/);
  });

  it("generates tenant ids as 24-char lowercase ObjectIds", () => {
    const id = generateTenantId();
    expect(id).toMatch(/^[0-9a-f]{24}$/);
    expect(id).not.toBe(generateTenantId());
  });

  it("generates lowercase-only ids", () => {
    const docId = generateDocId();
    const tenantId = generateTenantId();
    expect(docId).toBe(docId.toLowerCase());
    expect(tenantId).toBe(tenantId.toLowerCase());
  });

  it("generates lexicographically increasing doc ids over time", () => {
    // ObjectId embeds a second-resolution Unix timestamp in the leading bytes,
    // so ids from later timestamps must sort strictly after earlier ones.
    jest.useFakeTimers();
    try {
      const ids: string[] = [];
      for (let i = 0; i < 50; i++) {
        ids.push(generateDocId("sort"));
        jest.advanceTimersByTime(1000);
      }
      const sorted = [...ids].sort();
      expect(sorted).toEqual(ids);
    } finally {
      jest.useRealTimers();
    }
  });

  it("encodes increasing timestamps to lexicographically increasing ObjectIds", () => {
    const timestamps = [1, 2, 1_700_000_000, 1_700_000_001, 0x7fffffff];
    const encoded = timestamps.map((t) => generateObjectId(t));
    expect([...encoded].sort()).toEqual(encoded);
    encoded.forEach((e) => expect(e).toMatch(/^[0-9a-f]{24}$/));
  });

  it("generates attachment chunk ids without relying on Buffer", () => {
    const globalWithOptionalBuffer = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
    const originalBuffer = globalWithOptionalBuffer.Buffer;

    try {
      globalWithOptionalBuffer.Buffer = undefined as unknown as typeof Buffer;

      const chunkId = generateObjectId();
      expect(
        generateAttachmentChunkId(
          "019d4a73-b3b2-788c-9307-415f7f884e0d",
          "019d4a73-b3b2-788c-9307-415f7f884e0d",
          chunkId,
        ),
      ).toBe(
        `019d4a73-b3b2-788c-9307-415f7f884e0d_a_019d4a73-b3b2-788c-9307-415f7f884e0d_${chunkId}`,
      );
    } finally {
      globalWithOptionalBuffer.Buffer = originalBuffer;
    }
  });
});
