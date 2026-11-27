# Automerge memory benchmark

Measures how much WebAssembly memory and time Automerge needs to load documents of
different shapes, through the three load paths MindooDB can use:

- `incremental`: one `loadIncremental` per store entry (MindooDB's document load after a snapshot)
- `batch`: all changes in one `applyChanges`
- `snapshot`: `Automerge.load` of a saved state

Each case runs in its own process, so every peak starts from a clean heap. Text is random
(not compressible), the unfavourable case. Scenarios and sizes are in `scenarios.mjs`.

```sh
# all cases in Node (gen + incremental + snapshot), ~45 min
sh run-node.sh <dataDir> > results-node.jsonl
# one case, one path
node node-run.mjs gen <caseId> <dataDir>
node --expose-gc node-run.mjs load <caseId> <dataDir> incremental|batch|snapshot
# the same cases in WebKit (Playwright), after gen
node webkit-run.mjs <dataDir> <caseId>...
```

`results-*.jsonl` hold the run of 2026-11-27 (Automerge 3.5.0, Node 24, Playwright WebKit, Apple
Silicon). `wasmMB` is the growth of the wasm memory (exact, from `memory.buffer`), `peakRssMB`
the growth of the process RSS. A wasm instance that runs out of its 4 GB fails with
`RuntimeError: unreachable` and answers every later call with `Module terminated`.
