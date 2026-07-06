import fs from "fs";
import os from "os";
import path from "path";

import { PurgedDocRegistry } from "../node/server/PurgedDocRegistry";

describe("PurgedDocRegistry", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mindoodb-purge-registry-"));
    file = path.join(dir, "purged-docs.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("tracks processed requests and purged docs, and persists across reloads", () => {
    const registry = new PurgedDocRegistry(file);
    expect(registry.isRequestProcessed("acl_dochistorypurge_req1")).toBe(false);
    expect(registry.getPurgedDocIds("main").size).toBe(0);

    registry.recordPurgedDoc("main", "doc-1");
    registry.recordPurgedDoc("main", "doc-2");
    registry.recordPurgedDoc("other", "doc-3");
    registry.markRequestProcessed("acl_dochistorypurge_req1");

    expect(registry.isRequestProcessed("acl_dochistorypurge_req1")).toBe(true);
    expect([...registry.getPurgedDocIds("main")].sort()).toEqual(["doc-1", "doc-2"]);
    expect([...registry.getPurgedDocIds("other")]).toEqual(["doc-3"]);

    // markRequestProcessed persisted to disk; a fresh instance reads it back.
    const reloaded = new PurgedDocRegistry(file);
    expect(reloaded.isRequestProcessed("acl_dochistorypurge_req1")).toBe(true);
    expect([...reloaded.getPurgedDocIds("main")].sort()).toEqual(["doc-1", "doc-2"]);
    expect([...reloaded.getPurgedDocIds("other")]).toEqual(["doc-3"]);
  });

  it("starts empty when the file is absent or corrupt", () => {
    const fresh = new PurgedDocRegistry(path.join(dir, "missing.json"));
    expect(fresh.isRequestProcessed("x")).toBe(false);

    fs.writeFileSync(file, "{ not valid json", "utf-8");
    const corrupt = new PurgedDocRegistry(file);
    expect(corrupt.isRequestProcessed("x")).toBe(false);
    expect(corrupt.getPurgedDocIds("main").size).toBe(0);
  });
});
