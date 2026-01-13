# Migration Patterns

## Overview

Migrating to MindooDB from traditional databases or cloud services requires careful planning and execution. This document explores migration strategies, data import patterns, and validation approaches.

## Migration Strategies

### From Traditional Databases

#### SQL Databases

**Pattern**: Convert relational data to documents

```typescript
class SQLToMindooDBMigration {
  async migrateTable(tableName: string, sqlDB: SQLDatabase, tenant: MindooTenant) {
    const db = await tenant.openDB(tableName);
    const rows = await sqlDB.query(`SELECT * FROM ${tableName}`);
    
    for (const row of rows) {
      const doc = await db.createDocument();
      await db.changeDoc(doc, (d) => {
        // Convert row to document
        Object.assign(d.getData(), row);
        d.getData().type = tableName;
        d.getData().migratedAt = Date.now();
      });
    }
  }
  
  async migrateRelationships(
    tableName: string,
    foreignKey: string,
    sqlDB: SQLDatabase,
    tenant: MindooTenant
  ) {
    const db = await tenant.openDB(tableName);
    const rows = await sqlDB.query(`SELECT * FROM ${tableName}`);
    
    for (const row of rows) {
      const doc = await db.createDocument();
      await db.changeDoc(doc, (d) => {
        Object.assign(d.getData(), row);
        // Store foreign key as document reference
        d.getData()[foreignKey] = row[foreignKey];
        d.getData().type = tableName;
      });
    }
  }
}
```

#### NoSQL Databases

**Pattern**: Direct document mapping

```typescript
class NoSQLToMindooDBMigration {
  async migrateCollection(
    collectionName: string,
    sourceDB: NoSQLDatabase,
    tenant: MindooTenant
  ) {
    const db = await tenant.openDB(collectionName);
    const documents = await sourceDB.getCollection(collectionName).find({});
    
    for (const sourceDoc of documents) {
      const doc = await db.createDocument();
      await db.changeDoc(doc, (d) => {
        Object.assign(d.getData(), sourceDoc);
        d.getData().migratedAt = Date.now();
      });
    }
  }
}
```

### From Cloud Services

#### SaaS Platform Migration

**Pattern**: Export and import data

```typescript
class SaaSPlatformMigration {
  async exportFromSaaS(apiClient: any): Promise<any[]> {
    // Export data from SaaS platform
    const data = await apiClient.exportAll();
    return data;
  }
  
  async importToMindooDB(
    exportedData: any[],
    tenant: MindooTenant,
    dbId: string
  ) {
    const db = await tenant.openDB(dbId);
    
    for (const item of exportedData) {
      const doc = await db.createDocument();
      await db.changeDoc(doc, (d) => {
        Object.assign(d.getData(), item);
        d.getData().migratedAt = Date.now();
        d.getData().sourceId = item.id; // Preserve original ID
      });
    }
  }
}
```

## Data Import Patterns

### Bulk Import

**Pattern**: Import large datasets efficiently

```typescript
class BulkImport {
  async importBatch(
    items: any[],
    db: MindooDB,
    batchSize: number = 100
  ) {
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      
      // Create documents in batch
      const promises = batch.map(item => 
        this.createDocument(db, item)
      );
      
      await Promise.all(promises);
    }
  }
  
  private async createDocument(db: MindooDB, item: any): Promise<MindooDoc> {
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), item);
    });
    return doc;
  }
}
```

### Incremental Import

**Pattern**: Import data incrementally

```typescript
class IncrementalImport {
  private lastImportTimestamp: number = 0;
  
  async importIncremental(
    source: any,
    db: MindooDB
  ) {
    // Get new items since last import
    const newItems = await source.getItemsSince(this.lastImportTimestamp);
    
    for (const item of newItems) {
      const doc = await db.createDocument();
      await db.changeDoc(doc, (d) => {
        Object.assign(d.getData(), item);
      });
      
      this.lastImportTimestamp = Math.max(
        this.lastImportTimestamp,
        item.timestamp || Date.now()
      );
    }
  }
}
```

## Schema Mapping

### Relational to Document

**Pattern**: Convert relational schema to document model

```typescript
class SchemaMapping {
  async mapRelationalToDocument(
    tableName: string,
    relationships: Map<string, string[]>,
    sqlDB: SQLDatabase,
    tenant: MindooTenant
  ) {
    const db = await tenant.openDB(tableName);
    const rows = await sqlDB.query(`SELECT * FROM ${tableName}`);
    
    for (const row of rows) {
      const doc = await db.createDocument();
      await db.changeDoc(doc, (d) => {
        Object.assign(d.getData(), row);
        
        // Embed related data
        const relatedTables = relationships.get(tableName) || [];
        for (const relatedTable of relatedTables) {
          const relatedRows = await sqlDB.query(
            `SELECT * FROM ${relatedTable} WHERE ${tableName}_id = ?`,
            [row.id]
          );
          d.getData()[relatedTable] = relatedRows;
        }
      });
    }
  }
}
```

## Gradual Migration

### Phased Approach

**Pattern**: Migrate in phases

```typescript
class GradualMigration {
  async phase1_Setup() {
    // Phase 1: Set up MindooDB infrastructure
    const tenant = await this.createTenant();
    const dbs = await this.createDatabases();
    return { tenant, dbs };
  }
  
  async phase2_ImportReadOnly() {
    // Phase 2: Import data as read-only
    await this.importHistoricalData();
    // Verify data integrity
    await this.validateImport();
  }
  
  async phase3_DualWrite() {
    // Phase 3: Write to both systems
    await this.enableDualWrite();
    // Monitor both systems
    await this.monitorDualWrite();
  }
  
  async phase4_Cutover() {
    // Phase 4: Switch to MindooDB only
    await this.disableOldSystem();
    await this.enableMindooDBOnly();
  }
  
  async phase5_Cleanup() {
    // Phase 5: Clean up old system
    await this.archiveOldSystem();
  }
}
```

## Validation

### Data Integrity Checks

**Pattern**: Verify migration success

```typescript
class MigrationValidation {
  async validateMigration(
    sourceDB: any,
    targetDB: MindooDB,
    entityType: string
  ): Promise<boolean> {
    // Count comparison
    const sourceCount = await sourceDB.count(entityType);
    const targetDocs = await targetDB.getAllDocuments();
    const targetCount = targetDocs.filter(d => 
      d.getData().type === entityType
    ).length;
    
    if (sourceCount !== targetCount) {
      console.error(`Count mismatch: ${sourceCount} vs ${targetCount}`);
      return false;
    }
    
    // Sample validation
    const sourceSamples = await sourceDB.getSamples(entityType, 10);
    for (const sample of sourceSamples) {
      const targetDoc = targetDocs.find(d => 
        d.getData().sourceId === sample.id
      );
      
      if (!targetDoc) {
        console.error(`Missing document: ${sample.id}`);
        return false;
      }
      
      if (!this.compareData(sample, targetDoc.getData())) {
        console.error(`Data mismatch: ${sample.id}`);
        return false;
      }
    }
    
    return true;
  }
  
  private compareData(source: any, target: any): boolean {
    // Compare key fields
    for (const key in source) {
      if (source[key] !== target[key]) {
        return false;
      }
    }
    return true;
  }
}
```

## Best Practices

### 1. Plan Migration Carefully

- Understand source data structure
- Map to MindooDB document model
- Plan for data relationships
- Consider access patterns

### 2. Test Migration Process

- Test with sample data
- Validate data integrity
- Test performance
- Verify access controls

### 3. Gradual Migration

- Migrate in phases
- Use dual-write during transition
- Validate each phase
- Plan rollback procedures

### 4. Data Validation

- Compare record counts
- Validate sample data
- Check relationships
- Verify timestamps

### 5. Documentation

- Document migration process
- Record migration decisions
- Maintain migration logs
- Update documentation

## Related Patterns

- **[Data Modeling Patterns](data-modeling-patterns.md)** - Organizing migrated data
- **[Access Control Patterns](access-control-patterns.md)** - Migrating access controls
- **[Performance Optimization](performance-optimization.md)** - Optimizing migrated data

## Conclusion

Successful migration to MindooDB requires:

1. **Careful Planning** of data structure mapping
2. **Gradual Migration** in phases
3. **Data Validation** to ensure integrity
4. **Testing** at each phase
5. **Documentation** of the process

By following these patterns, you can successfully migrate from traditional databases or cloud services to MindooDB while maintaining data integrity and minimizing disruption.
