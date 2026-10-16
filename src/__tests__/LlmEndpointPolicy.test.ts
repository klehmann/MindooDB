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
import { parseLlmEndpointPolicy, parsePolicyDoc } from "../core/accesscontrol/directoryProjection";
import { validateAccessPolicy, validateLlmEndpointPolicy } from "../core/accesscontrol/types";

/**
 * Language-model endpoint policy: the `llm` block of the tenant default policy
 * (`acl_defaultpolicy`). Clients such as Haven's built-in assistant read it with
 * `getLlmEndpointPolicy()` and refuse to send tenant data elsewhere.
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

describe("parseLlmEndpointPolicy / validateLlmEndpointPolicy", () => {
  it("keeps string patterns and the default endpoint, dropping malformed members", () => {
    expect(
      parseLlmEndpointPolicy({
        allowedEndpoints: [" https://llm.example.com/* ", 3, "", "http://localhost:*"],
        defaultEndpoint: "https://llm.example.com/v1",
      }),
    ).toEqual({
      allowedEndpoints: ["https://llm.example.com/*", "http://localhost:*"],
      defaultEndpoint: "https://llm.example.com/v1",
    });
    expect(parseLlmEndpointPolicy({ allowedEndpoints: "nope", defaultEndpoint: 5 })).toEqual({});
    expect(parseLlmEndpointPolicy(undefined)).toBeUndefined();
    expect(parseLlmEndpointPolicy(["x"])).toBeUndefined();
  });

  it("is part of the parsed default policy", () => {
    const parsed = parsePolicyDoc({ type: "defaultpolicy", llm: { allowedEndpoints: [] } });
    expect(parsed.llm).toEqual({ allowedEndpoints: [] });
    expect(parsePolicyDoc({ type: "defaultpolicy" }).llm).toBeUndefined();
  });

  it("rejects malformed blocks before they are written", () => {
    expect(() => validateLlmEndpointPolicy("x")).toThrow(/must be an object/);
    expect(() => validateLlmEndpointPolicy({ allowedEndpoints: "https://a" })).toThrow(/array/);
    expect(() => validateLlmEndpointPolicy({ allowedEndpoints: ["ftp://a"] })).toThrow(/http\(s\)/);
    expect(() => validateLlmEndpointPolicy({ allowedEndpoints: ["https://a b"] })).toThrow(/http\(s\)/);
    expect(() => validateLlmEndpointPolicy({ defaultEndpoint: "https://u:p@a.example/v1" })).toThrow(
      /defaultEndpoint/,
    );
    expect(() => validateLlmEndpointPolicy({ defaultEndpoint: "https://a.example/v1?key=1" })).toThrow(
      /defaultEndpoint/,
    );
    expect(() => validateLlmEndpointPolicy({ models: [] })).toThrow(/not a known field/);
    expect(() =>
      validateAccessPolicy({
        llm: { allowedEndpoints: ["https://llm.example.com/*", "http://localhost:*"], defaultEndpoint: "https://llm.example.com/v1" },
      }),
    ).not.toThrow();
    expect(() => validateAccessPolicy({ llm: {} })).not.toThrow();
  });
});

describe("tenant LLM endpoint policy (directory round trip)", () => {
  let factory: BaseMindooTenantFactory;
  const tenantId = "tenant-llm-policy";
  let admin: PrivateUserId;
  const adminPassword = "adminpass123";
  let adminKeyBag: KeyBag;
  let member: PrivateUserId;
  const memberPassword = "memberpass123";
  let memberTenant: MindooTenant;

  type AclDirectory = Awaited<ReturnType<MindooTenant["openDirectory"]>> & {
    setDefaultAccessPolicy(policy: Record<string, unknown>, key: string, password: string): Promise<unknown>;
    setDatabaseAccessPolicy(dbid: string, policy: Record<string, unknown>, key: string, password: string): Promise<unknown>;
    getLlmEndpointPolicy(): Promise<{ allowedEndpoints?: string[]; defaultEndpoint?: string } | null>;
  };

  beforeEach(async () => {
    factory = new BaseMindooTenantFactory(new SharedInMemoryStoreFactory(), new NodeCryptoAdapter());
    admin = await factory.createUserId("CN=admin/O=llm", adminPassword);
    adminKeyBag = new KeyBag(admin.userEncryptionKeyPair.privateKey, adminPassword, new NodeCryptoAdapter());
    await adminKeyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await adminKeyBag.createTenantKey(tenantId);

    member = await factory.createUserId("CN=member/O=llm", memberPassword);
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

  async function dir(): Promise<AclDirectory> {
    return (await memberTenant.openDirectory()) as unknown as AclDirectory;
  }

  it("is null without a policy and without an llm block", async () => {
    const d = await dir();
    expect(await d.getLlmEndpointPolicy()).toBeNull();
    await d.setDefaultAccessPolicy({}, admin.userSigningKeyPair.privateKey, adminPassword);
    expect(await d.getLlmEndpointPolicy()).toBeNull();
  }, 90000);

  it("round-trips the admin-written block and lifts it again with {}", async () => {
    const d = await dir();
    await d.setDefaultAccessPolicy(
      {
        llm: {
          allowedEndpoints: ["https://llm.example.com/v1", "http://localhost:*"],
          defaultEndpoint: "https://llm.example.com/v1",
        },
      },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    expect(await d.getLlmEndpointPolicy()).toEqual({
      allowedEndpoints: ["https://llm.example.com/v1", "http://localhost:*"],
      defaultEndpoint: "https://llm.example.com/v1",
    });

    // Writing another field keeps the block; writing llm replaces it whole.
    await d.setDefaultAccessPolicy({ denyDocDelete: true }, admin.userSigningKeyPair.privateKey, adminPassword);
    expect((await d.getLlmEndpointPolicy())?.allowedEndpoints).toHaveLength(2);
    await d.setDefaultAccessPolicy({ llm: { allowedEndpoints: [] } }, admin.userSigningKeyPair.privateKey, adminPassword);
    expect(await d.getLlmEndpointPolicy()).toEqual({ allowedEndpoints: [] });
    await d.setDefaultAccessPolicy({ llm: {} }, admin.userSigningKeyPair.privateKey, adminPassword);
    expect(await d.getLlmEndpointPolicy()).toEqual({});
  }, 90000);

  it("is tenant-level only and applies even with the master switch on (as new tenants have it)", async () => {
    const d = await dir();
    await expect(
      d.setDatabaseAccessPolicy(
        "main",
        { llm: { allowedEndpoints: ["https://db-level.example/v1"] } },
        admin.userSigningKeyPair.privateKey,
        adminPassword,
      ),
    ).rejects.toThrow(/tenant-level/);

    await d.setDefaultAccessPolicy(
      { llm: { allowedEndpoints: ["https://llm.example.com/v1"] }, disableAllAccessChecksAndPolicies: true },
      admin.userSigningKeyPair.privateKey,
      adminPassword,
    );
    expect(await d.getLlmEndpointPolicy()).toEqual({ allowedEndpoints: ["https://llm.example.com/v1"] });
  }, 90000);

  it("refuses to write an invalid block", async () => {
    const d = await dir();
    await expect(
      d.setDefaultAccessPolicy(
        { llm: { allowedEndpoints: ["javascript:alert(1)"] } },
        admin.userSigningKeyPair.privateKey,
        adminPassword,
      ),
    ).rejects.toThrow(/http\(s\)/);
    expect(await d.getLlmEndpointPolicy()).toBeNull();
  }, 90000);
});
