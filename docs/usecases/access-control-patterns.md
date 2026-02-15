# Access Control Patterns

## Overview

MindooDB provides fine-grained access control through **named encryption keys**. Unlike traditional role-based access control (RBAC), MindooDB uses document-level encryption where only users with the appropriate encryption key can decrypt specific documents. This document explores patterns for implementing access control, distributing keys securely, and managing key rotation.

## Key Concepts

### Default vs. Named Keys

MindooDB uses two types of encryption keys to control who can access document content.

**Default Encryption** uses the tenant's encryption key, which is a fresh AES-256 symmetric key generated when the tenant is created. This key is separate from the admin keys—the admin signing key (Ed25519) is used for signing operations, and the admin encryption key (RSA-OAEP) is used only for encrypting sensitive directory data like usernames. All members of a tenant who have the default key in their KeyBag can decrypt documents encrypted with it. This is suitable for general tenant-wide documents where all team members should have access.

**Named Key Encryption** uses separate symmetric keys that are identified by a key ID and stored in the user's KeyBag. Only users who possess a specific named key can decrypt documents encrypted with that key. This enables fine-grained, document-level access control. For example, a document encrypted with the key ID `"hr-confidential"` can only be read by users who have that specific key in their KeyBag.

The key difference is distribution scope: default keys are available to all tenant members automatically, while named keys must be explicitly distributed to specific users through secure offline channels.

### Key Distribution Model

Named keys are distributed **offline** to maintain end-to-end encryption guarantees. The distribution process works as follows:

First, an administrator creates a symmetric key and encrypts it with a strong password. The encrypted key data can then be transmitted through any channel—email, file sharing, or direct transfer—since it cannot be decrypted without the password.

Second, the password is shared through a **separate, secure channel**—typically a phone call, in-person meeting, or secure messaging. This separation ensures that even if the encrypted key is intercepted, an attacker cannot decrypt it without the password from the other channel.

Third, the user imports the key into their KeyBag by providing the encrypted key data and the password. The KeyBag itself is encrypted with the user's encryption key password, providing an additional layer of protection at rest.

This offline distribution model is essential to MindooDB's security: named keys never pass through any server in decrypted form, and the distribution process cannot be compromised by a malicious or compromised server.

## Document-Level Access Control

### Basic Pattern

Document-level access control in MindooDB works through named encryption keys. When you want to restrict access to a specific document, you ensure that only the intended recipients have the named key required to decrypt it.

**Pattern**: Use named keys to control access to specific documents

```typescript
// Administrator: Create and distribute a named key for sensitive documents
const tenantFactory = tenant.getFactory();
const keyPassword = generateSecurePassword();
const encryptedKey = await tenantFactory.createDocEncryptionKey(keyPassword);

// Import the key into the KeyBag with a meaningful ID
const keyBag = tenant.getKeyBag();
const keyId = "sensitive-data-key";
const decryptedKeyBytes = await tenantFactory.decryptSymmetricKey(encryptedKey, keyPassword);
keyBag.setKey(keyId, decryptedKeyBytes);

// Now documents can be encrypted with this key
// When the tenant encrypts/decrypts, it uses the specified key from the KeyBag
const db = await tenant.openDB("documents");
const sensitiveDoc = await db.createDocument();
await db.changeDoc(sensitiveDoc, (d) => {
  d.getData().content = "Top secret information";
  d.getData().encryptionKeyId = keyId; // Store which key was used for reference
});

// The document changes are encrypted using the tenant's encryptPayload method
// which uses the named key from the KeyBag
```

**Benefits:**
- Only users with the named key can decrypt the document
- The server cannot read the data—it only sees encrypted bytes
- Fine-grained per-document or per-document-type control
- Works completely offline once keys are distributed

### Tiered Access Patterns

Many organizations have data classification systems with multiple sensitivity levels. MindooDB supports this through a hierarchy of named keys, where users are granted keys based on their clearance level.

**Pattern**: Different keys for different sensitivity levels

```typescript
// Set up keys for different security levels
// Public data uses the default tenant key - all members can access
const publicKeyId = "default";

// Higher classification levels use named keys with controlled distribution
const internalKeyId = "internal-key";
const confidentialKeyId = "confidential-key";
const secretKeyId = "secret-key";

// Administrator creates and imports keys (in practice, these are distributed separately)
async function setupSecurityKeys(adminTenant: MindooTenant) {
  const factory = adminTenant.getFactory();
  const keyBag = adminTenant.getKeyBag();
  
  // Create keys for each level (store passwords securely for distribution)
  for (const keyId of [internalKeyId, confidentialKeyId, secretKeyId]) {
    const password = generateSecurePassword();
    const encryptedKey = await factory.createDocEncryptionKey(keyId, password);
    const keyBytes = await factory.decryptSymmetricKey(encryptedKey, password);
    keyBag.setKey(keyId, keyBytes);
    
    // Store encrypted key and password securely for distribution to authorized users
    await storeForDistribution(keyId, encryptedKey, password);
  }
}

// When creating documents, use the appropriate key based on classification
async function createClassifiedDocument(
  db: MindooDB,
  classification: 'public' | 'internal' | 'confidential' | 'secret',
  content: any
): Promise<MindooDoc> {
  const keyId = {
    public: "default",
    internal: internalKeyId,
    confidential: confidentialKeyId,
    secret: secretKeyId
  }[classification];
  
  const doc = await db.createEncryptedDocument(keyId);
  await db.changeDoc(doc, (d) => {
    Object.assign(d.getData(), content);
    d.getData().classification = classification;
    d.getData().encryptionKeyId = keyId;
  });
  
  return doc;
}
```

**Use Cases:**
- Government classification levels (Unclassified, Confidential, Secret, Top Secret)
- Corporate data classification (Public, Internal, Confidential, Restricted)
- Healthcare data sensitivity levels (General, PHI, Sensitive PHI)
- Financial data tiers (Public, Customer, Proprietary)

### Project-Based Access

In project-based organizations, different teams work on isolated projects and should only access their own project data. Named keys provide natural boundaries between projects.

**Pattern**: Separate keys for different projects

```typescript
class ProjectKeyManager {
  constructor(private tenant: MindooTenant) {}
  
  /**
   * Creates a new project with its own encryption key.
   * Returns the key ID and encrypted key for distribution.
   */
  async createProject(projectName: string): Promise<{
    keyId: string;
    encryptedKey: Uint8Array;
    password: string;
  }> {
    const keyId = `project-${projectName}-key`;
    const password = generateSecurePassword();
    const factory = this.tenant.getFactory();
    
    // Create encrypted key for distribution
    const encryptedKey = await factory.createDocEncryptionKey(keyId, password);
    
    // Import into creator's KeyBag
    const keyBytes = await factory.decryptSymmetricKey(encryptedKey, password);
    this.tenant.getKeyBag().setKey(keyId, keyBytes);
    
    return { keyId, encryptedKey, password };
  }
  
  /**
   * Grants a user access to a project by distributing the project key.
   */
  async grantProjectAccess(
    userTenant: MindooTenant,
    keyId: string,
    encryptedKey: Uint8Array,
    password: string
  ): Promise<void> {
    const factory = userTenant.getFactory();
    const keyBytes = await factory.decryptSymmetricKey(encryptedKey, password);
    userTenant.getKeyBag().setKey(keyId, keyBytes);
  }
  
  /**
   * Creates a document for a specific project.
   */
  async createProjectDocument(
    projectKeyId: string,
    data: any
  ): Promise<MindooDoc> {
    const db = await this.tenant.openDB("projects");
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), data);
      d.getData().projectKeyId = projectKeyId;
    });
    return doc;
  }
}
```

**Benefits:**
- Project data is cryptographically isolated
- Users only get keys for projects they're assigned to
- Revoking access is simple: stop distributing new key versions
- Clear access boundaries that are enforced by encryption, not just access control lists

### Role-Based Key Distribution

**Pattern**: Distribute keys based on user roles

```typescript
// Key distribution based on roles
async function distributeKeysForRole(user: User, role: string) {
  const keysToDistribute: string[] = [];
  
  switch (role) {
    case "admin":
      keysToDistribute.push("admin-key", "manager-key", "employee-key");
      break;
    case "manager":
      keysToDistribute.push("manager-key", "employee-key");
      break;
    case "employee":
      keysToDistribute.push("employee-key");
      break;
  }
  
  // Distribute keys to user
  for (const keyId of keysToDistribute) {
    await distributeKeyToUser(user, keyId);
  }
}
```

**Benefits:**
- Familiar role-based model
- Hierarchical access (roles inherit lower-level access)
- Easy to understand and manage
- Can combine with other patterns

## Secure Key Distribution

### Offline Distribution Pattern

**Pattern**: Share keys via secure offline channels

```typescript
// Administrator creates and exports key
const encryptedKey = await tenantFactory.createDocEncryptionKey(
  "secure-password-xyz"
);

// Export key for distribution (e.g., via email, secure file share)
const keyExport = {
  keyId: "sensitive-data-key",
  encryptedKey: encryptedKey, // Base64 encoded
  instructions: "Password shared via phone: 555-1234"
};

// User receives and imports key
await userKeyBag.decryptAndImportKey(
  "sensitive-data-key",
  encryptedKey,
  "secure-password-xyz" // Received via phone
);
```

**Security Best Practices:**
- Use strong, unique passwords per key
- Share passwords via different channel than key
- Use secure file transfer for key data
- Verify key import with test document
- Rotate keys periodically

### In-Person Distribution

**Pattern**: Distribute keys during physical meetings

```typescript
// Generate QR code with key data
const keyData = {
  keyId: "meeting-key-2025-01-15",
  encryptedKey: encryptedKey,
  password: generateTemporaryPassword()
};

const qrCode = generateQRCode(JSON.stringify(keyData));

// User scans QR code during meeting
// Imports key immediately
await userKeyBag.decryptAndImportKey(
  keyData.keyId,
  keyData.encryptedKey,
  keyData.password
);
```

**Benefits:**
- Highest security (no network transmission)
- Immediate verification
- Can verify user identity
- Good for high-security scenarios

### Secure Email Distribution

**Pattern**: Send key via email, password via phone

```typescript
// Administrator
const encryptedKey = await tenantFactory.createDocEncryptionKey(
  generateStrongPassword()
);

// Email 1: Send encrypted key
await sendEmail(user.email, {
  subject: "Encryption Key for Project Alpha",
  body: `Please find your encryption key attached.
  
  You will receive the password via phone call.`,
  attachment: encryptedKey
});

// Phone call: Share password
await makePhoneCall(user.phone, `Your password is: ${password}`);

// User imports key
await userKeyBag.decryptAndImportKey(
  "project-alpha-key",
  encryptedKey,
  password // From phone call
);
```

**Security Considerations:**
- Use encrypted email if possible
- Verify phone number before calling
- Use temporary passwords when possible
- Log key distribution for audit

## Key Rotation Strategies

### Why Rotate Keys

Key rotation is important for:
- Security: Limit exposure if key is compromised
- Access control: Revoke access by not sharing new key
- Compliance: Meet regulatory requirements
- Best practices: Regular key rotation

### Rotation Pattern with Versioning

**Pattern**: Support multiple key versions during rotation

MindooDB's KeyBag supports multiple versions per key ID:

```typescript
// Old key version
await userKeyBag.set("project-key", oldKeyBytes, oldCreatedAt);

// Add new key version (newest tried first)
await userKeyBag.set("project-key", newKeyBytes, newCreatedAt);

// KeyBag tries newest version first when decrypting
const decrypted = await tenant.decryptPayload(
  encryptedData,
  "project-key" // Tries newKeyBytes first, falls back to oldKeyBytes
);
```

**Rotation Process:**

```typescript
async function rotateKey(keyId: string, tenant: MindooTenant) {
  // 1. Create new key version
  const newEncryptedKey = await tenantFactory.createDocEncryptionKey(
    generateNewPassword()
  );
  
  // 2. Distribute new key to authorized users
  const authorizedUsers = await getUsersWithKey(keyId);
  for (const user of authorizedUsers) {
    await distributeKeyToUser(user, keyId, newEncryptedKey, newPassword);
  }
  
  // 3. Start encrypting new documents with new key
  // Old documents remain encrypted with old key (still decryptable)
  
  // 4. After transition period, optionally re-encrypt old documents
  // (This requires decrypting and re-encrypting, which is a separate process)
}
```

### Gradual Rotation

**Pattern**: Rotate keys gradually over time

```typescript
async function gradualKeyRotation(keyId: string) {
  // Phase 1: Create and distribute new key
  const newKey = await createAndDistributeNewKey(keyId);
  
  // Phase 2: New documents use new key, old documents use old key
  // Both keys work during transition
  
  // Phase 3: After all users have new key, stop using old key
  // Old documents still decryptable with old key in KeyBag
  
  // Phase 4: Optional - re-encrypt old documents with new key
  // (Requires access to all documents and re-encryption)
}
```

**Benefits:**
- No service interruption
- Users can update at their own pace
- Old documents remain accessible
- Smooth transition

## Graduated Disclosure

### Progressive Access Pattern

**Pattern**: Grant increasing access based on trust or time

```typescript
// Level 1: Public information (default key)
const publicDoc = await db.createDocument();

// Level 2: After initial trust, grant internal key
const internalKey = await distributeKey(user, "internal-key");
const internalDoc = await db.createEncryptedDocument("internal-key");

// Level 3: After more trust, grant confidential key
const confidentialKey = await distributeKey(user, "confidential-key");
const confidentialDoc = await db.createEncryptedDocument("confidential-key");
```

**Use Cases:**
- Onboarding new employees
- Building trust with partners
- Time-based access (e.g., after N days)
- Achievement-based access

### Time-Based Access

**Pattern**: Grant access for limited time periods

```typescript
// Create temporary key with expiration
const tempKey = await tenantFactory.createDocEncryptionKey(
  generateTemporaryPassword()
);

// Distribute with expiration notice
await distributeKeyWithExpiration(user, "temp-project-key", {
  key: tempKey,
  expiresAt: Date.now() + (30 * 24 * 60 * 60 * 1000) // 30 days
});

// User can access documents until expiration
// After expiration, stop sharing new key versions
```

## Access Audit Trails

### Tracking Key Distribution

**Pattern**: Maintain audit log of key distribution

```typescript
interface KeyDistributionLog {
  keyId: string;
  userId: string;
  distributedAt: number;
  distributedBy: string;
  method: "email" | "in-person" | "secure-channel";
}

async function logKeyDistribution(
  keyId: string,
  userId: string,
  method: string
) {
  const logEntry: KeyDistributionLog = {
    keyId,
    userId,
    distributedAt: Date.now(),
    distributedBy: currentUserId,
    method
  };
  
  // Store in audit log database
  await auditLogDB.createDocument();
  await auditLogDB.changeDoc(doc, (d) => {
    d.getData().type = "key-distribution";
    Object.assign(d.getData(), logEntry);
  });
}
```

### Document Access Tracking

**Pattern**: Track which users have access to which documents

```typescript
// When distributing key, track document access
async function grantDocumentAccess(userId: string, keyId: string, docIds: string[]) {
  // Distribute key
  await distributeKeyToUser(userId, keyId);
  
  // Log access grant
  await accessLogDB.createDocument();
  await accessLogDB.changeDoc(doc, (d) => {
    d.getData().type = "access-grant";
    d.getData().userId = userId;
    d.getData().keyId = keyId;
    d.getData().docIds = docIds;
    d.getData().grantedAt = Date.now();
  });
}
```

**Benefits:**
- Compliance with audit requirements
- Track who has access to what
- Investigate security incidents
- Demonstrate due diligence

## Implementation Examples

### Example 1: Project-Based Access Control

```typescript
class ProjectAccessManager {
  private tenant: MindooTenant;
  private keyBag: KeyBag;
  
  async createProject(projectName: string, adminPassword: string): Promise<string> {
    // Create project-specific key
    const projectKeyId = `project-${projectName}-key`;
    const encryptedKey = await this.tenant.getFactory().createDocEncryptionKey(
      adminPassword
    );
    
    // Store key metadata
    const keyDoc = await this.tenant.openDB("keys").createDocument();
    await this.tenant.openDB("keys").changeDoc(keyDoc, (d) => {
      d.getData().keyId = projectKeyId;
      d.getData().projectName = projectName;
      d.getData().createdAt = Date.now();
    });
    
    return projectKeyId;
  }
  
  async grantProjectAccess(userId: string, projectKeyId: string, password: string) {
    // Get encrypted key
    const keyDoc = await this.findKeyDocument(projectKeyId);
    const encryptedKey = keyDoc.getData().encryptedKey;
    
    // Distribute to user (implementation depends on distribution method)
    await this.distributeKeyToUser(userId, projectKeyId, encryptedKey, password);
    
    // Log access grant
    await this.logAccessGrant(userId, projectKeyId);
  }
  
  async createProjectDocument(projectKeyId: string, data: any): Promise<MindooDoc> {
    const db = await this.tenant.openDB("projects");
    const doc = await db.createEncryptedDocument(projectKeyId);
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), data);
      d.getData().projectKeyId = projectKeyId;
    });
    return doc;
  }
}
```

### Example 2: Role-Based Key Management

```typescript
class RoleBasedAccessControl {
  private roleToKeys: Map<string, string[]> = new Map([
    ["admin", ["admin-key", "manager-key", "employee-key", "public-key"]],
    ["manager", ["manager-key", "employee-key", "public-key"]],
    ["employee", ["employee-key", "public-key"]],
    ["guest", ["public-key"]]
  ]);
  
  async assignRole(userId: string, role: string) {
    const keysForRole = this.roleToKeys.get(role) || [];
    
    // Distribute all keys for this role
    for (const keyId of keysForRole) {
      await this.distributeKeyToUser(userId, keyId);
    }
    
    // Log role assignment
    await this.logRoleAssignment(userId, role);
  }
  
  async createDocumentWithRole(role: string, data: any): Promise<MindooDoc> {
    // Determine key based on role hierarchy
    const keyId = this.getKeyForRole(role);
    const db = await this.tenant.openDB("documents");
    const doc = await db.createEncryptedDocument(keyId);
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), data);
      d.getData().accessLevel = role;
    });
    return doc;
  }
  
  private getKeyForRole(role: string): string {
    // Use most restrictive key for the role
    const roleHierarchy = ["admin", "manager", "employee", "guest"];
    const roleIndex = roleHierarchy.indexOf(role);
    
    if (roleIndex === 0) return "admin-key";
    if (roleIndex === 1) return "manager-key";
    if (roleIndex === 2) return "employee-key";
    return "public-key";
  }
}
```

## Best Practices

### 1. Use Strong Passwords

- Generate cryptographically strong passwords
- Use unique passwords per key
- Consider password managers for administrators
- Never reuse passwords

### 2. Secure Key Distribution

- Use separate channels for key and password
- Verify user identity before distribution
- Log all key distributions
- Use encrypted channels when possible

### 3. Regular Key Rotation

- Rotate keys periodically (e.g., annually)
- Rotate immediately if compromise suspected
- Support multiple key versions during rotation
- Document rotation procedures

### 4. Audit and Monitoring

- Log all key distributions
- Track document access patterns
- Monitor for unusual access
- Regular access reviews

### 5. Key Recovery Procedures

- Document key recovery process
- Store key backups securely (encrypted, offline)
- Limit who can recover keys
- Test recovery procedures regularly

## Security Considerations

### Key Compromise

If a key is compromised:
1. Create new key version immediately
2. Distribute to authorized users only
3. Stop using old key for new documents
4. Consider re-encrypting sensitive documents
5. Investigate how compromise occurred

### Key Loss

If a user loses a key:
1. Verify user identity
2. Re-distribute key if authorized
3. Log key recovery
4. Consider if key should be rotated

### Access Revocation

To revoke access:
1. Stop sharing new key versions with user
2. User cannot decrypt new documents
3. Previously decrypted documents remain accessible (append-only limitation)
4. Log revocation for audit

## Related Patterns

- **[Data Modeling Patterns](data-modeling-patterns.md)** - Organizing data with access control in mind
- **[Cross-Tenant Collaboration](cross-tenant-collaboration.md)** - Sharing keys across organizations
- **[Compliance Patterns](compliance-patterns.md)** - Meeting regulatory requirements
- **[Backups and Recovery](backups-and-recovery.md)** - Key backup strategies

## Conclusion

Effective access control in MindooDB requires:

1. **Understanding named keys** and their distribution model
2. **Planning key structure** based on access requirements
3. **Implementing secure distribution** via offline channels
4. **Managing key rotation** to maintain security
5. **Auditing access** for compliance and security

By following these patterns, you can implement fine-grained, secure access control that leverages MindooDB's end-to-end encryption architecture.
