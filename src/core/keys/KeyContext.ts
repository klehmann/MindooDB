export type KeyType = "doc";

export function buildKeyDerivationSalt(type: KeyType, tenantId: string, id: string): string;
export function buildKeyDerivationSalt(type: KeyType, tenantId: string, id: string): string {
  if (!id) {
    throw new Error("Document keys require a tenantId and keyId.");
  }
  return `${type}:v2:${tenantId}:${id}`;
}

export function buildScopedKeyId(type: KeyType, tenantId: string, id: string): string;
export function buildScopedKeyId(type: KeyType, tenantId: string, id: string): string {
  if (!id) {
    throw new Error("Document keys require a tenantId and keyId.");
  }
  return `${type}:${tenantId}:${id}`;
}
