import {
  addDevice,
  revokeDevice,
  addPerson,
  makeTenant,
  syncAll,
  type DeviceHandle,
  type MultiDeviceFixture,
} from "./multiDevice";
import { USER_DIRECTORY_DB_ID, type StoreEntryMetadata } from "../../core/types";
import type { BaseMindooTenantDirectory } from "../../core/BaseMindooTenantDirectory";
import * as userKeyDocument from "../../core/userkeys/UserKeyDocument";

/**
 * docs/userkeys.md §9.3 under different orders of events. Which generations
 * count depends on a cutoff and on each change's trusted time, and trusted
 * times differ by where a tenant lives:
 *
 * - `local`: no server, entries have no `receivedAt` (trusted time = now);
 * - `witnessed`: a server stamps every entry right after it is written;
 * - `late-push`: a local tenant is pushed to a server at the end, which
 *   stamps every old entry with the push time (MindooDB #114).
 *
 * In every order the person must stay usable: their published User-Key is the
 * key their device holds, it is not pending, they can seal to themselves, and
 * another member can seal to them.
 */

export type Origin = "new" | "legacy" | "legacy-signed";
type Cutoff = "none" | "policy" | "self-grant";
type Extra = "none" | "second-device" | "rotate" | "approved-by-revoked";
type TimeMode = "local" | "witnessed" | "late-push";

export interface Case {
  origin: Origin;
  cutoff: Cutoff;
  extra: Extra;
  time: TimeMode;
}

const DIRECTORY_DB_ID = "directory";

/** Stamp every unwitnessed entry of the given replicas like a server would. */
async function witness(replicas: DeviceHandle[], at: (meta: StoreEntryMetadata) => number) {
  for (const replica of replicas) {
    for (const dbId of [DIRECTORY_DB_ID, USER_DIRECTORY_DB_ID]) {
      const db = await replica.tenant.openDB(dbId);
      const store = db.getStore() as unknown as {
        findNewEntries(known: string[]): Promise<StoreEntryMetadata[]>;
        applyWitnessReceipts(receipts: StoreEntryMetadata[]): Promise<void>;
      };
      const metas = await store.findNewEntries([]);
      const receipts = metas
        .filter((meta) => meta.receivedAt === undefined)
        .map((meta) => ({ ...meta, receivedAt: at(meta), receivedByPublicKey: "test-witness" }));
      if (receipts.length) await store.applyWitnessReceipts(receipts);
      await db.syncStoreChanges();
    }
  }
}

async function reconcile(device: DeviceHandle) {
  device.tenant.noteUserDirectoryFetched!();
  return device.tenant.reconcileUserKeys!({ allowSelfCreate: true });
}

export async function runCase(c: Case, tenantId: string) {
  const fixture: MultiDeviceFixture = await makeTenant({ tenantId });
  const alice1 = await addPerson(fixture, "alice", "laptop");
  const bob = await addPerson(fixture, "bob", "phone");
  const everyone = () => [fixture.host, ...fixture.devices];
  const step = async () => {
    await syncAll(fixture, DIRECTORY_DB_ID);
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    // A server stamps right away, with the entry's own time.
    if (c.time === "witnessed") await witness(everyone(), (meta) => meta.createdAt);
  };
  for (const device of [alice1, bob]) {
    await device.factory.ensureUserKeyPair!(device.user, device.password);
  }
  await step();

  // 1. Alice's User-Key document.
  if (c.origin === "new") {
    await reconcile(alice1);
  } else {
    const original = userKeyDocument.createPendingUserKeyDocument;
    const spy = jest
      .spyOn(userKeyDocument, "createPendingUserKeyDocument")
      .mockImplementation((input) =>
        original({ ...input, signingPublicKey: undefined, signatures: undefined }),
      );
    try {
      await reconcile(alice1);
    } finally {
      spy.mockRestore();
    }
    if (c.origin === "legacy-signed") {
      // An updated device adds the signing key before any cutoff.
      await reconcile(alice1);
    }
  }
  await reconcile(bob);
  await step();

  // 2. A cutoff arrives.
  const directory = (await fixture.host.tenant.openDirectory()) as BaseMindooTenantDirectory;
  if (c.cutoff === "policy") {
    await directory.requireUserKeyGenerationSignatures(
      fixture.adminUser.userSigningKeyPair.privateKey,
      fixture.adminPassword,
    );
  } else if (c.cutoff === "self-grant") {
    const key = await alice1.tenant.getDeviceSelfGrantPublicKey!();
    expect(key).toBeTruthy();
    await directory.setDeviceSelfGrant(
      alice1.username,
      key!,
      fixture.adminUser.userSigningKeyPair.privateKey,
      fixture.adminPassword,
    );
  }
  await step();
  await reconcile(alice1);
  await step();

  // 3. Something happens after the cutoff.
  let alice2: DeviceHandle | null = null;
  if (c.extra === "second-device") {
    alice2 = await addDevice(fixture, alice1, "tablet");
    await step();
    await reconcile(alice1);
    await reconcile(alice2);
    const pending = await alice1.tenant.listPendingUserKeyDevices!();
    expect(pending).toHaveLength(1);
    await alice1.tenant.approveUserKeyDevice!(pending[0].fingerprint);
    await step();
    expect((await reconcile(alice2)).state).toBe("approved");
  } else if (c.extra === "approved-by-revoked") {
    // A second device approves a third one, then loses access itself.
    const tablet = await addDevice(fixture, alice1, "tablet");
    await step();
    await reconcile(alice1);
    await reconcile(tablet);
    await alice1.tenant.approveUserKeyDevice!((await alice1.tenant.listPendingUserKeyDevices!())[0].fingerprint);
    await step();
    expect((await reconcile(tablet)).state).toBe("approved");
    alice2 = await addDevice(fixture, alice1, "phone");
    await step();
    await reconcile(tablet);
    await reconcile(alice2);
    await tablet.tenant.approveUserKeyDevice!((await tablet.tenant.listPendingUserKeyDevices!())[0].fingerprint);
    await step();
    expect((await reconcile(alice2)).state).toBe("approved");
    await revokeDevice(fixture, alice1.username, tablet.user.userSigningKeyPair.publicKey);
    await step();
  } else if (c.extra === "rotate") {
    alice1.tenant.noteUserDirectoryFetched!();
    await alice1.tenant.rotateUserKey!();
  }
  await step();
  for (const device of [alice1, ...(alice2 ? [alice2] : []), bob]) await reconcile(device);
  await step();

  // 4. A local tenant goes to a server: every old entry is stamped now.
  if (c.time === "late-push") {
    const pushedAt = Date.now() + 1000;
    await witness(everyone(), () => pushedAt);
  }

  // Invariants.
  const expectedKey = alice1.user.userKeyPair!.publicKey;
  for (const viewer of [fixture.host, bob, alice1]) {
    const published = await viewer.tenant.getUserKeyManager().publishedUserKeyFor(alice1.username);
    expect({ viewer: viewer.label, publicKey: published?.publicKey, pending: published?.pending }).toEqual({
      viewer: viewer.label,
      publicKey: expectedKey,
      pending: false,
    });
  }
  for (const device of [alice1, ...(alice2 ? [alice2] : [])]) {
    const db = await device.tenant.openDB("matrix-notes");
    const doc = await db.createDocument({ recipients: [], initialValues: { title: device.label } });
    expect((await db.getDocument(doc.getId())).getData().title).toBe(device.label);
  }
  const bobDb = await bob.tenant.openDB("matrix-shared");
  const shared = await bobDb.createDocument({
    recipients: [alice1.username],
    recipientOptions: { strict: true },
    initialValues: { title: "for alice" },
  });
  const readers = [alice1, ...(alice2 ? [alice2] : [])];
  await syncAll(fixture, "matrix-shared", [bob, ...readers]);
  for (const reader of readers) {
    const db = await reader.tenant.openDB("matrix-shared");
    expect((await db.getDocument(shared.getId())).getData().title).toBe("for alice");
  }
}

/** Every combination for one kind of document (cutoff "none" only needs one time mode). */
export function casesFor(origin: Origin): Case[] {
  const cases: Case[] = [];
  for (const cutoff of ["none", "policy", "self-grant"] as Cutoff[]) {
    for (const extra of ["none", "second-device", "rotate", "approved-by-revoked"] as Extra[]) {
      const times: TimeMode[] = cutoff === "none" ? ["local"] : ["local", "witnessed", "late-push"];
      for (const time of times) cases.push({ origin, cutoff, extra, time });
    }
  }
  return cases;
}
