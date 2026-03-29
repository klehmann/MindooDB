import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { InMemoryContentAddressedStoreFactory } from "../appendonlystores/InMemoryContentAddressedStoreFactory";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { decryptPrivateKey } from "../core/crypto/privateKeyEncryption";
import type { PrivateUserId } from "../core/userid";
import { run as runChangeIdentityPassword, HELP_TEXT as CHANGE_PASSWORD_HELP } from "../node/cli/change-identity-password";
import { CliUsageError } from "../node/cli/cli-utils";
import { run as runIdentityExportPublic } from "../node/cli/identity-export-public";
import { run as runIdentityInfo, HELP_TEXT as IDENTITY_INFO_HELP } from "../node/cli/identity-info";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

describe("IdentityTools", () => {
  const cryptoAdapter = new NodeCryptoAdapter();
  const factory = new BaseMindooTenantFactory(
    new InMemoryContentAddressedStoreFactory(),
    cryptoAdapter,
  );

  let tempDir: string;
  let identity: PrivateUserId;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "mindoodb-identity-tools-"));
    identity = await factory.createUserId("CN=identity-tool-user/O=test", "old-password");
  }, 60000);

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("changeIdentityPassword", () => {
    it("re-encrypts both private keys and preserves public identity fields", async () => {
      const updated = await factory.changeIdentityPassword(identity, "old-password", "new-password");

      expect(updated.username).toBe(identity.username);
      expect(updated.userSigningKeyPair.publicKey).toBe(identity.userSigningKeyPair.publicKey);
      expect(updated.userEncryptionKeyPair.publicKey).toBe(identity.userEncryptionKeyPair.publicKey);
      expect(updated.userSigningKeyPair.privateKey.ciphertext).not.toBe(identity.userSigningKeyPair.privateKey.ciphertext);
      expect(updated.userEncryptionKeyPair.privateKey.ciphertext).not.toBe(identity.userEncryptionKeyPair.privateKey.ciphertext);

      await expect(
        decryptPrivateKey(
          cryptoAdapter,
          updated.userSigningKeyPair.privateKey,
          "old-password",
          "signing",
        ),
      ).rejects.toThrow();

      await expect(
        decryptPrivateKey(
          cryptoAdapter,
          updated.userSigningKeyPair.privateKey,
          "new-password",
          "signing",
        ),
      ).resolves.toBeInstanceOf(ArrayBuffer);

      await expect(
        decryptPrivateKey(
          cryptoAdapter,
          updated.userEncryptionKeyPair.privateKey,
          "new-password",
          "encryption",
        ),
      ).resolves.toBeInstanceOf(ArrayBuffer);
    }, 60000);

    it("fails when the current password is wrong", async () => {
      await expect(
        factory.changeIdentityPassword(identity, "wrong-password", "new-password"),
      ).rejects.toThrow();
    });
  });

  describe("CLI commands", () => {
    function writeIdentityFile(fileName: string, value: PrivateUserId): string {
      const path = join(tempDir, fileName);
      writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
      return path;
    }

    it("prints help for identity:info when called without parameters", async () => {
      await expect(runIdentityInfo([])).rejects.toEqual(
        expect.objectContaining({
          name: "CliUsageError",
          message: IDENTITY_INFO_HELP,
          exitCode: 1,
        }),
      );
    });

    it("prints identity info for a valid file", async () => {
      const identityPath = writeIdentityFile("info.identity.json", identity);
      const output: string[] = [];
      const logSpy = jest.spyOn(console, "log").mockImplementation((value?: unknown) => {
        output.push(value === undefined ? "" : String(value));
      });

      try {
        const exitCode = await runIdentityInfo(["--identity", identityPath]);
        expect(exitCode).toBe(0);
      } finally {
        logSpy.mockRestore();
      }

      const text = output.join("\n");
      expect(text).toContain(`Identity file: ${identityPath}`);
      expect(text).toContain(`Username: ${identity.username}`);
      expect(text).toContain("Public user ID (hex):");
      expect(text).toContain("Encrypted private keys present: yes");
    });

    it("prints help for identity:change-password when called without parameters", async () => {
      await expect(runChangeIdentityPassword([])).rejects.toEqual(
        expect.objectContaining({
          name: "CliUsageError",
          message: CHANGE_PASSWORD_HELP,
          exitCode: 1,
        }),
      );
    });

    it("changes the password of an identity file", async () => {
      const identityPath = writeIdentityFile("change-password.identity.json", identity);
      const promptValues = ["old-password", "rotated-password", "rotated-password"];
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);

      try {
        const exitCode = await runChangeIdentityPassword(
          ["--identity", identityPath],
          {
            prompt: async () => {
              const next = promptValues.shift();
              if (!next) {
                throw new Error("Unexpected prompt");
              }
              return next;
            },
          },
        );
        expect(exitCode).toBe(0);
      } finally {
        logSpy.mockRestore();
      }

      const updated = JSON.parse(readFileSync(identityPath, "utf8")) as PrivateUserId;
      expect(updated.username).toBe(identity.username);
      expect(updated.userSigningKeyPair.publicKey).toBe(identity.userSigningKeyPair.publicKey);

      await expect(
        decryptPrivateKey(
          cryptoAdapter,
          updated.userSigningKeyPair.privateKey,
          "rotated-password",
          "signing",
        ),
      ).resolves.toBeInstanceOf(ArrayBuffer);
    }, 60000);

    it("exports the public portion of an identity", async () => {
      const identityPath = writeIdentityFile("export.identity.json", identity);
      const outputPath = join(tempDir, "exported-public.json");
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);

      try {
        const exitCode = await runIdentityExportPublic([
          "--identity",
          identityPath,
          "--output",
          outputPath,
        ]);
        expect(exitCode).toBe(0);
      } finally {
        logSpy.mockRestore();
      }

      const exported = JSON.parse(readFileSync(outputPath, "utf8")) as {
        username: string;
        userSigningPublicKey: string;
        userEncryptionPublicKey: string;
      };

      expect(exported).toEqual({
        username: identity.username,
        userSigningPublicKey: identity.userSigningKeyPair.publicKey,
        userEncryptionPublicKey: identity.userEncryptionKeyPair.publicKey,
      });
    });
  });
});
