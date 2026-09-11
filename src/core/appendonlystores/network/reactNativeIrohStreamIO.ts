import { MINDOODB_IROH_ALPN, type IrohByteStream, type IrohStreamIO } from "./IrohStreamIO";

/**
 * Optional adapter for `react-native-iroh`. Loaded dynamically so mindoodb
 * does not hard-depend on that package.
 */
export async function createReactNativeIrohStreamIO(): Promise<IrohStreamIO> {
  const mod = await import("react-native-iroh").catch(() => null) as
    | {
        Endpoint?: {
          create: (options: { alpns?: string[]; preset?: string }) => Promise<{
            id: string;
            ticket?: () => Promise<string>;
            streams: {
              connect: (peer: string, alpn: string) => Promise<{
                openStream: () => Promise<{
                  send: (bytes: Uint8Array) => Promise<void>;
                  data: AsyncIterable<Uint8Array>;
                }>;
              }>;
              listen: (alpn: string) => AsyncIterable<{
                incoming: AsyncIterable<{
                  send: (bytes: Uint8Array) => Promise<void>;
                  data: AsyncIterable<Uint8Array>;
                }>;
              }>;
            };
          }>;
        };
      }
    | null;
  if (!mod?.Endpoint) {
    throw new Error("react-native-iroh is not installed");
  }
  const endpoint = await mod.Endpoint.create({ alpns: [MINDOODB_IROH_ALPN], preset: "n0" });
  const ticket = typeof endpoint.ticket === "function" ? await endpoint.ticket() : endpoint.id;

  const toByteStream = async (stream: {
    send: (bytes: Uint8Array) => Promise<void>;
    data: AsyncIterable<Uint8Array>;
  }): Promise<IrohByteStream> => {
    const iterator = stream.data[Symbol.asyncIterator]();
    return {
      send: (bytes) => stream.send(bytes),
      recv: async () => {
        const next = await iterator.next();
        return next.done ? null : next.value;
      },
      close: async () => undefined,
    };
  };

  return {
    async getLocalTicket() {
      return ticket;
    },
    async connect(peerTicket, alpn = MINDOODB_IROH_ALPN) {
      const connection = await endpoint.streams.connect(peerTicket, alpn);
      return toByteStream(await connection.openStream());
    },
    async *listen(alpn = MINDOODB_IROH_ALPN) {
      for await (const connection of endpoint.streams.listen(alpn)) {
        for await (const inbound of connection.incoming) {
          yield toByteStream(inbound);
        }
      }
    },
  };
}
