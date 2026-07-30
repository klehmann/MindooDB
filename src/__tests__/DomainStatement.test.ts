/**
 * Domain-separated statement signing.
 *
 * The point of these tests is the *negative* property: bytes signed as a seal
 * statement must never be usable as a store-entry signature or an auth
 * challenge response, no matter what an application asks for.
 */

import {
  assertAllowedSigningDomain,
  buildDomainStatementBytes,
  InvalidSigningDomainError,
  isAllowedSigningDomain,
  MAX_DOMAIN_STATEMENT_BYTES,
  SIGNING_DOMAINS,
} from "../core/crypto/DomainStatement";
import {
  buildEntrySigningBytes,
  importEd25519PublicKeyFromPem,
  ENTRY_SIGNATURE_LAYOUT_VERSION,
} from "../core/crypto/EntrySignature";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { InMemoryContentAddressedStoreFactory } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { KeyBag } from "../core/keys/KeyBag";
import { PUBLIC_INFOS_KEY_ID, type MindooTenant, type PrivateUserId } from "../core/types";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

const encoder = new TextEncoder();

describe("buildDomainStatementBytes", () => {
  it("prefixes the domain and a NUL separator", () => {
    const statement = encoder.encode("{}");
    const bytes = buildDomainStatementBytes(SIGNING_DOMAINS.SEAL_V1, statement);

    const domainBytes = encoder.encode(SIGNING_DOMAINS.SEAL_V1);
    expect(Array.from(bytes.slice(0, domainBytes.length))).toEqual(Array.from(domainBytes));
    expect(bytes[domainBytes.length]).toBe(0x00);
    expect(Array.from(bytes.slice(domainBytes.length + 1))).toEqual(Array.from(statement));
  });

  it("cannot collide with the store-entry signing layout", () => {
    const entryBytes = buildEntrySigningBytes({
      entryType: "doc_change",
      id: "doc1_d_abcd_efgh",
      docId: "doc1",
      decryptionKeyId: "default",
      createdAt: 1_700_000_000_000,
      dependencyIds: [],
      contentHash: "a".repeat(64),
      createdByPublicKey: "-----BEGIN PUBLIC KEY-----\nAAA\n-----END PUBLIC KEY-----",
    });
    const statementBytes = buildDomainStatementBytes(
      SIGNING_DOMAINS.SEAL_V1,
      encoder.encode("anything at all"),
    );

    // The entry layout opens with its version byte; every domain opens with an
    // ASCII letter, so the two byte spaces are disjoint at offset 0.
    expect(entryBytes[0]).toBe(ENTRY_SIGNATURE_LAYOUT_VERSION);
    expect(statementBytes[0]).not.toBe(ENTRY_SIGNATURE_LAYOUT_VERSION);
  });

  it("cannot be steered into another domain by a crafted statement", () => {
    // A statement that itself starts with a domain prefix still lands under the
    // real domain, because the prefix is prepended rather than parsed.
    const sneaky = encoder.encode(`${SIGNING_DOMAINS.SEAL_V1}\u0000{"evil":true}`);
    const bytes = buildDomainStatementBytes(SIGNING_DOMAINS.SEAL_V1, sneaky);
    const domainBytes = encoder.encode(SIGNING_DOMAINS.SEAL_V1);
    expect(bytes.byteLength).toBe(domainBytes.length + 1 + sneaky.byteLength);
  });

  it.each(["", "mindoodb-seal", "mindoodb-seal/v2", "auth-challenge", "../seal"])(
    "rejects domain %p",
    (domain) => {
      expect(() => buildDomainStatementBytes(domain, encoder.encode("x"))).toThrow(
        InvalidSigningDomainError,
      );
    },
  );

  it("rejects an oversized statement", () => {
    expect(() =>
      buildDomainStatementBytes(
        SIGNING_DOMAINS.SEAL_V1,
        new Uint8Array(MAX_DOMAIN_STATEMENT_BYTES + 1),
      ),
    ).toThrow(/too large/);
  });
});

describe("signing domain allowlist", () => {
  it("accepts only the declared domains", () => {
    expect(isAllowedSigningDomain(SIGNING_DOMAINS.SEAL_V1)).toBe(true);
    expect(isAllowedSigningDomain("whatever")).toBe(false);
    expect(() => assertAllowedSigningDomain("whatever")).toThrow(InvalidSigningDomainError);
  });
});

describe("tenant.signDomainStatement", () => {
  let tenant: MindooTenant;
  let currentUser: PrivateUserId;

  beforeEach(async () => {
    const factory = new BaseMindooTenantFactory(
      new InMemoryContentAddressedStoreFactory(),
      new NodeCryptoAdapter(),
    );
    const adminPassword = "adminpass123";
    const admin = await factory.createUserId("CN=admin/O=sealtenant", adminPassword);
    const userPassword = "userpassword123";
    currentUser = await factory.createUserId("CN=sealer/O=sealtenant", userPassword);
    const keyBag = new KeyBag(
      currentUser.userEncryptionKeyPair.privateKey,
      userPassword,
      factory.getCryptoAdapter(),
    );
    const tenantId = "seal-domain-tenant";
    await keyBag.createDocKey(tenantId, PUBLIC_INFOS_KEY_ID);
    await keyBag.createTenantKey(tenantId);
    tenant = await factory.openTenant(
      tenantId,
      admin.userSigningKeyPair.publicKey,
      admin.userEncryptionKeyPair.publicKey,
      currentUser,
      userPassword,
      keyBag,
    );
  }, 20000);

  it("signs a statement that verifies against the author's key", async () => {
    const statement = encoder.encode(JSON.stringify({ version: 1, kind: "page" }));
    const signature = await tenant.signDomainStatement(SIGNING_DOMAINS.SEAL_V1, statement);

    await expect(
      tenant.verifyDomainStatement(
        SIGNING_DOMAINS.SEAL_V1,
        statement,
        signature,
        currentUser.userSigningKeyPair.publicKey,
      ),
    ).resolves.toBe(true);
  }, 20000);

  it("fails verification when the statement is altered by one byte", async () => {
    const statement = encoder.encode(JSON.stringify({ version: 1, kind: "page" }));
    const signature = await tenant.signDomainStatement(SIGNING_DOMAINS.SEAL_V1, statement);

    const tampered = Uint8Array.from(statement);
    tampered[tampered.length - 2] ^= 0x01;

    await expect(
      tenant.verifyDomainStatement(
        SIGNING_DOMAINS.SEAL_V1,
        tampered,
        signature,
        currentUser.userSigningKeyPair.publicKey,
      ),
    ).resolves.toBe(false);
  }, 20000);

  it("refuses to sign under an unlisted domain", async () => {
    await expect(
      tenant.signDomainStatement("attacker-chosen", encoder.encode("{}")),
    ).rejects.toThrow(InvalidSigningDomainError);
  }, 20000);

  it("does not produce a signature valid over the bare statement", async () => {
    // Domain separation in one assertion: the signature covers the prefixed
    // bytes, so it is worthless to anyone verifying the raw payload — which is
    // exactly what the entry and challenge verifiers do. Checked against raw
    // WebCrypto rather than tenant.verifySignature, which would also reject on
    // the unrelated grounds that the key is not in this tenant's directory.
    const statement = encoder.encode("{}");
    const signature = await tenant.signDomainStatement(SIGNING_DOMAINS.SEAL_V1, statement);

    const subtle = new NodeCryptoAdapter().getSubtle();
    const key = await importEd25519PublicKeyFromPem(
      currentUser.userSigningKeyPair.publicKey,
      subtle,
    );
    await expect(
      subtle.verify(
        { name: "Ed25519" },
        key,
        signature.buffer as ArrayBuffer,
        statement.buffer as ArrayBuffer,
      ),
    ).resolves.toBe(false);
    await expect(
      subtle.verify(
        { name: "Ed25519" },
        key,
        signature.buffer as ArrayBuffer,
        buildDomainStatementBytes(SIGNING_DOMAINS.SEAL_V1, statement).buffer as ArrayBuffer,
      ),
    ).resolves.toBe(true);
  }, 20000);
});
