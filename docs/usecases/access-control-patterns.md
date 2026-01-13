# Access Control Patterns

## Overview

MindooDB provides fine-grained access control through **named encryption keys**. Unlike traditional role-based access control (RBAC), MindooDB uses document-level encryption where only users with the appropriate encryption key can decrypt specific documents. This document explores patterns for implementing access control, distributing keys securely, and managing key rotation.

## Key Concepts

### Default vs. Named Keys

MindooDB supports two types of encryption:

1. **Default Encryption** (`decryptionKeyId: "default"`):
   - Uses tenant encryption key
   - All tenant members can decrypt
   - Suitable for general tenant-wide documents

2. **Named Key Encryption** (`decryptionKeyId: "<keyId>"`):
   - Uses a named symmetric key
   - Only users with that key can decrypt
   - Enables document-level access control

### Key Distribution Model

Named keys are distributed **offline** via secure channels:
- Keys are encrypted with a password
- Password shared via secure channel (phone, in-person, etc.)
- Users import keys into their KeyBag
- KeyBag is encrypted on disk with user's encryption key password

## Document-Level Access Control

### Basic Pattern

**Pattern**: Use named keys to control access to specific documents

```typescript
// Create a named key for sensitive documents
const sensitiveKey = await tenantFactory.createSymmetricEncryptedPrivateKey(
  "secure-password-123"
);

// Create document encrypted with named key
const sensitiveDoc = await db.createEncryptedDocument("sensitive-data-key");
await db.changeDoc(sensitiveDoc, (d) => {
  d.getData().content = "Top secret information";
});
```

**Benefits:**
- Only users with the key can decrypt
- Server cannot read the data
- Fine-grained per-document control
- Works offline

### Tiered Access Patterns

**Pattern**: Different keys for different sensitivity levels

```typescript
// Create keys for different security levels
const publicKey = "default"; // Tenant key
const internalKey = await tenantFactory.createSymmetricEncryptedPrivateKey("internal-pwd");
const confidentialKey = await tenantFactory.createSymmetricEncryptedPrivateKey("confidential-pwd");
const secretKey = await tenantFactory.createSymmetricEncryptedPrivateKey("secret-pwd");

// Create documents with appropriate keys
const publicDoc = await db.createDocument(); // Uses default key
const internalDoc = await db.createEncryptedDocument("internal-key");
const confidentialDoc = await db.createEncryptedDocument("confidential-key");
const secretDoc = await db.createEncryptedDocument("secret-key");
```

**Use Cases:**
- Government classification levels
- Corporate data classification
- Healthcare data sensitivity levels
- Financial data tiers

### Project-Based Access

**Pattern**: Separate keys for different projects

```typescript
// Create keys per project
const projectAlphaKey = await tenantFactory.createSymmetricEncryptedPrivateKey("alpha-pwd");
const projectBetaKey = await tenantFactory.createSymmetricEncryptedPrivateKey("beta-pwd");

// Documents encrypted with project-specific keys
const alphaDoc = await db.createEncryptedDocument("project-alpha-key");
const betaDoc = await db.createEncryptedDocument("project-beta-key");
```

**Benefits:**
- Project isolation
- Users only get keys for projects they're on
- Easy to revoke project access (stop sharing key)
- Clear access boundaries

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
const encryptedKey = await tenantFactory.createSymmetricEncryptedPrivateKey(
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
const encryptedKey = await tenantFactory.createSymmetricEncryptedPrivateKey(
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
  const newEncryptedKey = await tenantFactory.createSymmetricEncryptedPrivateKey(
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
const tempKey = await tenantFactory.createSymmetricEncryptedPrivateKey(
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
    const encryptedKey = await this.tenant.getFactory().createSymmetricEncryptedPrivateKey(
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
