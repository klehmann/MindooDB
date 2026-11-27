/**
 * Node runner. One case per process, so every peak starts from a clean heap:
 *
 *   node node-run.mjs gen <caseId> <dataDir>          build and store the changes
 *   node node-run.mjs load <caseId> <dataDir> <path>  path = incremental | batch | snapshot
 *
 * `load` prints one JSON line with time and memory figures.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Capture Automerge's WebAssembly memory: it grows and never shrinks, so its
// size at the end is also the peak of the wasm heap.
const memories = [];
const OrigInstance = WebAssembly.Instance;
WebAssembly.Instance = new Proxy(OrigInstance, {
  construct(target, args) {
    const instance = new target(...args);
    if (instance.exports.memory) memories.push(instance.exports.memory);
    return instance;
  },
});
const A = await import("@automerge/automerge");
const { allCases, SCENARIOS } = await import("./scenarios.mjs");

const wasmBytes = () => memories.reduce((sum, m) => sum + m.buffer.byteLength, 0);
const MB = (n) => Math.round((n / 1048576) * 10) / 10;

function pack(chunks) {
  const total = chunks.reduce((s, c) => s + 4 + c.byteLength, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let o = 0;
  for (const c of chunks) {
    view.setUint32(o, c.byteLength);
    out.set(c, o + 4);
    o += 4 + c.byteLength;
  }
  return out;
}

function unpack(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const chunks = [];
  for (let o = 0; o < buf.byteLength; ) {
    const len = view.getUint32(o);
    chunks.push(buf.subarray(o + 4, o + 4 + len));
    o += 4 + len;
  }
  return chunks;
}

const [mode, id, dataDir, path] = process.argv.slice(2);
const c = allCases().find((x) => x.id === id);
if (!c) throw new Error(`unknown case ${id}`);

if (mode === "gen") {
  mkdirSync(dataDir, { recursive: true });
  const { doc, changes } = SCENARIOS[c.name].build(A, c.params, c.variant === "atomic");
  writeFileSync(join(dataDir, `${id}.changes`), pack(changes));
  writeFileSync(join(dataDir, `${id}.snapshot`), A.save(doc));
  console.log(JSON.stringify({ id, changes: changes.length }));
} else {
  // Like MindooDB: all entries are read into memory first, then applied.
  const changes = unpack(readFileSync(join(dataDir, `${id}.changes`)));
  const snapshot = readFileSync(join(dataDir, `${id}.snapshot`));
  const storedBytes = changes.reduce((s, x) => s + x.byteLength, 0);
  global.gc?.();
  const base = { rss: process.memoryUsage().rss, heap: process.memoryUsage().heapUsed, wasm: wasmBytes() };
  let peakRss = base.rss;
  let peakHeap = base.heap;
  const sample = () => {
    const m = process.memoryUsage();
    if (m.rss > peakRss) peakRss = m.rss;
    if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
  };
  const t0 = performance.now();
  let doc;
  if (path === "snapshot") {
    doc = A.load(snapshot);
    sample();
  } else if (path === "batch") {
    // All changes in one call instead of one loadIncremental per entry.
    [doc] = A.applyChanges(A.init(), changes);
    sample();
  } else {
    doc = A.init();
    const every = Math.max(1, Math.floor(changes.length / 200));
    changes.forEach((change, i) => {
      doc = A.loadIncremental(doc, change);
      if (i % every === 0) sample();
    });
    sample();
  }
  const loadMs = performance.now() - t0;
  const wasmAfterLoad = wasmBytes();
  const t1 = performance.now();
  const plain = A.toJS(doc);
  sample();
  const toJsMs = performance.now() - t1;
  const keys = Object.keys(plain).length;
  console.log(
    JSON.stringify({
      id,
      path,
      changes: changes.length,
      storedMB: MB(storedBytes),
      snapshotMB: MB(snapshot.byteLength),
      loadMs: Math.round(loadMs),
      toJsMs: Math.round(toJsMs),
      wasmMB: MB(wasmAfterLoad - base.wasm),
      wasmTotalMB: MB(wasmBytes()),
      peakRssMB: MB(peakRss - base.rss),
      peakHeapMB: MB(peakHeap - base.heap),
      keys,
    }),
  );
}
