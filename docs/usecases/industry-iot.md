# IoT & Edge Computing Use Cases

## Overview

IoT and edge computing require efficient data collection, offline operation, bandwidth optimization, and device management. MindooDB's offline-first architecture, incremental sync, and time-series data patterns make it ideal for IoT applications.

## Key Requirements

### IoT-Specific Needs

- **Offline Operation**: Edge devices work independently
- **Bandwidth Optimization**: Minimize data transfer
- **Time-Series Data**: Efficient storage of sensor readings
- **Device Management**: Configuration and firmware updates
- **Edge-to-Cloud Sync**: Efficient synchronization

### Edge Computing Needs

- **Local Processing**: Process data at the edge
- **Intermittent Connectivity**: Handle network issues
- **Resource Constraints**: Efficient on edge devices
- **Real-Time Updates**: Fast local updates
- **Cloud Aggregation**: Aggregate edge data in cloud

## Use Cases

### Sensor Data Collection

**Pattern**: Time-series data from edge devices

```typescript
class SensorDataCollection {
  private tenant: MindooTenant;
  
  async createDeviceDatabase(deviceId: string): Promise<MindooDB> {
    // Time-sharded databases for device data
    const year = new Date().getFullYear();
    const month = String(new Date().getMonth() + 1).padStart(2, '0');
    const dbId = `device-${deviceId}-${year}${month}`;
    
    return await this.tenant.openDB(dbId);
  }
  
  async recordSensorReading(deviceId: string, reading: any): Promise<MindooDoc> {
    const db = await this.createDeviceDatabase(deviceId);
    
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      d.getData().type = "sensor-reading";
      d.getData().deviceId = deviceId;
      d.getData().sensorType = reading.sensorType;
      d.getData().value = reading.value;
      d.getData().unit = reading.unit;
      d.getData().timestamp = Date.now();
      d.getData().location = reading.location;
    });
    
    return doc;
  }
  
  async getDeviceReadings(deviceId: string, startDate: Date, endDate: Date): Promise<MindooDoc[]> {
    const results: MindooDoc[] = [];
    const startYear = startDate.getFullYear();
    const endYear = endDate.getFullYear();
    
    for (let year = startYear; year <= endYear; year++) {
      for (let month = 1; month <= 12; month++) {
        const dbId = `device-${deviceId}-${year}${String(month).padStart(2, '0')}`;
        try {
          const db = await this.tenant.openDB(dbId);
          
          // Filter by date range while iterating
          await db.processChangesSince(null, 100, (doc, cursor) => {
            const data = doc.getData();
            const timestamp = data.timestamp;
            if (timestamp >= startDate.getTime() && timestamp <= endDate.getTime()) {
              results.push(doc);
            }
            return true; // Continue iterating
          });
        } catch (error) {
          continue;
        }
      }
    }
    
    return results;
  }
}
```

**Data Modeling:**
- **Time-Sharded**: Monthly databases per device
- **Device-Based**: Separate databases per device
- **Time-Series**: Efficient storage of readings
- **Offline-First**: Devices work independently

### Device Management

**Pattern**: Configuration and firmware updates

```typescript
class DeviceManagement {
  private tenant: MindooTenant;
  
  async createDevice(deviceData: any): Promise<MindooDoc> {
    const db = await this.tenant.openDB("devices");
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), deviceData);
      d.getData().type = "device";
      d.getData().status = "active";
      d.getData().createdAt = Date.now();
    });
    return doc;
  }
  
  async updateDeviceConfig(deviceId: string, config: any): Promise<void> {
    const db = await this.tenant.openDB("devices");
    const device = await db.getDocument(deviceId);
    await db.changeDoc(device, (d) => {
      d.getData().config = config;
      d.getData().configUpdatedAt = Date.now();
    });
  }
  
  async pushFirmwareUpdate(deviceId: string, firmware: any): Promise<void> {
    const db = await this.tenant.openDB("devices");
    const device = await db.getDocument(deviceId);
    await db.changeDoc(device, (d) => {
      if (!d.getData().firmwareUpdates) {
        d.getData().firmwareUpdates = [];
      }
      d.getData().firmwareUpdates.push({
        version: firmware.version,
        url: firmware.url,
        checksum: firmware.checksum,
        pushedAt: Date.now(),
        status: "pending"
      });
    });
  }
  
  async markFirmwareInstalled(deviceId: string, version: string): Promise<void> {
    const db = await this.tenant.openDB("devices");
    const device = await db.getDocument(deviceId);
    await db.changeDoc(device, (d) => {
      const update = d.getData().firmwareUpdates.find((u: any) => u.version === version);
      if (update) {
        update.status = "installed";
        update.installedAt = Date.now();
      }
      d.getData().currentFirmware = version;
    });
  }
}
```

### Edge-to-Cloud Sync

**Pattern**: Efficient incremental sync from edge to cloud

```typescript
class EdgeToCloudSync {
  private edgeDB: MindooDB;
  private cloudStore: AppendOnlyStore;
  private lastSyncCursor: ProcessChangesCursor | null = null;
  
  async syncToCloud() {
    // Use incremental sync
    const newHashes = await this.edgeDB.getStore().findNewChanges(
      await this.cloudStore.getAllChangeHashes()
    );
    
    if (newHashes.length === 0) {
      return; // No new data
    }
    
    // Get new changes
    const newChanges = await this.edgeDB.getStore().getChanges(newHashes);
    
    // Push to cloud
    for (const change of newChanges) {
      await this.cloudStore.append(change);
    }
    
    // Update sync cursor
    this.lastSyncCursor = await this.edgeDB.processChangesSince(
      this.lastSyncCursor,
      1,
      (doc, cursor) => {
        return false; // Just get cursor
      }
    );
  }
  
  async syncFromCloud(): Promise<void> {
    // Pull configuration and firmware updates from cloud
    const localStore = this.edgeDB.getStore();
    const newHashes = await this.cloudStore.findNewChanges(
      await localStore.getAllChangeHashes()
    );
    
    if (newHashes.length > 0) {
      const changes = await this.cloudStore.getChanges(newHashes);
      for (const change of changes) {
        await localStore.append(change);
      }
      await this.edgeDB.syncStoreChanges(newHashes);
    }
  }
  
  async startPeriodicSync(interval: number = 60 * 60 * 1000) {
    // Initial sync
    await this.syncToCloud();
    await this.syncFromCloud();
    
    // Periodic sync
    setInterval(async () => {
      await this.syncToCloud();
      await this.syncFromCloud();
    }, interval);
  }
}
```

**Benefits:**
- Only transfers new data
- Efficient bandwidth usage
- Works with intermittent connectivity
- Automatic retry on failure

### Bandwidth Optimization

**Pattern**: Minimize data transfer

```typescript
class BandwidthOptimizedSync {
  async syncOnlyChanges(edgeDB: MindooDB, cloudStore: AppendOnlyStore) {
    // Get only new changes
    const cloudHashes = await cloudStore.getAllChangeHashes();
    const edgeNewHashes = await edgeDB.getStore().findNewChanges(cloudHashes);
    
    // Get only metadata first (small)
    const edgeNewChanges = await edgeDB.getStore().getChanges(edgeNewHashes);
    
    // Filter to only essential changes
    const essentialChanges = edgeNewChanges.filter(change => {
      // Only sync sensor readings, not all metadata
      return change.type === "change" && 
             this.isEssentialChange(change);
    });
    
    // Push essential changes
    for (const change of essentialChanges) {
      await cloudStore.append(change);
    }
  }
  
  private isEssentialChange(change: MindooDocChange): boolean {
    // Filter logic for essential changes
    // e.g., only sensor readings, not device metadata
    return true; // Implement filtering logic
  }
}
```

## Offline Operation

### Edge Device Independence

**Pattern**: Devices work completely offline

```typescript
class OfflineEdgeDevice {
  private localDB: MindooDB;
  private cloudStore: AppendOnlyStore | null = null;
  
  async recordSensorReading(reading: any) {
    // Always record locally first
    const db = await this.localDB;
    const doc = await db.createDocument();
    await db.changeDoc(doc, (d) => {
      Object.assign(d.getData(), reading);
      d.getData().type = "sensor-reading";
      d.getData().timestamp = Date.now();
    });
    
    // Try to sync if online
    if (this.cloudStore) {
      try {
        await this.syncToCloud();
      } catch (error) {
        console.log("Offline - data stored locally");
      }
    }
  }
  
  async syncWhenOnline() {
    if (!this.cloudStore) return;
    
    try {
      await this.syncToCloud();
      await this.syncFromCloud();
    } catch (error) {
      console.error("Sync failed:", error);
    }
  }
}
```

## Best Practices

### 1. Time-Based Sharding

- Use monthly or weekly databases per device
- Archive old data efficiently
- Enable fast time-range queries
- Reduce database size

### 2. Incremental Sync

- Only sync new changes
- Use `processChangesSince()` for efficiency
- Batch changes when possible
- Handle sync failures gracefully

### 3. Bandwidth Optimization

- Filter non-essential data
- Compress when possible
- Sync on schedule, not real-time
- Prioritize critical data

### 4. Device Management

- Centralized device registry
- Configuration versioning
- Firmware update tracking
- Device status monitoring

## Related Patterns

- **[Data Modeling Patterns](data-modeling-patterns.md)** - Time-based sharding
- **[Sync Patterns](sync-patterns.md)** - Edge-to-cloud sync
- **[Backups and Recovery](backups-and-recovery.md)** - Device data backup

## Conclusion

MindooDB is ideal for IoT and edge computing:

1. **Offline Operation** for edge device independence
2. **Bandwidth Optimization** through incremental sync
3. **Time-Series Data** with efficient time-based sharding
4. **Device Management** with configuration and firmware tracking
5. **Edge-to-Cloud Sync** with efficient data transfer

By following these patterns, you can build robust IoT systems that work reliably at the edge while efficiently syncing with cloud infrastructure.
