import { MindooDoc, SigningKeyPair, MindooDocPayload } from "../types";
import { BaseMindooTenant } from "../BaseMindooTenant";
import { Logger, MindooLogger, getDefaultLogLevel } from "../logging";

/**
 * MindooDocSigner provides functionality to create and verify combined signatures
 * for multiple document items in a MindooDoc.
 * 
 * This class addresses the security requirement of preventing selective tampering
 * with document fields. By signing multiple document items together in a single
 * signature operation, any modification to any signed field will invalidate the
 * entire signature.
 * 
 * ## Key Features
 * 
 * - **Combined Signatures**: All specified document items are signed together in
 *   one operation, preventing attackers from selectively modifying individual fields
 *   (e.g., changing a "type" field while keeping other fields intact).
 * 
 * - **Canonical JSON Serialization**: Uses deterministic JSON serialization that
 *   handles JavaScript's non-deterministic object key ordering. Object keys are
 *   sorted alphabetically, and nested objects are processed recursively to ensure
 *   the same data always produces the same signature.
 * 
 * - **Ed25519 Signatures**: Uses Ed25519 digital signatures for cryptographic
 *   security and verification.
 * 
 * ## Usage Example
 * 
 * ```typescript
 * const signer = new MindooDocSigner(tenant, signingKeyPair);
 * 
 * // Sign multiple document items together
 * const signature = await signer.signItems(
 *   doc,
 *   ["type", "status", "metadata"],
 *   password
 * );
 * 
 * // Verify the signature
 * const isValid = await signer.verifyItems(
 *   doc,
 *   ["type", "status", "metadata"],
 *   signature,
 *   publicKey
 * );
 * ```
 * 
 * ## Security Considerations
 * 
 * - The signature covers all specified items as a single unit. Changing any
 *   signed field will invalidate the signature.
 * - Missing fields are included as `null` in the canonical representation to
 *   ensure deterministic signatures regardless of field presence.
 * - The signing key is decrypted using the tenant's key decryption infrastructure,
 *   ensuring consistent security practices across the codebase.
 * 
 * ## Dependencies
 * 
 * - Requires a `BaseMindooTenant` instance for cryptographic operations
 *   (key decryption, crypto adapter access)
 * - Uses Ed25519 signing algorithm (Ed25519 signatures)
 * - Uses canonical JSON serialization for deterministic signatures
 * 
 * @see BaseMindooTenant For the tenant infrastructure used for key management
 */
export class MindooDocSigner {
  private tenant: BaseMindooTenant;
  private signKey: SigningKeyPair;
  private logger: Logger;

  constructor(tenant: BaseMindooTenant, signKey: SigningKeyPair, logger?: Logger) {
    this.tenant = tenant;
    this.signKey = signKey;
    this.logger =
      logger ||
      new MindooLogger(getDefaultLogLevel(), "MindooDocSigner", true);
  }

  /**
   * Creates a canonical JSON representation of the selected document items.
   * This ensures deterministic serialization regardless of object key order.
   * 
   * The canonical format:
   * - Object keys are sorted alphabetically
   * - Nested objects are processed recursively
   * - Arrays preserve order
   * - Primitives (string, number, boolean, null) are serialized as-is
   * - undefined values are omitted (not included in the signature)
   * 
   * @param payload The document payload
   * @param items The item keys to include in the signature
   * @returns A canonical JSON string representation
   */
  private createCanonicalJSON(payload: MindooDocPayload, items: string[]): string {
    // Extract only the specified items
    // Include all specified items, even if they don't exist (will be null)
    // This ensures deterministic signatures regardless of field presence
    const selectedItems: MindooDocPayload = {};
    for (const itemKey of items) {
      if (itemKey in payload) {
        selectedItems[itemKey] = payload[itemKey];
      } else {
        // Field doesn't exist - include as null for deterministic signature
        selectedItems[itemKey] = null;
      }
    }

    // Recursively canonicalize the object
    const canonicalize = (value: unknown): unknown => {
      if (value === null || value === undefined) {
        return null; // Treat undefined as null for consistency
      }
      
      if (Array.isArray(value)) {
        return value.map(item => canonicalize(item));
      }
      
      if (typeof value === "object") {
        // Sort keys alphabetically and recursively process values
        const sortedKeys = Object.keys(value).sort();
        const canonicalized: MindooDocPayload = {};
        for (const key of sortedKeys) {
          const itemValue = (value as MindooDocPayload)[key];
          if (itemValue !== undefined) {
            canonicalized[key] = canonicalize(itemValue);
          }
        }
        return canonicalized;
      }
      
      // Primitives: string, number, boolean
      return value;
    };

    const canonicalized = canonicalize(selectedItems);
    return JSON.stringify(canonicalized);
  }

  /**
   * Signs the specified document items with a combined signature.
   * This prevents selective tampering by signing all items together in one operation.
   * 
   * @param doc The document to sign items from
   * @param items The item keys to include in the signature
   * @param signPassword The password to decrypt the signing private key
   * @returns The signature as a Uint8Array
   */
  async signItems(doc: MindooDoc, items: string[], signPassword: string): Promise<Uint8Array> {
    const docPayload = doc.getData();
    
    // Create canonical JSON representation
    const canonicalJSON = this.createCanonicalJSON(docPayload, items);
    this.logger.debug(`Canonical JSON for signing: ${canonicalJSON}`);
    
    // Convert to bytes (UTF-8 encoding)
    const encoder = new TextEncoder();
    const payloadBytes = encoder.encode(canonicalJSON);
    
    // Decrypt the signing private key using the tenant's decryptPrivateKey method
    const decryptedKeyBuffer = await this.tenant.decryptPrivateKey(
      this.signKey.privateKey,
      signPassword,
      "signing"
    );
    
    const subtle = this.tenant.getCryptoAdapter().getSubtle();
    
    // Import the decrypted key as an Ed25519 private key
    const signingKey = await subtle.importKey(
      "pkcs8",
      decryptedKeyBuffer,
      {
        name: "Ed25519",
      },
      false, // not extractable
      ["sign"]
    );
    
    // Sign the payload
    const signature = await subtle.sign(
      {
        name: "Ed25519",
      },
      signingKey,
      payloadBytes.buffer as ArrayBuffer
    );
    
    this.logger.debug(`Signed ${items.length} items (signature: ${signature.byteLength} bytes)`);
    return new Uint8Array(signature);
  }

  /**
   * Verifies the signature for the specified document items.
   * 
   * @param doc The document to verify items from
   * @param items The item keys that were included in the signature
   * @param signature The signature to verify
   * @param publicKey The public key to verify the signature with (Ed25519, PEM format)
   * @returns True if the signature is valid, false otherwise
   */
  async verifyItems(
    doc: MindooDoc,
    items: string[],
    signature: Uint8Array,
    publicKey: string
  ): Promise<boolean> {
    const docPayload = doc.getData();
    
    // Create the same canonical JSON representation
    const canonicalJSON = this.createCanonicalJSON(docPayload, items);
    this.logger.debug(`Canonical JSON for verification: ${canonicalJSON}`);
    
    // Convert to bytes (UTF-8 encoding)
    const encoder = new TextEncoder();
    const payloadBytes = encoder.encode(canonicalJSON);
    
    const subtle = this.tenant.getCryptoAdapter().getSubtle();
    
    // Convert PEM format to ArrayBuffer using tenant's public method
    const publicKeyBuffer = this.tenant.pemToArrayBuffer(publicKey);
    
    // Import the public key from SPKI format
    const cryptoKey = await subtle.importKey(
      "spki",
      publicKeyBuffer,
      {
        name: "Ed25519",
      },
      false, // not extractable
      ["verify"]
    );
    
    // Verify the signature
    const isValid = await subtle.verify(
      {
        name: "Ed25519",
      },
      cryptoKey,
      signature.buffer as ArrayBuffer,
      payloadBytes.buffer as ArrayBuffer
    );
    
    this.logger.debug(`Signature verification: ${isValid ? "valid" : "invalid"}`);
    return isValid;
  }

}
