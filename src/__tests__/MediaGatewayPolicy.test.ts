import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import {
  ContentAddressedStoreFactory,
  CreateStoreResult,
  OpenStoreOptions,
  StoreKind,
  DEFAULT_TENANT_KEY_ID,
  PUBLIC_INFOS_KEY_ID,
  PrivateUserId,
  MindooTenant,
} from "../core/types";
import { KeyBag } from "../core/keys/KeyBag";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { parseMediaGatewayPolicy } from "../core/accesscontrol/directoryProjection";
import {
  isValidMediaGatewayUrl,
  isValidMediaServerUrl,
  validateAccessPolicy,
  validateMediaGatewayPolicy,
} from "../core/accesscontrol/types";

/**
 * Media gateway policy: the `media` block of the tenant default policy
 * (`acl_defaultpolicy`). It names the gateway members' clients ask for access
 * to a call and the media server they then connect to. Clients read it with
 * `getMediaGatewayPolicy()`.
 */
class SharedInMemoryStoreFactory implements ContentAddressedStoreFactory {
  private stores = new Map<string, CreateStoreResult>();
  createStore(dbId: string, options?: OpenStoreOptions): CreateStoreResult {
    if (!this.stores.has(dbId)) {
      this.stores.set(dbId, {
        docStore: new InMemoryContentAddressedStore(dbId, StoreKind.docs, undefined, options),
        attachmentStore: new InMemoryContentAddressedStore(dbId, StoreKind.attachments, undefined, options),
      });
    }
    return this.stores.get(dbId)!;
  }
}

describe("parseMediaGatewayPolicy / validateMediaGatewayPolicy", () => {
  it("accepts bare origins only", () => {
    expect(isValidMediaGatewayUrl("https://calls.example.com")).toBe(true);
    expect(isValidMediaGatewayUrl("https://calls.example.com:8443")).toBe(true);
    expect(isValidMediaGatewayUrl("http://127.0.0.1:4310")).toBe(true);
    expect(isValidMediaGatewayUrl("http://localhost:4310")).toBe(true);
    // Plain http anywhere else would send the wrapped session key in the clear.
    expect(isValidMediaGatewayUrl("http://calls.example.com")).toBe(false);
    expect(isValidMediaGatewayUrl("https://calls.example.com/")).toBe(false);
    expect(isValidMediaGatewayUrl("https://calls.example.com/api")).toBe(false);
    expect(isValidMediaGatewayUrl("https://user:pw@calls.example.com")).toBe(false);
    expect(isValidMediaGatewayUrl("https://calls.example.com?x=1")).toBe(false);
    expect(isValidMediaGatewayUrl("https://calls.example.com#x")).toBe(false);
    expect(isValidMediaGatewayUrl("wss://calls.example.com")).toBe(false);
    expect(isValidMediaGatewayUrl("calls.example.com")).toBe(false);
    // A wildcard is not an origin: a policy must not open a whole domain.
    expect(isValidMediaGatewayUrl("https://*.example.com")).toBe(false);

    expect(isValidMediaServerUrl("wss://media.example.com")).toBe(true);
    expect(isValidMediaServerUrl("https://media.example.com")).toBe(true);
    expect(isValidMediaServerUrl("ws://127.0.0.1:7880")).toBe(true);
    expect(isValidMediaServerUrl("ws://media.example.com")).toBe(false);
    expect(isValidMediaServerUrl("wss://media.example.com/rtc")).toBe(false);
    expect(isValidMediaServerUrl("wss://*")).toBe(false);
  });

  it("keeps strings and drops malformed members when reading", () => {
    expect(
      parseMediaGatewayPolicy({ gatewayUrl: " https://calls.example.com ", mediaUrls: ["wss://media.example.com", 3, " "] }),
    ).toEqual({ gatewayUrl: "https://calls.example.com", mediaUrls: ["wss://media.example.com"] });
    expect(parseMediaGatewayPolicy({ gatewayUrl: 5, mediaUrls: "wss://a" })).toEqual({});
    expect(parseMediaGatewayPolicy(undefined)).toBeUndefined();
    expect(parseMediaGatewayPolicy(["https://calls.example.com"])).toBeUndefined();
  });

  it("validates a block before it is written", () => {
    expect(() => validateMediaGatewayPolicy({})).not.toThrow();
    expect(() => validateMediaGatewayPolicy({ gatewayUrl: "https://calls.example.com" })).not.toThrow();
    expect(() =>
      validateAccessPolicy({
        media: { gatewayUrl: "https://calls.example.com", mediaUrls: ["wss://media.example.com", "https://media.example.com"] },
      }),
    ).not.toThrow();
    expect(() => validateMediaGatewayPolicy("https://calls.example.com")).toThrow(/must be an object/);
    expect(() => validateMediaGatewayPolicy({ gatewayUrl: "http://calls.example.com" })).toThrow(/gatewayUrl/);
    expect(() => validateMediaGatewayPolicy({ gatewayUrl: "https://calls.example.com/x" })).toThrow(/gatewayUrl/);
    expect(() =>
      validateMediaGatewayPolicy({ gatewayUrl: "https://calls.example.com", mediaUrls: "wss://media.example.com" }),
    ).toThrow(/array/);
    expect(() =>
      validateMediaGatewayPolicy({ gatewayUrl: "https://calls.example.com", mediaUrls: ["wss://*.example.com"] }),
    ).toThrow(/mediaUrls entry/);
    expect(() =>
      validateMediaGatewayPolicy({
        gatewayUrl: "https://calls.example.com",
        mediaUrls: Array.from({ length: 11 }, (_, index) => `wss://m${index}.example.com`),
      }),
    ).toThrow(/at most 10/);
    expect(() => validateMediaGatewayPolicy({ mediaUrls: ["wss://media.example.com"] })).toThrow(/needs media.gatewayUrl/);
    expect(() => validateMediaGatewayPolicy({ gatewayUrl: "https://calls.example.com", secret: "x" })).toThrow(
      /not a known field/,
    );
  });
});

describe("tenant media gateway policy (directory round trip)", () => {
  let factory: BaseMindooTenantFactory;
  const tenantId = "tenant-media-policy";
  let admin: PrivateUserId;
  const adminPassword = "adminpass123";
  let adminKeyBag: KeyBag;
  let member: PrivateUserId;
  const memberPassword = "memberpass123";
  let memberTenant: MindooTenant;

  type MediaDirectory = Awaited<ReturnType<MindooTenant["openDirectory"]>> & {
    setDefaultAccessPolicy(policy: Record<string, unknown>, key: string, password: string): Promise<unknown>;
    setDatabaseAccessPolicy(dbid: string, policy: Record<string, unknown>, key: string, password: string): Promise<unknown>;
    getMediaGatewayPolicy(): Promise<{ gatewayUrl?: string; mediaUrls?: string[] } | null>;
    getLlmEndpointPolicy(): Promise<unknown>;
  };

  beforeEach(async () => {
    factory = new BaseMindooTenantFactory(new SharedInMemoryStoreFactory(), new NodeCryptoAdapter());
    admin = await factory.createUserId("CN=admin/O=media", adminPassword);
    adminKeyBag = new KeyBag(admin.userEncryptionKeyPair.privateKey, adminPassword, new NodeCryptoAdapter());
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);

    member = await factory.createUserId("CN=member/O=media", memberPassword);
    const memberKeyBag = new KeyBag(member.userEncryptionKeyPair.privateKey, memberPassword, new NodeCryptoAdapter());
    await memberKeyBag.set("doc", tenantId, PUBLIC_INFOS_KEY_ID, (await adminKeyBag.get("doc", tenantId, PUBLIC_INFOS_KEY_ID))!);
    await memberKeyBag.set("doc", tenantId, DEFAULT_TENANT_KEY_ID, (await adminKeyBag.get("doc", tenantId, DEFAULT_TENANT_KEY_ID))!);
    memberTenant = await factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      member,
      memberPassword,
      memberKeyBag,
    );
    const directory = await memberTenant.openDirectory();
    await directory.registerUser(factory.toPublicUserId(admin), admin.userSigningKeyPair.privateKey, adminPassword);
    await directory.registerUser(factory.toPublicUserId(member), admin.userSigningKeyPair.privateKey, adminPassword);
  }, 90000);

  async function dir(): Promise<MediaDirectory> {
    return (await memberTenant.openDirectory()) as unknown as MediaDirectory;
  }

  const key = () => admin.userSigningKeyPair.privateKey as unknown as string;

  it("is null without a policy and without a media block", async () => {
    const d = await dir();
    expect(await d.getMediaGatewayPolicy()).toBeNull();
    await d.setDefaultAccessPolicy({}, key(), adminPassword);
    expect(await d.getMediaGatewayPolicy()).toBeNull();
  }, 90000);

  it("round-trips the admin-written block, keeps it across other writes and clears it with {}", async () => {
    const d = await dir();
    const media = { gatewayUrl: "https://calls.example.com", mediaUrls: ["wss://media.example.com"] };
    await d.setDefaultAccessPolicy({ media }, key(), adminPassword);
    expect(await d.getMediaGatewayPolicy()).toEqual(media);

    // Another field, and the llm block, leave it alone.
    await d.setDefaultAccessPolicy({ denyDocDelete: true, llm: { allowedEndpoints: [] } }, key(), adminPassword);
    expect(await d.getMediaGatewayPolicy()).toEqual(media);
    expect(await d.getLlmEndpointPolicy()).toEqual({ allowedEndpoints: [] });

    // Writing media replaces the block whole.
    await d.setDefaultAccessPolicy({ media: { gatewayUrl: "http://127.0.0.1:4310" } }, key(), adminPassword);
    expect(await d.getMediaGatewayPolicy()).toEqual({ gatewayUrl: "http://127.0.0.1:4310" });
    await d.setDefaultAccessPolicy({ media: {} }, key(), adminPassword);
    expect(await d.getMediaGatewayPolicy()).toBeNull();
  }, 90000);

  it("is tenant-level only and applies even with the master switch on (as new tenants have it)", async () => {
    const d = await dir();
    await expect(
      d.setDatabaseAccessPolicy("main", { media: { gatewayUrl: "https://db-level.example" } }, key(), adminPassword),
    ).rejects.toThrow(/tenant-level/);

    await d.setDefaultAccessPolicy(
      { media: { gatewayUrl: "https://calls.example.com" }, disableAllAccessChecksAndPolicies: true },
      key(),
      adminPassword,
    );
    expect(await d.getMediaGatewayPolicy()).toEqual({ gatewayUrl: "https://calls.example.com" });
  }, 90000);

  it("refuses to write an invalid block", async () => {
    const d = await dir();
    await expect(
      d.setDefaultAccessPolicy({ media: { gatewayUrl: "https://calls.example.com/path" } }, key(), adminPassword),
    ).rejects.toThrow(/gatewayUrl/);
    await expect(
      d.setDefaultAccessPolicy(
        { media: { gatewayUrl: "https://calls.example.com", mediaUrls: ["wss://*"] } },
        key(),
        adminPassword,
      ),
    ).rejects.toThrow(/mediaUrls entry/);
    expect(await d.getMediaGatewayPolicy()).toBeNull();
  }, 90000);
});
