import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { WitnessingInMemoryContentAddressedStore } from "./_helpers/witnessingStore";
import {
  ContentAddressedStoreFactory,
  CreateStoreResult,
  OpenStoreOptions,
  StoreKind,
  DEFAULT_TENANT_KEY_ID,
  PUBLIC_INFOS_KEY_ID,
  PrivateUserId,
  MindooTenant,
  SigningKeyPair,
} from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { AccessDeniedError } from "../core/accesscontrol/AccessDeniedError";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

/**
 * End-to-end check of the `memberOfFieldGroup` and `unchanged` Tier 2
 * operators (docs/accesscontrol.md §6.3) with a real directory, real rules,
 * the local write precheck and quarantine on a fresh replica.
 *
 * Scenario (room bookings): approvers of a room are the members of the group
 * `roomapprovers-<roomId>` and may change a booking of that room; the author
 * may change their own booking, but not its `status` decision.
 *
 * The stores witness every entry (shared clock), so `$author` resolves at the
 * creator's trusted time on the fresh replica as it does in production.
 */
class SharedWitnessingStoreFactory implements ContentAddressedStoreFactory {
  private stores = new Map<string, CreateStoreResult>();
  private readonly ticks = { n: Date.now() };

  createStore(dbId: string, options?: OpenStoreOptions): CreateStoreResult {
    if (!this.stores.has(dbId)) {
      const ticks = this.ticks;
      class SharedClockStore extends WitnessingInMemoryContentAddressedStore {
        override nextWitnessTime(): number {
          return ++ticks.n;
        }
      }
      this.stores.set(dbId, {
        docStore: new SharedClockStore(dbId, StoreKind.docs, undefined, options),
        attachmentStore: new SharedClockStore(dbId, StoreKind.attachments, undefined, options),
      });
    }
    return this.stores.get(dbId)!;
  }
}

describe("Tier 2 field operators: memberOfFieldGroup + unchanged", () => {
  let factory: BaseMindooTenantFactory;
  const tenantId = "tenant-room-bookings";

  let admin: PrivateUserId;
  const adminPassword = "adminpass123";
  let adminKeyBag: KeyBag;

  let alice: PrivateUserId;
  const alicePassword = "alicepass123";
  let bob: PrivateUserId;
  const bobPassword = "bobpass123";

  let writerTenant: MindooTenant;
  let aliceUsername: string;
  let bobUsername: string;
  let aliceSigning: SigningKeyPair;
  let bobSigning: SigningKeyPair;

  type AclDirectory = Required<
    Pick<
      Awaited<ReturnType<MindooTenant["openDirectory"]>>,
      | "setDefaultAccessPolicy"
      | "setDatabaseAccessPolicy"
      | "createAccessRule"
      | "addUsersToGroup"
      | "evaluateClientAccess"
    >
  > & {
    getUserBySigningPublicKey(key: string): Promise<{ username: string } | null>;
    buildIdentitySet(username: string): Promise<{ groups: string[] }>;
  };
  let aclDir: AclDirectory;

  async function keyBagFor(user: PrivateUserId, password: string): Promise<KeyBag> {
    const kb = new KeyBag(user.userEncryptionKeyPair.privateKey, password, new NodeCryptoAdapter());
    for (const keyId of [PUBLIC_INFOS_KEY_ID, DEFAULT_TENANT_KEY_ID]) {
      await kb.set("doc", tenantId, keyId, (await adminKeyBag.get("doc", tenantId, keyId))!);
    }
    return kb;
  }

  async function openTenantAs(user: PrivateUserId, password: string): Promise<MindooTenant> {
    return factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      user,
      password,
      await keyBagFor(user, password),
    );
  }

  beforeEach(async () => {
    factory = new BaseMindooTenantFactory(new SharedWitnessingStoreFactory(), new NodeCryptoAdapter());

    admin = await factory.createUserId("CN=admin/O=rooms", adminPassword);
    adminKeyBag = new KeyBag(admin.userEncryptionKeyPair.privateKey, adminPassword, new NodeCryptoAdapter());
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);

    alice = await factory.createUserId("CN=alice/O=rooms", alicePassword);
    bob = await factory.createUserId("CN=bob/O=rooms", bobPassword);

    const writerUser = await factory.createUserId("CN=writer/O=rooms", "writerpass123");
    writerTenant = await openTenantAs(writerUser, "writerpass123");

    const directory = await writerTenant.openDirectory();
    for (const u of [admin, alice, bob, writerUser]) {
      await directory.registerUser(factory.toPublicUserId(u), admin.userSigningKeyPair.privateKey, adminPassword);
    }
    aclDir = directory as unknown as AclDirectory;
    aliceUsername = (await aclDir.getUserBySigningPublicKey(alice.userSigningKeyPair.publicKey))!.username;
    bobUsername = (await aclDir.getUserBySigningPublicKey(bob.userSigningKeyPair.publicKey))!.username;

    aliceSigning = { publicKey: alice.userSigningKeyPair.publicKey, privateKey: alice.userSigningKeyPair.privateKey };
    bobSigning = { publicKey: bob.userSigningKeyPair.publicKey, privateKey: bob.userSigningKeyPair.privateKey };

    await aclDir.setDefaultAccessPolicy({}, admin.userSigningKeyPair.privateKey, adminPassword);
    await aclDir.setDatabaseAccessPolicy(
      "rooms",
      { denyDocChange: true },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    // Approvers of the booked room may change anything.
    await aclDir.createAccessRule(
      {
        ruleId: "room-approvers",
        type: "doc_change",
        dbid: "rooms",
        action: "allow",
        users_hashes: ["$everyone"],
        withfields: [{ key: "roomId", op: "memberOfFieldGroup", value: "roomapprovers-{value}", when: "before" }],
      },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    // The author may change the booking, but not the decision.
    await aclDir.createAccessRule(
      {
        ruleId: "booking-author",
        type: "doc_change",
        dbid: "rooms",
        action: "allow",
        users_hashes: ["$author"],
        withfields: [{ key: "status", op: "unchanged" }],
      },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
  }, 120000);

  it("lets room approvers decide, lets the author edit all but the decision, and quarantines the rest", async () => {
    // Mixed case on purpose: the directory stores group names normalized.
    await aclDir.addUsersToGroup("RoomApprovers-R1", [aliceUsername], admin.userSigningKeyPair.privateKey, adminPassword);

    const rooms = await writerTenant.openDB("rooms");
    // Bob books room r1 (creating is not restricted).
    const doc = await rooms.createDocument({
      signingKeyPair: bobSigning,
      signingKeyPassword: bobPassword,
      initialValues: { title: "Sprint review", roomId: "r1", status: "pending" },
    });
    const docId = doc.getId();

    // Bob (author) renames the booking: status unchanged -> allowed.
    await rooms.changeDoc(
      await rooms.getDocument(docId),
      (d) => {
        d.getData().title = "Sprint review + demo";
      },
      { signingKeyPair: bobSigning, signingKeyPassword: bobPassword },
    );

    // Bob may not approve his own booking: the local precheck refuses it.
    await expect(
      rooms.changeDoc(
        await rooms.getDocument(docId),
        (d) => {
          d.getData().status = "approved";
        },
        { signingKeyPair: bobSigning, signingKeyPassword: bobPassword },
      ),
    ).rejects.toBeInstanceOf(AccessDeniedError);

    // Alice is in roomapprovers-r1 and approves: allowed.
    await rooms.changeDoc(
      await rooms.getDocument(docId),
      (d) => {
        d.getData().status = "approved";
      },
      { signingKeyPair: aliceSigning, signingKeyPassword: alicePassword },
    );

    // Bob flips the decision anyway, standing in for a peer that skipped the
    // precheck: must be quarantined.
    await rooms.changeDoc(
      await rooms.getDocument(docId),
      (d) => {
        d.getData().status = "rejected";
      },
      { signingKeyPair: bobSigning, signingKeyPassword: bobPassword, bypassAccessControlPrecheck: true },
    );

    // A fresh replica judges every entry during materialization.
    const readerUser = await factory.createUserId("CN=reader/O=rooms", "readerpass123");
    await (await writerTenant.openDirectory()).registerUser(
      factory.toPublicUserId(readerUser),
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    const reader = await openTenantAs(readerUser, "readerpass123");
    const readerRooms = await reader.openDB("rooms");
    const readDoc = await readerRooms.getDocument(docId);
    expect(readDoc!.getData().title).toBe("Sprint review + demo");
    expect(readDoc!.getData().status).toBe("approved");

    const log = (readerRooms as unknown as {
      getQuarantineLog: () => Array<{ reason: string; entryType: string; docId: string }>;
    }).getQuarantineLog();
    const quarantined = log.filter((r) => r.docId === docId);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0].entryType).toBe("doc_change");
  }, 120000);

  it("a group with the member \"*\" contains every registered user", async () => {
    await aclDir.addUsersToGroup("roomapprovers-r2", ["*"], admin.userSigningKeyPair.privateKey, adminPassword);

    expect((await aclDir.buildIdentitySet(bobUsername)).groups).toContain("roomapprovers-r2");
    expect((await aclDir.buildIdentitySet(aliceUsername)).groups).toContain("roomapprovers-r2");

    const decide = async (roomId: string) =>
      (
        await aclDir.evaluateClientAccess({
          op: "doc_change",
          dbid: "rooms",
          signingKey: bob.userSigningKeyPair.publicKey,
          trustedTime: Number.MAX_SAFE_INTEGER,
          isAuthor: false,
          beforeDoc: { roomId, status: "pending" },
          afterDoc: { roomId, status: "approved" },
        })
      ).allowed;
    expect(await decide("r2")).toBe(true);
    expect(await decide("r1")).toBe(false);
  }, 120000);
});
