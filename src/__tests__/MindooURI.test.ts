/**
 * Unit tests for the MindooDB URI scheme (mdb://).
 */
import {
  encodeMindooURI,
  decodeMindooURI,
  isMindooURI,
  encodeKeyDistributionRequest,
  decodeKeyDistributionRequest,
} from "../core/uri/MindooURI";
import type { KeyDistributionRequest } from "../core/accesscontrol/types";

describe("MindooURI", () => {
  describe("encodeMindooURI", () => {
    it("should encode a join-request payload", () => {
      const payload = {
        v: 1,
        username: "cn=user2/o=acme",
        signingPublicKey: "-----BEGIN PUBLIC KEY-----\nMCo...\n-----END PUBLIC KEY-----",
        encryptionPublicKey: "-----BEGIN PUBLIC KEY-----\nMII...\n-----END PUBLIC KEY-----",
      };

      const uri = encodeMindooURI("join-request", payload);
      expect(uri).toMatch(/^mdb:\/\/join-request\//);
    });

    it("should encode a join-response payload", () => {
      const payload = {
        v: 2,
        tenantId: "acme",
        adminSigningPublicKey: "pk1",
        adminEncryptionPublicKey: "pk2",
        encryptedDocKeys: [
          {
            keyId: "$publicinfos",
            versions: [
              {
                createdAt: 2,
                encryptedKey: { ciphertext: "ct2", iv: "iv2", tag: "tag2", salt: "s2", iterations: 100000 },
              },
            ],
          },
          {
            keyId: "default",
            versions: [
              {
                createdAt: 1,
                encryptedKey: { ciphertext: "ct", iv: "iv", tag: "tag", salt: "s", iterations: 100000 },
              },
            ],
          },
        ],
      };

      const uri = encodeMindooURI("join-response", payload);
      expect(uri).toMatch(/^mdb:\/\/join-response\//);
    });

    it("should reject an invalid type", () => {
      expect(() =>
        encodeMindooURI("invalid-type" as any, { v: 1 })
      ).toThrow(/Invalid MindooDB URI type/);
    });

    it("should reject a payload without v field", () => {
      expect(() =>
        encodeMindooURI("join-request", { username: "test" })
      ).toThrow(/must contain a "v" field/);
    });

    it("should reject a payload with v = 0", () => {
      expect(() =>
        encodeMindooURI("join-request", { v: 0 })
      ).toThrow(/must contain a "v" field/);
    });

    it("should reject a payload with non-integer v", () => {
      expect(() =>
        encodeMindooURI("join-request", { v: 1.5 })
      ).toThrow(/must contain a "v" field/);
    });
  });

  describe("decodeMindooURI", () => {
    it("should roundtrip a join-request", () => {
      const payload = {
        v: 1,
        username: "cn=user2/o=acme",
        signingPublicKey: "pk-sign",
        encryptionPublicKey: "pk-enc",
      };

      const uri = encodeMindooURI("join-request", payload);
      const decoded = decodeMindooURI(uri);

      expect(decoded.type).toBe("join-request");
      expect(decoded.version).toBe(1);
      expect(decoded.payload).toEqual(payload);
    });

    it("should roundtrip a join-response", () => {
      const payload = {
        v: 2,
        tenantId: "acme",
        adminSigningPublicKey: "pk1",
        adminEncryptionPublicKey: "pk2",
        serverUrl: "https://sync.acme.com",
        encryptedDocKeys: [
          {
            keyId: "$publicinfos",
            versions: [
              {
                createdAt: 2,
                encryptedKey: { ciphertext: "ct2", iv: "iv2", tag: "tag2", salt: "s2", iterations: 100000 },
              },
            ],
          },
        ],
      };

      const uri = encodeMindooURI("join-response", payload);
      const decoded = decodeMindooURI(uri);

      expect(decoded.type).toBe("join-response");
      expect(decoded.version).toBe(2);
      expect(decoded.payload).toEqual(payload);
    });

    it("should handle payloads with unicode characters", () => {
      const payload = {
        v: 1,
        username: "cn=müller/o=städte",
        signingPublicKey: "pk",
        encryptionPublicKey: "pk",
      };

      const uri = encodeMindooURI("join-request", payload);
      const decoded = decodeMindooURI(uri);
      expect((decoded.payload as any).username).toBe("cn=müller/o=städte");
    });

    it("should reject a string that does not start with mdb://", () => {
      expect(() => decodeMindooURI("https://example.com")).toThrow(/must start with "mdb:\/\/"/);
    });

    it("should reject a URI with no type/payload separator", () => {
      expect(() => decodeMindooURI("mdb://noslash")).toThrow(/missing type\/payload separator/);
    });

    it("should reject an unknown type", () => {
      expect(() => decodeMindooURI("mdb://unknown-type/eyJ2IjoxfQ")).toThrow(/Invalid MindooDB URI type/);
    });

    it("should reject an empty payload", () => {
      expect(() => decodeMindooURI("mdb://join-request/")).toThrow(/empty payload/);
    });

    it("should reject invalid base64url payload", () => {
      expect(() => decodeMindooURI("mdb://join-request/!!!invalid!!!")).toThrow(/not valid/);
    });

    it("should reject non-JSON payload", () => {
      // base64url of "not json"
      const base64url = Buffer.from("not json").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      expect(() => decodeMindooURI(`mdb://join-request/${base64url}`)).toThrow(/not valid JSON/);
    });

    it("should reject a payload that is not an object", () => {
      const base64url = Buffer.from("[1,2,3]").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      expect(() => decodeMindooURI(`mdb://join-request/${base64url}`)).toThrow(/must be a JSON object/);
    });

    it("should reject a payload without v field", () => {
      const base64url = Buffer.from('{"foo":"bar"}').toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      expect(() => decodeMindooURI(`mdb://join-request/${base64url}`)).toThrow(/must contain a "v" field/);
    });
  });

  describe("isMindooURI", () => {
    it("should return true for valid join-request URI", () => {
      const uri = encodeMindooURI("join-request", { v: 1, username: "test", signingPublicKey: "pk", encryptionPublicKey: "pk" });
      expect(isMindooURI(uri)).toBe(true);
    });

    it("should return true for valid join-response URI", () => {
      const uri = encodeMindooURI("join-response", {
        v: 2,
        tenantId: "acme",
        adminSigningPublicKey: "pk1",
        adminEncryptionPublicKey: "pk2",
        encryptedDocKeys: [
          {
            keyId: "$publicinfos",
            versions: [{ encryptedKey: {} }],
          },
        ],
      });
      expect(isMindooURI(uri)).toBe(true);
    });

    it("should return false for non-mdb URIs", () => {
      expect(isMindooURI("https://example.com")).toBe(false);
      expect(isMindooURI("")).toBe(false);
      expect(isMindooURI("mdb://")).toBe(false);
      expect(isMindooURI("mdb://unknown-type/eyJ2IjoxfQ")).toBe(false);
    });

    it("should return false for malformed payload", () => {
      expect(isMindooURI("mdb://join-request/not-base64!!!")).toBe(false);
      expect(isMindooURI("mdb://join-request/")).toBe(false);
    });
  });

  describe("key-distribution requests", () => {
    const request: KeyDistributionRequest = {
      v: 1,
      tenantId: "acme",
      keyId: "team-key",
      keyVersions: [
        { createdAt: 1000, fingerprint: "aa".repeat(32) },
        { createdAt: 2000, fingerprint: "bb".repeat(32) },
      ],
      title: "Team key",
      comment: "Quarterly rotation",
      preparedByPublicKey: "-----BEGIN PUBLIC KEY-----\nMCo...\n-----END PUBLIC KEY-----",
      pushto: [
        {
          username: "CN=alice/O=acme",
          username_hash: "hash-alice",
          devices: {
            "aa:bb:cc:dd:ee:ff:00:11": {
              ["aa".repeat(32)]: "wrapped-v1-d1",
              ["bb".repeat(32)]: "wrapped-v2-d1",
            },
            "11:22:33:44:55:66:77:88": {
              ["aa".repeat(32)]: "wrapped-v1-d2",
              ["bb".repeat(32)]: "wrapped-v2-d2",
            },
          },
        },
      ],
      pullfrom: [{ username: "CN=mallory/O=acme", username_hash: "hash-mallory" }],
    };

    it("round-trips a full request through the URI", () => {
      const uri = encodeKeyDistributionRequest(request);
      expect(uri).toMatch(/^mdb:\/\/key-distribution\//);
      expect(isMindooURI(uri)).toBe(true);

      const decoded = decodeKeyDistributionRequest(uri);
      expect(decoded).toEqual(request);
    });

    it("decodes via the generic decoder with the right type", () => {
      const uri = encodeKeyDistributionRequest(request);
      const decoded = decodeMindooURI<KeyDistributionRequest>(uri);
      expect(decoded.type).toBe("key-distribution");
      expect(decoded.version).toBe(1);
      expect(decoded.payload.keyId).toBe("team-key");
    });

    it("rejects a non key-distribution URI", () => {
      const joinUri = encodeMindooURI("join-request", { v: 1, username: "x" });
      expect(() => decodeKeyDistributionRequest(joinUri)).toThrow();
    });

    it("rejects a structurally invalid request payload", () => {
      const bad = encodeMindooURI("key-distribution", { v: 1, keyId: "" });
      expect(() => decodeKeyDistributionRequest(bad)).toThrow();
    });
  });
});
