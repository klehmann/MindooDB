import {
  decryptEncryptedField,
  getEncryptedFieldKeyId,
  type EncryptedFieldDecryptor,
} from "../core/crypto/encryptedFields";
import { DEFAULT_TENANT_KEY_ID } from "../core/types";

/**
 * Identity "decryptor": returns the ciphertext bytes unchanged and records the
 * key id it was asked to use. Combined with a base64-of-plaintext field this
 * lets us assert the full decode -> decrypt -> utf8 pipeline without real keys.
 */
function createIdentityDecryptor(): EncryptedFieldDecryptor & { keyIds: string[] } {
  const keyIds: string[] = [];
  return {
    keyIds,
    async decryptPayload(encryptedPayload: Uint8Array, decryptionKeyId: string): Promise<Uint8Array> {
      keyIds.push(decryptionKeyId);
      return encryptedPayload;
    },
  };
}

function base64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

describe("getEncryptedFieldKeyId", () => {
  it("prefers an explicit override", () => {
    const data = { secret_encrypted_key: "companion" };
    expect(getEncryptedFieldKeyId(data, "secret_encrypted", "override")).toBe("override");
  });

  it("falls back to the companion field, then the tenant default", () => {
    expect(getEncryptedFieldKeyId({ secret_encrypted_key: "companion" }, "secret_encrypted")).toBe("companion");
    expect(getEncryptedFieldKeyId({}, "secret_encrypted")).toBe(DEFAULT_TENANT_KEY_ID);
    // Blank companions are ignored.
    expect(getEncryptedFieldKeyId({ secret_encrypted_key: "   " }, "secret_encrypted")).toBe(DEFAULT_TENANT_KEY_ID);
  });
});

describe("decryptEncryptedField", () => {
  it("decodes base64, decrypts, and utf8-decodes using the default key", async () => {
    const decryptor = createIdentityDecryptor();
    const data = { user_details_encrypted: base64('{"username":"Ada"}') };

    const result = await decryptEncryptedField(decryptor, data, "user_details_encrypted");

    expect(result).toBe('{"username":"Ada"}');
    expect(decryptor.keyIds).toEqual([DEFAULT_TENANT_KEY_ID]);
  });

  it("resolves the key id from the companion field", async () => {
    const decryptor = createIdentityDecryptor();
    const data = {
      contact_encrypted: base64("hello"),
      contact_encrypted_key: "named-key",
    };

    const result = await decryptEncryptedField(decryptor, data, "contact_encrypted");

    expect(result).toBe("hello");
    expect(decryptor.keyIds).toEqual(["named-key"]);
  });

  it("honors an explicit key override", async () => {
    const decryptor = createIdentityDecryptor();
    const data = {
      contact_encrypted: base64("hello"),
      contact_encrypted_key: "named-key",
    };

    await decryptEncryptedField(decryptor, data, "contact_encrypted", "override-key");

    expect(decryptor.keyIds).toEqual(["override-key"]);
  });

  it("returns null when the field is missing or blank", async () => {
    const decryptor = createIdentityDecryptor();
    expect(await decryptEncryptedField(decryptor, {}, "missing_encrypted")).toBeNull();
    expect(await decryptEncryptedField(decryptor, { x_encrypted: "" }, "x_encrypted")).toBeNull();
    expect(decryptor.keyIds).toEqual([]);
  });

  it("returns null when decryption fails (e.g. key not in key bag)", async () => {
    const failing: EncryptedFieldDecryptor = {
      async decryptPayload(): Promise<Uint8Array> {
        throw new Error("key not found");
      },
    };
    const data = { secret_encrypted: base64("data") };

    expect(await decryptEncryptedField(failing, data, "secret_encrypted")).toBeNull();
  });
});
