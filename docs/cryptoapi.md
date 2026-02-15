# MindooDB Crypto API

This document describes the cryptographic operations used by MindooDB, the challenges of running them in React Native environments, and the solutions we've implemented.

## Overview

MindooDB relies heavily on the [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) for all cryptographic operations. This API is natively available in modern browsers and Node.js, but requires special handling in React Native environments.

## Cryptographic Operations Used

MindooDB uses the following cryptographic algorithms and operations:

### Digital Signatures (Ed25519)

Used for signing and verifying document entries to ensure data integrity and authenticity.

| Operation | Algorithm | Key Format | Purpose |
|-----------|-----------|------------|---------|
| `generateKey` | Ed25519 | - | Generate signing key pairs |
| `sign` | Ed25519 | - | Sign document entries |
| `verify` | Ed25519 | - | Verify document signatures |
| `importKey` | Ed25519 | SPKI (public), PKCS8 (private) | Import stored keys |
| `exportKey` | Ed25519 | SPKI (public), PKCS8 (private) | Export keys for storage |

### Asymmetric Encryption (RSA-OAEP)

Used for secure key exchange and encrypting data for specific recipients.

| Operation | Algorithm | Key Size | Hash | Purpose |
|-----------|-----------|----------|------|---------|
| `generateKey` | RSA-OAEP | 3072 bits | SHA-256 | Generate encryption key pairs |
| `encrypt` | RSA-OAEP | - | SHA-256 | Encrypt symmetric keys for recipients |
| `decrypt` | RSA-OAEP | - | SHA-256 | Decrypt received symmetric keys |
| `importKey` | RSA-OAEP | - | - | Import stored keys (SPKI/PKCS8) |
| `exportKey` | RSA-OAEP | - | - | Export keys for storage (SPKI/PKCS8) |

### Symmetric Encryption (AES-GCM)

Used for encrypting document content and private keys at rest.

| Operation | Algorithm | Key Size | IV Size | Tag Size | Purpose |
|-----------|-----------|----------|---------|----------|---------|
| `generateKey` | AES-GCM | 256 bits | - | - | Generate content encryption keys |
| `encrypt` | AES-GCM | - | 12 bytes | 128 bits | Encrypt document content |
| `decrypt` | AES-GCM | - | 12 bytes | 128 bits | Decrypt document content |
| `importKey` | AES-GCM | - | - | - | Import raw key material |
| `exportKey` | AES-GCM | - | - | - | Export raw key material |

### Key Derivation (PBKDF2)

Used for deriving encryption keys from user passwords.

| Operation | Algorithm | Hash | Iterations | Purpose |
|-----------|-----------|------|------------|---------|
| `deriveKey` | PBKDF2 | SHA-256 | 310,000 | Derive AES keys from passwords |
| `importKey` | PBKDF2 | - | - | Import password as key material |

### Hashing (SHA-256)

Used for content addressing and username hashing.

| Operation | Algorithm | Purpose |
|-----------|-----------|---------|
| `digest` | SHA-256 | Hash content for addressing |
| `digest` | SHA-256 | Hash usernames for privacy |

### Message Authentication (HMAC-SHA256)

Used for JWT token signing in the authentication service.

| Operation | Algorithm | Purpose |
|-----------|-----------|---------|
| `sign` | HMAC-SHA256 | Sign JWT tokens |
| `verify` | HMAC-SHA256 | Verify JWT tokens |
| `importKey` | HMAC | Import secret key |
| `generateKey` | HMAC | Generate secret key |

### Random Number Generation

| Operation | Purpose |
|-----------|---------|
| `getRandomValues` | Generate cryptographically secure random bytes for IVs, salts, etc. |

## React Native Challenges

The Web Crypto API is not natively available in React Native's JavaScript runtime. This presents a significant challenge for running MindooDB in mobile applications.

### The Problem

React Native uses either Hermes or JavaScriptCore as its JavaScript engine, neither of which includes the Web Crypto API. This means:

- `crypto.subtle` is undefined
- `crypto.getRandomValues` is undefined
- All cryptographic operations fail

## Solution 1: react-native-quick-crypto (Recommended)

For production React Native apps built with native code, [react-native-quick-crypto](https://github.com/margelo/react-native-quick-crypto) provides a near-complete implementation of the Web Crypto API using native C++ code.

### Advantages

- **Native performance**: Cryptographic operations run at native speed
- **Full API compatibility**: Implements the standard Web Crypto API
- **Production-ready**: Well-maintained and widely used

### Requirements

- React Native app with native build capability
- iOS: Requires CocoaPods integration
- Android: Requires native module linking

### Usage

```javascript
import { subtle, getRandomValues } from 'react-native-quick-crypto';

class ReactNativeCryptoAdapter {
  getSubtle() {
    return subtle;
  }

  getRandomValues(array) {
    return getRandomValues(array);
  }
}
```

### Limitations

- **Cannot be used with Expo Go**: Expo Go is a pre-built app that doesn't include native modules
- Requires a development build or ejected Expo app

## Solution 2: JavaScript-Only Implementation (Expo Go)

For development with Expo Go or environments where native modules cannot be used, we've built a pure JavaScript implementation of the required crypto operations.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    ExpoGoCryptoAdapter                       │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              SubtleCryptoPolyfill                    │    │
│  │  ┌─────────────┬─────────────┬─────────────────┐    │    │
│  │  │ Ed25519     │ RSA-OAEP    │ AES-GCM         │    │    │
│  │  │ Adapter     │ Adapter     │ Adapter         │    │    │
│  │  │ (tweetnacl) │ (node-forge)│ (node-forge)    │    │    │
│  │  │             │             │                 │    │    │
│  │  └─────────────┴─────────────┴─────────────────┘    │    │
│  │  ┌─────────────┬─────────────┬─────────────────┐    │    │
│  │  │ PBKDF2      │ SHA-256     │ HMAC            │    │    │
│  │  │ Adapter     │ Adapter     │ Adapter         │    │    │
│  │  │ (node-forge)│ (node-forge)│ (node-forge)    │    │    │
│  │  └─────────────┴─────────────┴─────────────────┘    │    │
│  └─────────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────┐    │
│  │           expo-standard-web-crypto                   │    │
│  │              (getRandomValues)                       │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### Dependencies

All cryptographic libraries are **pure JavaScript** with no native code, ensuring compatibility with Expo Go:

| Library | Purpose | Size | Native Code? |
|---------|---------|------|--------------|
| `tweetnacl` | Ed25519 signatures | ~7 KB | No (pure JS) |
| `node-forge` | RSA, AES, PBKDF2, SHA-256, HMAC | ~200 KB | No (pure JS) |
| `expo-standard-web-crypto` | Secure random number generation | Part of Expo | Uses Expo's built-in secure random |

### Implementation Details

#### Ed25519 (via TweetNaCl)

[TweetNaCl.js](https://tweetnacl.js.org/) is a **pure JavaScript** port of the TweetNaCl/NaCl cryptographic library. Key benefits:

- **Security audited** by [Cure53](https://cure53.de/tweetnacl.pdf) and found to be "bug-free"
- **Pure JavaScript** - no native code, works in Expo Go without issues
- **CommonJS compatible** - works directly with Jest without mocking (unlike `@noble/ed25519` which is ES module only)
- **Lightweight** - only ~7 KB minified and gzipped
- **Real Ed25519** - actual elliptic curve operations, not simplified substitutes

Our adapter handles:

- Key generation using secure random bytes
- ASN.1/DER encoding for SPKI (public key) and PKCS8 (private key) formats
- Signing and verification operations

#### RSA-OAEP (via node-forge)

Node-forge provides RSA-OAEP with SHA-256 support. Our adapter handles:

- Key pair generation (3072-bit modulus)
- PEM format conversion for import/export
- Encryption and decryption with proper padding

#### AES-GCM (via node-forge)

Node-forge's AES-GCM implementation handles:

- 256-bit key encryption/decryption
- 12-byte IV handling
- 128-bit authentication tag (appended to ciphertext, matching Web Crypto behavior)

#### PBKDF2 (via node-forge)

Password-based key derivation with:

- SHA-256 hash function
- 310,000 iterations (matching MindooDB's security requirements)
- Derived key output as CryptoKey-like object

### Usage

```javascript
import { ExpoGoCryptoAdapter } from './expo/crypto';

// The adapter automatically uses JavaScript implementations
const adapter = new ExpoGoCryptoAdapter();

// Use it like any other CryptoAdapter
const subtle = adapter.getSubtle();
const keyPair = await subtle.generateKey(
  { name: 'Ed25519' },
  true,
  ['sign', 'verify']
);
```

### Auto-Detection

The `ReactNativeCryptoAdapter` automatically detects the best available implementation:

```javascript
import { ReactNativeCryptoAdapter, isQuickCryptoAvailable } from './ReactNativeCryptoAdapter';

const adapter = new ReactNativeCryptoAdapter();

// Check which implementation is being used
if (isQuickCryptoAvailable) {
  console.log('Using native crypto (fast)');
} else {
  console.log('Using JavaScript crypto (slower)');
}
```

## Performance Considerations

### Benchmarks (Approximate)

| Operation | Native (quick-crypto) | JavaScript (Expo Go) | Slowdown |
|-----------|----------------------|---------------------|----------|
| Ed25519 key generation | ~1 ms | ~50-100 ms | 50-100x |
| Ed25519 sign | ~1 ms | ~20-50 ms | 20-50x |
| Ed25519 verify | ~1 ms | ~30-60 ms | 30-60x |
| RSA-3072 key generation | ~100-500 ms | ~5-30 s | 10-100x |
| RSA-3072 encrypt | ~5 ms | ~50-200 ms | 10-40x |
| RSA-3072 decrypt | ~50 ms | ~200-500 ms | 4-10x |
| AES-GCM encrypt (1 KB) | ~0.1 ms | ~5-10 ms | 50-100x |
| AES-GCM decrypt (1 KB) | ~0.1 ms | ~5-10 ms | 50-100x |
| PBKDF2 (310k iterations) | ~100-200 ms | ~5-10 s | 25-100x |
| SHA-256 (1 KB) | ~0.01 ms | ~1-2 ms | 100-200x |

*Note: These are rough estimates. Actual performance varies by device, JavaScript engine, and data size.*

### Impact on User Experience

The JavaScript implementation is significantly slower, which affects:

1. **Initial Setup**: Creating a new user or tenant involves RSA key generation and PBKDF2 key derivation, which can take 10-40 seconds on mobile devices.

2. **Login**: PBKDF2 key derivation runs on every login, adding 5-10 seconds of delay.

3. **Document Operations**: Each document write involves signing, and reading involves verification. This adds noticeable latency per operation.

4. **Bulk Operations**: Syncing many documents will be significantly slower.

### Recommendations

| Use Case | Recommended Solution |
|----------|---------------------|
| Production app | Use `react-native-quick-crypto` with a development build |
| Development/prototyping | Expo Go with JavaScript crypto is acceptable |
| Demo/testing | JavaScript implementation works fine |
| Performance-critical | Always use native implementation |

### Optimization Strategies

If using the JavaScript implementation:

1. **Minimize key generation**: Cache generated keys and reuse them
2. **Batch operations**: Group multiple operations to amortize overhead
3. **Show progress**: Display loading indicators during slow operations
4. **Background processing**: Move crypto operations off the main thread where possible

## Security Considerations

### JavaScript Implementation Security

The JavaScript crypto implementation provides the same cryptographic security as the native implementation:

- Same algorithms and key sizes
- Same security guarantees for encryption and signatures
- Cryptographically secure random number generation via Expo

### Caveats

1. **Side-channel attacks**: JavaScript implementations may be more vulnerable to timing attacks compared to constant-time native implementations.

2. **Memory handling**: JavaScript's garbage collection means sensitive key material may persist in memory longer than in native implementations.

3. **Bundle size**: The JavaScript crypto libraries add approximately 200+ KB to your app bundle.

## Testing

Both implementations are covered by comprehensive tests that use **real cryptographic operations** (not mocks):

```bash
# Run all crypto tests
npm test

# Run unit tests only
npm test -- ExpoGoCryptoAdapter.test.ts

# Run integration tests with MindooDB
npm test -- integration.test.ts
```

The test suite covers:

- All cryptographic operations (19 unit tests)
- Integration with MindooDB's `BaseMindooTenantFactory` (5 integration tests)
- Key format conversions (SPKI, PKCS8, PEM, raw)
- Edge cases and error handling

All cryptographic libraries (TweetNaCl for Ed25519, node-forge for RSA/AES/PBKDF2) work directly with Jest, so tests exercise real cryptographic algorithms.

## File Structure

```
expo/
└── crypto/
    ├── index.ts                 # Main exports
    ├── ExpoGoCryptoAdapter.ts   # CryptoAdapter implementation
    ├── SubtleCryptoPolyfill.ts  # SubtleCrypto interface implementation
    ├── Ed25519Adapter.ts        # Ed25519 operations (via TweetNaCl)
    ├── RSAAdapter.ts            # RSA-OAEP operations (via node-forge)
    ├── AESAdapter.ts            # AES-GCM operations (via node-forge)
    ├── PBKDF2Adapter.ts         # PBKDF2 key derivation (via node-forge)
    ├── SHA256Adapter.ts         # SHA-256 hashing (via node-forge)
    ├── HMACAdapter.ts           # HMAC-SHA256 operations (via node-forge)
    ├── KeyFormatConverter.ts    # PEM/DER conversion utilities
    └── __tests__/
        ├── __mocks__/
        │   └── expo-standard-web-crypto.ts  # Mock for getRandomValues in Node.js
        ├── ExpoGoCryptoAdapter.test.ts      # Unit tests
        └── integration.test.ts              # MindooDB integration tests
```

## Summary

MindooDB's crypto requirements can be met in React Native through two approaches:

| Approach | Performance | Complexity | Use Case |
|----------|-------------|------------|----------|
| `react-native-quick-crypto` | Native speed | Requires native build | Production apps |
| `ExpoGoCryptoAdapter` | 10-100x slower | Pure JavaScript | Expo Go development |

For production applications, always use the native implementation. The JavaScript fallback exists to enable rapid development and testing with Expo Go, accepting the performance trade-off for convenience.
