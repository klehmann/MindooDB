import {
  BINARY_GET_ENTRIES_FORMAT,
  BINARY_PUT_ENTRIES_FORMAT,
  decodeBinaryEntryMessage,
  encodeBinaryEntryMessage,
  measureBinaryEntryMessage,
  type BinaryEntryFrame,
} from "../core/appendonlystores/network/binaryEntryFraming";

describe("binary entry framing (sync-v5 phase 3)", () => {
  function frame(id: string, payloadBytes: number[]): BinaryEntryFrame {
    return {
      meta: {
        id,
        docId: `doc-${id}`,
        entryType: "doc_change",
        createdAt: 1234,
        signature: "c2ln", // base64, as the serialized metadata carries it
      },
      payload: new Uint8Array(payloadBytes),
    };
  }

  test("round-trips header and entries byte-exactly", () => {
    const message = {
      header: { format: BINARY_GET_ENTRIES_FORMAT, wrappedSessionKey: "a2V5" },
      entries: [
        frame("e1", [1, 2, 3, 4, 5]),
        frame("e2", [255, 0, 128]),
      ],
    };

    const encoded = encodeBinaryEntryMessage(message);
    const decoded = decodeBinaryEntryMessage(encoded);

    expect(decoded.header).toEqual(message.header);
    expect(decoded.entries.length).toBe(2);
    expect(decoded.entries[0].meta).toEqual(message.entries[0].meta);
    expect(decoded.entries[0].payload).toEqual(message.entries[0].payload);
    expect(decoded.entries[1].meta).toEqual(message.entries[1].meta);
    expect(decoded.entries[1].payload).toEqual(message.entries[1].payload);
  });

  test("round-trips an empty entry list and empty payloads", () => {
    const emptyList = encodeBinaryEntryMessage({
      header: { format: BINARY_PUT_ENTRIES_FORMAT },
      entries: [],
    });
    const decodedEmptyList = decodeBinaryEntryMessage(emptyList);
    expect(decodedEmptyList.header.format).toBe(BINARY_PUT_ENTRIES_FORMAT);
    expect(decodedEmptyList.entries).toEqual([]);

    const emptyPayload = encodeBinaryEntryMessage({
      header: { format: BINARY_PUT_ENTRIES_FORMAT },
      entries: [frame("empty", [])],
    });
    const decodedEmptyPayload = decodeBinaryEntryMessage(emptyPayload);
    expect(decodedEmptyPayload.entries.length).toBe(1);
    expect(decodedEmptyPayload.entries[0].payload.length).toBe(0);
  });

  test("survives binary payloads that are not valid UTF-8", () => {
    const payload = new Uint8Array(256);
    for (let i = 0; i < 256; i++) payload[i] = i;

    const encoded = encodeBinaryEntryMessage({
      header: { format: BINARY_GET_ENTRIES_FORMAT },
      entries: [{ meta: { id: "bin" }, payload }],
    });
    const decoded = decodeBinaryEntryMessage(encoded);
    expect(decoded.entries[0].payload).toEqual(payload);
  });

  test("measureBinaryEntryMessage matches the encoded size exactly", () => {
    const header = { format: BINARY_GET_ENTRIES_FORMAT, wrappedSessionKey: "a2V5" };
    const entries = [frame("e1", [1, 2, 3]), frame("e2", []), frame("äöü-unicode", [9, 9])];

    const measured = measureBinaryEntryMessage(header, entries);
    const encoded = encodeBinaryEntryMessage({ header, entries });
    expect(measured).toBe(encoded.byteLength);
  });

  test("decoding works on a subarray view with a non-zero byteOffset", () => {
    const encoded = encodeBinaryEntryMessage({
      header: { format: BINARY_GET_ENTRIES_FORMAT },
      entries: [frame("view", [7, 8, 9])],
    });
    // Embed the message mid-buffer, as a chunked network read might.
    const padded = new Uint8Array(encoded.length + 10);
    padded.set(encoded, 5);
    const view = padded.subarray(5, 5 + encoded.length);

    const decoded = decodeBinaryEntryMessage(view);
    expect(decoded.entries[0].payload).toEqual(new Uint8Array([7, 8, 9]));
  });

  test("decoded payloads are copies, not views into the body buffer", () => {
    const encoded = encodeBinaryEntryMessage({
      header: { format: BINARY_GET_ENTRIES_FORMAT },
      entries: [frame("copy", [42])],
    });
    const decoded = decodeBinaryEntryMessage(encoded);
    encoded.fill(0);
    expect(decoded.entries[0].payload).toEqual(new Uint8Array([42]));
  });

  test("rejects truncated bodies with a clear error", () => {
    const encoded = encodeBinaryEntryMessage({
      header: { format: BINARY_GET_ENTRIES_FORMAT },
      entries: [frame("trunc", [1, 2, 3, 4, 5, 6, 7, 8])],
    });

    // Cut inside the last payload.
    expect(() => decodeBinaryEntryMessage(encoded.subarray(0, encoded.length - 3)))
      .toThrow(/Truncated binary entry message/);

    // Cut inside a length prefix.
    expect(() => decodeBinaryEntryMessage(encoded.subarray(0, 2)))
      .toThrow(/Truncated binary entry message/);
  });

  test("rejects bodies whose length prefix overruns the buffer", () => {
    const encoded = encodeBinaryEntryMessage({
      header: { format: BINARY_GET_ENTRIES_FORMAT },
      entries: [],
    });
    const corrupted = new Uint8Array(encoded);
    // Inflate the header length prefix beyond the body size.
    new DataView(corrupted.buffer).setUint32(0, 0xffff, false);
    expect(() => decodeBinaryEntryMessage(corrupted)).toThrow(/Truncated binary entry message/);
  });
});
