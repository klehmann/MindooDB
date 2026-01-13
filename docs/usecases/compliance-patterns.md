# Compliance Patterns

## Overview

Regulatory compliance requires complete audit trails, data protection, access controls, and retention policies. MindooDB's append-only architecture, end-to-end encryption, and cryptographic integrity make it ideal for meeting compliance requirements.

## Key Regulations

### GDPR (General Data Protection Regulation)

**Requirements:**
- Right to be forgotten
- Data portability
- Access logging
- Data protection by design

### HIPAA (Health Insurance Portability and Accountability Act)

**Requirements:**
- Patient data protection
- Access controls
- Audit trails
- Data encryption

### SOX (Sarbanes-Oxley Act)

**Requirements:**
- Financial audit trails
- Immutable records
- Access controls
- Data retention

### PCI-DSS (Payment Card Industry Data Security Standard)

**Requirements:**
- Payment card data protection
- Access controls
- Audit trails
- Encryption

## GDPR Compliance

### Right to Be Forgotten

**Pattern**: Mark data as deleted while preserving audit trail

```typescript
class GDPRCompliance {
  async deleteUserData(userId: string) {
    // Mark documents as deleted (append-only limitation)
    const db = await this.tenant.openDB("user-data");
    const userDocs = await db.getAllDocuments().filter(doc => 
      doc.getData().userId === userId
    );
    
    for (const doc of userDocs) {
      await db.changeDoc(doc, (d) => {
        d.getData().deleted = true;
        d.getData().deletedAt = Date.now();
        d.getData().deletedForGDPR = true;
        // Anonymize sensitive data
        d.getData().email = null;
        d.getData().name = "Deleted User";
      });
    }
    
    // Log deletion
    await this.logGDPRDeletion(userId);
  }
  
  async logGDPRDeletion(userId: string) {
    const auditDB = await this.tenant.openDB("audit-logs");
    const logDoc = await auditDB.createDocument();
    await auditDB.changeDoc(logDoc, (d) => {
      d.getData().type = "gdpr-deletion";
      d.getData().userId = userId;
      d.getData().timestamp = Date.now();
      d.getData().reason = "Right to be forgotten";
    });
  }
}
```

**Note**: Append-only limitation means data cannot be truly deleted, but can be marked and anonymized.

### Data Portability

**Pattern**: Export user data in portable format

```typescript
async function exportUserData(userId: string): Promise<any> {
  const db = await this.tenant.openDB("user-data");
  const userDocs = await db.getAllDocuments().filter(doc => 
    doc.getData().userId === userId && !doc.getData().deleted
  );
  
  const exportData = {
    userId,
    exportedAt: Date.now(),
    documents: userDocs.map(doc => ({
      id: doc.getId(),
      data: doc.getData(),
      createdAt: doc.getData().createdAt,
      lastModified: doc.getLastModified()
    }))
  };
  
  return exportData;
}
```

## HIPAA Compliance

### Patient Data Protection

**Pattern**: End-to-end encryption with access controls

```typescript
class HIPAACompliance {
  async createPatientRecord(patientData: any): Promise<MindooDoc> {
    // Use patient-specific encryption key
    const patientKeyId = `patient-${patientData.patientId}-key`;
    const db = await this.tenant.openDB("patient-records");
    const doc = await db.createEncryptedDocument(patientKeyId);
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), patientData);
      d.getData().type = "patient-record";
      d.getData().createdAt = Date.now();
    });
    return doc;
  }
  
  async logAccess(userId: string, patientId: string, action: string) {
    const auditDB = await this.tenant.openDB("audit-logs");
    const logDoc = await auditDB.createDocument();
    await auditDB.changeDoc(logDoc, (d) => {
      d.getData().type = "hipaa-access-log";
      d.getData().userId = userId;
      d.getData().patientId = patientId;
      d.getData().action = action;
      d.getData().timestamp = Date.now();
      d.getData().ipAddress = this.getClientIP();
    });
  }
  
  async getAccessHistory(patientId: string): Promise<MindooDoc[]> {
    const auditDB = await this.tenant.openDB("audit-logs");
    const allLogs = await auditDB.getAllDocuments();
    return allLogs.filter(doc => 
      doc.getData().patientId === patientId &&
      doc.getData().type === "hipaa-access-log"
    );
  }
}
```

## SOX Compliance

### Financial Audit Trails

**Pattern**: Immutable transaction records

```typescript
class SOXCompliance {
  async createFinancialTransaction(transaction: any): Promise<MindooDoc> {
    // Time-sharded for efficient archival
    const year = new Date().getFullYear();
    const quarter = Math.floor(new Date().getMonth() / 3) + 1;
    const dbId = `transactions-${year}-Q${quarter}`;
    
    const db = await this.tenant.openDB(dbId);
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), transaction);
      d.getData().type = "financial-transaction";
      d.getData().timestamp = Date.now();
      // Immutable - never modify, only append corrections
    });
    
    // Log transaction creation
    await this.logTransaction(transaction.id, "create");
    
    return doc;
  }
  
  async createCorrection(originalTransactionId: string, correction: any): Promise<MindooDoc> {
    // Create new transaction for correction (never modify original)
    const db = await this.tenant.openDB("transactions-current");
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      d.getData().type = "correction";
      d.getData().originalTransactionId = originalTransactionId;
      Object.assign(d.getData(), correction);
      d.getData().timestamp = Date.now();
    });
    
    await this.logTransaction(correction.id, "correction");
    return doc;
  }
  
  async logTransaction(transactionId: string, action: string) {
    const auditDB = await this.tenant.openDB("audit-logs");
    const logDoc = await auditDB.createDocument();
    await auditDB.changeDoc(logDoc, (d) => {
      d.getData().type = "sox-audit-log";
      d.getData().transactionId = transactionId;
      d.getData().action = action;
      d.getData().timestamp = Date.now();
      d.getData().userId = this.getCurrentUserId();
    });
  }
}
```

## PCI-DSS Compliance

### Payment Card Data Protection

**Pattern**: Encrypt payment data with restricted access

```typescript
class PCIDSSCompliance {
  async storePaymentCard(cardData: any): Promise<MindooDoc> {
    // Use restricted encryption key
    const paymentKeyId = "payment-card-key";
    const db = await this.tenant.openDB("payment-cards");
    const doc = await db.createEncryptedDocument(paymentKeyId);
    await db.changeDoc(doc, (d) => {
      // Store only last 4 digits in metadata (for display)
      d.getData().last4 = cardData.number.slice(-4);
      d.getData().cardType = cardData.type;
      // Full card data encrypted in payload
      d.getData().encryptedCardData = this.encryptCardData(cardData);
      d.getData().type = "payment-card";
      d.getData().createdAt = Date.now();
    });
    
    // Log storage
    await this.logPaymentCardAccess(cardData.id, "store");
    
    return doc;
  }
  
  async logPaymentCardAccess(cardId: string, action: string) {
    const auditDB = await this.tenant.openDB("audit-logs");
    const logDoc = await auditDB.createDocument();
    await auditDB.changeDoc(logDoc, (d) => {
      d.getData().type = "pci-access-log";
      d.getData().cardId = cardId;
      d.getData().action = action;
      d.getData().timestamp = Date.now();
      d.getData().userId = this.getCurrentUserId();
    });
  }
}
```

## Audit Trails

### Complete Change History

**Pattern**: Log all changes for compliance

```typescript
class ComplianceAuditTrail {
  async logChange(
    entityType: string,
    entityId: string,
    action: string,
    details: any
  ) {
    const auditDB = await this.tenant.openDB("audit-logs");
    const logDoc = await auditDB.createDocument();
    await auditDB.changeDoc(logDoc, (d) => {
      d.getData().type = "audit-log";
      d.getData().entityType = entityType;
      d.getData().entityId = entityId;
      d.getData().action = action;
      d.getData().details = details;
      d.getData().userId = this.getCurrentUserId();
      d.getData().timestamp = Date.now();
      d.getData().ipAddress = this.getClientIP();
    });
  }
  
  async getAuditTrail(entityType: string, entityId: string): Promise<MindooDoc[]> {
    const auditDB = await this.tenant.openDB("audit-logs");
    const allLogs = await auditDB.getAllDocuments();
    return allLogs.filter(doc => {
      const data = doc.getData();
      return data.entityType === entityType && 
             data.entityId === entityId &&
             data.type === "audit-log";
    }).sort((a, b) => a.getData().timestamp - b.getData().timestamp);
  }
}
```

## Data Retention

### Retention Policies

**Pattern**: Archive data based on retention requirements

```typescript
class DataRetention {
  async archiveOldData(retentionPeriod: number) {
    const cutoffDate = Date.now() - retentionPeriod;
    const db = await this.tenant.openDB("main");
    const allDocs = await db.getAllDocuments();
    
    const oldDocs = allDocs.filter(doc => 
      doc.getData().createdAt < cutoffDate
    );
    
    // Move to archive database
    const archiveDB = await this.tenant.openDB("archive");
    for (const doc of oldDocs) {
      const changeHashes = await db.getStore()
        .getAllChangeHashesForDoc(doc.getId());
      const changes = await db.getStore()
        .getChanges(changeHashes);
      
      for (const change of changes) {
        await archiveDB.getStore().append(change);
      }
    }
  }
}
```

## Access Logging

### Who Accessed What and When

**Pattern**: Complete access logging

```typescript
class AccessLogging {
  async logAccess(
    resourceType: string,
    resourceId: string,
    action: string
  ) {
    const auditDB = await this.tenant.openDB("access-logs");
    const logDoc = await auditDB.createDocument();
    await auditDB.changeDoc(logDoc, (d) => {
      d.getData().type = "access-log";
      d.getData().resourceType = resourceType;
      d.getData().resourceId = resourceId;
      d.getData().action = action;
      d.getData().userId = this.getCurrentUserId();
      d.getData().timestamp = Date.now();
      d.getData().ipAddress = this.getClientIP();
      d.getData().userAgent = this.getUserAgent();
    });
  }
  
  async getAccessHistory(resourceId: string): Promise<MindooDoc[]> {
    const auditDB = await this.tenant.openDB("access-logs");
    const allLogs = await auditDB.getAllDocuments();
    return allLogs.filter(doc => 
      doc.getData().resourceId === resourceId
    ).sort((a, b) => a.getData().timestamp - b.getData().timestamp);
  }
}
```

## Best Practices

### 1. Complete Audit Trails

- Log all access and changes
- Include user, timestamp, IP address
- Store in append-only audit log
- Never modify audit logs

### 2. Data Protection

- Use end-to-end encryption
- Implement access controls
- Regular security reviews
- Key rotation

### 3. Retention Policies

- Implement retention schedules
- Archive old data
- Maintain compliance with regulations
- Document retention policies

### 4. Regular Compliance Reviews

- Review access logs regularly
- Audit key distribution
- Verify encryption
- Test compliance procedures

## Related Patterns

- **[Access Control Patterns](access-control-patterns.md)** - Fine-grained security
- **[Backups and Recovery](backups-and-recovery.md)** - Compliance backup requirements
- **[Data Modeling Patterns](data-modeling-patterns.md)** - Organizing compliant data

## Conclusion

MindooDB supports compliance through:

1. **Complete Audit Trails** via append-only architecture
2. **Data Protection** through end-to-end encryption
3. **Access Controls** with fine-grained permissions
4. **Immutable Records** for financial compliance
5. **Access Logging** for all compliance requirements

By following these patterns, organizations can meet regulatory requirements while maintaining data security and integrity.
