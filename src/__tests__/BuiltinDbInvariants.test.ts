import { evaluateBuiltinWrite } from "../core/builtinDbInvariants";

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
});
