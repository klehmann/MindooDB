import { namedExport } from "../core/utils/dynamicImportInterop";

describe("namedExport", () => {
  class HttpTransport {}

  it("reads a named export (Node / Rollup interop)", () => {
    expect(namedExport(Object.freeze({ HttpTransport }), "HttpTransport")).toBe(HttpTransport);
  });

  it("falls back to default.<name> (esbuild prebundle of a CJS module)", () => {
    expect(namedExport({ default: { HttpTransport } }, "HttpTransport")).toBe(HttpTransport);
  });

  it("fails with a clear message instead of 'is not a constructor'", () => {
    expect(() => namedExport({ default: {} }, "HttpTransport")).toThrow(/no export "HttpTransport"/);
  });
});
