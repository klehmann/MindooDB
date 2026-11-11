import {
  AUTH_CHALLENGE_SIGNING_DOMAIN,
  AUTH_CHALLENGE_V2_PREFIX,
  authChallengeForm,
  authChallengeSigningBytes,
  issueAuthChallenge,
  setLegacyChallengeSignaturePolicy,
} from "../core/crypto/AuthChallenge";
import { buildEntrySigningBytes } from "../core/crypto/EntrySignature";
import { AuthenticationService } from "../core/appendonlystores/network/AuthenticationService";
import { ClientNetworkContentAddressedStore } from "../appendonlystores/network/ClientNetworkContentAddressedStore";
import type { NetworkTransport } from "../core/appendonlystores/network/NetworkTransport";
import { StoreKind } from "../core/appendonlystores/types";
import type { MindooTenantDirectory } from "../core/types";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import {
  acceptsLegacyChallengeSignatures,
  configureLegacyChallengeSignatures,
} from "../server/legacyChallengeSignatures";
import { SystemAdminAuthService } from "../server/SystemAdminAuth";

/**
 * Login challenges are signed with keys that also sign store entries, seals and
 * witness receipts. Whoever issues the challenge — a server, or a peer device
 * on Iroh — must not be able to choose the bytes that get signed.
 */
describe("login challenge signing", () => {
  const crypto = new NodeCryptoAdapter();
  const subtle = crypto.getSubtle();
  let keyPair: CryptoKeyPair;
  let publicKeyPem: string;

  beforeAll(async () => {
    keyPair = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const spki = new Uint8Array(await subtle.exportKey("spki", keyPair.publicKey));
    publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(spki).toString("base64")}\n-----END PUBLIC KEY-----`;
  });

  function directoryWith(username: string, signingPublicKey: string): MindooTenantDirectory {
    return {
      getUserPublicKeys: async (name: string) =>
        name === username ? { signingPublicKey, encryptionPublicKey: "unused" } : null,
      getSigningKeyUniverse: undefined,
    } as unknown as MindooTenantDirectory;
  }

  async function sign(bytes: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await subtle.sign({ name: "Ed25519" }, keyPair.privateKey, bytes as Uint8Array<ArrayBuffer>));
  }

  describe("the challenge formats a client signs", () => {
    it("issues v2 challenges", () => {
      expect(authChallengeForm(issueAuthChallenge())).toBe("v2");
    });

    it("still signs a bare UUID from an older server, as before", () => {
      const legacy = "0b8f6c1e-3d2a-4f5b-9c7e-1a2b3c4d5e6f";
      expect(authChallengeSigningBytes(legacy)).toEqual(new TextEncoder().encode(legacy));
    });

    it("signs a v2 challenge under its own domain", () => {
      const challenge = issueAuthChallenge();
      const bytes = authChallengeSigningBytes(challenge);
      const text = new TextDecoder().decode(bytes);
      expect(text).toBe(`${AUTH_CHALLENGE_SIGNING_DOMAIN}\u0000${challenge}`);
    });

    it("refuses an entry-signing layout handed over as a challenge", () => {
      const layout = buildEntrySigningBytes({
        entryType: "doc_change",
        id: "e1",
        docId: "d1",
        decryptionKeyId: "default",
        createdAt: 0x7f7f7f7f,
        dependencyIds: [],
        contentHash: "a".repeat(64),
        createdByPublicKey: "k",
      });
      // Every byte is below 0x80, so it travels as a JSON string unchanged.
      const asString = new TextDecoder().decode(layout);
      expect(new TextEncoder().encode(asString)).toEqual(layout);
      expect(() => authChallengeSigningBytes(asString)).toThrow(/unknown format/);
    });

    it.each([
      "",
      "mindoodb-seal/v1\u0000{}",
      `${AUTH_CHALLENGE_V2_PREFIX}not-a-uuid`,
      `${AUTH_CHALLENGE_V2_PREFIX}0b8f6c1e-3d2a-4f5b-9c7e-1a2b3c4d5e6f\u0000extra`,
      " 0b8f6c1e-3d2a-4f5b-9c7e-1a2b3c4d5e6f",
    ])("refuses %j", (challenge) => {
      expect(() => authChallengeSigningBytes(challenge)).toThrow(/unknown format/);
    });
  });

  describe("a client facing a hostile server", () => {
    it("never signs a challenge it does not recognise", async () => {
      const layout = new TextDecoder().decode(
        buildEntrySigningBytes({
          entryType: "doc_delete",
          id: "forged",
          docId: "victim-doc",
          decryptionKeyId: "default",
          createdAt: 0x7f7f7f7f,
          dependencyIds: [],
          contentHash: "a".repeat(64),
          createdByPublicKey: "k",
        }),
      );
      const signed: Uint8Array[] = [];
      const transport = {
        getIdentity: () => "hostile",
        requestChallenge: async () => layout,
        authenticate: async (_challenge: string, signature: Uint8Array) => {
          signed.push(signature);
          return { success: true, token: "t" };
        },
      } as unknown as NetworkTransport;
      const store = new ClientNetworkContentAddressedStore(
        "db",
        StoreKind.docs,
        transport,
        crypto,
        "alice",
        keyPair.privateKey,
        "unused",
      );

      await expect(store.findNewEntries([])).rejects.toThrow(/unknown format/);
      expect(signed).toHaveLength(0);
    });
  });

  describe("the tenant server", () => {
    function service(options: { acceptLegacyChallengeSignatures?: boolean } = {}) {
      return new AuthenticationService(crypto, directoryWith("alice", publicKeyPem), "t1", options);
    }

    it("accepts the v2 domain signature", async () => {
      const auth = service();
      const challenge = await auth.generateChallenge("alice");
      const result = await auth.authenticate(challenge, await sign(authChallengeSigningBytes(challenge)));
      expect(result.success).toBe(true);
    });

    it("accepts a raw signature from an older client while the transition lasts", async () => {
      const auth = service();
      const challenge = await auth.generateChallenge("alice");
      const result = await auth.authenticate(challenge, await sign(new TextEncoder().encode(challenge)));
      expect(result.success).toBe(true);
    });

    it("refuses the raw signature once legacy signatures are switched off", async () => {
      const auth = service({ acceptLegacyChallengeSignatures: false });
      const challenge = await auth.generateChallenge("alice");
      const result = await auth.authenticate(challenge, await sign(new TextEncoder().encode(challenge)));
      expect(result.success).toBe(false);
    });
  });

  describe("the server's switch for legacy signatures", () => {
    afterEach(() => {
      setLegacyChallengeSignaturePolicy({ accept: true });
    });

    async function login(kind: "raw" | "v2") {
      const auth = new AuthenticationService(crypto, directoryWith("alice", publicKeyPem), "t1");
      const challenge = await auth.generateChallenge("alice");
      const bytes = kind === "raw" ? new TextEncoder().encode(challenge) : authChallengeSigningBytes(challenge);
      return (await auth.authenticate(challenge, await sign(bytes))).success;
    }

    it("reads the setting: only an explicit off refuses", () => {
      for (const value of [undefined, "", "1", "true", "anything"]) {
        expect(acceptsLegacyChallengeSignatures(value)).toBe(true);
      }
      for (const value of ["0", "false", " FALSE ", "off", "no"]) {
        expect(acceptsLegacyChallengeSignatures(value)).toBe(false);
      }
    });

    it("refuses raw signatures for every login of the process when switched off", async () => {
      expect(configureLegacyChallengeSignatures("0", { log: () => undefined })).toBe(false);
      expect(await login("raw")).toBe(false);
      expect(await login("v2")).toBe(true);

      const admin = new SystemAdminAuthService(crypto, {
        capabilities: { "ALL:*": [{ username: "cn=root", publicsignkey: publicKeyPem }] },
      } as never);
      const challenge = await admin.generateChallenge("cn=root", publicKeyPem);
      const raw = await sign(new TextEncoder().encode(challenge));
      expect((await admin.authenticate(challenge, raw)).success).toBe(false);
    });

    it("logs accepted legacy logins, at most once an hour per kind, with the count", async () => {
      const lines: string[] = [];
      let time = 1_000_000_000;
      configureLegacyChallengeSignatures(undefined, { log: (line) => lines.push(line), now: () => time });

      expect(await login("v2")).toBe(true);
      expect(lines).toHaveLength(0);

      expect(await login("raw")).toBe(true);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("1 sync login(s)");
      expect(lines[0]).toContain("MINDOODB_ACCEPT_LEGACY_CHALLENGE_SIGNATURES");

      expect(await login("raw")).toBe(true);
      expect(await login("raw")).toBe(true);
      expect(lines).toHaveLength(1);

      time += 60 * 60 * 1000;
      expect(await login("raw")).toBe(true);
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain("3 sync login(s)");
    });
  });

  describe("the system admin login", () => {
    it("issues v2 challenges and accepts the domain signature", async () => {
      const auth = new SystemAdminAuthService(crypto, {
        capabilities: { "ALL:*": [{ username: "cn=root", publicsignkey: publicKeyPem }] },
      } as never);
      const challenge = await auth.generateChallenge("cn=root", publicKeyPem);
      expect(authChallengeForm(challenge)).toBe("v2");
      const result = await auth.authenticate(challenge, await sign(authChallengeSigningBytes(challenge)));
      expect(result.success).toBe(true);
    });
  });
});
