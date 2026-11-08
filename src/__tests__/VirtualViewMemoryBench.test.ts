/**
 * Opt-in benchmark: heap used by a VirtualView's entries.
 *
 * Builds mail-like views (folder category, date sort, a few display columns,
 * a total) and reports the retained heap per document entry, plus the build
 * time. Needs `--expose-gc` for stable numbers:
 *
 *   BENCH=1 NODE_OPTIONS=--expose-gc npm test -- VirtualViewMemoryBench
 *
 * BENCH_DOCS=10000,50000 picks the sizes; BENCH_READ=0 skips reading every
 * entry's position after the build.
 */
import {
  ColumnSorting,
  TotalMode,
  VirtualView,
  VirtualViewColumn,
  VirtualViewDataChange,
} from "../core/indexing/virtualviews";

const RUN = process.env.BENCH === "1";
const SIZES = (process.env.BENCH_DOCS ?? "10000,50000").split(",").map(Number);
const READ = process.env.BENCH_READ !== "0";
const gc = (globalThis as unknown as { gc?: () => void }).gc;

function heapUsed(): number {
  gc?.();
  gc?.();
  return process.memoryUsage().heapUsed;
}

/** Deterministic pseudo-random text (mulberry32). */
function textGenerator(seed: number): (length: number) => string {
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const alphabet = "abcdefghijklmnopqrstuvwxyz ";
  return (length) => {
    // Flat strings (as from JSON.parse), not concatenation ropes.
    const chars: string[] = new Array(length);
    for (let i = 0; i < length; i++) chars[i] = alphabet[Math.floor(next() * alphabet.length)];
    return chars.join("");
  };
}

interface Scenario {
  name: string;
  columns: () => VirtualViewColumn[];
  values: (i: number, text: (n: number) => string) => Record<string, unknown>;
}

const SCENARIOS: Scenario[] = [
  {
    name: "mail (folder, date, subject, from, preview, unread)",
    columns: () => [
      VirtualViewColumn.category("folder", { sorting: ColumnSorting.ASCENDING }),
      VirtualViewColumn.sorted("receivedAt", ColumnSorting.DESCENDING),
      new VirtualViewColumn({ name: "subject" }),
      new VirtualViewColumn({ name: "from" }),
      new VirtualViewColumn({ name: "preview" }),
      VirtualViewColumn.total("unread", TotalMode.SUM),
    ],
    values: (i, text) => ({
      folder: `acc${i % 3}/folder${i % 40}`,
      receivedAt: new Date(1.7e12 + i * 60000).toISOString(),
      subject: text(45),
      from: `${text(12)} <${text(8)}@example.com>`,
      preview: text(120),
      unread: i % 5 === 0 ? 1 : 0,
    }),
  },
  {
    name: "slim (folder, date, unread)",
    columns: () => [
      VirtualViewColumn.category("folder", { sorting: ColumnSorting.ASCENDING }),
      VirtualViewColumn.sorted("receivedAt", ColumnSorting.DESCENDING),
      VirtualViewColumn.total("unread", TotalMode.SUM),
    ],
    values: (i) => ({
      folder: `acc${i % 3}/folder${i % 40}`,
      receivedAt: new Date(1.7e12 + i * 60000).toISOString(),
      unread: i % 5 === 0 ? 1 : 0,
    }),
  },
  {
    name: "flat (date, subject)",
    columns: () => [
      VirtualViewColumn.sorted("receivedAt", ColumnSorting.DESCENDING),
      new VirtualViewColumn({ name: "subject" }),
    ],
    values: (i, text) => ({
      receivedAt: new Date(1.7e12 + i * 60000).toISOString(),
      subject: text(45),
    }),
  },
];

/** Flat copy of a string (template literals build ropes; stored data is flat). */
const flat = (value: string): string => [value].join("");

function measure(scenario: Scenario, size: number): string {
  const text = textGenerator(42);
  // The strings the view keeps (doc ids, values) count: a real view holds
  // them too.
  const before = heapUsed();
  const view = new VirtualView(scenario.columns());
  let change: VirtualViewDataChange | null = new VirtualViewDataChange("mail");
  for (let i = 0; i < size; i++) {
    const values = scenario.values(i, text);
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === "string") values[key] = flat(value);
    }
    change.addEntry(flat(`doc${i.toString(36).padStart(4, "0")}${text(20)}`), values);
  }
  const started = performance.now();
  view.applyChanges(change);
  const buildMs = performance.now() - started;
  change = null;
  // Read every entry once (positions get cached, as in real paging).
  let read = 0;
  const walk = (entry: ReturnType<VirtualView["getRoot"]>) => {
    for (const child of entry.getChildEntries()) {
      child.getPositionStr();
      read++;
      walk(child);
    }
  };
  if (READ) walk(view.getRoot());
  const bytes = heapUsed() - before;
  if (READ) expect(read).toBeGreaterThanOrEqual(size);
  expect(view.getRoot().getDescendantDocumentCount()).toBe(size);
  return `${scenario.name} N=${size}: ${(bytes / 1048576).toFixed(1)} MB, ${Math.round(bytes / size)} B/doc, build ${buildMs.toFixed(0)} ms`;
}

(RUN ? describe : describe.skip)("VirtualView memory benchmark", () => {
  it("reports heap per entry", () => {
    if (!gc) {
      console.warn("Run with NODE_OPTIONS=--expose-gc for stable numbers.");
    }
    const lines: string[] = [];
    for (const scenario of SCENARIOS) {
      for (const size of SIZES) {
        lines.push(measure(scenario, size));
      }
    }
    console.log(lines.join("\n"));
  });
});
