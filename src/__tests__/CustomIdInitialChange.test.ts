import * as Automerge from "@automerge/automerge";
import { CUSTOM_DOC_ID_INITIAL_CHANGE_BYTES } from "../core/BaseMindooDB";

/**
 * Self-check tests for the hard-coded initial Automerge change bytes that
 * seed every custom-id document.
 *
 * These bytes are baked into the codebase intentionally: they pin the
 * `doc_create` Automerge hash (and therefore the entry id) for every
 * `createDocument({ id })` across replicas and across Automerge releases.
 *
 * If any assertion in this file ever needs to be relaxed, that is almost
 * certainly a breaking change for existing custom-id documents in the field —
 * stop and double-check before regenerating via
 * `node scripts/regen-custom-id-initial-change.js`.
 */
describe("CUSTOM_DOC_ID_INITIAL_CHANGE_BYTES", () => {
  const EXPECTED_HASH =
    "b55efb45769e62bff921fd6f4fbb325a446d788ded077ec2a625c32e7631a190";
  const EXPECTED_ACTOR = "00000000000000c0";

  it("is a non-empty Uint8Array", () => {
    expect(CUSTOM_DOC_ID_INITIAL_CHANGE_BYTES).toBeInstanceOf(Uint8Array);
    expect(CUSTOM_DOC_ID_INITIAL_CHANGE_BYTES.length).toBeGreaterThan(0);
  });

  it("decodes to the expected hash, actor, time, and deps", () => {
    const decoded = Automerge.decodeChange(CUSTOM_DOC_ID_INITIAL_CHANGE_BYTES);
    expect(decoded.hash).toBe(EXPECTED_HASH);
    expect(decoded.actor).toBe(EXPECTED_ACTOR);
    expect(decoded.seq).toBe(1);
    expect(decoded.startOp).toBe(1);
    expect(decoded.time).toBe(0);
    expect(decoded.deps).toEqual([]);
  });

  it("performs exactly one op that creates the empty `_attachments` list", () => {
    const decoded = Automerge.decodeChange(CUSTOM_DOC_ID_INITIAL_CHANGE_BYTES);
    expect(decoded.ops.length).toBe(1);
    const op = decoded.ops[0];
    expect(op.action).toBe("makeList");
    expect(op.key).toBe("_attachments");
  });

  it("loads into a fresh Automerge document with the empty MindooDoc shape", () => {
    const doc = Automerge.load<{ _attachments: unknown[] }>(
      CUSTOM_DOC_ID_INITIAL_CHANGE_BYTES
    );

    expect(doc).toBeDefined();
    expect(Object.keys(doc)).toEqual(["_attachments"]);
    expect(Array.isArray(doc._attachments)).toBe(true);
    expect(doc._attachments).toEqual([]);

    const heads = Automerge.getHeads(doc);
    expect(heads).toEqual([EXPECTED_HASH]);
  });

  it("merges deterministically when applied into independent replicas", () => {
    const docA = Automerge.load<{ _attachments: unknown[] }>(
      CUSTOM_DOC_ID_INITIAL_CHANGE_BYTES
    );

    const docBInit = Automerge.init<{ _attachments: unknown[] }>();
    const [docB] = Automerge.applyChanges(docBInit, [
      CUSTOM_DOC_ID_INITIAL_CHANGE_BYTES,
    ]);

    expect(Automerge.getHeads(docA)).toEqual([EXPECTED_HASH]);
    expect(Automerge.getHeads(docB)).toEqual([EXPECTED_HASH]);

    const merged = Automerge.merge(docA, docB);
    expect(Automerge.getHeads(merged)).toEqual([EXPECTED_HASH]);
  });
});
