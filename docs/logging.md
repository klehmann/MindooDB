# Logging System

MindooDB includes a comprehensive logging system designed for security, debugging, and production monitoring. The logger provides structured logging with automatic sanitization of sensitive data, hierarchical context, and configurable log levels.

## Overview

The logging system consists of:

- **Log Levels**: Five levels (ERROR, WARN, INFO, DEBUG, TRACE) to control verbosity
- **Automatic Sanitization**: Redacts sensitive data (keys, tokens, passwords) from log output
- **Context Hierarchy**: Child loggers provide contextual information (e.g., `Tenant:abc123.BaseMindooDB`)
- **Stack Trace Preservation**: Error stack traces are preserved while sanitizing sensitive content

## Log Levels

The logging system supports five log levels, ordered by severity:

| Level | Value | Description | Use Case |
|-------|-------|-------------|----------|
| **ERROR** | 0 | Critical errors that require attention | Production monitoring |
| **WARN** | 1 | Warning messages for potential issues | Production monitoring |
| **INFO** | 2 | General informational messages | Default level, production use |
| **DEBUG** | 3 | Detailed debugging information | Development and troubleshooting |
| **TRACE** | 4 | Very verbose tracing information | Deep debugging |

When a log level is set, all messages at that level and below are displayed. For example, setting `INFO` will show ERROR, WARN, and INFO messages, but not DEBUG or TRACE.

## Configuration

### Node.js Environment

In Node.js, configure the log level using the `MINDOO_LOG_LEVEL` environment variable:

```bash
# Set log level via environment variable
export MINDOO_LOG_LEVEL=DEBUG

# Or inline with your command
MINDOO_LOG_LEVEL=DEBUG node your-app.js

# In package.json scripts
{
  "scripts": {
    "dev": "MINDOO_LOG_LEVEL=DEBUG node src/index.js",
    "start": "MINDOO_LOG_LEVEL=INFO node src/index.js"
  }
}
```

**Supported values**: `ERROR`, `WARN`, `INFO`, `DEBUG`, `TRACE` (case-insensitive)

**Default**: `INFO` (if not set)

### Browser Environment

In browser environments, configure the log level using one of these methods:

#### Option 1: localStorage (Recommended)

Set the log level in browser localStorage before initializing MindooDB:

```javascript
// Set log level before creating tenant factory
localStorage.setItem('MINDOO_LOG_LEVEL', 'DEBUG');

// Now initialize MindooDB
const factory = new BaseMindooTenantFactory(storeFactory, cryptoAdapter);
```

**Note**: The logging system does not read URL parameters for security reasons. Setting log levels via URL parameters would be a security risk, as attackers could enable verbose logging by tricking users into visiting malicious URLs. Always use localStorage or programmatic configuration instead.

#### Option 2: Programmatic Configuration

For more control, you can create a custom logger and pass it to the factory:

```typescript
import { MindooLogger, LogLevel } from '@mindoodb/core';

// Create a logger with specific level
const logger = new MindooLogger(LogLevel.DEBUG, 'MyApp', true);

// Pass it to the factory
const factory = new BaseMindooTenantFactory(
  storeFactory,
  cryptoAdapter,
  logger
);
```

### Environment Detection

The logger automatically detects the environment:

- **Node.js**: Reads from `process.env.MINDOO_LOG_LEVEL`
- **Browser**: Reads from `localStorage.getItem('MINDOO_LOG_LEVEL')` or falls back to default

## Automatic Sanitization

The logger automatically redacts sensitive information from log output to prevent accidental exposure:

### What Gets Sanitized

1. **PEM Keys**: Any string containing `BEGIN` and `KEY` (e.g., `-----BEGIN PRIVATE KEY-----`)
   - Redacted as: `[REDACTED: Key]`

2. **JWT Tokens**: Long strings (>100 chars) matching JWT pattern (`xxx.yyy.zzz`)
   - Redacted as: `[REDACTED: Token]`

3. **Base64 Encrypted Data**: Long base64 strings (>200 chars)
   - Redacted as: `[REDACTED: Encrypted Data]`

4. **Passwords**: Short strings (<100 chars) containing "password" or "pwd"
   - Redacted as: `[REDACTED: Password]`

### Stack Trace Preservation

Error stack traces are **preserved** for debugging purposes. The logger sanitizes sensitive content within stack traces while maintaining:
- File paths and line numbers
- Function names
- Call stack structure

Example:

```typescript
try {
  // Some operation that might log sensitive data
} catch (error) {
  logger.error('Operation failed', error);
  // Stack trace is preserved, but sensitive strings in the error message are sanitized
}
```

## Context Hierarchy

The logger supports hierarchical context for better traceability:

```
MindooTenantFactory
  └── Tenant:abc123
      ├── Directory
      └── BaseMindooDB:my-db
          └── RSAEncryption
```

Each component creates child loggers with additional context:

```typescript
// In BaseMindooTenantFactory
const tenantLogger = this.logger.createChild(`Tenant:${tenantId}`);

// In BaseMindooTenant
const dbLogger = this.logger.createChild(`BaseMindooDB:${dbId}`);
```

Log messages include the full context path:

```
[INFO][MindooTenantFactory.Tenant:abc123.BaseMindooDB:my-db] Database opened successfully
```

## Usage Examples

### Basic Usage

The logger is automatically integrated into MindooDB components. You typically don't need to use it directly:

```typescript
import { BaseMindooTenantFactory } from '@mindoodb/core';

// Logger is created automatically with default level (INFO)
const factory = new BaseMindooTenantFactory(storeFactory, cryptoAdapter);

// All internal logging uses the logger
const tenant = await factory.openTenant(tenantId, adminSigningPublicKey, adminEncryptionPublicKey, currentUser, currentUserPassword, keyBag);
```

### Custom Logger

For advanced use cases, you can provide a custom logger:

```typescript
import { MindooLogger, LogLevel } from '@mindoodb/core';

// Create logger with DEBUG level and custom context
const logger = new MindooLogger(
  LogLevel.DEBUG,
  'MyApplication',
  true // Enable sanitization
);

const factory = new BaseMindooTenantFactory(
  storeFactory,
  cryptoAdapter,
  logger
);
```

### Disabling Sanitization (Development Only)

⚠️ **Warning**: Only disable sanitization in secure development environments.

```typescript
const logger = new MindooLogger(
  LogLevel.DEBUG,
  'DevLogger',
  false // Disable sanitization - USE WITH CAUTION
);
```

## Log Output Format

Log messages follow this format:

```
[LEVEL][Context] Message [additional args...]
```

Example outputs:

```
[ERROR][MindooTenantFactory] Failed to create tenant: [REDACTED: Key]
[WARN][Tenant:abc123] Public key not trusted: [REDACTED: Key]
[INFO][Tenant:abc123.BaseMindooDB:my-db] Database opened successfully
[DEBUG][Tenant:abc123] Signing payload
[TRACE][RSAEncryption] Encrypting with RSA key
```

## Best Practices

1. **Production**: Use `INFO` or `WARN` level to reduce noise
2. **Development**: Use `DEBUG` level for detailed troubleshooting
3. **Troubleshooting**: Temporarily set `TRACE` level to diagnose issues
4. **Never disable sanitization in production**: Always keep sanitization enabled
5. **Use context**: Let the hierarchical context help you trace log messages to their source

## Troubleshooting

### Logs Not Appearing

1. **Check log level**: Ensure your level is set low enough (e.g., DEBUG shows DEBUG, INFO, WARN, ERROR)
2. **Browser localStorage**: Verify `localStorage.getItem('MINDOO_LOG_LEVEL')` returns the expected value
3. **Node.js environment**: Verify `process.env.MINDOO_LOG_LEVEL` is set correctly

### Too Many Logs

1. **Increase log level**: Set to `WARN` or `ERROR` to reduce verbosity
2. **Production defaults**: Use `INFO` as the default for production environments

### Sensitive Data in Logs

1. **Verify sanitization is enabled**: Check that logger was created with `sanitize: true` (default)
2. **Report issues**: If sensitive data appears in logs, report it as a security issue
3. **Custom sanitization**: Extend `MindooLogger` to add custom sanitization rules

## Implementation Details

The logging system is implemented in:

- `src/core/logging/LogLevel.ts` - Log level enum and parsing
- `src/core/logging/Logger.ts` - Logger interface
- `src/core/logging/MindooLogger.ts` - Logger implementation
- `src/core/logging/index.ts` - Public exports

All MindooDB components use the logger through dependency injection, ensuring consistent logging behavior across the codebase.
