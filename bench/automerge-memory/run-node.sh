#!/bin/sh
# Runs every case in Node (gen, then load via both paths), one process each.
# Usage: sh run-node.sh <dataDir> > results-node.jsonl
cd "$(dirname "$0")"
DATA="$1"
for id in $(node -e 'import("./scenarios.mjs").then(m=>m.allCases().forEach(c=>console.log(c.id)))'); do
  node --max-old-space-size=8192 node-run.mjs gen "$id" "$DATA" >/dev/null 2>&1 || { echo "{\"id\":\"$id\",\"error\":\"gen failed\"}"; continue; }
  for path in incremental snapshot; do
    out=$(perl -e 'alarm 600; exec @ARGV' node --expose-gc --max-old-space-size=8192 node-run.mjs load "$id" "$DATA" "$path" 2>&1 | tail -1)
    case "$out" in "{"*) echo "$out" ;; *) echo "{\"id\":\"$id\",\"path\":\"$path\",\"error\":$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(s.slice(0,200))))')}" ;; esac
  done
  rm -f "$DATA/$id.changes" "$DATA/$id.snapshot"
done
