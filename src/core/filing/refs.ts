/**
 * Reference format of filed documents.
 *
 * A filing sidecar stores the document it files as a reference RELATIVE to
 * the database the sidecar lives in (the filing database), so the common
 * case stays short and a filing database can be copied between tenants
 * without rewriting same-database references:
 *
 * - `"<docId>"` — a document in the filing database itself,
 * - `"mdbref:/<dbId>/<docId>"` — a document in another database of the
 *   same tenant,
 * - `"mdbref://<tenantId>/<dbId>/<docId>"` — a document in a database of
 *   another tenant.
 *
 * The reference always names the PHYSICAL identity (tenant id, database id)
 * — never a view-local origin name or an app's logical database name.
 * Views translate references into the canonical physical key
 * `"<tenantId>/<dbId>/<docId>"` ({@link physicalFilingRefKey}) to match them
 * against their data sources.
 */

/** A filed document, addressed by its physical identity. */
export interface FilingTarget {
  tenantId: string;
  dbId: string;
  docId: string;
}

/**
 * A filed document as accepted by the filing API: a reference string
 * (`"<docId>"`, `"mdbref:/<dbId>/<docId>"`, `"mdbref://<tenantId>/<dbId>/<docId>"`)
 * or an object whose missing `tenantId` / `dbId` default to the filing
 * database's.
 */
export type FilingRefInput = string | { tenantId?: string; dbId?: string; docId: string };

/** The database a reference is relative to (the filing database). */
export interface FilingRefBase {
  tenantId: string;
  dbId: string;
}

const REF_SCHEME = "mdbref:";

function assertSegment(value: string, what: string, ref: string): void {
  if (!value || value.includes("/")) {
    throw new Error(`Invalid filing reference "${ref}": missing or malformed ${what}.`);
  }
}

/** Resolve a reference (string or object) against the filing database. */
export function resolveFilingRef(ref: FilingRefInput, base: FilingRefBase): FilingTarget {
  if (typeof ref !== "string") {
    if (!ref || typeof ref.docId !== "string") {
      throw new Error("Invalid filing reference: expected a reference string or { docId }.");
    }
    const target = {
      tenantId: ref.tenantId ?? base.tenantId,
      dbId: ref.dbId ?? base.dbId,
      docId: ref.docId,
    };
    assertSegment(target.tenantId, "tenant id", JSON.stringify(ref));
    assertSegment(target.dbId, "database id", JSON.stringify(ref));
    assertSegment(target.docId, "document id", JSON.stringify(ref));
    return target;
  }
  if (!ref.startsWith(REF_SCHEME)) {
    assertSegment(ref, "document id", ref);
    return { tenantId: base.tenantId, dbId: base.dbId, docId: ref };
  }
  const rest = ref.slice(REF_SCHEME.length);
  if (rest.startsWith("//")) {
    const parts = rest.slice(2).split("/");
    if (parts.length !== 3) {
      throw new Error(`Invalid filing reference "${ref}": expected mdbref://<tenantId>/<dbId>/<docId>.`);
    }
    const [tenantId, dbId, docId] = parts;
    assertSegment(tenantId, "tenant id", ref);
    assertSegment(dbId, "database id", ref);
    assertSegment(docId, "document id", ref);
    return { tenantId, dbId, docId };
  }
  if (rest.startsWith("/")) {
    const parts = rest.slice(1).split("/");
    if (parts.length !== 2) {
      throw new Error(`Invalid filing reference "${ref}": expected mdbref:/<dbId>/<docId>.`);
    }
    const [dbId, docId] = parts;
    assertSegment(dbId, "database id", ref);
    assertSegment(docId, "document id", ref);
    return { tenantId: base.tenantId, dbId, docId };
  }
  throw new Error(`Invalid filing reference "${ref}".`);
}

/**
 * The shortest reference string for `target` relative to `base` — the form
 * stored in sidecars.
 */
export function formatFilingRef(target: FilingTarget, base: FilingRefBase): string {
  if (target.tenantId !== base.tenantId) {
    return `${REF_SCHEME}//${target.tenantId}/${target.dbId}/${target.docId}`;
  }
  if (target.dbId !== base.dbId) {
    return `${REF_SCHEME}/${target.dbId}/${target.docId}`;
  }
  return target.docId;
}

/** Canonical physical key `"<tenantId>/<dbId>/<docId>"` of a filed document. */
export function physicalFilingRefKey(target: FilingTarget): string {
  return `${target.tenantId}/${target.dbId}/${target.docId}`;
}

/** Inverse of {@link physicalFilingRefKey}. */
export function parsePhysicalFilingRefKey(key: string): FilingTarget {
  const first = key.indexOf("/");
  const last = key.lastIndexOf("/");
  return {
    tenantId: key.slice(0, first),
    dbId: key.slice(first + 1, last),
    docId: key.slice(last + 1),
  };
}

/** Physical key prefix `"<tenantId>/<dbId>/"` of a database. */
export function physicalDbKey(tenantId: string, dbId: string): string {
  return `${tenantId}/${dbId}`;
}
