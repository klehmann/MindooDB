import { BaseMindooTenantFactory } from "../../core/BaseMindooTenantFactory";

/**
 * After every test, wait for the background work (trust/key reconciles,
 * auto-follow catch-ups) of every tenant the test opened. Without this, such
 * work outlives its test: it logs after the test has finished and races the
 * next test's setup.
 */
type IdleAwareTenant = { whenBackgroundIdle?: () => Promise<void> };

const openedTenants = new Set<IdleAwareTenant>();

const originalOpenTenant = BaseMindooTenantFactory.prototype.openTenant;
BaseMindooTenantFactory.prototype.openTenant = async function (
  this: BaseMindooTenantFactory,
  ...args: unknown[]
) {
  const tenant = await (originalOpenTenant as (...a: unknown[]) => Promise<unknown>).apply(this, args);
  openedTenants.add(tenant as IdleAwareTenant);
  return tenant;
} as typeof originalOpenTenant;

// Kept for the whole test file: tenants opened in beforeAll serve several tests.
afterEach(async () => {
  for (const tenant of Array.from(openedTenants)) {
    await tenant.whenBackgroundIdle?.();
  }
});
