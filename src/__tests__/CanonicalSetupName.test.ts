import { toCanonicalSetupName } from "../node/server/canonicalSetupName";

describe("toCanonicalSetupName", () => {
  it("expands the abbreviated form operators actually type", () => {
    expect(toCanonicalSetupName("server1/acme")).toBe("cn=server1/o=acme");
    expect(toCanonicalSetupName("sysadmin/dev/acme")).toBe("cn=sysadmin/ou=dev/o=acme");
  });

  it("leaves a canonical name alone instead of prefixing it again", () => {
    // The old setup wrote `CN=${name}` unconditionally, which turned a correctly
    // typed name into `CN=cn=server1/o=acme`.
    expect(toCanonicalSetupName("cn=server1/o=acme")).toBe("cn=server1/o=acme");
    expect(toCanonicalSetupName("CN=server1/O=acme")).toBe("CN=server1/O=acme");
  });

  it("completes a name that carries only some of its keys", () => {
    expect(toCanonicalSetupName("server1/o=acme")).toBe("cn=server1/o=acme");
    expect(toCanonicalSetupName("cn=server1/acme")).toBe("cn=server1/o=acme");
  });

  it("rejects a name without an organization", () => {
    // `canonicalizeUsername` refuses these later, and a system admin stored
    // without an organization authenticates until the first encryption path.
    expect(toCanonicalSetupName("server1")).toBeNull();
    expect(toCanonicalSetupName("cn=server1")).toBeNull();
    expect(toCanonicalSetupName("cn=server1/ou=dev")).toBeNull();
  });

  it("rejects a name without a common name, and empty input", () => {
    expect(toCanonicalSetupName("o=acme")).toBeNull();
    expect(toCanonicalSetupName("   ")).toBeNull();
  });

  it("ignores surrounding whitespace", () => {
    expect(toCanonicalSetupName("  server1/acme  ")).toBe("cn=server1/o=acme");
  });
});
