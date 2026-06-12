import {
  extractSigningPublicKeys,
  extractEncryptionPublicKeys,
  extractWipeRequestedSigningKeys,
} from "./grantKeys";
import {
  ACCESS_CONTROL_FORM,
  ACL_DEFAULT_POLICY_DOC_ID,
  AclRuleDoc,
  DefaultAccessPolicyDoc,
  RULE_TYPES,
  RuleType,
  TrustedWitnessDoc,
  WithFieldClause,
  decodeAclIdComponent,
} from "./types";
import {
  DirectoryStateChainBuilder,
  UserGrantSnapshot,
} from "./DirectoryStateNode";

const ACL_DB_POLICY_PREFIX = "acl_dbpolicy_";

/** Parse a policy document's fields into a {@link DefaultAccessPolicyDoc}. */
export function parsePolicyDoc(data: Record<string, unknown>): DefaultAccessPolicyDoc {
  const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
  // An array of strings, or undefined when absent/malformed (treated as
  // unconstrained). Non-string members are dropped defensively.
  const stringArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : undefined;
  return {
    form: ACCESS_CONTROL_FORM,
    type: "defaultpolicy",
    disableAllAccessChecksAndPolicies: bool(data.disableAllAccessChecksAndPolicies),
    denyDocCreate: bool(data.denyDocCreate),
    denyDocChange: bool(data.denyDocChange),
    denyDocDelete: bool(data.denyDocDelete),
    denyDocUndelete: bool(data.denyDocUndelete),
    denyDocSnapshot: bool(data.denyDocSnapshot),
    denyDocPurge: bool(data.denyDocPurge),
    denyDocRead: bool(data.denyDocRead),
    defaultCreateKeyId:
      typeof data.defaultCreateKeyId === "string" ? data.defaultCreateKeyId : undefined,
    databaseCreationPolicy:
      data.databaseCreationPolicy === "directory-restricted"
        ? "directory-restricted"
        : data.databaseCreationPolicy === "open"
          ? "open"
          : undefined,
    allowedDbIds: stringArray(data.allowedDbIds),
    requireMetadataSignatureSince:
      typeof data.requireMetadataSignatureSince === "number" &&
      Number.isFinite(data.requireMetadataSignatureSince)
        ? data.requireMetadataSignatureSince
        : undefined,
  };
}

/** Parse a rule document's fields into an {@link AclRuleDoc}. */
export function parseRuleDoc(data: Record<string, unknown>, ruleType: RuleType): AclRuleDoc {
  const usersHashes = Array.isArray(data.users_hashes)
    ? data.users_hashes.filter((h): h is string => typeof h === "string")
    : [];
  const withfields = Array.isArray(data.withfields)
    ? (data.withfields as unknown[]).filter((c): c is WithFieldClause =>
        !!c && typeof c === "object" && typeof (c as WithFieldClause).key === "string")
    : undefined;
  return {
    form: ACCESS_CONTROL_FORM,
    type: ruleType,
    ruleId: data.ruleId as string,
    description: typeof data.description === "string" ? data.description : undefined,
    dbid: typeof data.dbid === "string" ? data.dbid : "*",
    withfields,
    users_hashes: usersHashes,
    users_encrypted: typeof data.users_encrypted === "string" ? data.users_encrypted : "",
    action: data.action === "deny" ? "deny" : "allow",
  };
}

/** A single directory document revision to project onto the time-travel chain. */
export interface DirectoryRevisionInput {
  docId: string;
  data: Record<string, unknown>;
  deleted: boolean;
  trustedTime: number;
  /** Normalizes a raw group name (e.g. lowercase) for keying group snapshots. */
  normalizeGroupName: (name: string) => string;
}

/**
 * Classify a single directory document revision and feed it into the
 * time-travel {@link DirectoryStateChainBuilder} at the revision's trusted time
 * (docs/accesscontrol.md §6, §8).
 *
 * This is the revision-grain projection: it is called once per persisted change
 * (not once per merged document), so every intermediate policy/grant/group
 * state becomes its own chain node.
 */
export function projectDirectoryRevision(
  builder: DirectoryStateChainBuilder,
  input: DirectoryRevisionInput
): void {
  const { docId, data, deleted, trustedTime } = input;

  // Grant documents (`useroperation`/`grantaccess`). Revocation is expressed by
  // removing keys from the grant in place (§6.5), so applyGrant with an empty
  // key array deactivates the user.
  if (data.form === "useroperation" && data.type === "grantaccess") {
    if (typeof data.username_hash === "string") {
      const signingKeys = extractSigningPublicKeys(data);
      const grant: UserGrantSnapshot = {
        usernameHash: data.username_hash,
        signingKeys,
        encryptionKeys: extractEncryptionPublicKeys(data),
        wipeRequestedSigningKeys: extractWipeRequestedSigningKeys(data),
        active: signingKeys.length > 0,
      };
      builder.applyGrant(grant, trustedTime);
    }
    return;
  }

  // Access-control documents (policies, rules, trusted witnesses), §6.
  if (data.form === ACCESS_CONTROL_FORM) {
    projectAccessControlDoc(builder, docId, data, deleted, trustedTime);
    return;
  }

  // Group documents (§8.1): each document's members contribute to the
  // union-by-name group snapshot, keyed by the document id so revisions and
  // deletions are tracked per document.
  if (data.form === "group" && data.type === "group" && typeof data.groupName === "string") {
    const name = input.normalizeGroupName(data.groupName);
    if (deleted) {
      builder.removeGroupDoc(docId, trustedTime);
    } else {
      const memberHashes = Array.isArray(data.members_hashes)
        ? data.members_hashes.filter((h): h is string => typeof h === "string")
        : [];
      builder.applyGroupDoc(docId, name, memberHashes, trustedTime);
    }
  }
}

/** Project an `accesscontrol` document onto the chain. Deletions remove. */
function projectAccessControlDoc(
  builder: DirectoryStateChainBuilder,
  docId: string,
  data: Record<string, unknown>,
  deleted: boolean,
  trustedTime: number
): void {
  // Default tenant policy / per-database policy share the same shape and are
  // distinguished by their fixed document id (§6.1, §6.2).
  if (data.type === "defaultpolicy") {
    if (deleted) return;
    const policy = parsePolicyDoc(data);
    if (docId === ACL_DEFAULT_POLICY_DOC_ID) {
      builder.applyDefaultPolicy(policy, trustedTime);
    } else if (docId.startsWith(ACL_DB_POLICY_PREFIX)) {
      const dbid = decodeAclIdComponent(docId.slice(ACL_DB_POLICY_PREFIX.length));
      builder.applyDbPolicy(dbid, policy, trustedTime);
    }
    return;
  }

  // Key-distribution documents carry no directory-state projection (they are
  // read directly by recipient clients during reconcile); skip them here.
  if (data.type === "keydistribution") {
    return;
  }

  // Trusted witness (§6.4).
  if (data.type === "trustedwitness" && typeof data.witnessPublicKey === "string") {
    if (deleted) {
      builder.removeTrustedWitness(data.witnessPublicKey, trustedTime);
    } else {
      const witness: TrustedWitnessDoc = {
        form: ACCESS_CONTROL_FORM,
        type: "trustedwitness",
        witnessPublicKey: data.witnessPublicKey,
        serverUrl: typeof data.serverUrl === "string" ? data.serverUrl : undefined,
      };
      builder.applyTrustedWitness(witness, trustedTime);
    }
    return;
  }

  // Access-control rule (§6.3).
  if ((RULE_TYPES as readonly string[]).includes(data.type as string) && typeof data.ruleId === "string") {
    const ruleType = data.type as RuleType;
    if (deleted) {
      builder.removeRule(data.ruleId, ruleType, trustedTime);
    } else {
      builder.applyRule(parseRuleDoc(data, ruleType), trustedTime);
    }
  }
}
