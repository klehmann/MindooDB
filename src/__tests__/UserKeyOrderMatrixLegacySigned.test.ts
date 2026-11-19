import { casesFor, runCase } from "./_helpers/userKeyOrderMatrix";

/** docs/userkeys.md §9.3 under different orders of events; see _helpers/userKeyOrderMatrix.ts. */
describe("User-Key generations under different orders of events (legacy-signed document)", () => {
  jest.setTimeout(120000);

  it.each(casesFor("legacy-signed"))("cutoff $cutoff, then $extra ($time)", async (c) => {
    await runCase(c, `tenant-ukm-${c.origin}-${c.cutoff}-${c.extra}-${c.time}`);
  });
});
