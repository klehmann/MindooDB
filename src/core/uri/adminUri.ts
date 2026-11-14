/**
 * `mdb://admin-request/...` and `mdb://admin-response/...` (docs/accesscontrol.md §6.13).
 *
 * The admin request is the delegated-admin counterpart of a join request: the
 * future admin's device creates a dedicated admin identity and exports its
 * public keys. The root admin approves it, which writes the admin-key document,
 * and returns an admin response: the tenant's root keys (the trust anchor never
 * changes) plus the tenant `default` and `$publicinfos` keys RSA-OAEP-wrapped to
 * the new admin key, like a v3 join response.
 */
import type { JoinResponseEncryptedDocKey } from "../types";
import { decodeMindooURI, encodeMindooURI, isMindooURI } from "./MindooURI";

/** A request to become a delegated administrator. Public keys only. */
export interface AdminRequest {
  v: 1;
  /** Ed25519 public key of the admin identity (PEM). */
  signingPublicKey: string;
  /** RSA-OAEP public key of the admin identity (PEM). */
  encryptionPublicKey: string;
  /** The tenant the request is meant for (lets the root's UI catch a mix-up). */
  tenantId?: string;
  /** Suggested name of the admin; the root may override it. */
  name?: string;
  /** Suggested device label, e.g. "Laptop". */
  label?: string;
}

/** The root's answer to an {@link AdminRequest}. */
export interface AdminResponse {
  v: 1;
  tenantId: string;
  /** The tenant's ROOT admin signing key — still the trust anchor to open the tenant with. */
  adminSigningPublicKey: string;
  /** The tenant's root admin encryption key. */
  adminEncryptionPublicKey: string;
  /** The approved delegated admin key (echo of the request). */
  signingPublicKey: string;
  /** The name the admin was registered under. */
  name: string;
  label?: string;
  tenantLabel?: string;
  serverUrl?: string;
  /** `default` and `$publicinfos`, every version RSA-OAEP-wrapped to the admin's encryption key. */
  encryptedDocKeys: JoinResponseEncryptedDocKey[];
}

function requireString(value: unknown, field: string, kind: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${kind}: "${field}" is missing`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Encode an {@link AdminRequest} as `mdb://admin-request/...`. */
export function encodeAdminRequestUri(request: AdminRequest): string {
  return encodeMindooURI("admin-request", request as unknown as Record<string, unknown>);
}

/** Decode and validate `mdb://admin-request/...` (or pass an object through validation). */
export function decodeAdminRequestUri(uri: string | AdminRequest): AdminRequest {
  let payload: Record<string, unknown>;
  if (typeof uri === "string") {
    if (!isMindooURI(uri.trim())) {
      throw new Error("Invalid admin request: expected a mdb://admin-request/... URI");
    }
    const decoded = decodeMindooURI<Record<string, unknown>>(uri.trim());
    if (decoded.type !== "admin-request") {
      throw new Error(`Invalid URI type: expected "admin-request", got "${decoded.type}"`);
    }
    payload = decoded.payload;
  } else {
    payload = uri as unknown as Record<string, unknown>;
  }
  if (payload.v !== 1) throw new Error(`Unsupported admin request version: ${String(payload.v)}`);
  const request: AdminRequest = {
    v: 1,
    signingPublicKey: requireString(payload.signingPublicKey, "signingPublicKey", "admin request"),
    encryptionPublicKey: requireString(payload.encryptionPublicKey, "encryptionPublicKey", "admin request"),
  };
  const tenantId = optionalString(payload.tenantId);
  const name = optionalString(payload.name);
  const label = optionalString(payload.label);
  if (tenantId) request.tenantId = tenantId;
  if (name) request.name = name;
  if (label) request.label = label;
  return request;
}

/** Encode an {@link AdminResponse} as `mdb://admin-response/...`. */
export function encodeAdminResponseUri(response: AdminResponse): string {
  return encodeMindooURI("admin-response", response as unknown as Record<string, unknown>);
}

/** Decode and validate `mdb://admin-response/...`. */
export function decodeAdminResponseUri(uri: string | AdminResponse): AdminResponse {
  let payload: Record<string, unknown>;
  if (typeof uri === "string") {
    if (!isMindooURI(uri.trim())) {
      throw new Error("Invalid admin response: expected a mdb://admin-response/... URI");
    }
    const decoded = decodeMindooURI<Record<string, unknown>>(uri.trim());
    if (decoded.type !== "admin-response") {
      throw new Error(`Invalid URI type: expected "admin-response", got "${decoded.type}"`);
    }
    payload = decoded.payload;
  } else {
    payload = uri as unknown as Record<string, unknown>;
  }
  if (payload.v !== 1) throw new Error(`Unsupported admin response version: ${String(payload.v)}`);
  if (!Array.isArray(payload.encryptedDocKeys)) {
    throw new Error('Invalid admin response: "encryptedDocKeys" is missing');
  }
  const response: AdminResponse = {
    v: 1,
    tenantId: requireString(payload.tenantId, "tenantId", "admin response"),
    adminSigningPublicKey: requireString(payload.adminSigningPublicKey, "adminSigningPublicKey", "admin response"),
    adminEncryptionPublicKey: requireString(payload.adminEncryptionPublicKey, "adminEncryptionPublicKey", "admin response"),
    signingPublicKey: requireString(payload.signingPublicKey, "signingPublicKey", "admin response"),
    name: requireString(payload.name, "name", "admin response"),
    encryptedDocKeys: payload.encryptedDocKeys as JoinResponseEncryptedDocKey[],
  };
  const label = optionalString(payload.label);
  const tenantLabel = optionalString(payload.tenantLabel);
  const serverUrl = optionalString(payload.serverUrl);
  if (label) response.label = label;
  if (tenantLabel) response.tenantLabel = tenantLabel;
  if (serverUrl) response.serverUrl = serverUrl;
  return response;
}
