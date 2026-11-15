/**
 * Unit tests of the invitation / join-request primitives (docs/invitations.md):
 * the `joinrequests` write invariant, link fragments, hashes and the admin seal.
 */
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { evaluateBuiltinWrite, hasBuiltinWriteInvariant, shouldSkipLoadedEntry } from "../core/builtinDbInvariants";
import {
  buildInvitationLinkFragment,
  computeJoinRequestHmac,
  hashInvitationNonce,
  invitationKeyFingerprint,
  joinRequestHash,
  newInvitationId,
  newInvitationNonce,
  openAdminSeal,
  parseInvitationLinkFragment,
  sealForAdmins,
  verificationCodeFromHash,
  verifyJoinRequestHmac,
} from "../core/joinrequests/crypto";
import { JOIN_REQUESTS_DB_ID } from "../core/joinrequests/types";
import { generateRsaOaep3072, importRsaOaepPrivateKey } from "../core/crypto/rsaOaep3072";
import type { JoinRequest } from "../core/types";

const ADMIN = "-----BEGIN PUBLIC KEY-----\nADMIN\n-----END PUBLIC KEY-----";
const SERVER = "-----BEGIN PUBLIC KEY-----\nSERVER\n-----END PUBLIC KEY-----";
const MEMBER = "-----BEGIN PUBLIC KEY-----\nMEMBER\n-----END PUBLIC KEY-----";

function write(op: "doc_create" | "doc_change" | "doc_delete" | "doc_undelete", signer: string, docId = "jr_abc") {
  return evaluateBuiltinWrite({
    dbId: JOIN_REQUESTS_DB_ID,
    op,
    signerKey: signer,
    adminPublicKey: ADMIN,
    docId,
    signerIsJoinRequestServer: signer === SERVER,
  });
}

describe("joinrequests write invariant", () => {
  test("is a builtin database", () => {
    expect(hasBuiltinWriteInvariant(JOIN_REQUESTS_DB_ID)).toBe(true);
  });

  test("only the server creates, and only jr_ documents", () => {
    expect(write("doc_create", SERVER).allowed).toBe(true);
    expect(write("doc_create", SERVER, "invite_x").allowed).toBe(false);
    expect(write("doc_create", ADMIN).allowed).toBe(false);
    expect(write("doc_create", MEMBER).allowed).toBe(false);
  });

  test("only admins change and undelete; admins and the server delete", () => {
    expect(write("doc_change", ADMIN).allowed).toBe(true);
    expect(write("doc_change", SERVER).allowed).toBe(false);
    expect(write("doc_change", MEMBER).allowed).toBe(false);
    expect(write("doc_undelete", ADMIN).allowed).toBe(true);
    expect(write("doc_undelete", SERVER).allowed).toBe(false);
    expect(write("doc_delete", ADMIN).allowed).toBe(true);
    expect(write("doc_delete", SERVER).allowed).toBe(true);
    expect(write("doc_delete", MEMBER).allowed).toBe(false);
  });

  test("the load path drops forbidden entries", () => {
    const skip = (entryType: string, signer: string) =>
      shouldSkipLoadedEntry({
        dbId: JOIN_REQUESTS_DB_ID,
        entryType,
        signerKey: signer,
        adminPublicKey: ADMIN,
        docId: "jr_abc",
        signerIsJoinRequestServer: signer === SERVER,
      });
    expect(skip("doc_create", SERVER)).toBe(false);
    expect(skip("doc_create", MEMBER)).toBe(true);
    expect(skip("doc_change", ADMIN)).toBe(false);
    expect(skip("doc_change", MEMBER)).toBe(true);
  });
});

describe("invitation primitives", () => {
  const cryptoAdapter = new NodeCryptoAdapter();
  const subtle = cryptoAdapter.getSubtle();

  test("link fragment round trip, with and without nonce", () => {
    const invitationId = newInvitationId(cryptoAdapter);
    const nonce = newInvitationNonce(cryptoAdapter);
    const fragment = buildInvitationLinkFragment({
      serverUrl: "https://sync.example.com/",
      tenantId: "acme",
      invitationId,
      nonce,
      keyFingerprint: "abcdefghijklmnopqrstuv",
    });
    expect(fragment).not.toContain("#");
    expect(parseInvitationLinkFragment(`https://haven.example/welcome/join#${fragment}`)).toEqual({
      serverUrl: "https://sync.example.com",
      tenantId: "acme",
      invitationId,
      nonce,
      keyFingerprint: "abcdefghijklmnopqrstuv",
    });
    const open = parseInvitationLinkFragment(
      buildInvitationLinkFragment({ serverUrl: "https://s", tenantId: "acme", invitationId, keyFingerprint: "abcdefghijklmnopqrstuv" }),
    );
    expect(open?.nonce).toBeUndefined();
    expect(parseInvitationLinkFragment("#s=ftp://x&t=a&i=bad&f=x")).toBeNull();
  });

  test("HMAC binds the request to the nonce", async () => {
    const nonce = newInvitationNonce(cryptoAdapter);
    const request: JoinRequest = { v: 1, username: "cn=a/o=b", signingPublicKey: MEMBER, encryptionPublicKey: ADMIN };
    const hash = await joinRequestHash(subtle, "acme", "aaaaaaaaaaaaaaaa", request);
    const mac = await computeJoinRequestHmac(subtle, nonce, hash);
    expect(await verifyJoinRequestHmac(subtle, nonce, hash, mac)).toBe(true);
    expect(await verifyJoinRequestHmac(subtle, newInvitationNonce(cryptoAdapter), hash, mac)).toBe(false);
    const other = await joinRequestHash(subtle, "acme", "aaaaaaaaaaaaaaaa", { ...request, username: "cn=x/o=b" });
    expect(await verifyJoinRequestHmac(subtle, nonce, other, mac)).toBe(false);
    expect(verificationCodeFromHash(hash)).toMatch(/^\d{3} \d{3}$/);
    expect(await hashInvitationNonce(subtle, nonce)).not.toContain(nonce);
  });

  test("admin seal opens for each admin and keeps wraps on re-seal", async () => {
    const a = await generateRsaOaep3072(cryptoAdapter);
    const b = await generateRsaOaep3072(cryptoAdapter);
    const c = await generateRsaOaep3072(cryptoAdapter);
    const plaintext = new TextEncoder().encode("secret list");
    const { blob, aesKey } = await sealForAdmins(cryptoAdapter, plaintext, [
      { encryptionPublicKey: a.publicKeyPem },
      { encryptionPublicKey: b.publicKeyPem },
    ]);
    const openWith = async (pair: typeof a, sealed = blob) =>
      openAdminSeal(cryptoAdapter, sealed, {
        encryptionPublicKey: pair.publicKeyPem,
        encryptionPrivateKey: await importRsaOaepPrivateKey(cryptoAdapter, pair.privateKeyBytes),
      });
    expect(new TextDecoder().decode((await openWith(b))!.plaintext)).toBe("secret list");
    expect(await openWith(c)).toBeNull();

    // A later-added admin: re-seal under the same key, old wraps stay.
    const resealed = await sealForAdmins(
      cryptoAdapter,
      plaintext,
      [{ encryptionPublicKey: a.publicKeyPem }, { encryptionPublicKey: c.publicKeyPem }],
      { aesKey, wraps: blob.wraps },
    );
    expect(Object.keys(resealed.blob.wraps)).toHaveLength(3);
    expect(new TextDecoder().decode((await openWith(c, resealed.blob))!.plaintext)).toBe("secret list");
    expect(new TextDecoder().decode((await openWith(b, resealed.blob))!.plaintext)).toBe("secret list");

    expect(await invitationKeyFingerprint(subtle, a.publicKeyPem)).toHaveLength(22);
  });
});
