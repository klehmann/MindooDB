/**
 * WebKit runner (Playwright): loads stored cases in a fresh WebKit page each,
 * the engine Haven Desktop (macOS) and the iOS app run on.
 *
 *   node webkit-run.mjs <dataDir> <caseId>...   (generate first with node-run.mjs gen)
 *
 * Needs Playwright with its WebKit; NODE_PATH may point at a checkout that has it.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { webkit } = require("playwright");
const amEntry = require.resolve("@automerge/automerge");
const amDir = amEntry.slice(0, amEntry.indexOf("/dist/"));
const [dataDir, ...ids] = process.argv.slice(2);

const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".html": "text/html" };
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let file;
  if (url.pathname === "/") file = null;
  else if (url.pathname.startsWith("/am/")) file = join(amDir, url.pathname.slice(4));
  else if (url.pathname.startsWith("/data/")) file = join(dataDir, url.pathname.slice(6));
  try {
    const body = file ? readFileSync(file) : Buffer.from("<!doctype html><title>bench</title>");
    const ext = file ? file.slice(file.lastIndexOf(".")) : ".html";
    res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await webkit.launch();
for (const id of ids) {
  for (const path of ["incremental", "snapshot"]) {
    const page = await browser.newPage();
    await page.goto(base + "/");
    const result = await page
      .evaluate(
        async ({ id, path }) => {
          const memories = [];
          const orig = WebAssembly.instantiate;
          WebAssembly.instantiate = async (...args) => {
            const r = await orig.apply(WebAssembly, args);
            const inst = r.instance ?? r;
            if (inst.exports?.memory) memories.push(inst.exports.memory);
            return r;
          };
          const A = await import("/am/dist/mjs/entrypoints/slim.js");
          await A.initializeWasm(await (await fetch("/am/dist/automerge.wasm")).arrayBuffer());
          const wasm = () => memories.reduce((s, m) => s + m.buffer.byteLength, 0);
          const buf = new Uint8Array(await (await fetch(`/data/${id}.changes`)).arrayBuffer());
          const snap = new Uint8Array(await (await fetch(`/data/${id}.snapshot`)).arrayBuffer());
          const view = new DataView(buf.buffer);
          const changes = [];
          for (let o = 0; o < buf.byteLength; ) {
            const len = view.getUint32(o);
            changes.push(buf.subarray(o + 4, o + 4 + len));
            o += 4 + len;
          }
          const w0 = wasm();
          const t0 = performance.now();
          try {
            let doc;
            if (path === "snapshot") doc = A.load(snap);
            else {
              doc = A.init();
              for (const c of changes) doc = A.loadIncremental(doc, c);
            }
            const loadMs = performance.now() - t0;
            A.toJS(doc);
            return { loadMs: Math.round(loadMs), wasmMB: Math.round((wasm() - w0) / 104857.6) / 10 };
          } catch (e) {
            return { error: String(e), ms: Math.round(performance.now() - t0), wasmMB: Math.round((wasm() - w0) / 104857.6) / 10 };
          }
        },
        { id, path },
      )
      .catch((e) => ({ error: String(e).slice(0, 200) }));
    console.log(JSON.stringify({ engine: "webkit", id, path, ...result }));
    await page.close();
  }
}
await browser.close();
server.close();
