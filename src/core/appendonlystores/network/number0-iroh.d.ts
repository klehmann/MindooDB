declare module "@number0/iroh" {
  export class SecretKey {
    static fromBytes(bytes: Uint8Array | number[]): SecretKey;
    static fromString(value: string): SecretKey;
    static generate(): SecretKey;
  }

  export class EndpointTicket {
    static fromAddr(addr: unknown): EndpointTicket;
    static fromString(ticket: string): EndpointTicket;
    toString(): string;
    endpointAddr(): unknown;
  }

  export class Endpoint {
    static bind(options?: {
      alpns?: number[][];
      secretKey?: Uint8Array | number[];
    }): Promise<Endpoint>;
    id(): { toString(): string };
    addr(): unknown;
    online(): Promise<void>;
    close(): Promise<void>;
    connect(addr: unknown, alpn: number[]): Promise<unknown>;
    acceptNext(): Promise<unknown | null>;
  }
}
