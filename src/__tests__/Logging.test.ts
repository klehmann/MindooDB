import { LogLevel, parseLogLevel, getDefaultLogLevel } from "../core/logging/LogLevel";
import { MindooLogger } from "../core/logging/MindooLogger";

describe("Logging System", () => {
  // Store original console methods
  const originalConsole = {
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug,
  };

  // Mock console methods to capture output
  let consoleOutput: { level: string; args: any[] }[] = [];

  beforeEach(() => {
    consoleOutput = [];
    console.error = (...args: any[]) => {
      consoleOutput.push({ level: "error", args });
    };
    console.warn = (...args: any[]) => {
      consoleOutput.push({ level: "warn", args });
    };
    console.info = (...args: any[]) => {
      consoleOutput.push({ level: "info", args });
    };
    console.debug = (...args: any[]) => {
      consoleOutput.push({ level: "debug", args });
    };
  });

  afterEach(() => {
    // Restore original console methods
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
    console.info = originalConsole.info;
    console.debug = originalConsole.debug;
  });

  describe("LogLevel", () => {
    it("should have correct enum values", () => {
      expect(LogLevel.ERROR).toBe(0);
      expect(LogLevel.WARN).toBe(1);
      expect(LogLevel.INFO).toBe(2);
      expect(LogLevel.DEBUG).toBe(3);
      expect(LogLevel.TRACE).toBe(4);
    });
  });

  describe("parseLogLevel", () => {
    it("should parse valid log levels (lowercase)", () => {
      expect(parseLogLevel("error")).toBe(LogLevel.ERROR);
      expect(parseLogLevel("warn")).toBe(LogLevel.WARN);
      expect(parseLogLevel("info")).toBe(LogLevel.INFO);
      expect(parseLogLevel("debug")).toBe(LogLevel.DEBUG);
      expect(parseLogLevel("trace")).toBe(LogLevel.TRACE);
    });

    it("should parse valid log levels (uppercase)", () => {
      expect(parseLogLevel("ERROR")).toBe(LogLevel.ERROR);
      expect(parseLogLevel("WARN")).toBe(LogLevel.WARN);
      expect(parseLogLevel("INFO")).toBe(LogLevel.INFO);
      expect(parseLogLevel("DEBUG")).toBe(LogLevel.DEBUG);
      expect(parseLogLevel("TRACE")).toBe(LogLevel.TRACE);
    });

    it("should parse valid log levels (mixed case)", () => {
      expect(parseLogLevel("Error")).toBe(LogLevel.ERROR);
      expect(parseLogLevel("WaRn")).toBe(LogLevel.WARN);
      expect(parseLogLevel("InFo")).toBe(LogLevel.INFO);
    });

    it("should trim whitespace", () => {
      expect(parseLogLevel("  error  ")).toBe(LogLevel.ERROR);
      expect(parseLogLevel("\tdebug\n")).toBe(LogLevel.DEBUG);
    });

    it("should default to INFO for invalid levels", () => {
      expect(parseLogLevel("invalid")).toBe(LogLevel.INFO);
      expect(parseLogLevel("")).toBe(LogLevel.INFO);
      expect(parseLogLevel("unknown")).toBe(LogLevel.INFO);
    });
  });

  describe("getDefaultLogLevel", () => {
    const originalEnv = process.env.MINDOO_LOG_LEVEL;
    const originalLocalStorage = (global as any).window?.localStorage;

    afterEach(() => {
      // Restore original environment
      if (originalEnv !== undefined) {
        process.env.MINDOO_LOG_LEVEL = originalEnv;
      } else {
        delete process.env.MINDOO_LOG_LEVEL;
      }

      // Restore localStorage mock
      if (originalLocalStorage) {
        (global as any).window.localStorage = originalLocalStorage;
      } else {
        delete (global as any).window;
      }
    });

    it("should read from process.env in Node.js", () => {
      process.env.MINDOO_LOG_LEVEL = "DEBUG";
      expect(getDefaultLogLevel()).toBe(LogLevel.DEBUG);
    });

    it("should read from localStorage in browser", () => {
      // Mock window and localStorage
      let getItemCallCount = 0;
      const mockLocalStorage = {
        getItem: (key: string) => {
          getItemCallCount++;
          if (key === "MINDOO_LOG_LEVEL") return "TRACE";
          return null;
        },
      };
      (global as any).window = { localStorage: mockLocalStorage };

      // Clear process.env to simulate browser
      delete process.env.MINDOO_LOG_LEVEL;

      expect(getDefaultLogLevel()).toBe(LogLevel.TRACE);
      expect(getItemCallCount).toBeGreaterThan(0);
    });

    it("should prefer process.env over localStorage", () => {
      process.env.MINDOO_LOG_LEVEL = "WARN";
      const mockLocalStorage = {
        getItem: () => "DEBUG",
      };
      (global as any).window = { localStorage: mockLocalStorage };

      expect(getDefaultLogLevel()).toBe(LogLevel.WARN);
    });

    it("should default to INFO when neither is set", () => {
      delete process.env.MINDOO_LOG_LEVEL;
      delete (global as any).window;
      expect(getDefaultLogLevel()).toBe(LogLevel.INFO);
    });
  });

  describe("MindooLogger - Log Level Filtering", () => {
    it("should log ERROR messages at ERROR level", () => {
      const logger = new MindooLogger(LogLevel.ERROR, "", true);
      logger.error("Test error");
      expect(consoleOutput.length).toBe(1);
      expect(consoleOutput[0].level).toBe("error");
    });

    it("should not log WARN messages when level is ERROR", () => {
      const logger = new MindooLogger(LogLevel.ERROR, "", true);
      logger.warn("Test warn");
      logger.info("Test info");
      logger.debug("Test debug");
      logger.trace("Test trace");
      expect(consoleOutput.length).toBe(0);
    });

    it("should log ERROR and WARN messages at WARN level", () => {
      const logger = new MindooLogger(LogLevel.WARN, "", true);
      logger.error("Test error");
      logger.warn("Test warn");
      logger.info("Test info");
      expect(consoleOutput.length).toBe(2);
      expect(consoleOutput[0].level).toBe("error");
      expect(consoleOutput[1].level).toBe("warn");
    });

    it("should log all levels at TRACE level", () => {
      const logger = new MindooLogger(LogLevel.TRACE, "", true);
      logger.error("Test error");
      logger.warn("Test warn");
      logger.info("Test info");
      logger.debug("Test debug");
      logger.trace("Test trace");
      expect(consoleOutput.length).toBe(5);
    });

    it("should use correct console methods", () => {
      const logger = new MindooLogger(LogLevel.TRACE, "", true);
      logger.error("error");
      logger.warn("warn");
      logger.info("info");
      logger.debug("debug");
      logger.trace("trace");
      
      expect(consoleOutput[0].level).toBe("error");
      expect(consoleOutput[1].level).toBe("warn");
      expect(consoleOutput[2].level).toBe("info");
      expect(consoleOutput[3].level).toBe("debug");
      expect(consoleOutput[4].level).toBe("debug"); // TRACE uses console.debug
    });
  });

  describe("MindooLogger - Context", () => {
    it("should include context in log prefix", () => {
      const logger = new MindooLogger(LogLevel.INFO, "TestContext", true);
      logger.info("Test message");
      expect(consoleOutput.length).toBe(1);
      const prefix = consoleOutput[0].args[0];
      expect(prefix).toContain("[TestContext]");
    });

    it("should create child logger with extended context", () => {
      const parentLogger = new MindooLogger(LogLevel.INFO, "Parent", true);
      const childLogger = parentLogger.createChild("Child");
      childLogger.info("Test message");
      
      expect(consoleOutput.length).toBe(1);
      const prefix = consoleOutput[0].args[0];
      expect(prefix).toContain("[Parent.Child]");
    });

    it("should handle nested child loggers", () => {
      const rootLogger = new MindooLogger(LogLevel.INFO, "Root", true);
      const level1Logger = rootLogger.createChild("Level1");
      const level2Logger = level1Logger.createChild("Level2");
      level2Logger.info("Test message");
      
      expect(consoleOutput.length).toBe(1);
      const prefix = consoleOutput[0].args[0];
      expect(prefix).toContain("[Root.Level1.Level2]");
    });

    it("should handle empty context", () => {
      const logger = new MindooLogger(LogLevel.INFO, "", true);
      logger.info("Test message");
      expect(consoleOutput.length).toBe(1);
      const prefix = consoleOutput[0].args[0];
      expect(prefix).not.toContain("[]");
    });
  });

  describe("MindooLogger - Sanitization", () => {
    it("should sanitize PEM keys", () => {
      const logger = new MindooLogger(LogLevel.INFO, "", true);
      const pemKey = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...\n-----END PRIVATE KEY-----";
      logger.info("Key:", pemKey);
      
      expect(consoleOutput.length).toBe(1);
      const sanitizedArg = consoleOutput[0].args[2];
      expect(sanitizedArg).toBe("[REDACTED: Key]");
    });

    it("should sanitize JWT tokens", () => {
      const logger = new MindooLogger(LogLevel.INFO, "", true);
      const jwtToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      logger.info("Token:", jwtToken);
      
      expect(consoleOutput.length).toBe(1);
      const sanitizedArg = consoleOutput[0].args[2];
      expect(sanitizedArg).toBe("[REDACTED: Token]");
    });

    it("should sanitize long base64 strings", () => {
      const logger = new MindooLogger(LogLevel.INFO, "", true);
      const base64Data = "a".repeat(250); // Long base64-like string
      logger.info("Data:", base64Data);
      
      expect(consoleOutput.length).toBe(1);
      const sanitizedArg = consoleOutput[0].args[2];
      expect(sanitizedArg).toBe("[REDACTED: Encrypted Data]");
    });

    it("should sanitize passwords in strings", () => {
      const logger = new MindooLogger(LogLevel.INFO, "", true);
      logger.info("Password:", "mypassword123");
      logger.info("PWD:", "secretpwd");
      
      expect(consoleOutput.length).toBe(2);
      expect(consoleOutput[0].args[2]).toBe("[REDACTED: Password]");
      expect(consoleOutput[1].args[2]).toBe("[REDACTED: Password]");
    });

    it("should not sanitize normal strings", () => {
      const logger = new MindooLogger(LogLevel.INFO, "", true);
      const normalString = "This is a normal log message";
      logger.info("Message:", normalString);
      
      expect(consoleOutput.length).toBe(1);
      const sanitizedArg = consoleOutput[0].args[2];
      expect(sanitizedArg).toBe(normalString);
    });

    it("should sanitize strings in objects", () => {
      const logger = new MindooLogger(LogLevel.INFO, "", true);
      const obj = {
        key: "-----BEGIN PRIVATE KEY-----",
        normal: "normal value",
        number: 42,
      };
      logger.info("Object:", obj);
      
      expect(consoleOutput.length).toBe(1);
      const sanitizedObj = consoleOutput[0].args[2];
      expect(sanitizedObj.key).toBe("[REDACTED: Key]");
      expect(sanitizedObj.normal).toBe("normal value");
      expect(sanitizedObj.number).toBe(42);
    });

    it("should sanitize strings in arrays", () => {
      const logger = new MindooLogger(LogLevel.INFO, "", true);
      const arr = ["normal", "-----BEGIN PRIVATE KEY-----", "another"];
      logger.info("Array:", arr);
      
      expect(consoleOutput.length).toBe(1);
      const sanitizedArr = consoleOutput[0].args[2];
      expect(sanitizedArr[0]).toBe("normal");
      expect(sanitizedArr[1]).toBe("[REDACTED: Key]");
      expect(sanitizedArr[2]).toBe("another");
    });

    it("should preserve non-string values", () => {
      const logger = new MindooLogger(LogLevel.INFO, "", true);
      const obj = {
        number: 42,
        boolean: true,
        nullValue: null,
        undefinedValue: undefined,
        array: [1, 2, 3],
      };
      logger.info("Object:", obj);
      
      expect(consoleOutput.length).toBe(1);
      const sanitizedObj = consoleOutput[0].args[2];
      expect(sanitizedObj.number).toBe(42);
      expect(sanitizedObj.boolean).toBe(true);
      expect(sanitizedObj.nullValue).toBe(null);
      expect(sanitizedObj.undefinedValue).toBe(undefined);
      expect(sanitizedObj.array).toEqual([1, 2, 3]);
    });

    it("should allow disabling sanitization", () => {
      const logger = new MindooLogger(LogLevel.INFO, "", false);
      const pemKey = "-----BEGIN PRIVATE KEY-----";
      logger.info("Key:", pemKey);
      
      expect(consoleOutput.length).toBe(1);
      const arg = consoleOutput[0].args[2];
      expect(arg).toBe(pemKey); // Not sanitized
    });
  });

  describe("MindooLogger - Error Sanitization", () => {
    it("should preserve Error structure", () => {
      const logger = new MindooLogger(LogLevel.ERROR, "", true);
      const error = new Error("Test error message");
      logger.error("Error occurred:", error);
      
      expect(consoleOutput.length).toBe(1);
      const sanitizedError = consoleOutput[0].args[2];
      expect(sanitizedError).toBeInstanceOf(Error);
      expect(sanitizedError.name).toBe("Error");
    });

    it("should sanitize sensitive data in error messages", () => {
      const logger = new MindooLogger(LogLevel.ERROR, "", true);
      const error = new Error("Key: -----BEGIN PRIVATE KEY-----");
      logger.error("Error:", error);
      
      expect(consoleOutput.length).toBe(1);
      const sanitizedError = consoleOutput[0].args[2];
      expect(sanitizedError.message).toContain("[REDACTED: Key]");
      expect(sanitizedError.message).not.toContain("BEGIN PRIVATE KEY");
    });

    it("should preserve stack trace structure", () => {
      const logger = new MindooLogger(LogLevel.ERROR, "", true);
      const error = new Error("Test error");
      error.stack = "Error: Test error\n    at testFunction (test.ts:10:5)\n    at runTest (test.ts:20:10)";
      logger.error("Error:", error);
      
      expect(consoleOutput.length).toBe(1);
      const sanitizedError = consoleOutput[0].args[2];
      expect(sanitizedError.stack).toBeDefined();
      expect(sanitizedError.stack).toContain("at testFunction");
      expect(sanitizedError.stack).toContain("at runTest");
    });

    it("should sanitize sensitive data in stack traces", () => {
      const logger = new MindooLogger(LogLevel.ERROR, "", true);
      const error = new Error("Test error");
      // Use a full JWT token (header.payload.signature) to test sanitization
      const jwtToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      error.stack = `Error: Test error\n    at testFunction (test.ts:10:5)\n    Token: ${jwtToken}`;
      logger.error("Error:", error);
      
      expect(consoleOutput.length).toBe(1);
      const sanitizedError = consoleOutput[0].args[2];
      expect(sanitizedError.stack).toContain("[REDACTED: Token]");
      expect(sanitizedError.stack).not.toContain(jwtToken);
    });

    it("should preserve custom error properties", () => {
      class CustomError extends Error {
        constructor(message: string, public code: number, public keyId: string) {
          super(message);
          this.name = "CustomError";
        }
      }

      const logger = new MindooLogger(LogLevel.ERROR, "", true);
      const error = new CustomError("Custom error", 404, "-----BEGIN PRIVATE KEY-----");
      logger.error("Error:", error);
      
      expect(consoleOutput.length).toBe(1);
      const sanitizedError = consoleOutput[0].args[2];
      expect(sanitizedError).toBeInstanceOf(CustomError);
      expect(sanitizedError.name).toBe("CustomError");
      expect(sanitizedError.code).toBe(404);
      expect(sanitizedError.keyId).toBe("[REDACTED: Key]");
    });
  });

  describe("MindooLogger - isLevelEnabled", () => {
    it("should return true for levels at or below current level", () => {
      const logger = new MindooLogger(LogLevel.INFO, "", true);
      expect(logger.isLevelEnabled(LogLevel.ERROR)).toBe(true);
      expect(logger.isLevelEnabled(LogLevel.WARN)).toBe(true);
      expect(logger.isLevelEnabled(LogLevel.INFO)).toBe(true);
      expect(logger.isLevelEnabled(LogLevel.DEBUG)).toBe(false);
      expect(logger.isLevelEnabled(LogLevel.TRACE)).toBe(false);
    });

    it("should return true for all levels at TRACE", () => {
      const logger = new MindooLogger(LogLevel.TRACE, "", true);
      expect(logger.isLevelEnabled(LogLevel.ERROR)).toBe(true);
      expect(logger.isLevelEnabled(LogLevel.WARN)).toBe(true);
      expect(logger.isLevelEnabled(LogLevel.INFO)).toBe(true);
      expect(logger.isLevelEnabled(LogLevel.DEBUG)).toBe(true);
      expect(logger.isLevelEnabled(LogLevel.TRACE)).toBe(true);
    });

    it("should return false for all levels above ERROR at ERROR level", () => {
      const logger = new MindooLogger(LogLevel.ERROR, "", true);
      expect(logger.isLevelEnabled(LogLevel.ERROR)).toBe(true);
      expect(logger.isLevelEnabled(LogLevel.WARN)).toBe(false);
      expect(logger.isLevelEnabled(LogLevel.INFO)).toBe(false);
      expect(logger.isLevelEnabled(LogLevel.DEBUG)).toBe(false);
      expect(logger.isLevelEnabled(LogLevel.TRACE)).toBe(false);
    });
  });

  describe("MindooLogger - Integration", () => {
    it("should handle multiple arguments", () => {
      const logger = new MindooLogger(LogLevel.INFO, "", true);
      logger.info("Message", "arg1", 42, { key: "value" });
      
      expect(consoleOutput.length).toBe(1);
      expect(consoleOutput[0].args.length).toBeGreaterThan(1);
    });

    it("should handle empty messages", () => {
      const logger = new MindooLogger(LogLevel.INFO, "", true);
      logger.info("");
      expect(consoleOutput.length).toBe(1);
    });

    it("should maintain log level in child loggers", () => {
      const parentLogger = new MindooLogger(LogLevel.WARN, "Parent", true);
      const childLogger = parentLogger.createChild("Child");
      
      childLogger.info("Should not log");
      childLogger.warn("Should log");
      
      expect(consoleOutput.length).toBe(1);
      expect(consoleOutput[0].level).toBe("warn");
    });

    it("should maintain sanitization setting in child loggers", () => {
      const parentLogger = new MindooLogger(LogLevel.INFO, "Parent", true);
      const childLogger = parentLogger.createChild("Child");
      
      childLogger.info("Key:", "-----BEGIN PRIVATE KEY-----");
      
      expect(consoleOutput.length).toBe(1);
      const sanitizedArg = consoleOutput[0].args[2];
      expect(sanitizedArg).toBe("[REDACTED: Key]");
    });
  });

  describe("MindooLogger - Stack Trace Call Site", () => {
    // Helper function to call logger from - this simulates a real call site
    function callLoggerFromHelper(logger: MindooLogger, message: string) {
      logger.error(message);
    }

    // Another helper for debug
    function callDebugFromHelper(logger: MindooLogger, message: string) {
      logger.debug(message);
    }

    it("should show actual call site in stack trace for ERROR level (browser)", () => {
      // Mock window to simulate browser environment
      const originalWindow = (global as any).window;
      (global as any).window = {};

      try {
        const logger = new MindooLogger(LogLevel.ERROR, "", true);
        
        // Call logger from a helper function to simulate real usage
        callLoggerFromHelper(logger, "Test error message");
        
        expect(consoleOutput.length).toBeGreaterThanOrEqual(1);
        
        // Check that we got the error message
        const firstCall = consoleOutput[0];
        expect(firstCall.level).toBe("error");
        expect(firstCall.args[1]).toBe("Test error message");
        
        // If stack trace was extracted, there should be a second console.error call with "  at"
        // Or the Error object should be in the args
        if (consoleOutput.length > 1) {
          const secondCall = consoleOutput[1];
          expect(secondCall.level).toBe("error");
          // Should contain "at" indicating stack trace
          const hasStackTrace = secondCall.args.some((arg: any) => 
            typeof arg === "string" && arg.includes("at")
          );
          expect(hasStackTrace).toBe(true);
        } else {
          // Or Error object might be passed directly
          const hasError = firstCall.args.some((arg: any) => arg instanceof Error);
          expect(hasError).toBe(true);
        }
      } finally {
        // Restore window
        if (originalWindow) {
          (global as any).window = originalWindow;
        } else {
          delete (global as any).window;
        }
      }
    });

    it("should show actual call site in stack trace for DEBUG level (browser)", () => {
      // Mock window to simulate browser environment
      const originalWindow = (global as any).window;
      (global as any).window = {};

      try {
        const logger = new MindooLogger(LogLevel.DEBUG, "", true);
        
        // Call logger from a helper function to simulate real usage
        callDebugFromHelper(logger, "Test debug message");
        
        expect(consoleOutput.length).toBeGreaterThanOrEqual(1);
        
        // Check that we got the debug message
        const firstCall = consoleOutput[0];
        expect(firstCall.level).toBe("debug");
        expect(firstCall.args[1]).toBe("Test debug message");
        
        // If stack trace was extracted, there should be a second console.debug call with "  at"
        if (consoleOutput.length > 1) {
          const secondCall = consoleOutput[1];
          expect(secondCall.level).toBe("debug");
          // Should contain "at" indicating stack trace
          const hasStackTrace = secondCall.args.some((arg: any) => 
            typeof arg === "string" && arg.includes("at")
          );
          expect(hasStackTrace).toBe(true);
        }
      } finally {
        // Restore window
        if (originalWindow) {
          (global as any).window = originalWindow;
        } else {
          delete (global as any).window;
        }
      }
    });

    it("should not include MindooLogger.log in extracted stack trace", () => {
      // Mock window to simulate browser environment
      const originalWindow = (global as any).window;
      (global as any).window = {};

      try {
        const logger = new MindooLogger(LogLevel.ERROR, "", true);
        logger.error("Test message");
        
        // Collect all console output as strings
        const allOutput = consoleOutput.flatMap(call => 
          call.args.map((arg: any) => {
            if (typeof arg === "string") return arg;
            if (arg instanceof Error && arg.stack) return arg.stack;
            return String(arg);
          })
        ).join(" ");
        
        // The stack trace should NOT contain "MindooLogger.log" (the internal method)
        // It should contain the test function name or test file
        expect(allOutput).not.toContain("MindooLogger.log");
        
        // Should contain "at" indicating a stack trace was shown
        expect(allOutput).toContain("at");
      } finally {
        // Restore window
        if (originalWindow) {
          (global as any).window = originalWindow;
        } else {
          delete (global as any).window;
        }
      }
    });

    it("should work normally in Node.js environment (no window)", () => {
      // Ensure window is not defined (Node.js environment)
      const originalWindow = (global as any).window;
      delete (global as any).window;

      try {
        const logger = new MindooLogger(LogLevel.ERROR, "", true);
        logger.error("Test error");
        
        // In Node.js, should work normally without stack trace extraction
        expect(consoleOutput.length).toBe(1);
        expect(consoleOutput[0].level).toBe("error");
        expect(consoleOutput[0].args[1]).toBe("Test error");
      } finally {
        // Restore window if it existed
        if (originalWindow) {
          (global as any).window = originalWindow;
        }
      }
    });
  });
});
