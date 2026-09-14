/**
 * Throwaway spike: two native Iroh endpoints in one process, no relays.
 *
 * 1. Same bound endpoint can listen and dial outbound at the same time.
 * 2. A second openBi() on one QUIC connection arrives when the peer loops acceptBi().
 *
 *   node scripts/iroh-multistream-spike.mjs
 */
import pkg from "@number0/iroh";

const { Endpoint, RelayMode } = pkg;
const ALPN = Array.from(Buffer.from("mindoodb/spike", "utf8"));

async function bindLocal() {
  const builder = Endpoint.builder();
  builder.applyN0();
  builder.alpns([ALPN]);
  builder.relayMode(RelayMode.disabled());
  return builder.bind();
}

async function echoOnce(recv, send) {
  const msg = await recv.readToEnd(64);
  await send.writeAll(msg);
  await send.finish();
}

async function question1SameEndpointListenAndDial() {
  const a = await bindLocal();
  const b = await bindLocal();
  try {
    const acceptA = (async () => {
      const incoming = await a.acceptNext();
      if (!incoming) {
        throw new Error("A acceptNext returned null");
      }
      const conn = await (await incoming.accept()).connect();
      const bi = await conn.acceptBi();
      await echoOnce(bi.recv, bi.send);
    })();

    const acceptB = (async () => {
      const incoming = await b.acceptNext();
      if (!incoming) {
        throw new Error("B acceptNext returned null");
      }
      const conn = await (await incoming.accept()).connect();
      const bi = await conn.acceptBi();
      await echoOnce(bi.recv, bi.send);
    })();

    const connBA = await b.connect(a.addr(), ALPN);
    const streamBA = await connBA.openBi();
    await streamBA.send.writeAll(Array.from(Buffer.from("b-to-a")));
    await streamBA.send.finish();
    const replyBA = Buffer.from(await streamBA.recv.readToEnd(64)).toString("utf8");

    const connAB = await a.connect(b.addr(), ALPN);
    const streamAB = await connAB.openBi();
    await streamAB.send.writeAll(Array.from(Buffer.from("a-to-b")));
    await streamAB.send.finish();
    const replyAB = Buffer.from(await streamAB.recv.readToEnd(64)).toString("utf8");

    await acceptA;
    await acceptB;
    if (replyBA !== "b-to-a" || replyAB !== "a-to-b") {
      throw new Error(`echo mismatch: ${replyBA} / ${replyAB}`);
    }
    console.log("Q1 PASS: same bound endpoint listens and dials at the same time");
  } finally {
    await a.close();
    await b.close();
  }
}

async function question2SecondOpenBiOnSameConnection() {
  const a = await bindLocal();
  const b = await bindLocal();
  try {
    const acceptLoop = (async () => {
      const incoming = await a.acceptNext();
      if (!incoming) {
        throw new Error("A acceptNext returned null");
      }
      const conn = await (await incoming.accept()).connect();
      const first = await conn.acceptBi();
      const second = await conn.acceptBi();
      await Promise.all([echoOnce(first.recv, first.send), echoOnce(second.recv, second.send)]);
    })();

    const conn = await b.connect(a.addr(), ALPN);
    const stream1 = await conn.openBi();
    const stream2 = await conn.openBi();
    await stream1.send.writeAll(Array.from(Buffer.from("s1")));
    await stream1.send.finish();
    await stream2.send.writeAll(Array.from(Buffer.from("s2")));
    await stream2.send.finish();
    const reply1 = Buffer.from(await stream1.recv.readToEnd(64)).toString("utf8");
    const reply2 = Buffer.from(await stream2.recv.readToEnd(64)).toString("utf8");
    await acceptLoop;
    if (reply1 !== "s1" || reply2 !== "s2") {
      throw new Error(`multi-stream echo mismatch: ${reply1} / ${reply2}`);
    }
    console.log("Q2 PASS: second openBi() arrives on the same connection");
  } finally {
    await a.close();
    await b.close();
  }
}

await question1SameEndpointListenAndDial();
await question2SecondOpenBiOnSameConnection();
console.log("SPIKE OK — Option C is viable");
