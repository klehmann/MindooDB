/**
 * The invitation / join-request inbox and device discovery on the Cloudflare
 * host under `wrangler dev` (same scenario as the Node server's
 * `JoinRequestInboxServer.test.ts`).
 *
 * Opt-in like `CloudflareWorker.test.ts`:
 *   MINDOODB_CLOUDFLARE_TESTS=1 WRANGLER_BIN=/path/to/wrangler pnpm test CloudflareJoinRequests
 */
import { IsolatedInMemoryStoreFactory } from "./_helpers/multiDevice";
import { findWrangler, startCloudflareWorker, type RunningWorker } from "./_helpers/cloudflareWorker";
import { runJoinRequestInboxScenario } from "./_helpers/joinRequestInboxScenario";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";

const enabled = process.env.MINDOODB_CLOUDFLARE_TESTS === "1" && findWrangler() !== null;
const describeWorker = enabled ? describe : describe.skip;

const SERVER_PASSWORD = "cf-inbox-server-pass";
const SYSTEM_ADMIN_PASSWORD = "cf-inbox-sysadmin-pass";

describeWorker("join-request inbox on Cloudflare (wrangler dev)", () => {
  jest.setTimeout(300_000);
  let worker: RunningWorker | undefined;

  afterAll(async () => {
    await worker?.stop();
  });

  test("personal link: request, match, admit, discover, purge", async () => {
    const crypto = new NodeCryptoAdapter();
    const bootstrap = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    const globals = globalThis as { __MINDOODB_PBKDF2_ITERATIONS?: number };
    globals.__MINDOODB_PBKDF2_ITERATIONS = 100_000;
    const serverIdentity = await bootstrap.createUserId("CN=cf-inbox-server", SERVER_PASSWORD);
    delete globals.__MINDOODB_PBKDF2_ITERATIONS;
    const systemAdmin = await bootstrap.createUserId("cn=sysadmin/o=cf-inbox", SYSTEM_ADMIN_PASSWORD);
    worker = await startCloudflareWorker({
      serverIdentity,
      serverPassword: SERVER_PASSWORD,
      systemAdmin,
      serverConfig: { joinRequests: { maxRequestsPerIpPerHour: 6 } },
    });
    // The sweep runs in the joinrequests object after the admin's push.
    await runJoinRequestInboxScenario({
      baseUrl: worker.baseUrl,
      systemAdmin,
      systemAdminPassword: SYSTEM_ADMIN_PASSWORD,
      sweepDelayMs: 1500,
    });
  });
});
