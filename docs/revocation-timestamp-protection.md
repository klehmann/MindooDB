# Revocation Timestamp Protection: Concept Document

## Executive Summary

This document describes a critical security problem in MindooDB: **how to prevent revoked users from creating backdated changes by manipulating their system clock**. The problem arises from the end-to-end encrypted, offline-first architecture where clients control change timestamps. We analyze multiple cryptographic approaches to solve this problem while maintaining the system's core principles: end-to-end encryption, offline operation, and hybrid deployment models.

**Recommended Solution**: Hybrid approach using directory sequence numbers combined with local monotonic counters (Solution D), providing defense-in-depth protection while maintaining offline capabilities.

## Problem Statement

### The Attack Scenario

Consider the following sequence of events:

1. **User A generates their user ID** and is granted access to the tenant
2. **Admin grants access** - User A is registered in the directory database
3. **User A creates Document A** - Legitimate change with timestamp T₁
4. **Admin revokes User A** - Revocation record created in directory at timestamp T_revoke
5. **User A manipulates their system clock** - Sets clock back to T_before_revoke (where T_before_revoke < T_revoke)
6. **User A creates Document B** - Change created with backdated timestamp T_before_revoke
7. **User A pushes changes to tenant** - Document B appears to have been created before revocation

**The Question**: How can the system detect and reject Document B, knowing that User A was revoked at T_revoke, even though Document B claims to have been created at T_before_revoke?

### Why This Is a Problem

In the current implementation:
- Change timestamps (`createdAt`) are set by the client using `Date.now()`
- Timestamps are included in change metadata but are **not cryptographically protected**
- Signature verification only proves the change was created by the user's key, not when it was created
- A revoked user can manipulate their clock and create changes that appear legitimate

**Impact**:
- Revoked users can continue to create documents that appear to predate their revocation
- Undermines the security model: revocation should prevent future changes
- Compromises audit trails and compliance requirements
- Breaks trust in the end-to-end encrypted model

### Current System Behavior

Currently, when processing changes:
1. Signature is verified (proves authenticity and integrity)
2. Payload is decrypted
3. Change is applied to the document

**Missing**: Validation that the user was authorized at the claimed timestamp.

## System Context and Constraints

### Core Principles

Any solution must respect MindooDB's fundamental principles:

1. **End-to-End Encrypted Architecture**
   - No central authority required
   - All operations cryptographically verified
   - Trust established through cryptographic proofs

2. **Offline-First Operation**
   - System must work when offline
   - Changes can be created without network connectivity
   - Synchronization happens when connectivity is available

3. **Hybrid Deployment**
   - Some databases local (local AppendOnlyStore)
   - Some databases remote (remote AppendOnlyStore implementations)
   - Seamless synchronization between local and remote stores

4. **Append-Only Semantics**
   - Changes are never modified or deleted
   - Cryptographic chaining ensures integrity
   - Complete audit trail preserved

### Constraints

- **No External Services**: Cannot rely on external timestamping services (breaks offline requirement)
- **Client-Controlled Clocks**: Cannot trust client system clocks
- **Distributed System**: No single source of truth for time
- **Cryptographic Verification**: All security must be provable through cryptography
- **Performance**: Solution must not significantly impact change creation or processing

## Solution Approaches

### Solution 1: Timestamp-Based Revocation Check

**Description**: Enhance change processing to verify the user was authorized at the claimed timestamp by checking the directory database.

**How It Works**:
1. Extend `validatePublicSigningKey()` to accept a timestamp parameter
2. When processing changes, query directory for revocation records
3. Reject changes if `change.createdAt >= revocationTimestamp`

**Implementation**:
```typescript
// Enhanced validation
async validatePublicSigningKey(
  publicKey: string, 
  atTimestamp: number
): Promise<boolean> {
  // Query directory for user registration
  // Check if user was revoked at or before atTimestamp
  // Return false if revoked
}

// In change processing
const wasAuthorized = await tenant.validatePublicSigningKey(
  change.createdByPublicKey,
  change.createdAt
);
```

**Pros**:
- ✅ Simple to implement
- ✅ Uses existing directory infrastructure
- ✅ Works offline (if directory is synced)
- ✅ Deterministic validation
- ✅ No additional metadata required

**Cons**:
- ❌ Relies on directory sync being up-to-date
- ❌ If directory isn't synced, may reject valid changes
- ❌ Timestamp is still client-controlled (can be manipulated)
- ❌ Requires directory query for each change

**Offline Behavior**: Works if directory was synced before going offline. May reject valid changes if directory is stale.

**E2E Encryption Compliance**: ✅ Yes - uses existing cryptographic directory

---

### Solution 2: Cryptographic Chain Ordering

**Description**: Leverage existing dependency chains to prove ordering relative to other changes.

**How It Works**:
1. Changes already have `depsHashes` linking to previous changes
2. Verify that dependencies existed before revocation
3. Reject changes if dependencies were created after revocation

**Implementation**:
```typescript
async function validateChangeOrdering(
  change: MindooDocChange,
  revocationTimestamp: number
): Promise<boolean> {
  const deps = await store.getChanges(change.depsHashes);
  const latestDepTime = Math.max(...deps.map(d => d.createdAt));
  
  // If latest dependency is after revocation, invalid
  if (latestDepTime > revocationTimestamp) {
    return false;
  }
  
  // Change must be after its dependencies
  if (change.createdAt < latestDepTime) {
    return false; // Clock manipulation detected
  }
  
  return true;
}
```

**Pros**:
- ✅ Uses existing infrastructure (dependencies)
- ✅ No additional metadata needed
- ✅ Works completely offline
- ✅ Cryptographically verifiable ordering

**Cons**:
- ❌ Only prevents backdating relative to dependencies
- ❌ Doesn't prevent creating new documents with backdated timestamps
- ❌ Less precise than sequence numbers
- ❌ Complex validation logic

**Offline Behavior**: ✅ Works completely offline

**E2E Encryption Compliance**: ✅ Yes - uses cryptographic dependencies

---

### Solution 3: External Timestamping Service

**Description**: Use an external trusted timestamping service (e.g., RFC 3161) to sign timestamps.

**How It Works**:
1. When creating a change, contact timestamping service
2. Service returns signed timestamp
3. Include signed timestamp in change metadata
4. Verify timestamp signature when processing changes

**Pros**:
- ✅ Strong cryptographic guarantee
- ✅ Industry-standard approach
- ✅ Tamper-proof timestamps

**Cons**:
- ❌ **Requires network connectivity** (breaks offline requirement)
- ❌ External dependency (breaks E2E encryption principle)
- ❌ Additional latency for change creation
- ❌ Service availability concerns
- ❌ Cost considerations

**Offline Behavior**: ❌ Does not work offline

**E2E Encryption Compliance**: ❌ No - requires external trusted service

**Verdict**: **Not suitable** for MindooDB due to offline requirement.

---

### Solution 4: Directory Sequence Numbers

**Description**: Use the directory database as a sequence-numbered timestamp authority.

**How It Works**:
1. Each directory operation (registration, revocation) gets a sequence number
2. Sequence numbers are cryptographically linked (included in signatures)
3. When creating a change, include latest known directory sequence number
4. When processing, check if user was revoked at that sequence number

**Implementation**:
```typescript
interface DirectoryOperation {
  sequenceNumber: number;  // Cryptographically linked
  type: "grantaccess" | "revokeaccess";
  // ... other fields
  // Sequence number included in signature
}

interface MindooDocChangeHashes {
  // ... existing fields
  directorySequenceNumber: number;  // Latest directory seq when created
  // Included in signature - tamper-proof
}
```

**Pros**:
- ✅ Works offline (if directory was synced)
- ✅ Cryptographically strong (sequence in signature)
- ✅ No external service needed
- ✅ Deterministic ordering
- ✅ Uses existing directory infrastructure

**Cons**:
- ❌ Requires directory sync before creating changes
- ❌ More complex implementation
- ❌ May need directory state queries

**Offline Behavior**: Works if directory was synced. Cannot create changes if directory is completely unknown.

**E2E Encryption Compliance**: ✅ Yes - uses existing cryptographic directory

---

### Solution 5: Peer-Witnessed Timestamps (Distributed Timestamping)

**Description**: Use other tenant members as witnesses to sign timestamps.

**How It Works**:
1. When creating a change, request witness signatures from online peers
2. Peers sign: "I witnessed this change hash at timestamp T"
3. Include witness signatures in change metadata
4. Verify that enough witnesses signed before revocation

**Pros**:
- ✅ Distributed trust (no single point of failure)
- ✅ Works with peer connectivity (even without internet)
- ✅ Can require multiple witnesses for higher security

**Cons**:
- ❌ Requires peers to be online
- ❌ Complex coordination required
- ❌ Slows down change creation
- ❌ May not work in small tenants
- ❌ Witness availability concerns

**Offline Behavior**: ⚠️ Works if peers are available, but may not work in isolation

**E2E Encryption Compliance**: ✅ Yes - uses peer signatures

**Verdict**: **Complex** and may not work in all scenarios.

---

### Solution 6: Hybrid - Directory Sequence + Local Monotonic Counter ⭐ RECOMMENDED

**Description**: Combine directory sequence numbers with a local monotonic counter for defense-in-depth.

**How It Works**:
1. Include directory sequence number (from last sync)
2. Include local monotonic counter (increments with each change, never decreases)
3. Both are signed as part of the change
4. Validate both when processing changes

**Implementation**:
```typescript
interface MindooDocChangeHashes {
  // ... existing fields
  directorySequenceNumber: number;  // From directory (last known)
  localSequenceNumber: number;       // Local monotonic counter
  // Both included in signature - tamper-proof
}

// Local counter stored in persistent storage (encrypted, like KeyBag)
// Incremented atomically with each change creation
```

**Validation Logic**:
```typescript
// When processing a change:
1. Verify signature (includes both sequence numbers) ✓
2. Check directory sequence: was user revoked at that seq? ✓
3. Check local sequence: does it follow previous changes? ✓
4. Flag suspicious patterns (gaps, resets) for investigation
```

**Pros**:
- ✅ **Defense-in-depth**: Two independent ordering mechanisms
- ✅ **Offline protection**: Local counter works even when directory isn't synced
- ✅ **Tamper detection**: Local counter resets are detectable
- ✅ **Better audit trail**: Clear ordering even during offline periods
- ✅ **Prevents backdating relative to own changes**: Can't create change with lower localSeq than previous
- ✅ **Works with hybrid deployments**: Local counter per device/store

**Cons**:
- ❌ More complex implementation (two sequence numbers)
- ❌ Local counter can be reset (but detectable)
- ❌ Doesn't help first change after going offline (only directory sequence protects)
- ❌ Requires persistent storage for local counter

**Offline Behavior**: ✅ Excellent - local counter provides ordering even when offline

**E2E Encryption Compliance**: ✅ Yes - both mechanisms are cryptographic

**Additional Security Benefits**:
- Prevents creating multiple changes with same directory sequence but different local sequences
- Detects local state tampering (counter resets create gaps)
- Provides ordering within offline periods
- Works across multiple devices (each has independent local counter)

---

## Comparison Matrix

| Solution | Offline | E2E Encrypted | Complexity | Security | Recommended |
|----------|---------|------------|------------|----------|-------------|
| 1. Timestamp Check | ⚠️ If synced | ✅ | Low | Medium | Consider |
| 2. Chain Ordering | ✅ | ✅ | Medium | Medium | Consider |
| 3. External Service | ❌ | ❌ | Low | High | ❌ |
| 4. Directory Sequence | ⚠️ If synced | ✅ | Medium | High | Consider |
| 5. Peer Witness | ⚠️ If peers available | ✅ | High | High | ⚠️ |
| 6. Hybrid (4+Local) | ✅ | ✅ | Medium-High | **Highest** | ⭐ **YES** |

## Recommendation

**Recommended Solution: Hybrid Approach (Solution 6)**

Use **directory sequence numbers combined with local monotonic counters** because:

1. **Strongest Security**: Defense-in-depth with two independent mechanisms
2. **Offline Capable**: Local counter works even when directory isn't synced
3. **E2E Encryption Compliant**: Both mechanisms are cryptographic, no external dependencies
4. **Hybrid Deployment Friendly**: Works with local and remote stores
5. **Tamper Detection**: Local counter resets are detectable
6. **Better Audit Trail**: Clear ordering even during offline periods

### Implementation Priority

**Phase 1: Directory Sequence Numbers**
- Add sequence numbers to directory operations
- Include directory sequence in changes
- Validate directory sequence during change processing

**Phase 2: Local Monotonic Counter**
- Add local counter storage (encrypted, like KeyBag)
- Include local sequence in changes
- Validate local sequence ordering
- Detect and flag suspicious patterns

## Implementation Considerations

### Directory Sequence Numbers

**Storage**:
- Sequence numbers stored in directory database (append-only)
- Each operation increments sequence
- Sequence included in operation signature

**Change Creation**:
- Query directory for latest sequence number
- Include in change metadata
- Sign change (includes sequence number)

**Change Validation**:
- Query directory at sequence number = `change.directorySequenceNumber`
- Check if user was revoked at that sequence
- Reject if `revocationSequenceNumber <= change.directorySequenceNumber`

**Edge Cases**:
- First change after going offline: Only directory sequence protects (acceptable)
- Directory not synced: Cannot create changes (acceptable for security)
- Multiple devices: Each device has its own view of directory sequence

### Local Monotonic Counter

**Storage**:
- Store in persistent storage (encrypted, same security as KeyBag)
- Per-tenant or per-database counter
- Atomic increment with change creation

**Change Creation**:
- Read current local counter
- Increment atomically
- Include in change metadata
- Sign change (includes local sequence)

**Change Validation**:
- Track highest local sequence seen per user
- Reject if `change.localSequenceNumber <= previousHighest`
- Flag gaps for investigation

**Edge Cases**:
- First change: Local sequence = 1
- Local state reset: Detectable via sequence gaps
- Multiple devices: Each device has independent counter (acceptable)
- Counter overflow: Use 64-bit integer (sufficient for practical purposes)

### Performance Considerations

- **Directory Queries**: May need caching or indexing for performance
- **Local Counter**: In-memory with periodic persistence (like KeyBag)
- **Validation**: Can be done asynchronously for better performance
- **Batch Processing**: Validate multiple changes in single directory query

### Migration Strategy

1. **Backward Compatibility**: Changes without sequence numbers are accepted (legacy)
2. **Gradual Rollout**: New changes include sequence numbers
3. **Validation**: Optional initially, then mandatory
4. **Monitoring**: Track validation failures and suspicious patterns

## Security Analysis

### Attack Scenarios

**Scenario 1: Clock Manipulation**
- **Attack**: User manipulates clock, creates backdated change
- **Protection**: Directory sequence number prevents this (can't backdate directory state)
- **Result**: ✅ Prevented

**Scenario 2: Local State Reset**
- **Attack**: User deletes local state, resets counter, creates backdated change
- **Protection**: Local counter reset creates detectable gaps
- **Result**: ✅ Detected and flagged

**Scenario 3: Offline Backdating**
- **Attack**: User goes offline, creates multiple changes with same directory sequence
- **Protection**: Local counter enforces ordering
- **Result**: ✅ Prevented

**Scenario 4: Directory Sync Bypass**
- **Attack**: User creates change without syncing directory
- **Protection**: Change includes stale directory sequence, validation catches it
- **Result**: ✅ Prevented (if directory sync is required)

### Threat Model

**Assumptions**:
- Users can manipulate their system clock
- Users can reset local state (but detectable)
- Directory sync may be delayed but eventually consistent
- Peers may be offline or unavailable

**Protections**:
- Cryptographic signatures prevent forgery
- Sequence numbers prevent backdating
- Local counters prevent relative backdating
- Directory provides authoritative revocation state

## Conclusion

The hybrid approach (Solution 6) provides the strongest security while maintaining MindooDB's core principles of end-to-end encryption, offline operation, and hybrid deployment. The combination of directory sequence numbers and local monotonic counters creates defense-in-depth that prevents clock manipulation attacks while remaining practical to implement and maintain.

The solution respects the append-only nature of the system, works in offline scenarios, and provides cryptographic guarantees without requiring external services or breaking the end-to-end encrypted model.

