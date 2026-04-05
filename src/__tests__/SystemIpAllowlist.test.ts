import {
  isClientIpAllowedForSystemList,
  isSystemIpAllowListDisabled,
} from "../node/server/SystemIpAllowlist";

describe("SystemIpAllowlist", () => {
  test("isSystemIpAllowListDisabled", () => {
    expect(isSystemIpAllowListDisabled(undefined)).toBe(true);
    expect(isSystemIpAllowListDisabled("*")).toBe(true);
    expect(isSystemIpAllowListDisabled("127.0.0.1")).toBe(false);
  });

  test("exact IPv4 match", () => {
    expect(isClientIpAllowedForSystemList("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(isClientIpAllowedForSystemList("127.0.0.2", "127.0.0.1")).toBe(false);
  });

  test("IPv4-mapped IPv6 normalized to IPv4", () => {
    expect(
      isClientIpAllowedForSystemList("::ffff:127.0.0.1", "127.0.0.1"),
    ).toBe(true);
  });

  test("IPv4 CIDR", () => {
    expect(isClientIpAllowedForSystemList("10.5.3.2", "10.0.0.0/8")).toBe(true);
    expect(isClientIpAllowedForSystemList("172.16.0.1", "10.0.0.0/8")).toBe(
      false,
    );
    expect(isClientIpAllowedForSystemList("192.168.1.50", "192.168.1.0/24")).toBe(
      true,
    );
  });

  test("exact IPv6 match across equivalent forms", () => {
    expect(
      isClientIpAllowedForSystemList(
        "2001:db8::1",
        "2001:0db8:0:0:0:0:0:1",
      ),
    ).toBe(true);
  });

  test("IPv6 CIDR", () => {
    expect(
      isClientIpAllowedForSystemList("2001:db8::1234", "2001:db8::/32"),
    ).toBe(true);
    expect(
      isClientIpAllowedForSystemList("2001:db9::1", "2001:db8::/32"),
    ).toBe(false);
    expect(
      isClientIpAllowedForSystemList("fd12:3456:789a::42", "fd12:3456:789a::/48"),
    ).toBe(true);
  });

  test("multiple entries", () => {
    const list = "127.0.0.1, 10.0.0.0/8, ::1, 2001:db8::/32";
    expect(isClientIpAllowedForSystemList("127.0.0.1", list)).toBe(true);
    expect(isClientIpAllowedForSystemList("10.99.1.1", list)).toBe(true);
    expect(isClientIpAllowedForSystemList("::1", list)).toBe(true);
    expect(isClientIpAllowedForSystemList("2001:db8::99", list)).toBe(true);
  });
});
