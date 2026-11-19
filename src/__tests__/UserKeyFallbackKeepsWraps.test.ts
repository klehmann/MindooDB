import { addPerson, makeTenant, syncAll, type DeviceHandle } from "./_helpers/multiDevice";
import { USER_DIRECTORY_DB_ID } from "../core/types";
import type { BaseMindooTenantDirectory } from "../core/BaseMindooTenantDirectory";
import * as userKeyDocument from "../core/userkeys/UserKeyDocument";

/**
 * docs/userkeys.md §9.3: when the current value of a generation does not
 * count, an earlier value of the same epoch is used. A User-Key document is
 * created pending and gets its device wraps in a later change, and a
 * generation from before signed generations gets its `signingPublicKey` only
 * on a later reconcile. Once a cutoff applies, that signing-key change no
 * longer counts (its trusted time is after the cutoff), and the fallback is
 * the value from `doc_create`. The wraps on the live document belong to the
 * same public key, so the person must stay usable: no "pending" User-Key and
 * no "No published User-Key is available to seal this document to".
 */

async function reconcile(device: DeviceHandle) {
  device.tenant.noteUserDirectoryFetched!();
  await device.tenant.reconcileUserKeys!({ allowSelfCreate: true });
}

describe("User-Key generation fallback", () => {
  jest.setTimeout(180000);

  it("keeps the device wraps of the same public key when it falls back to the created value", async () => {
    const fixture = await makeTenant({ tenantId: "tenant-userkey-fallback-wraps" });
    const alice = await addPerson(fixture, "alice", "laptop");
    await alice.factory.ensureUserKeyPair!(alice.user, alice.password);
    await syncAll(fixture, "directory");

    // A document from before signed generations: created without a signing key.
    const original = userKeyDocument.createPendingUserKeyDocument;
    const spy = jest
      .spyOn(userKeyDocument, "createPendingUserKeyDocument")
      .mockImplementation((input) =>
        original({ ...input, signingPublicKey: undefined, signatures: undefined }),
      );
    try {
      await reconcile(alice);
    } finally {
      spy.mockRestore();
    }
    const manager = alice.tenant.getUserKeyManager();
    let resolved = await manager.resolveOwnUserKeyDocument();
    expect(resolved).not.toBeNull();

    // An updated device gives the generation its signing key (no cutoff yet).
    await reconcile(alice);
    resolved = await manager.resolveOwnUserKeyDocument();
    expect(resolved!.payload.userKeys["1"].signingPublicKey).toContain("BEGIN PUBLIC KEY");
    await syncAll(fixture, USER_DIRECTORY_DB_ID);

    // Now the tenant requires signed generations.
    const directory = (await fixture.host.tenant.openDirectory()) as BaseMindooTenantDirectory;
    await directory.requireUserKeyGenerationSignatures(
      fixture.adminUser.userSigningKeyPair.privateKey,
      fixture.adminPassword,
    );
    await syncAll(fixture, "directory");
    await syncAll(fixture, USER_DIRECTORY_DB_ID);

    const published = await fixture.host.tenant
      .getUserKeyManager()
      .publishedUserKeyFor(alice.username);
    expect(published?.publicKey).toBe(alice.user.userKeyPair!.publicKey);
    expect(published?.pending).toBe(false);

    const own = await alice.tenant.getUserKeyManager().publishedUserKeyFor(alice.username);
    expect(own?.pending).toBe(false);

    // Alice can still seal a document to herself.
    const db = await alice.tenant.openDB("sealed-notes");
    const doc = await db.createDocument({
      recipients: [],
      initialValues: { title: "only for alice" },
    });
    expect((await db.getDocument(doc.getId())).getData().title).toBe("only for alice");
  });
});
