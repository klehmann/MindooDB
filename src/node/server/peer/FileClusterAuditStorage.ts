/**
 * The cluster audit log on disk: `<dataDir>/cluster/audit.jsonl`, rotated to
 * `audit.jsonl.<timestamp>` once it passes {@link DEFAULT_MAX_BYTES}. Only the
 * active file is read back.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "fs";
import { join } from "path";

import type { ClusterAuditStorage } from "../../../server/peer/ClusterAuditLog";

/** Rotate once the active file passes this size. */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export class FileClusterAuditStorage implements ClusterAuditStorage {
  private readonly dir: string;
  private readonly file: string;

  constructor(
    dataDir: string,
    private readonly maxBytes: number = DEFAULT_MAX_BYTES,
  ) {
    this.dir = join(dataDir, "cluster");
    this.file = join(this.dir, "audit.jsonl");
  }

  appendLine(line: string): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.rotateIfNeeded();
    appendFileSync(this.file, `${line}\n`, "utf8");
  }

  readLines(): string[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8").split("\n");
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.file)) return;
    if (statSync(this.file).size < this.maxBytes) return;
    renameSync(this.file, `${this.file}.${Date.now()}`);
  }
}
