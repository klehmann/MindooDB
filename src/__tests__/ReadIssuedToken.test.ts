/**
 * AuthenticationService.readIssuedToken names the caller of a request from
 * the token alone (signature + expiry), so the server's rate-limit pass no
 * longer runs a second full directory evaluation per sync request. It must
 * never stand in for validateToken: a revoked user is still named, but only
 * validateToken refuses them.
 */

import { AuthenticationService } from "../core/appendonlystores/network/AuthenticationService";
import type { MindooTenantDirectory } from "../core/types";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

describe("AuthenticationService.readIssuedToken", () => {
  const crypto = new NodeCryptoAdapter();
  const subtle = crypto.getSubtle();

  async function issueToken(tokenExpirationMs?: number) {
    const keyPair = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const spki = Buffer.from(await subtle.exportKey("spki", keyPair.publicKey)).toString("base64");
    const signingPublicKey = `-----BEGIN PUBLIC KEY-----\n${spki}\n-----END PUBLIC KEY-----`;
    const state = { revoked: false };
    const directory = {
      getUserPublicKeys: async (username: string) =>
        username === "alice" && !state.revoked ? { signingPublicKey, encryptionPublicKey: "unused" } : null,
      isUserRevoked: async () => state.revoked,
      validatePublicSigningKey: async (key: string) => key === signingPublicKey && !state.revoked,
    } as unknown as MindooTenantDirectory;
    const auth = new AuthenticationService(crypto, directory, "tenant-a", { tokenExpirationMs });
    const challenge = await auth.generateChallenge("alice");
    const signature = await subtle.sign("Ed25519", keyPair.privateKey, new TextEncoder().encode(challenge));
    const result = await auth.authenticate(challenge, new Uint8Array(signature));
    expect(result.success).toBe(true);
    return { auth, token: result.token!, state };
  }

  test("returns the payload of an issued token", async () => {
    const { auth, token } = await issueToken();
    expect(await auth.readIssuedToken(token)).toEqual(
      expect.objectContaining({ sub: "alice", tenantId: "tenant-a" }),
    );
  });

  test("refuses tampered, foreign and malformed tokens", async () => {
    const { auth, token } = await issueToken();
    const [header, payload, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "mallory", tenantId: "tenant-a", exp: 4102444800 })).toString("base64url");
    expect(await auth.readIssuedToken(`${header}.${forged}.${signature}`)).toBeNull();
    expect(await auth.readIssuedToken(`${header}.${payload}.${signature.slice(0, -2)}xx`)).toBeNull();
    expect(await auth.readIssuedToken("not-a-token")).toBeNull();

    const other = await issueToken();
    expect(await auth.readIssuedToken(other.token)).toBeNull();
  });

  test("refuses an expired token", async () => {
    const { auth, token } = await issueToken(1);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await auth.readIssuedToken(token)).toBeNull();
  });

  test("names a revoked user, but only validateToken refuses them", async () => {
    const { auth, token, state } = await issueToken();
    state.revoked = true;
    expect(await auth.readIssuedToken(token)).toEqual(expect.objectContaining({ sub: "alice" }));
    expect(await auth.validateToken(token)).toBeNull();
  });
});
