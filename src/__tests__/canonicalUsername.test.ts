import {
  abbreviateCanonicalName,
  buildCanonicalName,
  canonicalizeUsername,
  expandAbbreviatedName,
  formatCanonicalDisplayName,
  formatCanonicalUsernameLabel,
  getCanonicalNameVariants,
  isCanonicalName,
  normalizeCanonicalNameForComparison,
  parseCanonicalName,
  sanitizeCanonicalNamePart,
  usernamesEqual,
} from "../core/userid/canonicalUsername";

describe("canonical name helpers (Haven algorithm)", () => {
  it("abbreviates canonical names by stripping prefixes case-insensitively", () => {
    expect(abbreviateCanonicalName("cn=abc/o=def")).toBe("abc/def");
    expect(abbreviateCanonicalName("CN=Karsten Lehmann/OU=mysuborg/O=Mindoo")).toBe(
      "Karsten Lehmann/mysuborg/Mindoo",
    );
    expect(abbreviateCanonicalName("CN=server1")).toBe("server1");
    expect(abbreviateCanonicalName("UID=karsten/OU=dev/O=Mindoo")).toBe("karsten/dev/Mindoo");
  });

  it("expands abbreviated Notes names to canonical form", () => {
    expect(expandAbbreviatedName("Karsten Lehmann/Mindoo")).toBe("cn=Karsten Lehmann/o=Mindoo");
    expect(expandAbbreviatedName("Karsten Lehmann/mysuborg/Mindoo")).toBe(
      "cn=Karsten Lehmann/ou=mysuborg/o=Mindoo",
    );
    expect(expandAbbreviatedName("cn=Karsten Lehmann/o=Mindoo")).toBe("cn=Karsten Lehmann/o=Mindoo");
    expect(expandAbbreviatedName("CN=Karsten Lehmann/O=Mindoo")).toBe("CN=Karsten Lehmann/O=Mindoo");
  });

  it("does not double-prefix segments that already carry a key", () => {
    expect(expandAbbreviatedName("test/o=myorg")).toBe("cn=test/o=myorg");
    expect(expandAbbreviatedName("cn=test/myorg")).toBe("cn=test/o=myorg");
  });

  it("returns single-segment input unchanged", () => {
    expect(expandAbbreviatedName("Peter Smith")).toBe("Peter Smith");
  });

  it("builds a canonical name from separate fields", () => {
    expect(buildCanonicalName({ cn: "Jane Doe", o: "Acme" })).toBe("cn=Jane Doe/o=Acme");
    expect(buildCanonicalName({ cn: "Jane Doe", ou: "Sales", o: "Acme" })).toBe(
      "cn=Jane Doe/ou=Sales/o=Acme",
    );
    expect(buildCanonicalName({ cn: "  Jane Doe  ", ou: "  ", o: "  Acme  " })).toBe("cn=Jane Doe/o=Acme");
    expect(buildCanonicalName({ cn: "", o: "Acme" })).toBe("");
  });

  it("strips structure-breaking characters when building a canonical name", () => {
    expect(sanitizeCanonicalNamePart("a/b=c")).toBe("abc");
    expect(sanitizeCanonicalNamePart(undefined)).toBe("");
    expect(buildCanonicalName({ cn: "Jane/Doe", o: "o=Acme" })).toBe("cn=JaneDoe/o=oAcme");
  });

  it("parses a canonical name back into separate fields", () => {
    expect(parseCanonicalName("cn=Jane Doe/ou=Sales/o=Acme")).toEqual({
      cn: "Jane Doe",
      ou: "Sales",
      o: "Acme",
    });
    expect(parseCanonicalName("Jane Doe/Acme")).toEqual({ cn: "Jane Doe", ou: "", o: "Acme" });
    expect(parseCanonicalName(undefined)).toEqual({ cn: "", ou: "", o: "" });
  });

  it("detects whether a Notes name is already canonical", () => {
    expect(isCanonicalName("cn=Karsten Lehmann/o=Mindoo")).toBe(true);
    expect(isCanonicalName("CN=Karsten Lehmann/OU=mysuborg/O=Mindoo")).toBe(true);
    expect(isCanonicalName("Karsten Lehmann/Mindoo")).toBe(false);
    expect(isCanonicalName("cn=/o=Mindoo")).toBe(false);
    expect(isCanonicalName("")).toBe(false);
  });

  it("formats canonical display names with abbreviation fallback", () => {
    expect(formatCanonicalDisplayName("cn=Server1/o=Mindoo", "https://sync.example.com")).toBe(
      "Server1/Mindoo",
    );
    expect(formatCanonicalDisplayName("CN=server1", "https://sync.example.com")).toBe("server1");
    expect(formatCanonicalDisplayName(undefined, "https://sync.example.com")).toBe(
      "https://sync.example.com",
    );
  });

  it("returns canonical, abbreviated, and common-name variants in order", () => {
    expect(getCanonicalNameVariants("cn=Server1/ou=Prod/o=Mindoo")).toEqual([
      "cn=Server1/ou=Prod/o=Mindoo",
      "Server1/Prod/Mindoo",
      "Server1",
    ]);
    expect(getCanonicalNameVariants("CN=server1")).toEqual(["CN=server1", "server1"]);
    expect(getCanonicalNameVariants(undefined)).toEqual([]);
  });

  it("normalizes canonical names for case-insensitive comparison using abbreviated form", () => {
    expect(normalizeCanonicalNameForComparison("cn=Server1/o=Mindoo")).toBe("server1/mindoo");
    expect(normalizeCanonicalNameForComparison("CN=server1/O=mindoo")).toBe("server1/mindoo");
    expect(normalizeCanonicalNameForComparison("server1/Mindoo")).toBe("server1/mindoo");
    expect(normalizeCanonicalNameForComparison("CN=server1")).toBe("server1");
  });
});

describe("canonicalizeUsername", () => {
  it("uppercases attribute types and lowercases values", () => {
    expect(canonicalizeUsername("cn=Alice/ou=HR/o=ACME")).toBe("CN=alice/OU=hr/O=acme");
  });

  it("expands abbreviated Notes names the same way as Haven", () => {
    expect(canonicalizeUsername("Alice/Acme")).toBe("CN=alice/O=acme");
    expect(canonicalizeUsername("Alice/HR/Acme")).toBe("CN=alice/OU=hr/O=acme");
    expect(canonicalizeUsername("test/o=myorg")).toBe("CN=test/O=myorg");
  });

  it("treats mixed-case and abbreviated DNs as equal", () => {
    expect(usernamesEqual("CN=Alice/O=Acme", "cn=alice/o=acme")).toBe(true);
    expect(usernamesEqual("Alice/Acme", "CN=alice/O=acme")).toBe(true);
    expect(usernamesEqual("UID=karsten/O=Mindoo", "CN=karsten/O=mindoo")).toBe(true);
  });

  it("throws when no organization can be derived from the value", () => {
    expect(() => canonicalizeUsername("alice")).toThrow(/organization/i);
    expect(() => canonicalizeUsername("CN=alice")).toThrow(/organization/i);
  });
});

describe("formatCanonicalUsernameLabel", () => {
  it("lowercases attribute types and keeps value case", () => {
    expect(formatCanonicalUsernameLabel("CN=Maya Chen/O=Acme")).toBe("cn=Maya Chen/o=Acme");
    expect(formatCanonicalUsernameLabel("cn=Ada Lovelace/ou=HR/o=Acme")).toBe(
      "cn=Ada Lovelace/ou=HR/o=Acme",
    );
  });

  it("expands abbreviated names without lowercasing values", () => {
    expect(formatCanonicalUsernameLabel("Maya Chen/Acme")).toBe("cn=Maya Chen/o=Acme");
    expect(formatCanonicalUsernameLabel("Ada Lovelace/HR/Acme")).toBe(
      "cn=Ada Lovelace/ou=HR/o=Acme",
    );
  });

  it("does not recover case from a persist key", () => {
    expect(formatCanonicalUsernameLabel("CN=maya chen/O=acme")).toBe("cn=maya chen/o=acme");
  });

  it("throws when no organization can be derived from the value", () => {
    expect(() => formatCanonicalUsernameLabel("alice")).toThrow(/organization/i);
    expect(() => formatCanonicalUsernameLabel("")).toThrow(/empty/i);
  });
});
