import {
  generateAttachmentChunkId,
  generateDocId,
  generateObjectId,
  generateTenantId,
} from "../core/utils/idGeneration";

describe("idGeneration", () => {
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
