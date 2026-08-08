/**
 * Unit tests for the compact join-request URI transport (v3).
 */
import { encodeMindooURI, decodeMindooURI } from "../core/uri/MindooURI";
import { decodeJoinRequestUri, encodeJoinRequestUri } from "../core/uri/joinRequestUri";
import type { JoinRequest } from "../core/types";

/** Build a canonically formatted PEM the way BaseMindooTenantFactory does. */
function pem(base64Body: string): string {
  const chunks = base64Body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${chunks.join("\n")}\n-----END PUBLIC KEY-----`;
}

/** Deterministic stand-in for a real SPKI body: valid base64, realistic length. */
function keyBody(seed: string, bytes: number): string {
  let raw = "";
  for (let i = 0; i < bytes; i++) {
    raw += String.fromCharCode((seed.charCodeAt(i % seed.length) + i) % 256);
  }
  return Buffer.from(raw, "binary").toString("base64");
}

const SIGNING_PEM = pem(keyBody("ed25519", 44));
const ENCRYPTION_PEM = pem(keyBody("rsa3072", 398));

function makeRequest(overrides: Partial<JoinRequest> = {}): JoinRequest {
  return {
    v: 1,
    username: "cn=user2/o=acme",
    signingPublicKey: SIGNING_PEM,
    encryptionPublicKey: ENCRYPTION_PEM,
    ...overrides,
  };
}

describe("joinRequestUri", () => {
  describe("encode/decode round-trip", () => {
    it("restores both PEM keys byte for byte", () => {
      const request = makeRequest();
      const decoded = decodeJoinRequestUri(encodeJoinRequestUri(request));

      // The directory compares these as exact strings when deciding whether a
      // grant is a second device or a second person.
      expect(decoded.signingPublicKey).toBe(SIGNING_PEM);
      expect(decoded.encryptionPublicKey).toBe(ENCRYPTION_PEM);
      expect(decoded.username).toBe("cn=user2/o=acme");
      expect(decoded.v).toBe(1);
    });

    it("keeps a nameless request nameless (v2 semantics)", () => {
      const request = makeRequest({ v: 2, username: undefined });
      const decoded = decodeJoinRequestUri(encodeJoinRequestUri(request));

      expect(decoded.username).toBeUndefined();
      expect(decoded.v).toBe(2);
    });

    it("round-trips the optional device label", () => {
      const decoded = decodeJoinRequestUri(encodeJoinRequestUri(makeRequest({ label: "iPad" })));
      expect(decoded.label).toBe("iPad");
    });

    it("emits the compact v3 transport version", () => {
      const uri = encodeJoinRequestUri(makeRequest());
      expect(decodeMindooURI(uri).version).toBe(3);
    });
  });

  describe("payload size", () => {
    it("drops the PEM overhead from a realistic request", () => {
      const request = makeRequest();
      const verbose = encodeMindooURI(
        "join-request",
        request as unknown as Record<string, unknown>,
      );
      const compact = encodeJoinRequestUri(request);

      // Armor, line breaks and the long field names cost ~200 characters on an
      // Ed25519 + RSA-3072 pair, which is a couple of QR versions' worth of
      // module density — the difference between scanning inline and only from
      // the full-screen dialog. The base64 key bodies themselves stay put, so
      // this is a fifth off, not a half.
      expect(verbose.length - compact.length).toBeGreaterThan(200);
    });
  });

  describe("non-canonical PEM", () => {
    it("falls back to the verbose encoding rather than reformatting the key", () => {
      // A key that survived a copy/paste round-trip: same base64, different
      // wrapping. Re-emitting it as canonical PEM would silently change the
      // string the directory matches on.
      const oddlyWrapped = `-----BEGIN PUBLIC KEY-----\n${keyBody("ed25519", 44)}\n\n-----END PUBLIC KEY-----`;
      const request = makeRequest({ signingPublicKey: oddlyWrapped });

      const uri = encodeJoinRequestUri(request);
      expect(decodeMindooURI(uri).version).toBe(1);
      expect(decodeJoinRequestUri(uri).signingPublicKey).toBe(oddlyWrapped);
    });
  });

  describe("legacy requests", () => {
    it("decodes a v1 request produced by an older client", () => {
      const uri = encodeMindooURI("join-request", {
        v: 1,
        username: "cn=legacy/o=acme",
        signingPublicKey: SIGNING_PEM,
        encryptionPublicKey: ENCRYPTION_PEM,
      });

      const decoded = decodeJoinRequestUri(uri);
      expect(decoded.v).toBe(1);
      expect(decoded.username).toBe("cn=legacy/o=acme");
      expect(decoded.signingPublicKey).toBe(SIGNING_PEM);
    });

    it("decodes a nameless v2 request", () => {
      const uri = encodeMindooURI("join-request", {
        v: 2,
        signingPublicKey: SIGNING_PEM,
        encryptionPublicKey: ENCRYPTION_PEM,
      });

      const decoded = decodeJoinRequestUri(uri);
      expect(decoded.v).toBe(2);
      expect(decoded.username).toBeUndefined();
    });
  });

  describe("hostile / malformed input", () => {
    it("rejects an unknown future version instead of guessing", () => {
      const uri = encodeMindooURI("join-request", { v: 99, s: "AAAA", e: "AAAA" });
      expect(() => decodeJoinRequestUri(uri)).toThrow(/Unsupported join request version 99/);
    });

    it("rejects a non-base64 compact key", () => {
      const uri = encodeMindooURI("join-request", { v: 3, s: "not base64!!", e: "AAAA" });
      expect(() => decodeJoinRequestUri(uri)).toThrow(/not a base64 public key body/);
    });

    it("rejects a compact payload with a missing key", () => {
      const uri = encodeMindooURI("join-request", { v: 3, s: "AAAA" });
      expect(() => decodeJoinRequestUri(uri)).toThrow(/missing "e"/);
    });

    it("rejects a URI of a different type", () => {
      const uri = encodeMindooURI("join-response", { v: 1 });
      expect(() => decodeJoinRequestUri(uri)).toThrow(/expected "join-request"/);
    });
  });
});
