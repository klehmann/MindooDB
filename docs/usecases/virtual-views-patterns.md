# Virtual Views Patterns

## Overview

MindooDB's VirtualView system enables powerful cross-boundary aggregation, allowing you to create views that span multiple databases and even multiple tenants. This document explores patterns for building federated views, cross-tenant reporting, and real-time aggregation across organizational boundaries.

## Key Concepts

### VirtualView Capabilities

VirtualView can aggregate documents from:
- **Multiple Databases**: Within the same tenant
- **Multiple Tenants**: Across different organizations
- **Different Origins**: Each data source has an origin identifier
- **Real-Time Updates**: Incremental updates via `processChangesSince()`

### Cross-Boundary Views

VirtualView enables:
- **Federated Reporting**: Aggregate data from multiple sources
- **Cross-Organization Dashboards**: View data across partners
- **Unified Views**: Combine data from different systems
- **Access Control**: Filter view entries based on permissions

## Cross-Database Views

### Basic Pattern

**Pattern**: Aggregate documents from multiple databases in the same tenant

```typescript
// Multiple databases in same tenant
const contactsDB = await tenant.openDB("contacts");
const dealsDB = await tenant.openDB("deals");
const tasksDB = await tenant.openDB("tasks");

// Create unified view
const unifiedView = await VirtualViewFactory.createView()
  .addCategoryColumn("type", { sorting: ColumnSorting.ASCENDING })
  .addSortedColumn("name")
  .addDisplayColumn("status")
  .addTotalColumn("value", TotalMode.SUM)
  .withDB("contacts", contactsDB, (doc) => doc.getData().type === "contact")
  .withDB("deals", dealsDB, (doc) => doc.getData().type === "deal")
  .withDB("tasks", tasksDB, (doc) => doc.getData().type === "task")
  .buildAndUpdate();

// Navigate unified view
const nav = VirtualViewFactory.createNavigator(unifiedView)
  .expandAll()
  .build();

for await (const entry of nav.entriesForward()) {
  if (entry.isCategory()) {
    console.log(`${entry.getCategoryValue()}: ${entry.getTotalValue("value")}`);
  } else {
    console.log(`${entry.origin}: ${entry.getColumnValue("name")}`);
  }
}
```

**Benefits:**
- Unified view of related data
- Clear origin tracking
- Efficient incremental updates
- Flexible filtering per database

### Time-Sharded Views

**Pattern**: Aggregate across time-sharded databases

```typescript
// Yearly sharded databases
const crm2023 = await tenant.openDB("crm2023");
const crm2024 = await tenant.openDB("crm2024");
const crm2025 = await tenant.openDB("crm2025");

// Create cross-year view
const multiYearView = await VirtualViewFactory.createView()
  .addCategoryColumn("year", {
    valueFunction: (doc, values, origin) => {
      // Extract year from origin (e.g., "crm2024" -> "2024")
      return origin.replace("crm", "");
    },
    sorting: ColumnSorting.DESCENDING
  })
  .addCategoryColumn("status")
  .addSortedColumn("name")
  .addTotalColumn("revenue", TotalMode.SUM)
  .withDB("crm2023", crm2023, (doc) => doc.getData().type === "deal")
  .withDB("crm2024", crm2024, (doc) => doc.getData().type === "deal")
  .withDB("crm2025", crm2025, (doc) => doc.getData().type === "deal")
  .buildAndUpdate();
```

**Benefits:**
- Aggregate across time periods
- Maintain sharding benefits
- Efficient for historical analysis
- Clear temporal organization

## Cross-Tenant Views

### Partner Aggregation

**Pattern**: Aggregate data from partner tenants

```typescript
// Get databases from different tenants
const supplierTenant = await tenantFactory.openTenant("supplier-tenant-id");
const customerTenant = await tenantFactory.openTenant("customer-tenant-id");

const supplierOrders = await supplierTenant.openDB("orders");
const customerOrders = await customerTenant.openDB("orders");

// Create cross-tenant view
const partnerView = await VirtualViewFactory.createView()
  .addCategoryColumn("partner", {
    valueFunction: (doc, values, origin) => {
      return origin === "supplier" ? "Supplier" : "Customer";
    }
  })
  .addCategoryColumn("status")
  .addSortedColumn("orderDate", ColumnSorting.DESCENDING)
  .addTotalColumn("amount", TotalMode.SUM)
  .withDB("supplier", supplierOrders, (doc) => doc.getData().type === "order")
  .withDB("customer", customerOrders, (doc) => doc.getData().type === "order")
  .buildAndUpdate();
```

**Benefits:**
- Unified view across organizations
- Real-time aggregation
- Clear partner identification
- Efficient incremental updates

### Multi-Organization Reporting

**Pattern**: Aggregate data from multiple organizations for reporting

```typescript
async function createCrossOrganizationReport(
  tenantDirectory: MindooTenantDirectory,
  tenantIds: string[]
): Promise<VirtualView> {
  const builder = VirtualViewFactory.createView()
    .addCategoryColumn("organization", { 
      title: "Organization",
      sorting: ColumnSorting.ASCENDING 
    })
    .addCategoryColumn("quarter", { 
      title: "Quarter",
      sorting: ColumnSorting.DESCENDING 
    })
    .addSortedColumn("projectName", ColumnSorting.ASCENDING)
    .addTotalColumn("revenue", TotalMode.SUM)
    .addTotalColumn("expenses", TotalMode.SUM);

  // Add each tenant's database
  for (const tenantId of tenantIds) {
    const tenant = await tenantDirectory.getTenant(tenantId);
    const db = await tenant.openDB("projects");
    
    builder.withDB(`tenant-${tenantId}`, db, (doc) => {
      return doc.getData().type === "project";
    });
  }

  return builder.buildAndUpdate();
}

// Usage
const crossOrgView = await createCrossOrganizationReport(
  tenantDirectory,
  ["acme-corp", "beta-inc", "gamma-llc"]
);
```

**Benefits:**
- Executive dashboards
- Cross-organization analytics
- Real-time reporting
- Flexible tenant selection

## Access Control in Views

### Filtering by Permissions

**Pattern**: Filter view entries based on user permissions

```typescript
class PermissionBasedView {
  private userPermissions: Map<string, string[]> = new Map();
  
  async createFilteredView(
    view: VirtualView,
    userId: string
  ): Promise<VirtualViewNavigator> {
    const allowedOrigins = this.userPermissions.get(userId) || [];
    
    const nav = VirtualViewFactory.createNavigator(view)
      .withAccessCallback((nav, entry) => {
        if (entry.isCategory()) {
          return true; // Always show categories
        }
        
        // Check if user has access to this origin
        return allowedOrigins.includes(entry.origin);
      })
      .hideEmptyCategories()
      .build();
    
    return nav;
  }
  
  async grantAccess(userId: string, origin: string) {
    const permissions = this.userPermissions.get(userId) || [];
    if (!permissions.includes(origin)) {
      permissions.push(origin);
      this.userPermissions.set(userId, permissions);
    }
  }
}
```

**Benefits:**
- Fine-grained access control
- Per-user view filtering
- Maintains view structure
- Easy to update permissions

### Role-Based View Access

**Pattern**: Filter views based on user roles

```typescript
class RoleBasedViewAccess {
  private userRoles: Map<string, string[]> = new Map();
  
  async createRoleFilteredView(
    view: VirtualView,
    userId: string
  ): Promise<VirtualViewNavigator> {
    const userRoles = this.userRoles.get(userId) || [];
    
    const nav = VirtualViewFactory.createNavigator(view)
      .withAccessCallback((nav, entry) => {
        if (entry.isCategory()) {
          return true;
        }
        
        // Check if entry requires role user doesn't have
        const requiredRole = entry.getColumnValue("requiredRole") as string;
        if (requiredRole && !userRoles.includes(requiredRole)) {
          return false;
        }
        
        return true;
      })
      .hideEmptyCategories()
      .build();
    
    return nav;
  }
}
```

## Performance Optimization

### Incremental Updates

VirtualView uses `processChangesSince()` for efficient updates:

```typescript
// Initial view creation
const view = await VirtualViewFactory.createView()
  .addCategoryColumn("status")
  .addSortedColumn("name")
  .withDB("main", mainDB)
  .buildAndUpdate();

// Later: incremental update (only processes changed documents)
await view.update();

// Or update specific origin
await view.updateOrigin("main");
```

**Benefits:**
- Only processes changed documents
- Fast updates for large views
- Efficient for real-time views
- Minimal computation

### Large Dataset Handling

**Pattern**: Optimize views for large datasets

```typescript
// Use filtering to reduce document count
const view = await VirtualViewFactory.createView()
  .addCategoryColumn("status")
  .addSortedColumn("name")
  .withDB("main", mainDB, (doc) => {
    // Only include active documents
    return doc.getData().status !== "archived";
  })
  .buildAndUpdate();

// Use pagination for navigation
const nav = VirtualViewFactory.createNavigator(view)
  .build();

let count = 0;
const pageSize = 100;

for await (const entry of nav.entriesForward()) {
  if (count >= pageSize) break;
  // Process entry
  count++;
}
```

**Considerations:**
- Filter documents at data provider level
- Use pagination for large result sets
- Consider multiple smaller views
- Cache view results when appropriate

## Use Cases

### Executive Dashboard

**Pattern**: Aggregate metrics across organizations

```typescript
async function createExecutiveDashboard(
  tenantDirectory: MindooTenantDirectory
): Promise<VirtualView> {
  const view = await VirtualViewFactory.createView()
    .addCategoryColumn("organization")
    .addCategoryColumn("department")
    .addTotalColumn("revenue", TotalMode.SUM)
    .addTotalColumn("expenses", TotalMode.SUM)
    .addDisplayColumn("profit", {
      valueFunction: (doc, values) => {
        return (values.revenue as number) - (values.expenses as number);
      }
    });

  // Add all organization databases
  const tenants = await tenantDirectory.getAllTenants();
  for (const tenant of tenants) {
    const db = await tenant.openDB("financials");
    view.withDB(`org-${tenant.getId()}`, db);
  }

  return view.buildAndUpdate();
}
```

### Cross-Project Reporting

**Pattern**: Aggregate data across multiple projects

```typescript
async function createProjectReport(
  tenant: MindooTenant,
  projectDBs: string[]
): Promise<VirtualView> {
  const builder = VirtualViewFactory.createView()
    .addCategoryColumn("project")
    .addCategoryColumn("status")
    .addSortedColumn("taskName")
    .addTotalColumn("hours", TotalMode.SUM)
    .addTotalColumn("cost", TotalMode.SUM);

  for (const dbId of projectDBs) {
    const db = await tenant.openDB(dbId);
    builder.withDB(dbId, db, (doc) => doc.getData().type === "task");
  }

  return builder.buildAndUpdate();
}
```

### Real-Time Analytics

**Pattern**: Real-time aggregation across data sources

```typescript
class RealTimeAnalytics {
  private view: VirtualView;
  
  async initialize() {
    this.view = await VirtualViewFactory.createView()
      .addCategoryColumn("category")
      .addTotalColumn("count", TotalMode.SUM)
      .addTotalColumn("value", TotalMode.SUM)
      .withDB("source1", source1DB)
      .withDB("source2", source2DB)
      .buildAndUpdate();
  }
  
  async update() {
    // Incremental update
    await this.view.update();
  }
  
  async getMetrics(): Promise<Map<string, number>> {
    const nav = VirtualViewFactory.createNavigator(this.view)
      .categoriesOnly()
      .build();
    
    const metrics = new Map<string, number>();
    
    for await (const entry of nav.entriesForward()) {
      if (entry.isCategory()) {
        metrics.set(
          entry.getCategoryValue() as string,
          entry.getTotalValue("value") || 0
        );
      }
    }
    
    return metrics;
  }
}
```

## Implementation Examples

### Example 1: Multi-Region Sales Dashboard

```typescript
class MultiRegionSalesDashboard {
  private tenant: MindooTenant;
  
  async createDashboard(): Promise<VirtualView> {
    // Regional databases
    const usEastDB = await this.tenant.openDB("sales-us-east");
    const euWestDB = await this.tenant.openDB("sales-eu-west");
    const asiaPacificDB = await this.tenant.openDB("sales-asia-pacific");
    
    const view = await VirtualViewFactory.createView()
      .addCategoryColumn("region", {
        valueFunction: (doc, values, origin) => {
          if (origin.includes("us")) return "US East";
          if (origin.includes("eu")) return "EU West";
          if (origin.includes("asia")) return "Asia Pacific";
          return "Unknown";
        }
      })
      .addCategoryColumn("product")
      .addSortedColumn("saleDate", ColumnSorting.DESCENDING)
      .addTotalColumn("revenue", TotalMode.SUM)
      .addTotalColumn("units", TotalMode.SUM)
      .withDB("us-east", usEastDB, (doc) => doc.getData().type === "sale")
      .withDB("eu-west", euWestDB, (doc) => doc.getData().type === "sale")
      .withDB("asia-pacific", asiaPacificDB, (doc) => doc.getData().type === "sale")
      .buildAndUpdate();
    
    return view;
  }
  
  async getRegionalSummary(): Promise<Map<string, number>> {
    const view = await this.createDashboard();
    const nav = VirtualViewFactory.createNavigator(view)
      .categoriesOnly()
      .fromCategory("region")
      .build();
    
    const summary = new Map<string, number>();
    
    for await (const entry of nav.entriesForward()) {
      if (entry.isCategory() && entry.getLevel() === 1) {
        summary.set(
          entry.getCategoryValue() as string,
          entry.getTotalValue("revenue") || 0
        );
      }
    }
    
    return summary;
  }
}
```

## Best Practices

### 1. Plan View Structure

- Design categories and columns upfront
- Consider access patterns
- Plan for incremental updates
- Document view purpose

### 2. Optimize Data Providers

- Use filters to reduce document count
- Only include necessary documents
- Consider data freshness requirements
- Balance performance and completeness

### 3. Handle Access Control

- Implement permission checks
- Filter at view level when needed
- Document access requirements
- Test with different user roles

### 4. Monitor Performance

- Track view update times
- Monitor memory usage
- Optimize for large datasets
- Consider caching strategies

### 5. Document Origins

- Use clear origin identifiers
- Document data source mapping
- Track origin changes
- Maintain origin metadata

## Related Patterns

- **[Data Modeling Patterns](data-modeling-patterns.md)** - Organizing data for views
- **[Cross-Tenant Collaboration](cross-tenant-collaboration.md)** - Sharing data for views
- **[Access Control Patterns](access-control-patterns.md)** - Securing view access
- **[Data Indexing](../dataindexing.md)** - Indexing strategies for views

## Conclusion

VirtualView enables powerful cross-boundary aggregation:

1. **Cross-Database Views** for unified data access
2. **Cross-Tenant Views** for partner aggregation
3. **Access Control** for secure view filtering
4. **Performance Optimization** for large datasets
5. **Real-Time Updates** via incremental processing

By leveraging VirtualView patterns, you can build sophisticated reporting and analytics systems that aggregate data across organizational boundaries while maintaining security and performance.
