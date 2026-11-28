/**
 * Keeps the session cache of sealed key series apart per database.
 *
 * A sealed key series is named after a document: `$sealed:<docId>`. Document
 * ids are unique per database only, so two databases may hold a group
 * document with the same id (Mindoo Mail derives the id of an account's
 * group from the account id; every mailbox has the same `mgrp_…` for the
 * Mindoo Mail account). The tenant caches unwrapped series by key id, so a
 * delegate holding her own group under that id took it for the owner's: new
 * documents of the owner's group looked readable on her device and failed to
 * load, and a document she wrote with that group id would have used her own
 * key.
 *
 * Each database therefore hands the tenant a scoped key id for sealed series
 * (`$sealed:<docId>#<dbId>`). Only the in-memory cache sees it: entries keep
 * storing and signing the plain `$sealed:<docId>`.
 *
 * @module userkeys/scopedSealedKeys
 */
import { isSealedKeyId } from "./sealedTypes";

const SCOPE_SEPARATOR = "#";

/** The cache name of `keyId` in database `dbId`; other key ids pass unchanged. */
export function scopeSealedKeyId(keyId: string, dbId: string): string {
  if (!isSealedKeyId(keyId) || keyId.includes(SCOPE_SEPARATOR)) return keyId;
  return `${keyId}${SCOPE_SEPARATOR}${dbId}`;
}

/** The stored key id of a scoped cache name (the inverse of {@link scopeSealedKeyId}). */
export function unscopeSealedKeyId(keyId: string): string {
  if (!isSealedKeyId(keyId)) return keyId;
  const separator = keyId.indexOf(SCOPE_SEPARATOR);
  return separator < 0 ? keyId : keyId.slice(0, separator);
}

/**
 * The tenant as one database sees it: every string argument that is a sealed
 * key id is scoped to `dbId` before the call. Everything else, results
 * included, passes through, and the tenant's own internal calls work on the
 * scoped ids they were given.
 */
export function withScopedSealedKeys<T extends object>(tenant: T, dbId: string): T {
  const wrapped = new Map<PropertyKey, unknown>();
  return new Proxy(tenant, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      let fn = wrapped.get(property);
      if (!fn || (fn as { __source?: unknown }).__source !== value) {
        const source = value as (...args: unknown[]) => unknown;
        const call = (...args: unknown[]) =>
          source.apply(
            target,
            args.map((arg) => (typeof arg === "string" ? scopeSealedKeyId(arg, dbId) : arg)),
          );
        Object.defineProperty(call, "__source", { value: source });
        wrapped.set(property, call);
        fn = call;
      }
      return fn;
    },
  });
}
