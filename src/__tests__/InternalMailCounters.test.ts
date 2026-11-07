import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { InMemoryContentAddressedStore } from "../core/appendonlystores/InMemoryContentAddressedStore";
import { ServerNetworkContentAddressedStore } from "../appendonlystores/network/ServerNetworkContentAddressedStore";

/**
 * The internal-mail counters (size per mail, rate per sender) live as long as
 * the server keeps the store instance; they must not grow with every mail ever
 * delivered (§6.11 limits).
 */
describe("internal mail counters", () => {
  const limits = { maxBytesPerMail: 4096, maxMailsPerHour: 2 };
  let now = Date.UTC(2026, 10, 7, 12, 0, 0);
  let nowSpy: jest.SpyInstance<number, []>;
  beforeEach(() => {
    nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(() => nowSpy.mockRestore());

  function serverStore(): ServerNetworkContentAddressedStore {
    return new ServerNetworkContentAddressedStore(
      new InMemoryContentAddressedStore("mmail_jane"),
      {} as never,
      {} as never,
      new NodeCryptoAdapter(),
    );
  }
  type Evaluate = (entry: unknown, l: typeof limits) => { reason: string } | null;
  const evaluate = (s: ServerNetworkContentAddressedStore, docId: string, sender: string) =>
    (s as unknown as { evaluateInternalMailLimits: Evaluate }).evaluateInternalMailLimits.call(s, {
      id: `${docId}-e`,
      docId,
      entryType: "doc_create",
      createdByPublicKey: sender,
      encryptedData: new Uint8Array(10),
    }, limits);

  test("the rate limit holds within the hour and frees up after it", () => {
    const s = serverStore();
    expect(evaluate(s, "memo_1", "karsten")).toBeNull();
    expect(evaluate(s, "memo_2", "karsten")).toBeNull();
    expect(evaluate(s, "memo_3", "karsten")?.reason).toMatch(/2 mails per hour/);
    now += 61 * 60 * 1000;
    expect(evaluate(s, "memo_4", "karsten")).toBeNull();
  });

  test("counters of mails and senders older than an hour are dropped", () => {
    const s = serverStore();
    for (let i = 0; i < 50; i++) {
      expect(evaluate(s, `memo_a${i}`, `sender${i}`)).toBeNull();
    }
    expect(s.internalMailCounterSizes()).toEqual({ docs: 50, senders: 50 });
    // Within the hour nothing is dropped.
    now += 30 * 60 * 1000;
    evaluate(s, "memo_b", "other");
    expect(s.internalMailCounterSizes()).toEqual({ docs: 51, senders: 51 });
    // After the hour only the recent sender and its mail remain.
    now += 31 * 60 * 1000;
    expect(evaluate(s, "memo_c", "other")).toBeNull();
    expect(s.internalMailCounterSizes()).toEqual({ docs: 2, senders: 1 });
  });

  test("pruning runs at most once a minute", () => {
    const s = serverStore();
    evaluate(s, "memo_1", "a");
    now += 60 * 60 * 1000 + 1;
    evaluate(s, "memo_2", "b"); // prunes memo_1/a
    expect(s.internalMailCounterSizes()).toEqual({ docs: 1, senders: 1 });
  });
});
