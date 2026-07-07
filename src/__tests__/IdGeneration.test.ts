import { generateAttachmentChunkId, generateDocId } from "../core/utils/idGeneration";

describe("idGeneration", () => {
  it("generates doc ids as 22-char base62 with optional prefix", () => {
    const plain = generateDocId();
    expect(plain).toMatch(/^[0-9A-Za-z]{22}$/);

    const prefixed = generateDocId("cls");
    expect(prefixed).toMatch(/^cls_[0-9A-Za-z]{22}$/);
  });

  it("generates lexicographically increasing doc ids over time (sortable base62)", () => {
    // UUID7 embeds a millisecond timestamp in the most significant bits and
    // the base62 alphabet is ASCII-ordered, so ids from later timestamps must
    // sort strictly after earlier ones. Fake timers advance the clock a full
    // millisecond per id so consecutive ids never share a timestamp (intra-ms
    // ordering depends on the uuid library's sequence counter, which is fine
    // but not what this test asserts).
    jest.useFakeTimers();
    try {
      const ids: string[] = [];
      for (let i = 0; i < 50; i++) {
        ids.push(generateDocId("sort"));
        jest.advanceTimersByTime(2);
      }
      const sorted = [...ids].sort();
      expect(sorted).toEqual(ids);
    } finally {
      jest.useRealTimers();
    }
  });

  it("encodes numerically increasing UUIDs to lexicographically increasing base62", () => {
    // Deterministic check of the encoder itself: feed numerically ascending
    // UUIDs through the base62 path (exposed via the chunk-id suffix) and
    // verify the encoded strings keep that order.
    const uuids = [
      "00000000-0000-7000-8000-000000000000",
      "00000000-0000-7000-8000-0000000000ff",
      "019d4a73-b3b2-788c-9307-415f7f884e0d",
      "019d4a73-b3b2-788c-9307-415f7f884e0e",
      "0fffffff-ffff-7fff-bfff-ffffffffffff",
      "ffffffff-ffff-7fff-bfff-ffffffffffff",
    ];
    const encoded = uuids.map(
      (u) => generateAttachmentChunkId("doc", "file", u).split("_").pop() as string,
    );
    expect([...encoded].sort()).toEqual(encoded);
    encoded.forEach((e) => expect(e).toMatch(/^[0-9A-Za-z]{22}$/));
  });

  it("generates attachment chunk ids without relying on Buffer", () => {
    const globalWithOptionalBuffer = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
    const originalBuffer = globalWithOptionalBuffer.Buffer;

    try {
      globalWithOptionalBuffer.Buffer = undefined as unknown as typeof Buffer;

      expect(
        generateAttachmentChunkId(
          "019d4a73-b3b2-788c-9307-415f7f884e0d",
          "019d4a73-b3b2-788c-9307-415f7f884e0d",
          "019d4a73-b3b2-788c-9307-415f7f884e0e",
        ),
      ).toMatch(/^019d4a73-b3b2-788c-9307-415f7f884e0d_a_019d4a73-b3b2-788c-9307-415f7f884e0d_[0-9a-zA-Z]{22}$/);
    } finally {
      globalWithOptionalBuffer.Buffer = originalBuffer;
    }
  });
});
