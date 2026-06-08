import { SimpleMindooDirectory } from "../node/server/TenantManager";
import type { TenantConfig } from "../node/server/types";

/**
 * The config-based directory (`config.users[]`) is a public-key allowlist:
 * identity is `signingPublicKey`, the cleartext `username` is documentation-only
 * and ignored for matching, and arbitrary extra fields (e.g. `comment`) are
 * tolerated (docs/accesscontrol.md §6.5, server config).
 */
describe("SimpleMindooDirectory (config allowlist)", () => {
  const ADMIN_KEY = "-----BEGIN PUBLIC KEY-----\nADMIN\n-----END PUBLIC KEY-----";
  const ALICE_SIGN = "-----BEGIN PUBLIC KEY-----\nALICE-SIGN\n-----END PUBLIC KEY-----";
  const ALICE_ENC = "-----BEGIN PUBLIC KEY-----\nALICE-ENC\n-----END PUBLIC KEY-----";

  function makeConfig(users: TenantConfig["users"]): TenantConfig {
    return {
      adminSigningPublicKey: ADMIN_KEY,
      adminEncryptionPublicKey: "-----BEGIN PUBLIC KEY-----\nADMIN-ENC\n-----END PUBLIC KEY-----",
      users,
    } as TenantConfig;
  }

  it("tolerates comment and arbitrary extra fields, and a missing username", () => {
    // No `username`; carries a `comment` and an unknown extra field.
    const config = makeConfig([
      {
        signingPublicKey: ALICE_SIGN,
        encryptionPublicKey: ALICE_ENC,
        comment: "alice's laptop",
        department: "engineering",
      } as unknown as NonNullable<TenantConfig["users"]>[number],
    ]);
    // Construction must not throw on the extra/missing fields.
    expect(() => new SimpleMindooDirectory(config)).not.toThrow();
  });

  it("identifies entries by signing key, not username", async () => {
    const dir = new SimpleMindooDirectory(
      makeConfig([
        {
          signingPublicKey: ALICE_SIGN,
          encryptionPublicKey: ALICE_ENC,
          comment: "alice",
        } as unknown as NonNullable<TenantConfig["users"]>[number],
      ]),
    );

    // The signing key is the identity: resolvable + validatable by key.
    const lookup = await dir.getUserBySigningPublicKey(ALICE_SIGN);
    expect(lookup).not.toBeNull();
    expect(lookup!.signingPublicKey).toBe(ALICE_SIGN);
    expect(lookup!.encryptionPublicKey).toBe(ALICE_ENC);
    expect(await dir.validatePublicSigningKey(ALICE_SIGN)).toBe(true);

    // The admin key is always trusted; an unknown key is not.
    expect(await dir.validatePublicSigningKey(ADMIN_KEY)).toBe(true);
    expect(await dir.validatePublicSigningKey("unknown-key")).toBe(false);
    expect(await dir.getUserBySigningPublicKey("unknown-key")).toBeNull();
  });

  it("still resolves a legacy username when one is supplied (back-compat)", async () => {
    const dir = new SimpleMindooDirectory(
      makeConfig([
        {
          username: "Alice",
          signingPublicKey: ALICE_SIGN,
          encryptionPublicKey: ALICE_ENC,
        },
      ]),
    );

    // Username lookup is case-insensitive and optional.
    const byName = await dir.getUserPublicKeys("alice");
    expect(byName).toEqual({ signingPublicKey: ALICE_SIGN, encryptionPublicKey: ALICE_ENC });

    // An entry without a username is simply not resolvable by name (but is by key).
    const keyless = new SimpleMindooDirectory(
      makeConfig([
        {
          signingPublicKey: ALICE_SIGN,
          encryptionPublicKey: ALICE_ENC,
          comment: "no name here",
        } as unknown as NonNullable<TenantConfig["users"]>[number],
      ]),
    );
    expect(await keyless.getUserPublicKeys("anything")).toBeNull();
    expect(await keyless.getUserBySigningPublicKey(ALICE_SIGN)).not.toBeNull();
  });
});
