# Collaborative Workspaces Use Cases

## Overview

Collaborative workspaces require real-time collaboration, offline editing, version control, and fine-grained access control. MindooDB's Automerge CRDTs, offline-first architecture, and document-level encryption make it ideal for collaborative applications.

## Key Requirements

### Collaboration Features

- **Real-Time Collaboration**: Multiple users editing simultaneously
- **Offline Editing**: Work without connectivity
- **Version Control**: Complete history of changes
- **Conflict Resolution**: Automatic merge of concurrent edits
- **Access Control**: Team and project-based permissions

### Workspace-Specific Needs

- **Document Management**: Version-controlled documents
- **Project Management**: Task tracking and collaboration
- **Knowledge Bases**: Wiki-style documentation
- **Team Communication**: Shared workspaces
- **File Sharing**: Secure document sharing

## Use Cases

### Document Management

**Pattern**: Version-controlled documents with offline editing

```typescript
class DocumentManagement {
  private tenant: MindooTenant;
  
  async createDocument(workspaceId: string, documentData: any): Promise<MindooDoc> {
    const db = await this.tenant.openDB(`workspace-${workspaceId}`);
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), documentData);
      d.getData().type = "document";
      d.getData().workspaceId = workspaceId;
      d.getData().createdAt = Date.now();
      d.getData().version = 1;
    });
    return doc;
  }
  
  async editDocument(docId: string, changes: (data: any) => void): Promise<void> {
    const db = await this.tenant.openDB("workspace-main");
    const doc = await db.getDocument(docId);
    await db.changeDoc(doc, (d) => {
      changes(d.getData());
      d.getData().lastModified = Date.now();
      d.getData().version = (d.getData().version || 1) + 1;
    });
  }
  
  async getDocumentHistory(docId: string): Promise<MindooDoc[]> {
    const db = await this.tenant.openDB("workspace-main");
    // Get all changes for document
    const changeHashes = await db.getStore().getAllChangeHashesForDoc(docId);
    const changes = await db.getStore().getChanges(changeHashes);
    
    // Reconstruct historical versions
    return this.reconstructVersions(changes);
  }
}
```

**Benefits:**
- Complete version history
- Offline editing support
- Automatic conflict resolution
- Real-time collaboration

### Project Management

**Pattern**: Task tracking with real-time collaboration

```typescript
class ProjectManagement {
  private tenant: MindooTenant;
  
  async createProject(projectData: any): Promise<MindooDoc> {
    const db = await this.tenant.openDB("projects");
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), projectData);
      d.getData().type = "project";
      d.getData().status = "active";
      d.getData().createdAt = Date.now();
    });
    return doc;
  }
  
  async createTask(projectId: string, taskData: any): Promise<MindooDoc> {
    const db = await this.tenant.openDB("projects");
    const taskDoc = await db.createDocument();
    await db.changeDoc(taskDoc, (d) => {
      Object.assign(d.getData(), taskData);
      d.getData().type = "task";
      d.getData().projectId = projectId;
      d.getData().status = "todo";
      d.getData().createdAt = Date.now();
    });
    return taskDoc;
  }
  
  async updateTaskStatus(taskId: string, status: string, userId: string): Promise<void> {
    const db = await this.tenant.openDB("projects");
    const task = await db.getDocument(taskId);
    await db.changeDoc(task, (d) => {
      d.getData().status = status;
      d.getData().updatedBy = userId;
      d.getData().updatedAt = Date.now();
    });
  }
  
  async getProjectView(projectId: string): Promise<VirtualView> {
    const db = await this.tenant.openDB("projects");
    const view = await VirtualViewFactory.createView()
      .addCategoryColumn("status")
      .addSortedColumn("priority", ColumnSorting.DESCENDING)
      .addSortedColumn("createdAt", ColumnSorting.DESCENDING)
      .addDisplayColumn("assignee")
      .withDB("projects", db, (doc) => 
        doc.getData().type === "task" && 
        doc.getData().projectId === projectId
      )
      .buildAndUpdate();
    return view;
  }
}
```

**Benefits:**
- Real-time task updates
- Offline task management
- Automatic conflict resolution
- Project-based organization

### Knowledge Bases

**Pattern**: Wiki-style documentation with access control

```typescript
class KnowledgeBase {
  private tenant: MindooTenant;
  
  async createArticle(articleData: any, keyId: string): Promise<MindooDoc> {
    const db = await this.tenant.openDB("knowledge-base");
    const doc = await db.createEncryptedDocument(keyId);
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), articleData);
      d.getData().type = "article";
      d.getData().createdAt = Date.now();
    });
    return doc;
  }
  
  async editArticle(articleId: string, content: string, userId: string): Promise<void> {
    const db = await this.tenant.openDB("knowledge-base");
    const article = await db.getDocument(articleId);
    await db.changeDoc(article, (d) => {
      d.getData().content = content;
      d.getData().lastEditedBy = userId;
      d.getData().lastEditedAt = Date.now();
    });
  }
  
  async createArticleView(): Promise<VirtualView> {
    const db = await this.tenant.openDB("knowledge-base");
    const view = await VirtualViewFactory.createView()
      .addCategoryColumn("category")
      .addSortedColumn("title")
      .addDisplayColumn("lastEditedAt")
      .withDB("kb", db, (doc) => doc.getData().type === "article")
      .buildAndUpdate();
    return view;
  }
}
```

**Benefits:**
- Collaborative editing
- Access-controlled articles
- Complete edit history
- Category organization

## Access Control Patterns

### Team-Based Access

**Pattern**: Grant access based on team membership

```typescript
class TeamBasedAccess {
  async grantTeamAccess(teamId: string, keyId: string) {
    const teamMembers = await this.getTeamMembers(teamId);
    for (const member of teamMembers) {
      await this.distributeKeyToUser(member.userId, keyId);
    }
  }
  
  async createTeamDocument(teamId: string, data: any): Promise<MindooDoc> {
    const teamKeyId = `team-${teamId}-key`;
    const db = await this.tenant.openDB("team-documents");
    const doc = await db.createEncryptedDocument(teamKeyId);
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), data);
      d.getData().teamId = teamId;
    });
    return doc;
  }
}
```

### Project-Based Access

**Pattern**: Control access by project

```typescript
class ProjectBasedAccess {
  async grantProjectAccess(projectId: string, userId: string) {
    const projectKeyId = `project-${projectId}-key`;
    await this.distributeKeyToUser(userId, projectKeyId);
  }
  
  async createProjectDocument(projectId: string, data: any): Promise<MindooDoc> {
    const projectKeyId = `project-${projectId}-key`;
    const db = await this.tenant.openDB("project-documents");
    const doc = await db.createEncryptedDocument(projectKeyId);
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), data);
      d.getData().projectId = projectId;
    });
    return doc;
  }
}
```

## Real-Time Collaboration

### Concurrent Editing

**Pattern**: Multiple users editing same document

```typescript
// User A edits document
await dbA.changeDoc(doc, (d) => {
  d.getData().title = "New Title";
});

// User B edits same document (different field)
await dbB.changeDoc(doc, (d) => {
  d.getData().content = "New Content";
});

// Sync both ways using store-level operations
const storeA = dbA.getStore();
const storeB = dbB.getStore();

// B pulls from A
const newForB = await storeA.findNewChanges(await storeB.getAllChangeHashes());
if (newForB.length > 0) {
  const changes = await storeA.getChanges(newForB);
  for (const c of changes) await storeB.append(c);
  await dbB.syncStoreChanges(newForB);
}

// A pulls from B
const newForA = await storeB.findNewChanges(await storeA.getAllChangeHashes());
if (newForA.length > 0) {
  const changes = await storeB.getChanges(newForA);
  for (const c of changes) await storeA.append(c);
  await dbA.syncStoreChanges(newForA);
}

// Both changes preserved
// Automerge automatically merges
```

**Benefits:**
- No conflicts for different fields
- Automatic merge for same fields
- Works offline
- Real-time updates

## Offline Editing

### Offline-First Workflow

**Pattern**: Work offline, sync when available

```typescript
class OfflineFirstEditor {
  private db: MindooDB;
  private serverStore: ContentAddressedStore | null = null;
  
  async editDocument(docId: string, changes: (data: any) => void): Promise<void> {
    // Always edit locally first - works offline
    const doc = await this.db.getDocument(docId);
    
    await this.db.changeDoc(doc, (d) => {
      changes(d.getData());
    });
    
    // Try to sync if online
    if (this.serverStore) {
      try {
        await this.pushToServer();
      } catch (error) {
        console.log("Offline - changes saved locally, will sync later");
      }
    }
  }
  
  async syncWhenOnline(): Promise<void> {
    if (!this.serverStore) return;
    
    try {
      await this.pullFromServer();
      await this.pushToServer();
    } catch (error) {
      console.error("Sync failed:", error);
    }
  }
  
  private async pullFromServer(): Promise<void> {
    if (!this.serverStore) return;
    
    const localStore = this.db.getStore();
    const newHashes = await this.serverStore.findNewChanges(
      await localStore.getAllChangeHashes()
    );
    
    if (newHashes.length > 0) {
      const changes = await this.serverStore.getChanges(newHashes);
      for (const change of changes) {
        await localStore.append(change);
      }
      await this.db.syncStoreChanges(newHashes);
    }
  }
  
  private async pushToServer(): Promise<void> {
    if (!this.serverStore) return;
    
    const localStore = this.db.getStore();
    const serverHashes = await this.serverStore.getAllChangeHashes();
    const newHashes = await localStore.findNewChanges(serverHashes);
    
    if (newHashes.length > 0) {
      const changes = await localStore.getChanges(newHashes);
      for (const change of changes) {
        await this.serverStore.append(change);
      }
    }
  }
}
```

## Best Practices

### 1. Document Organization

- Use workspaces or projects for organization
- Implement clear naming conventions
- Use categories and tags
- Plan for growth

### 2. Access Control

- Team-based access for collaboration
- Project-based access for isolation
- Document-level encryption for sensitive data
- Regular access reviews

### 3. Conflict Resolution

- Trust Automerge for automatic merging
- Design data structures to minimize conflicts
- Handle user notifications for conflicts
- Provide conflict resolution UI when needed

### 4. Offline Support

- Always create/edit locally first
- Queue sync operations
- Handle sync failures gracefully
- Provide offline indicators

## Related Patterns

- **[Sync Patterns](sync-patterns.md)** - Real-time sync strategies
- **[Access Control Patterns](access-control-patterns.md)** - Team and project access
- **[Data Modeling Patterns](data-modeling-patterns.md)** - Organizing collaborative data
- **[Virtual Views Patterns](virtual-views-patterns.md)** - Project and team views

## Conclusion

MindooDB is ideal for collaborative workspaces:

1. **Real-Time Collaboration** via Automerge CRDTs
2. **Offline Editing** with automatic sync
3. **Version Control** through complete history
4. **Access Control** with team and project-based permissions
5. **Conflict Resolution** automatically handled

By following these patterns, you can build powerful collaborative applications that work seamlessly online and offline while maintaining data security and integrity.
