import type { CryptoAdapter } from "../core/crypto/CryptoAdapter";

/** WebCrypto of the Workers runtime (`globalThis.crypto`). */
export class WorkersCryptoAdapter implements CryptoAdapter {
  getSubtle(): SubtleCrypto {
    return globalThis.crypto.subtle;
  }

  getRandomValues(array: Uint8Array): Uint8Array {
    return globalThis.crypto.getRandomValues(array);
  }
}
