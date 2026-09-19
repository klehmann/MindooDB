/**
 * Additive Iroh transport. Not imported by `mindoodb/browser`.
 *
 * Protocol types and `IrohNetworkTransport` live here. The Node QUIC adapter
 * (`createNodeIrohStreamIO`) is `mindoodb/iroh/node` so web bundlers do not
 * pull in `fs` / `@number0/iroh`.
 */
export {
  MINDOODB_IROH_ALPN,
  createLoopbackIrohPair,
  decodeIrohFrame,
  encodeIrohFrame,
  wrapLengthPrefixedByteStream,
  type IrohByteStream,
  type IrohConnectionHandle,
  type IrohRpcContext,
  type IrohRpcRequest,
  type IrohRpcResponse,
  type IrohStreamIO,
} from "../core/appendonlystores/network/IrohStreamIO";
export {
  IROH_SYNC_STORE_METHODS,
  IrohNetworkTransport,
  IrohPeerStore,
  createStoreIrohHandler,
  listenForIrohPeers,
  serveIrohRpc,
  type IrohListenOptions,
  type IrohRpcHandler,
} from "../core/appendonlystores/network/IrohNetworkTransport";
export { createReactNativeIrohStreamIO } from "../core/appendonlystores/network/reactNativeIrohStreamIO";
// `IrohPeerStore` takes a StoreKind in its constructor, so a peer-sync caller
// needs the enum without reaching into internal paths.
export { StoreKind } from "../core/appendonlystores/types";
export {
  extractEndpointIdFromTicket,
  isIrohLocator,
  normalizeIrohEndpointId,
  parseIrohLocator,
  resolveIrohEndpointId,
  type ParsedIrohLocator,
} from "../core/appendonlystores/network/irohLocator";
