/**
 * Building blocks of recovery contacts (docs/userkeys.md §12): Shamir
 * splitting, the compact rescue device blob and the password-protected
 * helper packages.
 */
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { combineShares, splitSecret } from "../core/recovery/shamir";
import { generateRescueDevice, openRescueDevice } from "../core/recovery/rescueDevice";
import {
  RecoveryPackageError,
  combineRecoveryHelperPackages,
  decryptRecoveryHelperPackage,
  encryptRecoveryHelperPackage,
  extractRecoveryPackageText,
  generateRecoveryPackagePassword,
  normalizeRecoveryPackagePassword,
  type RecoveryHelperPackage,
} from "../core/recovery/recoveryPackage";
import { bytesToBase64 } from "../core/userkeys/fingerprint";
import { RSAEncryption } from "../core/crypto/RSAEncryption";

const crypto = new NodeCryptoAdapter();

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Every k-subset of `items`. */
function subsets<T>(items: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (items.length < k) return [];
  const [head, ...rest] = items;
  return [...subsets(rest, k - 1).map((s) => [head!, ...s]), ...subsets(rest, k)];
}

describe("Shamir secret sharing", () => {
  test("any 2 of n shares recover the secret; one share is not the secret", () => {
    for (const n of [2, 3, 5, 8]) {
      const secret = crypto.getRandomValues(new Uint8Array(32));
      const shares = splitSecret(crypto, secret, n, 2);
      expect(shares).toHaveLength(n);
      for (const share of shares) {
        expect(share).toHaveLength(33);
        expect(equal(share.slice(0, 32), secret)).toBe(false);
      }
      for (const pair of subsets(shares, 2)) {
        expect(equal(combineShares(pair), secret)).toBe(true);
      }
      // More than the threshold still works.
      expect(equal(combineShares(shares), secret)).toBe(true);
    }
  });

  test("k-of-n for larger thresholds; k-1 shares give a wrong value", () => {
    const secret = crypto.getRandomValues(new Uint8Array(16));
    const shares = splitSecret(crypto, secret, 5, 3);
    for (const triple of subsets(shares, 3)) {
      expect(equal(combineShares(triple), secret)).toBe(true);
    }
    const wrong = subsets(shares, 2).filter((pair) => equal(combineShares(pair), secret));
    expect(wrong.length).toBeLessThan(2);
  });

  test("x-coordinates are distinct and non-zero", () => {
    const shares = splitSecret(crypto, new Uint8Array([1, 2, 3]), 255, 2);
    const xs = new Set(shares.map((s) => s[3]));
    expect(xs.size).toBe(255);
    expect(xs.has(0)).toBe(false);
  });

  test("rejects bad parameters and inputs", () => {
    const secret = new Uint8Array([7]);
    expect(() => splitSecret(crypto, secret, 1, 2)).toThrow();
    expect(() => splitSecret(crypto, secret, 3, 1)).toThrow();
    expect(() => splitSecret(crypto, secret, 256, 2)).toThrow();
    expect(() => splitSecret(crypto, new Uint8Array(0), 3, 2)).toThrow();
    const shares = splitSecret(crypto, secret, 3, 2);
    expect(() => combineShares([shares[0]!])).toThrow();
    expect(() => combineShares([shares[0]!, shares[0]!])).toThrow(/duplicate/);
    expect(() => combineShares([shares[0]!, new Uint8Array([1, 2, 3])])).toThrow();
  });
});

describe("rescue device blob", () => {
  jest.setTimeout(120000);

  test("opens with the secret into the same working keys, and only with it", async () => {
    const rescue = await generateRescueDevice(crypto);
    // Ed25519 seed + two 1536-bit primes, AES-GCM: small enough for a QR code.
    expect(Buffer.from(rescue.blob, "base64").length).toBeLessThan(500);
    const opened = await openRescueDevice(crypto, rescue.secret, rescue.blob);
    expect(opened.signingPublicKey).toBe(rescue.signingPublicKey);
    expect(opened.encryptionPublicKey).toBe(rescue.encryptionPublicKey);
    expect(opened.signingKeyFingerprint).toBe(rescue.signingKeyFingerprint);

    // The rebuilt RSA key decrypts what the public key encrypted.
    const rsa = new RSAEncryption(crypto);
    const probe = crypto.getRandomValues(new Uint8Array(32));
    const sealed = await rsa.encrypt(probe, rescue.encryptionPublicKey);
    const privateKey = await crypto
      .getSubtle()
      .importKey("pkcs8", opened.encryptionPkcs8.slice(), { name: "RSA-OAEP", hash: "SHA-256" }, false, [
        "decrypt",
      ]);
    expect(equal(await rsa.decrypt(sealed, privateKey), probe)).toBe(true);

    // The rebuilt Ed25519 key signs for the public key.
    const subtle = crypto.getSubtle();
    const signKey = await subtle.importKey("pkcs8", opened.signingPkcs8.slice(), { name: "Ed25519" }, false, ["sign"]);
    const message = new TextEncoder().encode("hello");
    const signature = await subtle.sign({ name: "Ed25519" }, signKey, message);
    const spki = Buffer.from(
      rescue.signingPublicKey.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""),
      "base64",
    );
    const verifyKey = await subtle.importKey("spki", spki, { name: "Ed25519" }, false, ["verify"]);
    expect(await subtle.verify({ name: "Ed25519" }, verifyKey, signature, message)).toBe(true);

    const wrongSecret = crypto.getRandomValues(new Uint8Array(32));
    await expect(openRescueDevice(crypto, wrongSecret, rescue.blob)).rejects.toThrow();
  });
});

describe("helper packages", () => {
  jest.setTimeout(120000);

  test("passwords are 12 unambiguous characters in groups of four", () => {
    for (let i = 0; i < 50; i++) {
      const password = generateRecoveryPackagePassword(crypto);
      expect(password).toMatch(/^[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}$/);
    }
    expect(normalizeRecoveryPackagePassword(" ABCD efgh-JKMN ")).toBe("abcdefghjkmn");
  });

  async function packagesFor(n: number) {
    const rescue = await generateRescueDevice(crypto);
    const shares = splitSecret(crypto, rescue.secret, n, 2);
    const packages: RecoveryHelperPackage[] = shares.map((share, i) => ({
      v: 1,
      kind: "mindoodb-recovery-share",
      tenantId: "acme",
      serverUrl: "https://sync.example.com",
      username: "cn=alice/o=acme",
      setupDocId: "rcv_1",
      threshold: 2,
      rescueSigningKeyFingerprint: rescue.signingKeyFingerprint,
      rescueBlob: rescue.blob,
      share: bytesToBase64(share),
      helper: `cn=helper${i}/o=acme`,
      createdAt: Date.now(),
    }));
    return { rescue, packages };
  }

  test("round trip through text and password; any two combine; one alone fails", async () => {
    const { rescue, packages } = await packagesFor(3);
    const password = generateRecoveryPackagePassword(crypto);
    const text = await encryptRecoveryHelperPackage(crypto, packages[0]!, password);
    expect(text.startsWith("mdbrescue1.")).toBe(true);
    // Fits a QR code (byte mode holds 2331 characters at error correction M).
    expect(text.length).toBeLessThan(1700);
    expect(extractRecoveryPackageText(`Here you go:\n${text}\nGood luck`)).toBe(text);
    const back = await decryptRecoveryHelperPackage(crypto, ` ${text} `, password.toUpperCase());
    expect(back).toEqual(packages[0]);
    await expect(decryptRecoveryHelperPackage(crypto, text, "abcd-efgh-jkmn")).rejects.toMatchObject({
      code: "wrong-password",
    });
    await expect(decryptRecoveryHelperPackage(crypto, "nonsense", password)).rejects.toMatchObject({
      code: "malformed",
    });

    for (const pair of subsets(packages, 2)) {
      const combined = await combineRecoveryHelperPackages(crypto, pair);
      expect(combined.rescueDevice.signingPublicKey).toBe(rescue.signingPublicKey);
      expect(combined.tenantId).toBe("acme");
      expect(combined.serverUrl).toBe("https://sync.example.com");
      expect(combined.username).toBe("cn=alice/o=acme");
    }
    await expect(combineRecoveryHelperPackages(crypto, [packages[0]!])).rejects.toMatchObject({
      code: "too-few",
    });
    await expect(combineRecoveryHelperPackages(crypto, [packages[0]!, packages[0]!])).rejects.toMatchObject({
      code: "duplicate",
    });
  });

  test("packages of different setups do not combine; a forged share does not open", async () => {
    const a = await packagesFor(2);
    const b = await packagesFor(2);
    await expect(
      combineRecoveryHelperPackages(crypto, [a.packages[0]!, b.packages[1]!]),
    ).rejects.toMatchObject({ code: "mismatch" });
    const forged = { ...a.packages[1]!, share: bytesToBase64(crypto.getRandomValues(new Uint8Array(33))) };
    await expect(combineRecoveryHelperPackages(crypto, [a.packages[0]!, forged])).rejects.toBeInstanceOf(
      RecoveryPackageError,
    );
  });
});
