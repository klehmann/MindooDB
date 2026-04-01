import { generateAttachmentChunkId } from "../core/utils/idGeneration";

describe("idGeneration", () => {
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
