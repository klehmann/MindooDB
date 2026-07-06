/**
 * Unit tests for the SSRF URL-safety helpers (audit, Medium: SSRF on sync URLs).
 */

import {
  assertSafeSyncUrl,
  isBlockedHostLiteral,
  isSameOrigin,
  UnsafeUrlError,
} from "../core/utils/urlSafety";

describe("urlSafety", () => {
  describe("isBlockedHostLiteral", () => {
    test.each([
      "localhost",
      "foo.localhost",
      "service.local",
      "metadata.google.internal",
      "127.0.0.1",
      "127.5.5.5",
      "0.0.0.0",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT
      "::1",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
    ])("blocks internal host %s", (host) => {
      expect(isBlockedHostLiteral(host)).toBe(true);
    });

    test.each([
      "example.com",
      "sync.example.com",
      "8.8.8.8",
      "172.32.0.1", // just outside the private 172.16/12 range
      "192.169.0.1",
      "2606:4700:4700::1111", // public IPv6 (Cloudflare)
    ])("allows public host %s", (host) => {
      expect(isBlockedHostLiteral(host)).toBe(false);
    });
  });

  describe("assertSafeSyncUrl", () => {
    test("accepts https public URL", () => {
      expect(() => assertSafeSyncUrl("https://sync.example.com/path")).not.toThrow();
    });

    test("rejects http when https required", () => {
      expect(() => assertSafeSyncUrl("http://sync.example.com")).toThrow(UnsafeUrlError);
    });

    test("rejects loopback even over https", () => {
      expect(() => assertSafeSyncUrl("https://127.0.0.1:8443")).toThrow(UnsafeUrlError);
      expect(() => assertSafeSyncUrl("https://localhost")).toThrow(UnsafeUrlError);
    });

    test("rejects the cloud metadata address", () => {
      expect(() => assertSafeSyncUrl("https://169.254.169.254/latest/meta-data")).toThrow(
        UnsafeUrlError,
      );
    });

    test("rejects non-http(s) schemes", () => {
      expect(() => assertSafeSyncUrl("file:///etc/passwd")).toThrow(UnsafeUrlError);
      expect(() => assertSafeSyncUrl("ftp://example.com")).toThrow(UnsafeUrlError);
    });

    test("allowPrivate + http permits localhost (dev)", () => {
      expect(() =>
        assertSafeSyncUrl("http://localhost:3000", {
          requireHttps: false,
          allowPrivate: true,
        }),
      ).not.toThrow();
    });
  });

  describe("isSameOrigin", () => {
    test("same scheme/host/port is same origin", () => {
      expect(
        isSameOrigin(new URL("https://a.com/x"), new URL("https://a.com/y")),
      ).toBe(true);
      // default https port normalization
      expect(
        isSameOrigin(new URL("https://a.com:443/x"), new URL("https://a.com/y")),
      ).toBe(true);
    });

    test("different host/scheme/port is cross origin", () => {
      expect(isSameOrigin(new URL("https://a.com"), new URL("https://b.com"))).toBe(false);
      expect(isSameOrigin(new URL("https://a.com"), new URL("http://a.com"))).toBe(false);
      expect(isSameOrigin(new URL("https://a.com:8443"), new URL("https://a.com"))).toBe(false);
    });
  });
});
