export type KeyType = "tenant" | "doc";

export function buildKeyDerivationSalt(type: KeyType, id: string): string {
  return `${type}:v1:${id}`;
}

export function buildScopedKeyId(type: KeyType, id: string): string {
  return `${type}:${id}`;
}
