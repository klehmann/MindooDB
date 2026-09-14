import { createNodeIrohStreamIO, tryImportNumber0Iroh } from "../iroh/node";

describe("mindoodb/iroh/node", () => {
  test("exports a Node Iroh factory", () => {
    expect(typeof createNodeIrohStreamIO).toBe("function");
    expect(typeof tryImportNumber0Iroh).toBe("function");
  });
});
