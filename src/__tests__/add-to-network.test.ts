import { parseArgs } from "../node/server/add-to-network";

describe("add-to-network parseArgs", () => {
  test("parses --identity, --new-server, --servers, --password-file", () => {
    const o = parseArgs([
      "--new-server",
      "http://localhost:3003",
      "--servers",
      "http://localhost:1661,http://localhost:3001",
      "--identity",
      "./admin.identity.json",
      "--password-file",
      "/run/secrets/pass",
    ]);
    expect(o.newServer).toBe("http://localhost:3003");
    expect(o.servers).toEqual(["http://localhost:1661", "http://localhost:3001"]);
    expect(o.identityPath).toBe("./admin.identity.json");
    expect(o.passwordFile).toBe("/run/secrets/pass");
    expect(o.help).toBe(false);
  });

  test("strips trailing slashes from server URLs", () => {
    const o = parseArgs([
      "--new-server",
      "http://a.com/",
      "--servers",
      "http://b.com///",
      "--identity",
      "./id.json",
    ]);
    expect(o.newServer).toBe("http://a.com");
    expect(o.servers).toEqual(["http://b.com"]);
  });
});
