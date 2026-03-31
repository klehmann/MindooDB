export type KeyType = "tenant" | "doc";

export function buildKeyDerivationSalt(type: "tenant", id: string): string;
export function buildKeyDerivationSalt(type: "doc", tenantId: string, id: string): string;
export function buildKeyDerivationSalt(type: KeyType, arg1: string, arg2?: string): string {
  if (type === "doc") {
    if (!arg2) {
      throw new Error("Document keys require a tenantId and keyId.");
    }
    return `${type}:v2:${arg1}:${arg2}`;
  }

  return `${type}:v1:${arg1}`;
}

export function buildScopedKeyId(type: "tenant", id: string): string;
export function buildScopedKeyId(type: "doc", tenantId: string, id: string): string;
export function buildScopedKeyId(type: KeyType, arg1: string, arg2?: string): string {
  if (type === "doc") {
    if (!arg2) {
      throw new Error("Document keys require a tenantId and keyId.");
    }
    return `${type}:${arg1}:${arg2}`;
  }

  return `${type}:${arg1}`;
}
