/**
 * Log levels for the MindooDB logger system.
 * Lower numbers indicate higher severity.
 */
export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
  TRACE = 4,
}

/**
 * Parse a log level string to LogLevel enum.
 * Supports: error, warn, info, debug, trace (case-insensitive)
 */
export function parseLogLevel(level: string): LogLevel {
  const normalized = level.toLowerCase().trim();
  switch (normalized) {
    case "error":
      return LogLevel.ERROR;
    case "warn":
      return LogLevel.WARN;
    case "info":
      return LogLevel.INFO;
    case "debug":
      return LogLevel.DEBUG;
    case "trace":
      return LogLevel.TRACE;
    default:
      return LogLevel.INFO; // Default to INFO if invalid
  }
}

/**
 * Get the default log level from environment variable (Node.js) or localStorage (browser) or return INFO.
 */
export function getDefaultLogLevel(): LogLevel {
  // Node.js: Check process.env
  if (typeof process !== "undefined" && process.env && process.env.MINDOO_LOG_LEVEL) {
    return parseLogLevel(process.env.MINDOO_LOG_LEVEL);
  }
  
  // Browser: Check localStorage
  if (typeof window !== "undefined" && window.localStorage) {
    const storedLevel = window.localStorage.getItem("MINDOO_LOG_LEVEL");
    if (storedLevel) {
      return parseLogLevel(storedLevel);
    }
  }
  
  return LogLevel.INFO;
}
