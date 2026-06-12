/**
 * Internal (non-public) contract the tenant uses to drive the KeyBag import
 * pass on its own directory (docs/accesscontrol.md §13).
 *
 * Deliberately NOT part of the public {@link MindooTenantDirectory} surface: the
 * only reconcile entry point consumers see is
 * `MindooTenant.reconcileKeyDistributionsForCurrentUser()`. The reconcile core
 * sources its RSA-OAEP session key from the directory's own tenant, so no
 * foreign decryption key is ever passed across an API boundary.
 */
export interface KeyBagReconciler {
  /**
   * Import the key versions pushed to `username` using the directory's OWN
   * tenant session key, and remove pulled (revoked) ids. Returns the imported
   * and removed key ids; both empty when the host is locked (no session key).
   */
  reconcileImportedKeysForCurrentUser(
    username: string,
  ): Promise<{ imported: string[]; removed: string[] }>;
}
