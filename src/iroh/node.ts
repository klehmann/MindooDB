/**
 * Node.js Iroh adapter (`@number0/iroh`). Import from `mindoodb/iroh/node`,
 * not `mindoodb/iroh` — this module uses `fs`/`path` and must not be bundled
 * for the browser.
 */
import {
  createNativeIrohStreamIO,
  tryImportNumber0Iroh,
  type NativeIrohStreamIO,
} from "../node/server/nativeIrohStreamIO";

export { createNativeIrohStreamIO, tryImportNumber0Iroh, type NativeIrohStreamIO };

export interface NodeIrohStreamIOOptions {
  /** Directory for the persistent 32-byte Iroh secret (created if missing). */
  dataDir: string;
  /**
   * Secret-key path. Relative paths resolve against {@link NodeIrohStreamIOOptions.dataDir}.
   * Defaults to `iroh-secret.key`.
   */
  secretKeyPath?: string;
}

/**
 * Bind a native Iroh endpoint for a Node CLI or service.
 *
 * Waits until the endpoint has a home relay (`online()`) so browser/WASM
 * peers can dial the ticket. Prefer {@link NativeIrohStreamIO.openConnection}
 * and then `openStream()` for each in-flight RPC (and the change feed);
 * {@link NativeIrohStreamIO.connect} is a one-stream convenience wrapper.
 */
export async function createNodeIrohStreamIO(
  options: NodeIrohStreamIOOptions,
): Promise<NativeIrohStreamIO> {
  return createNativeIrohStreamIO(options.dataDir, {
    enabled: true,
    secretKeyPath: options.secretKeyPath,
  });
}
