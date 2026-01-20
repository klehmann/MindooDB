import { LogLevel } from "./LogLevel";

/**
 * Logger interface for MindooDB logging system.
 * Provides structured logging with log levels, context, and sanitization.
 */
export interface Logger {
  /**
   * Log an error message.
   */
  error(message: string, ...args: any[]): void;

  /**
   * Log a warning message.
   */
  warn(message: string, ...args: any[]): void;

  /**
   * Log an informational message.
   */
  info(message: string, ...args: any[]): void;

  /**
   * Log a debug message (verbose).
   */
  debug(message: string, ...args: any[]): void;

  /**
   * Log a trace message (most verbose).
   */
  trace(message: string, ...args: any[]): void;

  /**
   * Check if a log level is enabled.
   */
  isLevelEnabled(level: LogLevel): boolean;

  /**
   * Create a child logger with additional context.
   * Useful for hierarchical logging (e.g., "Tenant:abc123.BaseMindooDB").
   */
  createChild(context: string): Logger;
}
