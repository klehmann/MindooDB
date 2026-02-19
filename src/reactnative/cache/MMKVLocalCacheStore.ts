import type { LocalCacheStore } from "../../core/cache/LocalCacheStore";

/**
 * Minimal MMKV interface (subset of react-native-mmkv).
 * Allows consumers to pass their own MMKV instance without
 * us importing the native module at the library level.
 */
export interface MMKVInterface {
  set(key: string, value: ArrayBuffer | boolean | string | number): void;
  getBuffer(key: string): ArrayBuffer | undefined;
  delete(key: string): void;
  getAllKeys(): string[];
  clearAll(): void;
}

/**
 * Minimal AsyncStorage interface (subset of @react-native-async-storage/async-storage).
 */
export interface AsyncStorageInterface {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
  clear(): Promise<void>;
}

/**
 * React Native {@link LocalCacheStore} backed by MMKV (synchronous, fast, binary-safe)
 * with an AsyncStorage fallback for environments where MMKV is unavailable.
 */
export class MMKVLocalCacheStore implements LocalCacheStore {
  private mmkv: MMKVInterface | null;
  private asyncStorage: AsyncStorageInterface | null;
  private readonly keyPrefix: string;

  /**
   * @param mmkv          An MMKV instance (from react-native-mmkv)
   * @param asyncStorage  Fallback AsyncStorage instance (used when mmkv is null)
   * @param keyPrefix     Optional prefix to namespace all keys (default: "mindoodb-cache:")
   */
  constructor(
    mmkv: MMKVInterface | null,
    asyncStorage?: AsyncStorageInterface | null,
    keyPrefix: string = "mindoodb-cache:",
  ) {
    this.mmkv = mmkv;
    this.asyncStorage = asyncStorage ?? null;
    this.keyPrefix = keyPrefix;

    if (!this.mmkv && !this.asyncStorage) {
      throw new Error("MMKVLocalCacheStore requires either an MMKV instance or AsyncStorage fallback");
    }
  }

  private toKey(type: string, id: string): string {
    return `${this.keyPrefix}${type}\0${id}`;
  }

  private fromKey(raw: string): { type: string; id: string } | null {
    if (!raw.startsWith(this.keyPrefix)) return null;
    const rest = raw.slice(this.keyPrefix.length);
    const sep = rest.indexOf("\0");
    if (sep === -1) return null;
    return { type: rest.slice(0, sep), id: rest.slice(sep + 1) };
  }

  // ---- Uint8Array <-> base64 for AsyncStorage (which only stores strings) ----

  private static toBase64(data: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < data.length; i++) {
      binary += String.fromCharCode(data[i]);
    }
    return btoa(binary);
  }

  private static fromBase64(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  // ---- LocalCacheStore ----

  async get(type: string, id: string): Promise<Uint8Array | null> {
    const key = this.toKey(type, id);

    if (this.mmkv) {
      const buf = this.mmkv.getBuffer(key);
      if (buf === undefined) return null;
      return new Uint8Array(buf);
    }

    const str = await this.asyncStorage!.getItem(key);
    if (str === null) return null;
    return MMKVLocalCacheStore.fromBase64(str);
  }

  async put(type: string, id: string, value: Uint8Array): Promise<void> {
    const key = this.toKey(type, id);

    if (this.mmkv) {
      const buf = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
      this.mmkv.set(key, buf);
      return;
    }

    await this.asyncStorage!.setItem(key, MMKVLocalCacheStore.toBase64(value));
  }

  async delete(type: string, id: string): Promise<void> {
    const key = this.toKey(type, id);

    if (this.mmkv) {
      this.mmkv.delete(key);
      return;
    }

    await this.asyncStorage!.removeItem(key);
  }

  async list(type: string): Promise<string[]> {
    const prefix = `${this.keyPrefix}${type}\0`;

    if (this.mmkv) {
      return this.mmkv
        .getAllKeys()
        .filter(k => k.startsWith(prefix))
        .map(k => k.slice(prefix.length));
    }

    const allKeys = await this.asyncStorage!.getAllKeys();
    return Array.from(allKeys)
      .filter(k => k.startsWith(prefix))
      .map(k => k.slice(prefix.length));
  }

  async clear(): Promise<void> {
    if (this.mmkv) {
      const allKeys = this.mmkv.getAllKeys();
      for (const key of allKeys) {
        if (key.startsWith(this.keyPrefix)) {
          this.mmkv.delete(key);
        }
      }
      return;
    }

    const allKeys = await this.asyncStorage!.getAllKeys();
    for (const key of allKeys) {
      if (key.startsWith(this.keyPrefix)) {
        await this.asyncStorage!.removeItem(key);
      }
    }
  }
}
