import {
  getDatabaseIdValidationError,
  getNewDatabaseIdValidationError,
  isValidNewDatabaseId,
  validateNewDatabaseId,
} from "../core/databaseIdValidation";

/**
 * Two rules, deliberately different in strictness (see `databaseIdValidation.ts`):
 * opening accepts what earlier versions allowed, creating is lowercase-only and
 * avoids names a Windows file system rejects.
 */
describe("database id validation", () => {
  describe("opening (lax, backwards compatible)", () => {
    it.each(["directory", "teacher_core", "test-db", "test.database", "TestDatabase", "0190abc"])(
      "accepts %j",
      (id) => {
        expect(getDatabaseIdValidationError(id)).toBeNull();
      },
    );

    it("still rejects ids outside the character set", () => {
      expect(getDatabaseIdValidationError("has space")).not.toBeNull();
      expect(getDatabaseIdValidationError("_leading")).not.toBeNull();
      expect(getDatabaseIdValidationError("")).not.toBeNull();
      expect(getDatabaseIdValidationError("a".repeat(65))).not.toBeNull();
    });
  });

  describe("creating (lowercase, Windows-safe)", () => {
    it.each(["directory", "teacher_core", "test-db", "test.database", "0190abc"])(
      "accepts %j",
      (id) => {
        expect(getNewDatabaseIdValidationError(id)).toBeNull();
        expect(isValidNewDatabaseId(id)).toBe(true);
      },
    );

    it("rejects uppercase, because the id becomes a directory name", () => {
      const error = getNewDatabaseIdValidationError("Sales");
      expect(error).toContain("lowercase");
      expect(isValidNewDatabaseId("Sales")).toBe(false);
      // The lax rule still lets an existing database of that name be opened.
      expect(getDatabaseIdValidationError("Sales")).toBeNull();
    });

    it.each(["con", "prn", "aux", "nul", "com1", "com9", "lpt1", "lpt9"])(
      "rejects the Windows device name %j",
      (id) => {
        expect(getNewDatabaseIdValidationError(id)).toContain("reserved");
      },
    );

    it("rejects a reserved device name that carries an extension", () => {
      // Windows reserves `nul` in every extension, not just bare.
      expect(getNewDatabaseIdValidationError("nul.docs")).toContain("reserved");
      // A reserved name as a mere prefix is fine.
      expect(getNewDatabaseIdValidationError("console")).toBeNull();
      expect(getNewDatabaseIdValidationError("com10")).toBeNull();
    });

    it("rejects a trailing dot, which Windows strips from directory names", () => {
      expect(getNewDatabaseIdValidationError("archive.")).toContain("dot");
    });

    it("throws from the assertion helper and returns the id otherwise", () => {
      expect(() => validateNewDatabaseId("Sales")).toThrow(/lowercase/);
      expect(validateNewDatabaseId("sales")).toBe("sales");
    });
  });
});
