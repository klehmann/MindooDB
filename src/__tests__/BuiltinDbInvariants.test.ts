import { evaluateBuiltinWrite, usernameHashFromCreateChangeBytes } from "../core/builtinDbInvariants";
import { Automerge } from "../core/automerge-adapter";

describe("evaluateBuiltinWrite", () => {
  const admin = "admin-key";
  const alice = "alice-key";
  const bob = "bob-key";
  const aliceHash = "hash-alice";
  const bobHash = "hash-bob";

  it("allows only the admin to write directory", () => {
    expect(
      evaluateBuiltinWrite({
        dbId: "directory",
        op: "doc_create",
        signerKey: admin,
        adminPublicKey: admin,
      }).allowed,
    ).toBe(true);
    expect(
      evaluateBuiltinWrite({
        dbId: "directory",
        op: "doc_change",
        signerKey: alice,
        adminPublicKey: admin,
      }).allowed,
    ).toBe(false);
  });

  it("lets the admin create and delete userdirectory documents, but not change them", () => {
    expect(
      evaluateBuiltinWrite({
        dbId: "userdirectory",
        op: "doc_create",
        signerKey: admin,
        adminPublicKey: admin,
      }).allowed,
    ).toBe(true);
    expect(
      evaluateBuiltinWrite({
        dbId: "userdirectory",
        op: "doc_delete",
        signerKey: admin,
        adminPublicKey: admin,
      }).allowed,
    ).toBe(true);
    expect(
      evaluateBuiltinWrite({
        dbId: "userdirectory",
        op: "doc_undelete",
        signerKey: admin,
        adminPublicKey: admin,
      }).allowed,
    ).toBe(true);
    expect(
      evaluateBuiltinWrite({
        dbId: "userdirectory",
        op: "doc_change",
        signerKey: admin,
        adminPublicKey: admin,
        documentUsernameHash: aliceHash,
        signerUsernameHash: null,
      }).allowed,
    ).toBe(false);
  });

  it("lets a person create and change their own userdirectory document", () => {
    expect(
      evaluateBuiltinWrite({
        dbId: "userdirectory",
        op: "doc_create",
        signerKey: alice,
        adminPublicKey: admin,
        documentUsernameHash: aliceHash,
        signerUsernameHash: aliceHash,
      }).allowed,
    ).toBe(true);
    expect(
      evaluateBuiltinWrite({
        dbId: "userdirectory",
        op: "doc_change",
        signerKey: alice,
        adminPublicKey: admin,
        documentUsernameHash: aliceHash,
        signerUsernameHash: aliceHash,
      }).allowed,
    ).toBe(true);
    expect(
      evaluateBuiltinWrite({
        dbId: "userdirectory",
        op: "doc_undelete",
        signerKey: alice,
        adminPublicKey: admin,
        documentUsernameHash: aliceHash,
        signerUsernameHash: aliceHash,
      }).allowed,
    ).toBe(true);
  });

  it("rejects creating a userdirectory document under someone else's username_hash", () => {
    expect(
      evaluateBuiltinWrite({
        dbId: "userdirectory",
        op: "doc_create",
        signerKey: alice,
        adminPublicKey: admin,
        documentUsernameHash: bobHash,
        signerUsernameHash: aliceHash,
      }).allowed,
    ).toBe(false);
  });

  it("lets the admin change their own userdirectory document, but not someone else's", () => {
    expect(
      evaluateBuiltinWrite({
        dbId: "userdirectory",
        op: "doc_change",
        signerKey: admin,
        adminPublicKey: admin,
        documentUsernameHash: aliceHash,
        signerUsernameHash: aliceHash,
      }).allowed,
    ).toBe(true);
    expect(
      evaluateBuiltinWrite({
        dbId: "userdirectory",
        op: "doc_change",
        signerKey: admin,
        adminPublicKey: admin,
        documentUsernameHash: bobHash,
        signerUsernameHash: aliceHash,
      }).allowed,
    ).toBe(false);
  });

  it("rejects a foreign change and a non-admin delete", () => {
    expect(
      evaluateBuiltinWrite({
        dbId: "userdirectory",
        op: "doc_change",
        signerKey: bob,
        adminPublicKey: admin,
        documentUsernameHash: aliceHash,
        signerUsernameHash: bobHash,
      }).allowed,
    ).toBe(false);
    expect(
      evaluateBuiltinWrite({
        dbId: "userdirectory",
        op: "doc_delete",
        signerKey: alice,
        adminPublicKey: admin,
        documentUsernameHash: aliceHash,
        signerUsernameHash: aliceHash,
      }).allowed,
    ).toBe(false);
  });

  it("names missing hashes separately from a foreign owner", () => {
    expect(
      evaluateBuiltinWrite({
        dbId: "userdirectory",
        op: "doc_change",
        signerKey: alice,
        adminPublicKey: admin,
        documentUsernameHash: null,
        signerUsernameHash: aliceHash,
      }).reason,
    ).toMatch(/username_hash could not be resolved/);
    expect(
      evaluateBuiltinWrite({
        dbId: "userdirectory",
        op: "doc_change",
        signerKey: alice,
        adminPublicKey: admin,
        documentUsernameHash: aliceHash,
        signerUsernameHash: null,
      }).reason,
    ).toMatch(/signer is not a granted device/);
    expect(
      evaluateBuiltinWrite({
        dbId: "userdirectory",
        op: "doc_change",
        signerKey: bob,
        adminPublicKey: admin,
        documentUsernameHash: aliceHash,
        signerUsernameHash: bobHash,
      }).reason,
    ).toMatch(/only the owning person can change/);
  });

  it("reads username_hash from a full Automerge document as well as a change", () => {
    const doc = Automerge.from({ username_hash: "hash-from-save" });
    expect(usernameHashFromCreateChangeBytes(Automerge.save(doc))).toBe("hash-from-save");

    let changeDoc = Automerge.init<Record<string, unknown>>();
    changeDoc = Automerge.change(changeDoc, (d) => {
      d.username_hash = "hash-from-change";
    });
    const change = Automerge.getLastLocalChange(changeDoc);
    expect(change).toBeTruthy();
    expect(usernameHashFromCreateChangeBytes(change!)).toBe("hash-from-change");
  });
});
