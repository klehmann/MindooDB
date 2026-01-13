# Data Modeling Patterns

## Overview

MindooDB's append-only architecture and multi-database design enable powerful data organization strategies. This document explores patterns for splitting data across multiple MindooDB instances, sharding strategies, and managing the append-only growth characteristic.

## Key Concepts

### Append-Only Nature

MindooDB uses an **append-only store**, meaning:
- Changes are never modified or deleted
- Data grows over time
- Complete history is preserved
- This enables audit trails but requires growth management strategies

### Multiple Databases Per Tenant

A single `MindooTenant` can contain multiple `MindooDB` instances:
- Each database is independent
- Can have different access patterns
- Can be sharded by time, category, or access level
- Enables efficient data organization and management

## Document Splitting Strategies

### When to Split

Consider splitting into multiple databases when:

1. **Data Volume**: Single database becomes too large for efficient operations
2. **Access Patterns**: Different document types have different access frequencies
3. **Retention Policies**: Some data needs different retention or archival strategies
4. **Performance**: Splitting improves query and sync performance
5. **Security**: Different security levels require separate databases

### Splitting by Document Type

**Pattern**: Create separate databases for different document types

**Example**: CRM System
```typescript
// Separate databases for different entity types
const contactsDB = await tenant.openDB("contacts");
const dealsDB = await tenant.openDB("deals");
const tasksDB = await tenant.openDB("tasks");
const notesDB = await tenant.openDB("notes");
```

**Benefits:**
- Clear separation of concerns
- Different access patterns per type
- Easier to manage and query
- Can archive types independently

**Considerations:**
- Cross-database relationships require document IDs
- VirtualView can aggregate across databases
- More databases to manage

### Splitting by Project or Category

**Pattern**: Create databases per project, team, or category

**Example**: Project Management
```typescript
// Separate database per project
const projectAlphaDB = await tenant.openDB("project-alpha");
const projectBetaDB = await tenant.openDB("project-beta");
const projectGammaDB = await tenant.openDB("project-gamma");
```

**Benefits:**
- Isolated project data
- Easy to archive completed projects
- Team-specific access control
- Clear data boundaries

**Considerations:**
- Need to track which database contains which project
- Cross-project views require VirtualView
- More databases as projects grow

## Sharding Patterns

### Time-Based Sharding

**Pattern**: Create new databases periodically (yearly, monthly, quarterly)

**Example**: CRM with Yearly Sharding
```typescript
// Create databases by year
const crm2024 = await tenant.openDB("crm2024");
const crm2025 = await tenant.openDB("crm2025");
const crm2026 = await tenant.openDB("crm2026");

// Or monthly for high-volume systems
const crm202512 = await tenant.openDB("crm202512"); // December 2025
const crm202601 = await tenant.openDB("crm202601"); // January 2026
```

**Benefits:**
- Natural archival boundaries
- Older databases can be read-only
- Easier to manage and backup
- Clear time-based queries

**When to Use:**
- High-volume time-series data
- Clear temporal boundaries
- Need for historical data archival
- Regulatory retention requirements

**Implementation Strategy:**
```typescript
function getDatabaseForDate(tenant: MindooTenant, date: Date): Promise<MindooDB> {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const dbId = `crm${year}${month}`;
  return tenant.openDB(dbId);
}

// Create document in appropriate database
const db = await getDatabaseForDate(tenant, new Date());
const doc = await db.createDocument();
```

### Category-Based Sharding

**Pattern**: Split by document category or classification

**Example**: Support Ticket System
```typescript
// Separate databases by priority or category
const criticalTickets = await tenant.openDB("tickets-critical");
const highTickets = await tenant.openDB("tickets-high");
const normalTickets = await tenant.openDB("tickets-normal");
const lowTickets = await tenant.openDB("tickets-low");
```

**Benefits:**
- Different access patterns per category
- Can optimize for category-specific queries
- Easier to manage high-priority data
- Clear category boundaries

**Considerations:**
- Need routing logic to determine database
- Categories may change over time
- Cross-category views require aggregation

### Access-Based Sharding

**Pattern**: Separate databases by security level or access requirements

**Example**: Multi-Level Security
```typescript
// Separate databases by classification
const publicDB = await tenant.openDB("public");
const internalDB = await tenant.openDB("internal");
const confidentialDB = await tenant.openDB("confidential");
const secretDB = await tenant.openDB("secret");
```

**Benefits:**
- Clear security boundaries
- Different encryption keys per level
- Easier access control enforcement
- Compliance with security requirements

**Considerations:**
- Need to classify documents correctly
- Cross-level access requires careful design
- More complex key management

### Geographic Sharding

**Pattern**: Split by geographic region or data residency requirements

**Example**: Multi-Region Deployment
```typescript
// Separate databases by region
const usEastDB = await tenant.openDB("us-east");
const euWestDB = await tenant.openDB("eu-west");
const asiaPacificDB = await tenant.openDB("asia-pacific");
```

**Benefits:**
- Data residency compliance
- Lower latency for regional access
- Regional disaster recovery
- Compliance with local regulations

**Considerations:**
- Cross-region sync complexity
- Need to route documents correctly
- Regional compliance requirements

## Multi-Tenant Patterns

### Separate Tenant Per Organization

**Pattern**: Each organization gets its own tenant

**Example**: SaaS Platform
```typescript
// Each customer is a separate tenant
const acmeTenant = await tenantFactory.openTenant("acme-corp-tenant-id");
const betaTenant = await tenantFactory.openTenant("beta-inc-tenant-id");
```

**Benefits:**
- Complete isolation between organizations
- Independent key management
- Clear data boundaries
- Easy to manage per organization

**When to Use:**
- Multi-tenant SaaS applications
- Different organizations with different requirements
- Need for complete data isolation
- Independent compliance requirements

### Shared Databases for Collaboration

**Pattern**: Organizations share specific databases for collaboration

**Example**: Partner Collaboration
```typescript
// Each organization has its own tenant
const orgATenant = await tenantFactory.openTenant("org-a");
const orgBTenant = await tenantFactory.openTenant("org-b");

// Shared collaboration database
const sharedDB = await orgATenant.openDB("collaboration");
// Org B syncs from Org A's shared database
await orgBTenant.openDB("collaboration").pullChangesFrom(sharedDB.getStore());
```

**Benefits:**
- Secure collaboration across organizations
- Controlled data sharing
- Independent tenant management
- Fine-grained access control

**See**: [Cross-Tenant Collaboration](cross-tenant-collaboration.md) for detailed patterns

## Dealing with Append-Only Growth

### Growth Characteristics

Append-only stores grow continuously:
- Every change is preserved
- Deletions are marked but not removed
- Complete history is maintained
- Storage grows over time

### Growth Management Strategies

#### 1. Time-Based Archival

**Strategy**: Move old data to archive databases

```typescript
// Active database for current year
const activeDB = await tenant.openDB("crm2025");

// Archive databases for previous years
const archive2024 = await tenant.openDB("crm2024-archive");
const archive2023 = await tenant.openDB("crm2023-archive");
```

**Benefits:**
- Active database stays manageable
- Historical data preserved
- Can make archives read-only
- Clear archival boundaries

#### 2. Document Lifecycle Management

**Strategy**: Mark documents as archived or inactive

```typescript
// Mark document as archived instead of deleting
await db.changeDoc(doc, (d) => {
  d.getData().status = "archived";
  d.getData().archivedAt = Date.now();
});
```

**Benefits:**
- Preserves audit trail
- Can filter archived documents
- Easy to restore if needed
- Maintains complete history

#### 3. Snapshot-Based Optimization

**Strategy**: Use Automerge snapshots to reduce change history

MindooDB automatically generates snapshots:
- Reduces number of changes to replay
- Faster document loading
- Less storage for old changes
- Still maintains complete history

**See**: [Architecture Specification](../specification.md) for snapshot details

#### 4. External Storage for Old Data

**Strategy**: Move old data to external storage (future enhancement)

```typescript
// Future: Move old changes to external storage
// while keeping metadata in MindooDB
// This is a planned feature
```

## When to Split: Decision Framework

### Performance Indicators

Split when you observe:
- Slow queries or sync operations
- Large database size affecting performance
- High memory usage during operations
- Slow incremental processing

### Volume Indicators

Consider splitting when:
- Database exceeds size thresholds (e.g., 10GB, 100GB)
- Document count exceeds limits (e.g., 1M, 10M documents)
- Change count grows very large
- Backup/restore times become unacceptable

### Access Pattern Indicators

Split when:
- Different document types have very different access patterns
- Some data is accessed frequently, other rarely
- Clear temporal access patterns (recent vs. old)
- Different security or compliance requirements

### Operational Indicators

Split when:
- Need different retention policies
- Different backup strategies required
- Different sync frequencies needed
- Different access control requirements

## Implementation Examples

### Example 1: Time-Based CRM Sharding

```typescript
class TimeShardedCRM {
  private tenant: MindooTenant;
  
  async getDatabaseForDate(date: Date): Promise<MindooDB> {
    const year = date.getFullYear();
    const dbId = `crm${year}`;
    return this.tenant.openDB(dbId);
  }
  
  async createContact(contactData: any): Promise<MindooDoc> {
    const db = await this.getDatabaseForDate(new Date());
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), contactData);
      d.getData().type = "contact";
      d.getData().createdAt = Date.now();
    });
    return doc;
  }
  
  async searchAllYears(query: string): Promise<MindooDoc[]> {
    const currentYear = new Date().getFullYear();
    const results: MindooDoc[] = [];
    
    // Search last 5 years
    for (let year = currentYear; year >= currentYear - 5; year--) {
      const db = await this.tenant.openDB(`crm${year}`);
      // Use VirtualView or custom search
      const matches = await this.searchInDatabase(db, query);
      results.push(...matches);
    }
    
    return results;
  }
  
  private async searchInDatabase(db: MindooDB, query: string): Promise<MindooDoc[]> {
    // Implementation depends on indexing strategy
    // Could use VirtualView, full-text search, etc.
    return [];
  }
}
```

### Example 2: Category-Based Project Management

```typescript
class CategoryShardedProjectManager {
  private tenant: MindooTenant;
  private categoryToDB: Map<string, string> = new Map([
    ["critical", "projects-critical"],
    ["high", "projects-high"],
    ["normal", "projects-normal"],
    ["low", "projects-low"]
  ]);
  
  async getDatabaseForPriority(priority: string): Promise<MindooDB> {
    const dbId = this.categoryToDB.get(priority) || "projects-normal";
    return this.tenant.openDB(dbId);
  }
  
  async createProject(projectData: any, priority: string): Promise<MindooDoc> {
    const db = await this.getDatabaseForPriority(priority);
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), projectData);
      d.getData().type = "project";
      d.getData().priority = priority;
      d.getData().createdAt = Date.now();
    });
    return doc;
  }
  
  async getUnifiedView(): Promise<VirtualView> {
    // Create VirtualView across all priority databases
    const view = await VirtualViewFactory.createView()
      .addCategoryColumn("priority")
      .addSortedColumn("name")
      .addDisplayColumn("status")
      .withDB("critical", await this.tenant.openDB("projects-critical"))
      .withDB("high", await this.tenant.openDB("projects-high"))
      .withDB("normal", await this.tenant.openDB("projects-normal"))
      .withDB("low", await this.tenant.openDB("projects-low"))
      .buildAndUpdate();
    
    return view;
  }
}
```

## Best Practices

### 1. Plan Sharding Strategy Early

- Consider growth patterns before implementation
- Design database naming conventions
- Plan for cross-database queries
- Consider archival requirements

### 2. Use Consistent Naming

- Clear, predictable database names
- Include time/category in name
- Document naming conventions
- Use helper functions for routing

### 3. Implement Database Routing

- Centralize database selection logic
- Handle edge cases (missing databases, etc.)
- Provide fallback mechanisms
- Log database selection for debugging

### 4. Plan for Cross-Database Operations

- Use VirtualView for aggregation
- Consider sync patterns across databases
- Plan for cross-database relationships
- Design for eventual consistency

### 5. Monitor and Adjust

- Track database sizes
- Monitor performance metrics
- Adjust sharding strategy as needed
- Archive old databases when appropriate

## Related Patterns

- **[Access Control Patterns](access-control-patterns.md)** - Security considerations for sharding
- **[Cross-Tenant Collaboration](cross-tenant-collaboration.md)** - Multi-tenant data sharing
- **[Virtual Views Patterns](virtual-views-patterns.md)** - Aggregating across databases
- **[Backups and Recovery](backups-and-recovery.md)** - Backup strategies for sharded data
- **[Performance Optimization](performance-optimization.md)** - Performance considerations

## Conclusion

Effective data modeling in MindooDB requires:

1. **Understanding append-only growth** and planning for it
2. **Choosing appropriate sharding strategies** based on access patterns
3. **Splitting databases** when volume or access patterns require it
4. **Planning for cross-database operations** using VirtualView
5. **Implementing archival strategies** to manage growth

By following these patterns, you can build scalable, maintainable applications that leverage MindooDB's unique architecture effectively.
