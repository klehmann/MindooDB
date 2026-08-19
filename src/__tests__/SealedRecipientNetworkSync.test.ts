/**
 * Regression for pushing a self-sealed document to a MindooDB server.
 *
 * Recipients are bound into `metadataSignature` as trailing tag 0x03. The HTTP
 * JSON codec used to omit `recipients`, so the server rebuilt signing bytes
 * without that block and rejected the entry:
 *
 *   Entry <id> has an invalid author signature
 *
 * Local in-memory sync never hits this path (the in-memory object still has
 * `recipients`). This test round-trips a real `createDocument({ recipients: [] })`
 * entry through the shared wire codec, then asks the server to ingest it.
 */

import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { ServerNetworkContentAddressedStore } from "../appendonlystores/network/ServerNetworkContentAddressedStore";
import {
  deserializeStoreEntry,
  serializeStoreEntry,
} from "../core/appendonlystores/network/entryWireCodec";
import { verifyEntrySignatureCrypto } from "../core/crypto/EntrySignature";
import type { AuthenticationService } from "../core/appendonlystores/network/AuthenticationService";
import type { MindooDB, MindooTenantDirectory, StoreEntry } from "../core/types";
import { StoreKind, USER_DIRECTORY_DB_ID } from "../core/types";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import {
  addPerson,
  makeTenant,
  syncAll,
  type DeviceHandle,
  type MultiDeviceFixture,
} from "./_helpers/multiDevice";

describe("sealed recipient entries over the HTTP wire", () => {
  jest.setTimeout(240000);

  const cryptoAdapter = new NodeCryptoAdapter();
  const subtle = cryptoAdapter.getSubtle();

  let fixture: MultiDeviceFixture;
  let alice: DeviceHandle;
  let sealedCreate: StoreEntry;

  function fakeAuth(): AuthenticationService {
    return {
      validateToken: async () => ({ sub: "CN=alice", iat: 0, exp: 0, tenantId: "t" }),
    } as unknown as AuthenticationService;
  }

  function fakeDirectory(): MindooTenantDirectory {
    return {
      validatePublicSigningKey: async () => true,
    } as unknown as MindooTenantDirectory;
  }

  function serverFor(store: InMemoryContentAddressedStore): ServerNetworkContentAddressedStore {
    return new ServerNetworkContentAddressedStore(store, fakeDirectory(), fakeAuth(), cryptoAdapter);
  }

  async function storeEntriesForDoc(db: MindooDB, docId: string): Promise<StoreEntry[]> {
    const metas = await db.getStore().findNewEntriesForDoc([], docId);
    const ordered = [...metas].sort(
      (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    );
    return db.getStore().getEntries(ordered.map((meta) => meta.id));
  }

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-sealed-wire" });
    alice = await addPerson(fixture, "alice", "laptop");
    await alice.factory.ensureUserKeyPair!(alice.user, alice.password);
    await syncAll(fixture, "directory");
    alice.tenant.noteUserDirectoryFetched!();
    await alice.tenant.reconcileUserKeys!({ allowSelfCreate: true });
    await syncAll(fixture, USER_DIRECTORY_DB_ID);

    const db = await alice.tenant.openDB("teamedit");
    const doc = await db.createDocument({
      recipients: [],
      initialValues: { title: "self-sealed" },
    });
    const entries = await storeEntriesForDoc(db, doc.getId());
    const create = entries.find((entry) => entry.entryType === "doc_create");
    if (!create) {
      throw new Error("expected a doc_create entry for the self-sealed document");
    }
    sealedCreate = create;
  });

  it("writes a recipient block wrapping only the author", () => {
    expect(sealedCreate.recipients).toBeDefined();
    expect(sealedCreate.recipients!.wraps.length).toBe(1);
    expect(sealedCreate.recipients!.wraps[0].kind).toBe("user");
    expect(sealedCreate.decryptionKeyId.startsWith("$sealed:")).toBe(true);
  });

  it("the local entry verifies before any network hop", async () => {
    expect(
      await verifyEntrySignatureCrypto(
        sealedCreate,
        sealedCreate.encryptedData,
        sealedCreate.createdByPublicKey,
        subtle,
      ),
    ).toBe(true);
  });

  it("JSON wire codec keeps recipients so the server accepts the push", async () => {
    const serialized = serializeStoreEntry(sealedCreate);
    expect(serialized.recipients).toEqual(sealedCreate.recipients);

    // HTTP JSON parse/stringify can reorder nothing but must not drop the block.
    const onTheWire = JSON.parse(JSON.stringify(serialized)) as typeof serialized;
    expect(onTheWire.recipients).toEqual(sealedCreate.recipients);

    const roundTripped = deserializeStoreEntry(onTheWire);
    expect(roundTripped.recipients).toEqual(sealedCreate.recipients);
    expect(
      await verifyEntrySignatureCrypto(
        roundTripped,
        roundTripped.encryptedData,
        roundTripped.createdByPublicKey,
        subtle,
      ),
    ).toBe(true);

    const localStore = new InMemoryContentAddressedStore("teamedit", StoreKind.docs);
    const ack = await serverFor(localStore).handlePutEntries("token", [roundTripped]);
    expect(ack.rejected).toEqual([]);
    expect(ack.receipts).toEqual([expect.objectContaining({ id: sealedCreate.id })]);
    const [stored] = await localStore.getEntries([sealedCreate.id]);
    expect(stored.recipients).toEqual(sealedCreate.recipients);
  });

  it("dropping recipients on the wire produces 'invalid author signature'", async () => {
    const serialized = serializeStoreEntry(sealedCreate);
    const dropped = { ...serialized };
    delete dropped.recipients;
    const roundTripped = deserializeStoreEntry(dropped);

    expect(
      await verifyEntrySignatureCrypto(
        roundTripped,
        roundTripped.encryptedData,
        roundTripped.createdByPublicKey,
        subtle,
      ),
    ).toBe(false);

    const localStore = new InMemoryContentAddressedStore("teamedit", StoreKind.docs);
    const ack = await serverFor(localStore).handlePutEntries("token", [roundTripped]);
    expect(ack.receipts).toHaveLength(0);
    expect(ack.rejected).toEqual([
      {
        id: sealedCreate.id,
        reason: expect.stringContaining("invalid author signature"),
      },
    ]);
  });
});
