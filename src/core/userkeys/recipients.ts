import type { BaseMindooTenant } from "../BaseMindooTenant";
import { extractActiveKeyPairs } from "../accesscontrol/grantKeys";
import { DIRECTORY_DB_ID } from "../types";
import type { MindooDocPayload } from "../types";
import {
  canonicalizeUsername,
  formatCanonicalUsernameLabel,
  usernamesEqual,
} from "../userid/canonicalUsername";
import { fingerprintEncryptionPublicKey } from "./fingerprint";
import { sealBundle } from "./sealedCrypto";
import {
  ENCRYPT_FOR_FIELD,
  type EncryptForEntry,
  type EntryRecipients,
  type RecipientOptions,
  type RecipientSpec,
  type ResolvedRecipient,
} from "./sealedTypes";

export interface ResolvedWrapTarget {
  kind: "user" | "device";
  /** Username for users, encryption-key fingerprint for devices. */
  id: string;
  /** Map key in `_encryptFor` (canonical username for users, fingerprint for devices). */
  stableId: string;
  keyFingerprint: string;
  publicKeyPem: string;
  label?: string;
}

export function newestRecipientBlock(
  entries: Array<{ recipients?: EntryRecipients; createdAt: number }>,
): EntryRecipients | undefined {
  let best: { recipients: EntryRecipients; createdAt: number } | undefined;
  for (const entry of entries) {
    if (!entry.recipients?.wraps?.length) continue;
    if (
      !best ||
      entry.recipients.epoch > best.recipients.epoch ||
      (entry.recipients.epoch === best.recipients.epoch && entry.createdAt > best.createdAt)
    ) {
      best = { recipients: entry.recipients, createdAt: entry.createdAt };
    }
  }
  return best?.recipients;
}

export function readEncryptFor(payload: MindooDocPayload | Record<string, unknown>): Record<string, EncryptForEntry> {
  const raw = (payload as Record<string, unknown>)[ENCRYPT_FOR_FIELD];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, EncryptForEntry>;
}

export function activeEncryptForEntries(
  map: Record<string, EncryptForEntry>,
): Array<[string, EncryptForEntry]> {
  return Object.entries(map).filter(([, entry]) => !entry.removedAt);
}

export function resolveRecipientsFromPayload(
  payload: MindooDocPayload | Record<string, unknown>,
  recipientsBlock?: EntryRecipients,
): ResolvedRecipient[] {
  const wraps = new Set((recipientsBlock?.wraps ?? []).map((wrap) => wrap.keyFingerprint));
  const epoch = recipientsBlock?.epoch ?? 1;
  return activeEncryptForEntries(readEncryptFor(payload)).map(([id, entry]) => ({
    kind: entry.kind === "device" ? "device" : "user",
    id: entry.kind === "device" ? (entry.keyFingerprint ?? id) : id,
    keyFingerprint: entry.keyFingerprint ?? "",
    label: entry.label,
    addedInEpoch: epoch,
    sealed: !!(entry.keyFingerprint && wraps.has(entry.keyFingerprint)),
  }));
}

function specKey(spec: RecipientSpec): string {
  if (typeof spec === "string") return `user:${spec}`;
  if ("user" in spec) return `user:${spec.user}`;
  if ("device" in spec) return `device:${spec.device}`;
  if ("devicePem" in spec) return `devicePem:${spec.devicePem}`;
  return JSON.stringify(spec);
}

function userNameFromSpec(spec: RecipientSpec): string | null {
  if (typeof spec === "string") return spec;
  if ("user" in spec) return spec.user;
  return null;
}

function assertCanonicalizableUsernames(specs: RecipientSpec[]): void {
  for (const spec of specs) {
    const name = userNameFromSpec(spec);
    if (name == null) continue;
    canonicalizeUsername(name);
  }
}

export async function resolveRecipientSpecs(input: {
  tenant: BaseMindooTenant;
  specs: RecipientSpec[];
  options?: RecipientOptions;
  addedBy: string;
  now: number;
}): Promise<{
  targets: ResolvedWrapTarget[];
  encryptFor: Record<string, EncryptForEntry>;
  skipped: Array<{ spec: RecipientSpec; reason: string }>;
}> {
  assertCanonicalizableUsernames(input.specs);
  const includeSelf = input.options?.includeSelf !== false;
  const strict = input.options?.strict === true;
  const specs = [...input.specs];
  if (includeSelf) {
    const me = (await input.tenant.getCurrentUserId()).username;
    const already = specs.some((spec) => {
      const name = typeof spec === "string" ? spec : "user" in spec ? spec.user : null;
      if (name == null) return false;
      try {
        return usernamesEqual(name, me);
      } catch {
        return false;
      }
    });
    if (!already) specs.push(me);
  }

  const targets: ResolvedWrapTarget[] = [];
  const skipped: Array<{ spec: RecipientSpec; reason: string }> = [];
  const seen = new Set<string>();

  const addTarget = (target: ResolvedWrapTarget) => {
    if (seen.has(target.stableId)) return;
    seen.add(target.stableId);
    targets.push(target);
  };

  for (const spec of specs) {
    try {
      const resolved = await resolveOneSpec(input.tenant, spec);
      if (resolved.skipped) {
        skipped.push({ spec, reason: resolved.skipped });
        if (strict) {
          throw new Error(`Recipient ${specKey(spec)} could not be resolved: ${resolved.skipped}`);
        }
        continue;
      }
      for (const target of resolved.targets) addTarget(target);
    } catch (error) {
      if (strict) throw error;
      skipped.push({
        spec,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (targets.length === 0) {
    throw new Error(
      includeSelf
        ? "No published User-Key is available to seal this document to"
        : "recipients: [] with includeSelf: false would produce a document nobody can read",
    );
  }

  const encryptFor: Record<string, EncryptForEntry> = {};
  for (const target of targets) {
    encryptFor[target.stableId] = {
      kind: target.kind,
      addedAt: input.now,
      addedBy: input.addedBy,
      keyFingerprint: target.keyFingerprint,
      ...(target.label ? { label: target.label } : {}),
    };
  }
  return { targets, encryptFor, skipped };
}

async function resolveOneSpec(
  tenant: BaseMindooTenant,
  spec: RecipientSpec,
): Promise<{ targets: ResolvedWrapTarget[]; skipped?: string }> {
  if (typeof spec === "string" || "user" in spec) {
    const username = typeof spec === "string" ? spec : spec.user;
    const target = await resolveUserTarget(tenant, username);
    if (!target) return { targets: [], skipped: "no published user key" };
    return { targets: [target] };
  }
  if ("devicePem" in spec) {
    const subtle = tenant.getCryptoAdapter().getSubtle();
    const fingerprint = await fingerprintEncryptionPublicKey(spec.devicePem, subtle);
    return {
      targets: [
        {
          kind: "device",
          id: fingerprint,
          stableId: fingerprint,
          keyFingerprint: fingerprint,
          publicKeyPem: spec.devicePem,
          label: spec.label,
        },
      ],
    };
  }
  const device = await resolveDeviceTarget(tenant, spec.device, spec.label);
  if (!device) return { targets: [], skipped: "device not found" };
  return { targets: [device] };
}

async function resolveUserTarget(
  tenant: BaseMindooTenant,
  username: string,
): Promise<ResolvedWrapTarget | null> {
  const canonical = canonicalizeUsername(username);
  const published = await tenant.getUserKeyManager().publishedUserKeyFor(canonical);
  if (!published || published.pending) return null;
  return {
    kind: "user",
    id: canonical,
    stableId: canonical,
    keyFingerprint: published.fingerprint,
    publicKeyPem: published.publicKey,
    label: formatCanonicalUsernameLabel(username),
  };
}

async function resolveDeviceTarget(
  tenant: BaseMindooTenant,
  fingerprint: string,
  label?: string,
): Promise<ResolvedWrapTarget | null> {
  const directoryDb = await tenant.openDB(DIRECTORY_DB_ID, { adminOnlyDb: true });
  const subtle = tenant.getCryptoAdapter().getSubtle();
  for await (const { doc } of directoryDb.iterateChangesSince(null)) {
    const data = doc.getData() as Record<string, unknown>;
    if (data.form !== "useroperation" || data.type !== "grantaccess") continue;
    for (const pair of extractActiveKeyPairs(data)) {
      const fp = await fingerprintEncryptionPublicKey(pair.encryptionPublicKey, subtle);
      if (fp === fingerprint) {
        return {
          kind: "device",
          id: fingerprint,
          stableId: fingerprint,
          keyFingerprint: fingerprint,
          publicKeyPem: pair.encryptionPublicKey,
          label: label ?? pair.label,
        };
      }
    }
  }
  return null;
}

export async function sealToTargets(input: {
  tenant: BaseMindooTenant;
  generations: Uint8Array[];
  targets: ResolvedWrapTarget[];
  epoch: number;
}): Promise<EntryRecipients> {
  const sealed = await sealBundle({
    crypto: input.tenant.getCryptoAdapter(),
    generations: input.generations,
    wrapsTo: input.targets.map((target) => ({
      kind: target.kind,
      fingerprint: target.keyFingerprint,
      publicKeyPem: target.publicKeyPem,
    })),
  });
  sealed.epoch = input.epoch;
  return sealed;
}

function automergeSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function applyEncryptForCreate(
  doc: MindooDocPayload,
  encryptFor: Record<string, EncryptForEntry>,
): void {
  (doc as Record<string, unknown>)[ENCRYPT_FOR_FIELD] = automergeSafe(encryptFor);
}

export function applyEncryptForAdds(
  doc: MindooDocPayload,
  encryptFor: Record<string, EncryptForEntry>,
  epoch: number,
): void {
  const current = readEncryptFor(doc) as Record<string, EncryptForEntry>;
  if (!(ENCRYPT_FOR_FIELD in doc) || !doc[ENCRYPT_FOR_FIELD]) {
    (doc as Record<string, unknown>)[ENCRYPT_FOR_FIELD] = {};
  }
  const map = doc[ENCRYPT_FOR_FIELD] as Record<string, EncryptForEntry>;
  for (const [id, entry] of Object.entries(encryptFor)) {
    const existing = current[id];
    if (existing && !existing.removedAt) continue;
    const key = existing?.removedAt ? `${id}#${epoch}` : id;
    map[key] = automergeSafe(entry);
  }
}

export function applyEncryptForRemoves(
  doc: MindooDocPayload,
  stableIds: string[],
  now: number,
  removedBy: string,
): string[] {
  const map = doc[ENCRYPT_FOR_FIELD] as Record<string, EncryptForEntry> | undefined;
  if (!map) return [];
  const removed: string[] = [];
  for (const id of Object.keys(map)) {
    const base = id.split("#")[0];
    if (!stableIds.includes(base) && !stableIds.includes(id)) continue;
    if (map[id].removedAt) continue;
    map[id].removedAt = now;
    map[id].removedBy = removedBy;
    removed.push(id);
  }
  return removed;
}

export function wrapTargetsFromEncryptFor(
  map: Record<string, EncryptForEntry>,
  resolved: ResolvedWrapTarget[],
): ResolvedWrapTarget[] {
  const byStable = new Map(resolved.map((t) => [t.stableId, t]));
  const byFp = new Map(resolved.map((t) => [t.keyFingerprint, t]));
  const out: ResolvedWrapTarget[] = [];
  for (const [id, entry] of activeEncryptForEntries(map)) {
    const target = byStable.get(id.split("#")[0]) ?? (entry.keyFingerprint ? byFp.get(entry.keyFingerprint) : undefined);
    if (target) out.push(target);
  }
  return out;
}

/**
 * True when the document is sealed (`$sealed:…`) and every listed user has an
 * active `_encryptFor` entry whose DEK wrap is present. Names are matched
 * case-insensitively after {@link canonicalizeUsername}.
 */
export function isPayloadEncryptedFor(
  payload: MindooDocPayload | Record<string, unknown>,
  recipientsBlock: EntryRecipients | undefined,
  users: string[],
): boolean {
  if (users.length === 0) return false;
  const recipients = resolveRecipientsFromPayload(payload, recipientsBlock);
  return users.every((user) => {
    const key = canonicalizeUsername(user);
    return recipients.some(
      (recipient) =>
        recipient.kind === "user"
        && recipient.sealed
        && canonicalizeUsername(recipient.id) === key,
    );
  });
}
