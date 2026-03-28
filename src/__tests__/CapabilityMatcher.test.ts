/**
 * Unit tests for the capability matching engine.
 */

import { CapabilityMatcher } from "../node/server/CapabilityMatcher";
import type { ServerConfig } from "../node/server/types";

describe("CapabilityMatcher", () => {
  const key1 = "-----BEGIN PUBLIC KEY-----\nKEY1\n-----END PUBLIC KEY-----";
  const key2 = "-----BEGIN PUBLIC KEY-----\nKEY2\n-----END PUBLIC KEY-----";
  const key3 = "-----BEGIN PUBLIC KEY-----\nKEY3\n-----END PUBLIC KEY-----";

  describe("exact path match", () => {
    test("should allow exact path match", () => {
      const config: ServerConfig = {
        capabilities: {
          "GET:/system/tenants": [
            { username: "admin", publicsignkey: key1 },
          ],
        },
      };
      const matcher = new CapabilityMatcher(config);

      expect(matcher.isAuthorized("GET", "/system/tenants", "admin", key1)).toBe(true);
    });

    test("should deny different path", () => {
      const config: ServerConfig = {
        capabilities: {
          "GET:/system/tenants": [
            { username: "admin", publicsignkey: key1 },
          ],
        },
      };
      const matcher = new CapabilityMatcher(config);

      expect(matcher.isAuthorized("GET", "/system/trusted-servers", "admin", key1)).toBe(false);
    });
  });

  describe("wildcard * match", () => {
    test("should match wildcard at end of path", () => {
      const config: ServerConfig = {
        capabilities: {
          "ALL:/system/*": [
            { username: "admin", publicsignkey: key1 },
          ],
        },
      };
      const matcher = new CapabilityMatcher(config);

      expect(matcher.isAuthorized("GET", "/system/tenants", "admin", key1)).toBe(true);
      expect(matcher.isAuthorized("POST", "/system/tenants/my-tenant", "admin", key1)).toBe(true);
      expect(matcher.isAuthorized("DELETE", "/system/tenants/my-tenant/sync-servers/foo", "admin", key1)).toBe(true);
    });

    test("should match prefix wildcard for tenant creation", () => {
      const config: ServerConfig = {
        capabilities: {
          "POST:/system/tenants/company-*": [
            { username: "ops", publicsignkey: key2 },
          ],
        },
      };
      const matcher = new CapabilityMatcher(config);

      expect(matcher.isAuthorized("POST", "/system/tenants/company-acme", "ops", key2)).toBe(true);
      expect(matcher.isAuthorized("POST", "/system/tenants/company-foo", "ops", key2)).toBe(true);
      expect(matcher.isAuthorized("POST", "/system/tenants/other-org", "ops", key2)).toBe(false);
    });

    test("wildcard should not match paths that don't start with prefix", () => {
      const config: ServerConfig = {
        capabilities: {
          "GET:/system/tenants/*": [
            { username: "admin", publicsignkey: key1 },
          ],
        },
      };
      const matcher = new CapabilityMatcher(config);

      expect(matcher.isAuthorized("GET", "/system/trusted-servers", "admin", key1)).toBe(false);
    });
  });

  describe("ALL method match", () => {
    test("should match any HTTP method", () => {
      const config: ServerConfig = {
        capabilities: {
          "ALL:/system/*": [
            { username: "admin", publicsignkey: key1 },
          ],
        },
      };
      const matcher = new CapabilityMatcher(config);

      expect(matcher.isAuthorized("GET", "/system/tenants", "admin", key1)).toBe(true);
      expect(matcher.isAuthorized("POST", "/system/tenants/x", "admin", key1)).toBe(true);
      expect(matcher.isAuthorized("PUT", "/system/tenants/x", "admin", key1)).toBe(true);
      expect(matcher.isAuthorized("DELETE", "/system/tenants/x", "admin", key1)).toBe(true);
    });
  });

  describe("method-specific rules", () => {
    test("should only match specified method", () => {
      const config: ServerConfig = {
        capabilities: {
          "POST:/system/tenants/*": [
            { username: "creator", publicsignkey: key1 },
          ],
        },
      };
      const matcher = new CapabilityMatcher(config);

      expect(matcher.isAuthorized("POST", "/system/tenants/new-tenant", "creator", key1)).toBe(true);
      expect(matcher.isAuthorized("GET", "/system/tenants", "creator", key1)).toBe(false);
      expect(matcher.isAuthorized("DELETE", "/system/tenants/new-tenant", "creator", key1)).toBe(false);
    });
  });

  describe("union semantics (multiple matching rules)", () => {
    test("should union principals from all matching rules", () => {
      const config: ServerConfig = {
        capabilities: {
          "ALL:/system/*": [
            { username: "superadmin", publicsignkey: key1 },
          ],
          "POST:/system/tenants/*": [
            { username: "creator", publicsignkey: key2 },
          ],
        },
      };
      const matcher = new CapabilityMatcher(config);

      // superadmin can do anything
      expect(matcher.isAuthorized("POST", "/system/tenants/x", "superadmin", key1)).toBe(true);
      // creator can create tenants
      expect(matcher.isAuthorized("POST", "/system/tenants/x", "creator", key2)).toBe(true);
      // creator cannot do other things
      expect(matcher.isAuthorized("GET", "/system/tenants", "creator", key2)).toBe(false);
    });
  });

  describe("no match returns deny", () => {
    test("should deny when no rules match", () => {
      const config: ServerConfig = {
        capabilities: {
          "GET:/system/tenants": [
            { username: "readonly", publicsignkey: key1 },
          ],
        },
      };
      const matcher = new CapabilityMatcher(config);

      expect(matcher.isAuthorized("DELETE", "/system/tenants/x", "readonly", key1)).toBe(false);
    });

    test("should deny with empty capabilities", () => {
      const config: ServerConfig = { capabilities: {} };
      const matcher = new CapabilityMatcher(config);

      expect(matcher.isAuthorized("GET", "/system/tenants", "anyone", key1)).toBe(false);
    });
  });

  describe("(username + key) must both match", () => {
    test("should deny when username matches but key does not", () => {
      const config: ServerConfig = {
        capabilities: {
          "ALL:/system/*": [
            { username: "admin", publicsignkey: key1 },
          ],
        },
      };
      const matcher = new CapabilityMatcher(config);

      expect(matcher.isAuthorized("GET", "/system/tenants", "admin", key2)).toBe(false);
    });

    test("should deny when key matches but username does not", () => {
      const config: ServerConfig = {
        capabilities: {
          "ALL:/system/*": [
            { username: "admin", publicsignkey: key1 },
          ],
        },
      };
      const matcher = new CapabilityMatcher(config);

      expect(matcher.isAuthorized("GET", "/system/tenants", "other-user", key1)).toBe(false);
    });
  });

  describe("username case-insensitivity", () => {
    test("should match usernames case-insensitively", () => {
      const config: ServerConfig = {
        capabilities: {
          "ALL:/system/*": [
            { username: "CN=Admin/O=MyOrg", publicsignkey: key1 },
          ],
        },
      };
      const matcher = new CapabilityMatcher(config);

      expect(matcher.isAuthorized("GET", "/system/tenants", "cn=admin/o=myorg", key1)).toBe(true);
      expect(matcher.isAuthorized("GET", "/system/tenants", "CN=ADMIN/O=MYORG", key1)).toBe(true);
    });
  });

  describe("overlapping rules", () => {
    test("should allow access when any overlapping rule grants it", () => {
      const config: ServerConfig = {
        capabilities: {
          "ALL:/system/*": [
            { username: "superadmin", publicsignkey: key1 },
          ],
          "GET:/system/*": [
            { username: "readonly", publicsignkey: key2 },
          ],
          "POST:/system/tenants/*": [
            { username: "readonly", publicsignkey: key2 },
          ],
        },
      };
      const matcher = new CapabilityMatcher(config);

      expect(matcher.isAuthorized("GET", "/system/tenants", "readonly", key2)).toBe(true);
      expect(matcher.isAuthorized("POST", "/system/tenants/x", "readonly", key2)).toBe(true);
      expect(matcher.isAuthorized("DELETE", "/system/tenants/x", "readonly", key2)).toBe(false);
    });
  });

  describe("principalExists", () => {
    test("should return true for existing principal", () => {
      const config: ServerConfig = {
        capabilities: {
          "ALL:/system/*": [
            { username: "admin", publicsignkey: key1 },
          ],
        },
      };
      const matcher = new CapabilityMatcher(config);

      expect(matcher.principalExists("admin", key1)).toBe(true);
      expect(matcher.principalExists("ADMIN", key1)).toBe(true);
    });

    test("should return false for unknown principal", () => {
      const config: ServerConfig = {
        capabilities: {
          "ALL:/system/*": [
            { username: "admin", publicsignkey: key1 },
          ],
        },
      };
      const matcher = new CapabilityMatcher(config);

      expect(matcher.principalExists("unknown", key1)).toBe(false);
      expect(matcher.principalExists("admin", key2)).toBe(false);
    });
  });

  describe("edge cases", () => {
    test("trailing slashes should not match", () => {
      const config: ServerConfig = {
        capabilities: {
          "GET:/system/tenants": [
            { username: "admin", publicsignkey: key1 },
          ],
        },
      };
      const matcher = new CapabilityMatcher(config);

      expect(matcher.isAuthorized("GET", "/system/tenants", "admin", key1)).toBe(true);
      expect(matcher.isAuthorized("GET", "/system/tenants/", "admin", key1)).toBe(false);
    });

    test("method comparison should be case-insensitive", () => {
      const config: ServerConfig = {
        capabilities: {
          "post:/system/tenants/*": [
            { username: "admin", publicsignkey: key1 },
          ],
        },
      };
      const matcher = new CapabilityMatcher(config);

      expect(matcher.isAuthorized("POST", "/system/tenants/x", "admin", key1)).toBe(true);
      expect(matcher.isAuthorized("post", "/system/tenants/x", "admin", key1)).toBe(true);
    });
  });
});
