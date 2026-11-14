/**
 * Live channel of a database: ephemeral messages between the people who have
 * the database open right now ("is typing", presence, positions on a map).
 *
 * Nothing here is stored. The sync server relays opaque bytes to the current
 * subscribers of the database (`publishLive` / `event: live`, capability
 * `supportsLiveChannel`) and forgets them; the database itself and its sync
 * stay the only source of truth. An app must work without the channel.
 *
 * Every message is
 * - **encrypted** with a key the database's readers hold (`keyId`: `"default"`,
 *   a named key, or the series of a group document, `$sealed:<groupDocId>`), so
 *   the server relays ciphertext;
 * - **signed** by the sending device. The receiver checks the signature, that
 *   the key is a trusted key of the tenant directory, and that the directory
 *   grants it to the user the server named as sender. `from` is therefore a
 *   checked name;
 * - **fresh**: messages older than {@link LIVE_MAX_AGE_MS} are dropped, which
 *   makes replaying a recorded message pointless.
 *
 * @module LiveChannel
 */
import { base64ToBytes, bytesToBase64 } from "../utils/base64";
import type { MindooTenant } from "../types";

/** Messages older than this (by the sender's clock) are dropped. */
export const LIVE_MAX_AGE_MS = 60_000;
/** Longest message, as JSON of `{ type, data }`, in bytes. */
export const LIVE_MAX_MESSAGE_BYTES = 8_000;

export type LiveChannelState = "connecting" | "connected" | "unavailable";

export interface LiveMessage {
  /** Checked username of the sender. */
  from: string;
  type: string;
  data: unknown;
  /** The sender's clock when the message was sent (ms epoch). */
  sentAt: number;
}

export interface LiveChannel {
  /** Send a message to everyone who has the channel open right now. Not stored, not retried. */
  send(type: string, data?: unknown): Promise<void>;
  /** Receive the messages of others. Returns an unsubscribe function. */
  onMessage(handler: (message: LiveMessage) => void): () => void;
  /** Connection state, called with the current state right away. Returns an unsubscribe function. */
  onState(handler: (state: LiveChannelState) => void): () => void;
  readonly state: LiveChannelState;
  close(): void;
}

/** What the channel needs from the remote store (`ClientNetworkContentAddressedStore`). */
export interface LiveTransport {
  subscribeToLive(
    onMessage: (event: { dbId: string; sender: string; payload: string }) => void,
    options?: { onState?: (state: LiveChannelState) => void },
  ): () => void;
  publishLive(payload: Uint8Array): Promise<void>;
}

export function isLiveTransport(store: unknown): store is LiveTransport {
  const candidate = store as Partial<LiveTransport> | null;
  return typeof candidate?.subscribeToLive === "function" && typeof candidate?.publishLive === "function";
}

interface Envelope {
  v: 1;
  /** Signing public key of the sending device (PEM). */
  k: string;
  /** Base64 signature over the ciphertext. */
  s: string;
  /** Base64 ciphertext of the JSON `{ t, d, at }`. */
  c: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function openLiveChannel(
  tenant: MindooTenant,
  transport: LiveTransport,
  options: { keyId: string; now?: () => number },
): LiveChannel {
  const now = options.now ?? Date.now;
  const messageHandlers = new Set<(message: LiveMessage) => void>();
  const stateHandlers = new Set<(state: LiveChannelState) => void>();
  let state: LiveChannelState = "connecting";
  let closed = false;

  async function receive(event: { sender: string; payload: string }) {
    if (closed || messageHandlers.size === 0) {
      return;
    }
    try {
      const envelope = JSON.parse(decoder.decode(base64ToBytes(event.payload))) as Partial<Envelope>;
      if (envelope.v !== 1 || typeof envelope.k !== "string" || typeof envelope.s !== "string" || typeof envelope.c !== "string") {
        return;
      }
      const ciphertext = base64ToBytes(envelope.c);
      if (!(await tenant.verifySignature(ciphertext, base64ToBytes(envelope.s), envelope.k))) {
        return;
      }
      // The server names the sender from its token. The signature must come from
      // a key the tenant directory currently grants to exactly that user. (Other
      // members see usernames in the directory only as hashes, so the check runs
      // from the name to its keys, not from the key to a name.)
      const directory = await tenant.openDirectory();
      if (!(await directory.validatePublicSigningKey(envelope.k))) {
        return;
      }
      const universe = await directory.getUserSigningKeyUniverse?.(event.sender);
      const keys = universe ? universe.active : [(await directory.getUserPublicKeys(event.sender))?.signingPublicKey];
      if (!keys.includes(envelope.k)) {
        return;
      }
      const message = JSON.parse(decoder.decode(await tenant.decryptPayload(ciphertext, options.keyId))) as {
        t?: unknown;
        d?: unknown;
        at?: unknown;
      };
      if (typeof message.t !== "string" || typeof message.at !== "number") {
        return;
      }
      if (Math.abs(now() - message.at) > LIVE_MAX_AGE_MS) {
        return;
      }
      const delivered: LiveMessage = { from: event.sender, type: message.t, data: message.d, sentAt: message.at };
      for (const handler of [...messageHandlers]) {
        try {
          handler(delivered);
        } catch {
          // one failing handler does not keep the others from the message
        }
      }
    } catch {
      // Not for us (another key), damaged, or forged: a live message is simply dropped.
    }
  }

  const unsubscribe = transport.subscribeToLive((event) => void receive(event), {
    onState: (next) => {
      state = next;
      for (const handler of [...stateHandlers]) {
        try {
          handler(next);
        } catch {
          // ignore
        }
      }
    },
  });

  return {
    async send(type, data) {
      if (closed) {
        throw new Error("The live channel is closed.");
      }
      if (typeof type !== "string" || type === "" || type.length > 64) {
        throw new Error("A live message needs a type of 1 to 64 characters.");
      }
      const plain = encoder.encode(JSON.stringify({ t: type, d: data ?? null, at: now() }));
      if (plain.length > LIVE_MAX_MESSAGE_BYTES) {
        throw new Error(`A live message can be at most ${LIVE_MAX_MESSAGE_BYTES} bytes.`);
      }
      const ciphertext = await tenant.encryptPayload(plain, options.keyId);
      const signature = await tenant.signPayload(ciphertext);
      const envelope: Envelope = {
        v: 1,
        k: (await tenant.getCurrentUserId()).userSigningPublicKey,
        s: bytesToBase64(signature),
        c: bytesToBase64(ciphertext),
      };
      await transport.publishLive(encoder.encode(JSON.stringify(envelope)));
    },
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => {
        messageHandlers.delete(handler);
      };
    },
    onState(handler) {
      stateHandlers.add(handler);
      handler(state);
      return () => {
        stateHandlers.delete(handler);
      };
    },
    get state() {
      return state;
    },
    close() {
      closed = true;
      messageHandlers.clear();
      stateHandlers.clear();
      unsubscribe();
    },
  };
}
