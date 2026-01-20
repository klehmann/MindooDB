import { LogLevel, getDefaultLogLevel } from "./LogLevel";
import { Logger } from "./Logger";

/**
 * MindooDB logger implementation with automatic sanitization and context support.
 */
export class MindooLogger implements Logger {
  private level: LogLevel;
  private context: string;
  private sanitize: boolean;

  constructor(
    level: LogLevel = getDefaultLogLevel(),
    context: string = "",
    sanitize: boolean = true
  ) {
    this.level = level;
    this.context = context;
    this.sanitize = sanitize;
  }

  error(message: string, ...args: any[]): void {
    if (this.isLevelEnabled(LogLevel.ERROR)) {
      // Capture stack trace at call site (where logger.error() was called)
      const callSiteError = typeof window !== "undefined" ? new Error() : undefined;
      this.log(LogLevel.ERROR, message, callSiteError, ...args);
    }
  }

  warn(message: string, ...args: any[]): void {
    if (this.isLevelEnabled(LogLevel.WARN)) {
      // Capture stack trace at call site (where logger.warn() was called)
      const callSiteError = typeof window !== "undefined" ? new Error() : undefined;
      this.log(LogLevel.WARN, message, callSiteError, ...args);
    }
  }

  info(message: string, ...args: any[]): void {
    if (this.isLevelEnabled(LogLevel.INFO)) {
      // Capture stack trace at call site (where logger.info() was called)
      const callSiteError = typeof window !== "undefined" ? new Error() : undefined;
      this.log(LogLevel.INFO, message, callSiteError, ...args);
    }
  }

  debug(message: string, ...args: any[]): void {
    if (this.isLevelEnabled(LogLevel.DEBUG)) {
      // Capture stack trace at call site (where logger.debug() was called)
      const callSiteError = typeof window !== "undefined" ? new Error() : undefined;
      this.log(LogLevel.DEBUG, message, callSiteError, ...args);
    }
  }

  trace(message: string, ...args: any[]): void {
    if (this.isLevelEnabled(LogLevel.TRACE)) {
      // Capture stack trace at call site (where logger.trace() was called)
      const callSiteError = typeof window !== "undefined" ? new Error() : undefined;
      this.log(LogLevel.TRACE, message, callSiteError, ...args);
    }
  }

  isLevelEnabled(level: LogLevel): boolean {
    return level <= this.level;
  }

  createChild(context: string): Logger {
    return new MindooLogger(
      this.level,
      `${this.context}${this.context ? "." : ""}${context}`,
      this.sanitize
    );
  }

  private log(level: LogLevel, message: string, callSiteError: Error | undefined, ...args: any[]): void {
    const prefix = `[${LogLevel[level]}]${this.context ? `[${this.context}]` : ""}`;
    const sanitizedArgs = this.sanitize ? this.sanitizeArgs(args) : args;

    // In browsers, console methods show stack traces pointing to where they're called.
    // By creating an Error in the public methods (error/warn/info/debug/trace) and passing it,
    // browsers will show a stack trace. However, it will still include the wrapper method.
    // A cleaner approach: use console methods directly but format the call to preserve context.
    // For browser environments, we can use the Error's stack to show the actual call site.
    switch (level) {
      case LogLevel.ERROR:
        if (callSiteError && callSiteError.stack) {
          // Extract the actual call site (skip Error constructor and our wrapper methods)
          const stackLines = callSiteError.stack.split("\n");
          // Skip: Error constructor, error() method, log() method - show the actual caller
          const actualCallSite = stackLines[3] || stackLines[2] || stackLines[1];
          if (actualCallSite) {
            console.error(prefix, message, ...sanitizedArgs);
            console.error("  at", actualCallSite.trim());
          } else {
            console.error(prefix, message, ...sanitizedArgs, callSiteError);
          }
        } else {
          console.error(prefix, message, ...sanitizedArgs);
        }
        break;
      case LogLevel.WARN:
        console.warn(prefix, message, ...sanitizedArgs);
        break;
      case LogLevel.INFO:
        console.info(prefix, message, ...sanitizedArgs);
        break;
      case LogLevel.DEBUG:
      case LogLevel.TRACE:
        if (callSiteError && callSiteError.stack) {
          // Extract the actual call site for debug/trace
          const stackLines = callSiteError.stack.split("\n");
          const actualCallSite = stackLines[3] || stackLines[2] || stackLines[1];
          if (actualCallSite) {
            console.debug(prefix, message, ...sanitizedArgs);
            console.debug("  at", actualCallSite.trim());
          } else {
            console.debug(prefix, message, ...sanitizedArgs, callSiteError);
          }
        } else {
          console.debug(prefix, message, ...sanitizedArgs);
        }
        break;
    }
  }

  private sanitizeArgs(args: any[]): any[] {
    return args.map((arg) => {
      // Handle strings
      if (typeof arg === "string") {
        return this.sanitizeString(arg);
      }

      // Handle Error objects (preserve structure, sanitize message and stack)
      if (arg instanceof Error) {
        return this.sanitizeError(arg);
      }

      // Handle objects (shallow sanitization of string values)
      if (arg && typeof arg === "object" && !Array.isArray(arg)) {
        const sanitized: any = {};
        for (const [key, value] of Object.entries(arg)) {
          if (typeof value === "string") {
            sanitized[key] = this.sanitizeString(value);
          } else {
            sanitized[key] = value; // Preserve non-string values
          }
        }
        return sanitized;
      }

      // Handle arrays (sanitize string elements)
      if (Array.isArray(arg)) {
        return arg.map((item) =>
          typeof item === "string" ? this.sanitizeString(item) : item
        );
      }

      return arg;
    });
  }

  private sanitizeString(str: string): string {
    // PEM keys
    if (str.includes("BEGIN") && str.includes("KEY")) {
      return "[REDACTED: Key]";
    }

    // JWT tokens - check if string contains a JWT pattern (header.payload.signature)
    // JWT format: base64url.base64url.base64url (3 parts separated by dots)
    // Base64url uses A-Z, a-z, 0-9, -, _ (no + or /)
    // We check for the pattern anywhere in the string, not just at the start
    // This handles cases where tokens appear in stack traces or other contexts
    if (str.length > 100) {
      // Look for JWT pattern: three base64url-like strings separated by dots
      // Each part should be at least 10 characters (typical JWT parts are longer)
      // Pattern matches: [base64url chars]{10,}.[base64url chars]{10,}.[base64url chars]{10,}
      const jwtPattern = /[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
      if (jwtPattern.test(str)) {
        return "[REDACTED: Token]";
      }
    }

    // Long base64 strings
    if (str.length > 200 && /^[A-Za-z0-9+/=]+$/.test(str)) {
      return "[REDACTED: Encrypted Data]";
    }

    // Passwords (if detected in variable names or patterns)
    // Note: This is conservative - only redact if clearly a password
    if (
      str.length > 0 &&
      str.length < 100 &&
      (/password/i.test(str) || /pwd/i.test(str))
    ) {
      return "[REDACTED: Password]";
    }

    return str;
  }

  /**
   * Sanitize Error objects while preserving stack trace structure.
   * Stack traces are critical for debugging, so we preserve the structure
   * but sanitize any sensitive data within the stack trace lines.
   */
  private sanitizeError(error: Error): Error {
    // Create a new Error object to preserve the Error prototype chain
    // This ensures console.error() and other tools recognize it as an Error
    const sanitizedError = new Error(this.sanitizeString(error.message));
    sanitizedError.name = error.name;

    // Preserve stack trace but sanitize sensitive content within it
    if (error.stack) {
      // Split stack into lines, sanitize each line, then rejoin
      // This preserves the stack trace structure (file paths, line numbers, function names)
      const stackLines = error.stack.split("\n");
      const sanitizedStackLines = stackLines.map((line) => {
        // Sanitize the line content but preserve the structure
        // Stack trace format: "    at FunctionName (file:line:column)"
        // We want to keep file paths and line numbers (useful for debugging)
        // but sanitize any sensitive data that might appear in the line
        return this.sanitizeString(line);
      });
      sanitizedError.stack = sanitizedStackLines.join("\n");
    }

    // Preserve any additional properties that might be on custom Error types
    // (e.g., SymmetricKeyNotFoundError.keyId, NetworkError.type, etc.)
    // but sanitize their values if they're strings
    if (error.constructor !== Error) {
      // This is a custom error type - preserve its type
      Object.setPrototypeOf(sanitizedError, error.constructor.prototype);

      // Copy over additional properties, sanitizing string values
      for (const key in error) {
        if (key !== "name" && key !== "message" && key !== "stack") {
          const value = (error as any)[key];
          if (typeof value === "string") {
            (sanitizedError as any)[key] = this.sanitizeString(value);
          } else {
            (sanitizedError as any)[key] = value;
          }
        }
      }
    }

    return sanitizedError;
  }
}
