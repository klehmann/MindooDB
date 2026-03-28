import { readFileSync } from "fs";
import { ENV_VARS } from "./types";

/**
 * Server identity password: optional file (preferred for Docker: avoids putting
 * the secret in the container environment block), else MINDOODB_SERVER_PASSWORD.
 * File content is trimmed (single line).
 */
export function resolveServerPassword(): string | undefined {
  const filePath = process.env[ENV_VARS.SERVER_PASSWORD_FILE]?.trim();
  if (filePath) {
    try {
      const s = readFileSync(filePath, "utf8").trim();
      return s.length > 0 ? s : undefined;
    } catch (e) {
      throw new Error(
        `Cannot read ${ENV_VARS.SERVER_PASSWORD_FILE} (${filePath}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  const direct = process.env[ENV_VARS.SERVER_PASSWORD];
  return direct !== undefined && direct.length > 0 ? direct : undefined;
}
