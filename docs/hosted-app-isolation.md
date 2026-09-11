# Hosted-app isolation in Haven

A third-party MindooDB app should see only the databases you mapped, must not read Haven’s storage or other apps, and — when Haven serves the code — must not phone home unless you listed the URL. This page explains that containment: what a **hosted bundle** is, how the **network allowlist** works, and why day-to-day development still uses an **entry URL** in external mode.

It is structured so different readers can stop when they have enough:

- **Sections 1–2** are for managers and anyone deciding whether to host an app inside Haven.
- **Section 3** is the integration path for app developers.
- **Section 4** is the isolation model for platform engineers.
- **Section 5** is a short appendix (pattern syntax and pointers).

This is not the same design as [distributed-webapps.md](distributed-webapps.md), where application assets live *inside* a MindooDB database. Haven-hosted apps are a zip that is served from a **separate origin per app**, one Haven itself cannot script — see [hosted-app-runner-origins.md](hosted-app-runner-origins.md) for that design. See also the sandbox notes in [haven-handbook.md](haven-handbook.md).

---

## 1) Start here

The problem is simple: a MindooDB app is someone else’s UI running next to your workspace. You still want it to read the databases you chose. You do not want it to see Haven’s cookies, walk other apps, or scrape the internet on your behalf.

**Hosted** mode is Haven serving that UI — but not from Haven’s address. Each installed app gets its own origin, derived from its instance id: `https://app-{hash}-{p|d}.mindoodb-apprunner.com`, where `p` and `d` separate production from development. That per-app origin is what Content-Security-Policy `'self'` means — not Haven, not the publisher, and not the **entry URL** you pasted (`https://app-example.mindoodb.com` or `http://127.0.0.1:4200`). The entry URL is only the update source. Talking to it later needs an allowlist entry.

Two apps therefore never share an origin, and none of them shares one with Haven. That is what makes the browser’s own same-origin policy — not a Haven-authored rule — the thing keeping an app out of Haven’s storage and DOM.

An empty **network allowlist** means no external network. The app can still load its own bundled JS, CSS, and images from that bundle prefix, and it talks to Haven only through the **bridge** (postMessage). Relative `fetch('/…')` resolves to the app’s own origin and is denied unless the path is this bundle’s own assets; `fetch('https://haven.mindoodb.com/…')` is a cross-origin request that the allowlist does not carry. Guessing another `bundleId` is denied too.

**Adoption snapshot.** Add `havenBundle()` to a Vite app (the [example app](https://github.com/klehmann/mindoodb-app-example) is the open-source reference), set `base: "./"`, run `vite build`, paste the same entry URL into Haven, switch to hosted, load from URL, and add allowlist patterns if the app needs something like Open-Meteo. Effort is small if the app already uses the App SDK.

**Decision checklist.** External mode exists for the one case a bundle cannot serve — a dev server with hot reload, since a bundle is a snapshot taken at install time. It has no network allowlist and no navigation containment by design, which is defensible for loopback because that is your own machine.

A public entry URL in external mode is a different matter: the app then runs from the internet with no policy Haven can apply. Haven **warns and still saves** it. That is a deliberate, temporary relaxation while the hosting feature is being exercised end to end, not a judgement that it is safe — treat it as a hard rule for anything you did not write, and install such apps as hosted bundles. The predicate is `isPublicEntryUrl` in `entryUrlPolicy.ts`; making it binding again means putting it back into `canSave` in `MindooDBAppEditorForm.vue`, and nothing else.

This is a strong default-deny jail for network, popups, and device sensors, on an origin of the app’s own. It is not a VM. Residual risk is a sloppy allowlist, an explicitly granted popup/OAuth checkbox, leftover channels such as WebRTC, and Haven itself being compromised.

---

## 2) What you are actually allowing

Empty allowlist still lets the app start. Haven serves the zip. The bridge still works.

What you list is every other host the UI may call with `fetch`, XHR, images, fonts, media, `sendBeacon`, or WebSockets. HTTP methods are not part of the policy: a secret on a query string is still a GET, and CSP cannot tell GET from POST. One URL pattern list is enough.

Catalog apps can ship a starting list. The SDK example’s manifest carries `https://api.open-meteo.com/*`, and Haven keeps those patterns on the registration even though the catalog entry installs as **external** — so the Network tab’s weather preset still works once you switch that app to hosted, instead of starting from an empty list. httpbin is not listed, so that probe fails in hosted mode even though CORS would allow it.

Popups, camera, microphone, and geolocation are off unless you tick them on the registration. Window-mode apps are a normal browser tab; those iframe flags do not apply there.

---

## 3) Integration guide

Happy path:

1. Copy the example app’s Vite wiring: `havenBundle()` from `mindoodb-app-sdk/vite`, and `base: "./"` so the zip works under Haven’s hosted prefix.
2. Run `vite build`. Confirm `dist/haven-bundle.json` and `dist/haven-bundle.zip`.
3. Point Haven at the same origin you would use externally, switch the registration to hosted, and load from URL.
4. If the app needs a public API, add a glob such as `https://api.open-meteo.com/*`.

The plugin runs only on `vite build`. `vite dev` does not emit those files. Day-to-day work stays **external** against `http://127.0.0.1:4200` (or Vega’s 4201) — which is also the only kind of URL external mode accepts. Hosted plus allowlist is for checking the published shape: install, update, and which URLs the sandbox permits. The Network tab in the example app is that probe, not the daily loop.

Common failures:

- Talking to the **dev server** in hosted mode (`/haven-bundle.json` 404) — the plugin is build-only. Run `vite build` and serve `dist/` over HTTP (the example app’s `pnpm preview` builds and then serves it through `wrangler dev`), and allow CORS from Haven.
- Allowlist miss — `fetch`, XHR, and `img` fail. Haven shows a warning toast when the service worker denies the request.
- Expecting the publisher origin to be `'self'` — after install, `'self'` is the app’s own runner origin. Haven is cross-origin from the app and is not reachable over HTTP at all; use the bridge.
- Expecting `localStorage` to be shared with anything. It works and it is real, but it belongs to that per-app origin, so it is empty on first launch and invisible to Haven, to other apps, and to the same app in the other environment.
- Saving a public entry URL in external mode — Haven warns but allows it while the feature is under test. Nothing is policed on that path, so install the app as a hosted bundle unless you wrote it.
- A full-page navigation inside the app, such as a plain `<a href>` to another origin. Hosted apps may navigate only within their own bundle; use the bridge or an allowlisted `fetch` instead.

---

## 4) Isolation semantics

Layers, and when each applies:

1. **A separate origin, plus `sandbox` with `allow-same-origin`.** The app document loads over a real `src` from its own `app-{hash}-{env}` origin, so the browser’s same-origin policy does the heavy lifting: Haven’s storage, DOM, and globals are simply not reachable, and neither is another app’s. `allow-same-origin` is not a hole here — it keeps the frame on *that* origin instead of dropping it to an opaque one. It has to stay, because an opaque-origin client gets no Cache Storage and no service worker, and the worker is the only server the bundle bytes have. The other sandbox tokens still apply: no popups unless granted, and no navigating an ancestor. Dropping `allow-same-origin` would not tighten anything Haven cares about; it would only break the mechanism that serves the app.
2. **Bridge.** Only mapped databases and views; permissions Haven already enforces. Communication with Haven stays on postMessage, never on Haven’s HTTP surface.
3. **CSP on the app document.** `script-src` and `style-src` allow `'self'` plus `'unsafe-inline'` (hosted `index.html` files ship an inline boot-recovery script). `default-src` is `'none'` so CSP3 resource hints (`prefetch` / `preconnect` / `dns-prefetch`) are not quietly allowed via the fallback union. `object-src` and `base-uri` are `'none'`. The allowlist widens `connect-src`, `img-src`, `font-src`, `media-src`, and `form-action`; `connect-src` always keeps `'self'` (a bundle-relative `fetch` must not die at CSP); `img-src` and `font-src` also always allow `data:`, because bundlers inline small images and fonts as base64, so the asset is part of the bundle rather than something fetched. `frame-src` stays `'self'` only — the network allowlist does not apply to nested frames, so `<iframe src="https://other.example">` never loads. The service worker stamps this policy (plus `Connection-Allowlist` for WebRTC and `X-DNS-Prefetch-Control: off` for hyperlink DNS prefetch) on every HTML response. Neither Haven’s outer iframe nor the wrapper’s inner iframe uses the `csp` attribute: Chrome Embedded Enforcement refused the app on Chrome 152 after `webrtc` left CSP. `'self'` on the explicit fetch directives is the app’s origin, not Haven.
4. **Wrapper document (hosted).** The app is not framed by Haven's page directly. Haven frames `__haven_frame__.html` on the app origin, and that wrapper frames the real entry. The wrapper's only job is containment: its CSP is `default-src 'none'` plus a `frame-src` naming this bundle's prefix, path included. Since `frame-src` is re-checked on *every* navigation of a child frame — not just the initial `src` — the app can navigate within its own bundle and nowhere else. Without this, a hosted app could set `location` to an off-allowlist URL and use the navigation itself as egress, because a document's own CSP never restricts where that document navigates itself and a worker only intercepts requests inside its own scope. Haven's page cannot host that directive itself: `frame-src` is document-wide, and Haven embeds arbitrary user-supplied URLs (web-content chicklets, YouTube) and `blob:` attachment previews in the same document. The app cannot escape by navigating the wrapper: the sandbox forbids ancestor navigation, which is what makes the wrapper's policy authoritative rather than advisory. The wrapper is transparent to everyone else: the SDK posts its handshake to `window.parent`, the wrapper forwards it up with the app's `MessagePort` transferred, and Haven answers over that port, so after the handshake the wrapper is not in the data path. A blocked navigation is reported on the wrapper rather than on Haven's page, so the wrapper relays it up as `haven-hosted-navigation-blocked` for the toast — the app is told nothing.

   That `frame-src` also has to name the worker's own script URL (`/sw.js`). The inner document is synthesised by the service worker rather than fetched, and Firefox checks the frame load against the URL of the worker that answered it instead of the URL that was requested; with only the prefix listed it blocks the app outright. It is a specific URL and not `'self'`, so nothing else on the origin becomes frameable.

   The wrapper is same-origin with the app, by design and unavoidably — it has to be served from the app origin to carry a `frame-src` about that origin's paths. So `window.parent.document` *is* readable from the app. What it yields is the wrapper: a document with no data in it whose entire content is one iframe. `window.top` is Haven and stays cross-origin.
5. **Service worker.** Runs on the app origin, not Haven's. Same-origin only under **this** bundle prefix. Cross-origin only if a glob matches. `403` outside that prefix and for a guessed `bundleId`. Same-origin navigations off the prefix are refused. On deny, the worker messages the installer frame, which relays to Haven (`haven-hosted-network-blocked`) so the host can toast.

**Iframe capabilities (default deny).** `allow-popups` is off unless `allowPopups` is set (needed for OAuth). Camera, microphone, and geolocation are Permissions-Policy gates: off means the iframe may not even ask. The browser still prompts the first time if you turn them on.

**Handshake.** `event.source` must be the iframe Haven created for that launch — with the wrapper in place, that is the wrapper frame, and the app's own handshake reaches Haven through it. `event.origin` must equal the expected app origin — a plain equality check, since the app has a stable origin of its own. The wrapper's `frame-src`, not this check, is what stops the app from navigating away. An already-open `MessagePort` dies with the old document.

**Fallback.** If no worker controls the client, the app has no server at all and does not start — there is no Haven-origin path left to fall back to. Bundle bytes live in Cache Storage on the app origin and the worker is the only thing that can read them, so a failed worker registration is a launch failure, reported as such, rather than a silently weaker sandbox.

**What holds**

- No mapped MindooDB data beyond the registration.
- No `fetch` / XHR / `img` / WebSocket / `sendBeacon` to a host that is not on the allowlist.
- No reading Haven’s storage, DOM, or globals, and none of another app’s. Enforced by the browser’s same-origin policy, because each app is on its own origin — not by a rule Haven has to get right.
- No HTTP to its own origin except this bundle’s asset prefix, so a guessed `bundleId` yields nothing.
- No navigating its own frame off the bundle. The attempt is refused before any request leaves the browser, and Haven is told which URL was attempted while the app is told nothing.
- Install hashes the zip; a tampered archive is not “the installed app”.

**What can still get out or weaken the box**

- A granted popup/OAuth checkbox. `frame-src` does not govern popups, so this is the one switch that reopens a general egress path.
- A service worker the app registers for itself — only when the registration has *Allow workers* ticked. The app policy now carries `worker-src 'none'` by default, which refuses all three worker kinds. Without it the chain falls through `child-src` to `script-src 'self'`, the bundle’s own script qualifies, and the app can put a worker over its own scope; being the deeper scope it would outrank the runner’s worker for that app’s pages, see every request they make, and — since worker scripts are served as bundle assets with no CSP header of their own — plausibly run its own `fetch` calls unpoliced. CSP has no service-worker-only source list, so the switch is all-or-nothing: an app that needs `new Worker` for off-thread work regains service workers with it. That trade is the reason it is a per-app capability rather than a hard block. The runner’s own worker is unaffected either way, because it is registered from the installer document, which has its own policy in `worker.ts` and never sees `buildHostedAppCspHeader`.
- Cookie scope. `mindoodb-apprunner.com` has to be on the Public Suffix List for the per-app origins to be separate cookie sites; until then they share a registrable domain. Nothing in the current design puts cookies there, but it constrains what may be added later. See §11 of [hosted-app-runner-origins.md](hosted-app-runner-origins.md).
- An over-broad allowlist (`https://*` or `*`).
- A host-wildcard allowlist entry (`https://*.example.com/*`). CSP3 resource hints are allowed if *any* fetch directive would allow the host, so `stolen-secret.example.com` is then a legal name. Prefer an exact origin (`https://api.example.com/*`) when the hostname could carry data. The service worker still applies the stricter glob for real fetches.
- A redirect on an allowed origin can reach a path you did not intend, because the CSP source is widened to the whole origin. Path-prefix patterns still help at the service-worker layer, which applies the stricter glob.
- Resource hints. Two different mechanisms. **Hyperlink prefetch** (`<a href="https://stolen.example">` without a click) is turned off by `X-DNS-Prefetch-Control: off` on the app HTML, the wrapper, the runner edge, and Haven itself. Chromium inherits the opt-out into child frames and then ignores a later `<meta http-equiv="x-dns-prefetch-control" content="on">`. That header is non-standard and does **not** cover `<link rel="dns-prefetch">` or `preconnect`. Those manual hints are supposed to hit the CSP3 resource-hint union (`default-src 'none'` plus the explicit fetch directives) and, in Chrome 152+, Connection-Allowlist. A `securitypolicyviolation` is the in-page signal; whether a resolver was queried is only visible in a DNS log. Firefox HTTPS pages already skip hyperlink prefetch by default.
- WebRTC, in Firefox and Safari. ICE traffic is a real egress channel: `connect-src` does not reach `iceServers` and the service worker never sees it, because ICE is not a `fetch`. A hostile app would name its own TURN server. Chrome 152+ closes this with the `Connection-Allowlist` header (`webrtc=block` by default, lifted by *Allow WebRTC*). The older CSP `webrtc 'block'` directive is still emitted for older Chromium, but current Chrome ignores it — that is why a Chrome 152 probe escaped before this header existed. Firefox and Safari honor neither. The Isolation tab points `iceServers` at a STUN server on no allowlist and reports `contained` only if no server-reflexive candidate comes back.
- External hosting: no allowlist and no wrapper containment. Restricted to loopback, so it is your own machine, but nothing is policed there.
- XSS or a malicious extension in the Haven page itself. Isolation is app-to-Haven, not “user malware vs browser”.

---

## 5) Appendix

**Pattern syntax.** Store glob strings. `*` is any run of characters. Examples: `https://api.open-meteo.com/v1/forecast*`, `https://*.open-meteo.com/*`. Matching is exact-glob in Haven’s code. CSP sources cannot express a mid-path `*`, so the header widens each pattern to its origin — `https://api.open-meteo.com/v1/forecast*` becomes `https://api.open-meteo.com` — or to a bare scheme for a host wildcard like `https://*`, which becomes `https:`. A host wildcard (`https://*.open-meteo.com/*`) becomes `https://*.open-meteo.com` in CSP and, because resource hints use the union of every fetch directive, allows a DNS name anywhere under that domain. Prefer the exact-origin form. A pattern the widening cannot express is dropped from the header. The service worker applies the stricter glob, so the path part of a pattern is enforced there and not in CSP.

**Weather example.** `https://api.open-meteo.com/*` is enough for the example app’s allowed preset.

**Example app.** [mindoodb-app-example](https://github.com/klehmann/mindoodb-app-example) — `havenBundle()`, relative `base`, a Network tab that probes `fetch`, XHR, and `img`, and an Isolation tab that tries to break out. The Isolation tab runs one probe per layer described above (self-navigation, sibling bundle, top and parent navigation, nested frame, popup, form post, parent DOM, storage, service worker, cross-bundle and Haven-page fetches, WebRTC), so it doubles as a live check that this document is still true. Run it in both hosting modes to see what external mode does not protect. The WebRTC and resource-hint probes are deliberately left out of the batch run: they are the ones that really send packets to a third party, so they have to be started on their own.

Two projects have hit the same wall from the same architecture and are worth reading before re-opening this: [Delta Chat's webxdc audit write-up](https://delta.chat/en/2023-05-22-webxdc-security), and [Peergos in Mozilla bug 1783489](https://bugzilla.mozilla.org/show_bug.cgi?id=1783489), whose comment 4 describes our exact setup — an untrusted app served by a service worker into a sandboxed iframe on an isolated subdomain — and names DNS prefetch and WebRTC as the only egress channels they know of. Both are covered by probes here. Note also comment 3 on that bug, from Mozilla's security team: "CSP never had the stated goal of preventing exfiltration." Treat CSP as the mechanism that governs *ordinary* network use, not as a leak-proof jail.

**Two probes used to report a pass as an escape**, because they were written against the old same-origin model. Both now target what their labels claim:

- *Read Haven’s DOM and URL* reaches for `window.top`, which is Haven and cross-origin, so it throws. It previously read `window.parent` — the wrapper, which is same-origin with the app by design and holds nothing but the app’s frame. The result still mentions the wrapper, so the distinction stays visible instead of looking like an omission.
- *Read localStorage* now expects storage to **work**. A real origin gets a real bucket; it is the app’s own, empty on first launch, and unreachable from Haven or any other app. The SDK’s Haven-backed storage shim is therefore a convenience for surviving reinstalls, not a workaround for missing storage.

*Register a service worker* was never answering anything either: it registered `./breakout-sw.js`, a file the bundle had never shipped, so it reported an installation error that read like a refusal. The worker now exists in `public/`, and the probe reports what actually happens — registration succeeds. It deliberately neither calls `skipWaiting()` nor claims the open page, and the probe unregisters it immediately, because a worker left in control would serve the bundle’s own asset requests and break the demo for whoever pressed the button.

**Why the wrapper is a separate document.** Two facts, both browser-verified rather than inferred. First, `frame-src` in the embedding document is checked on every navigation of a child frame, so it stops a frame from navigating itself — a document's own CSP does not. Second, the app's containment cannot live in Haven's page, because `frame-src` applies to the whole document and Haven legitimately embeds arbitrary URLs elsewhere on that page. The wrapper resolves both at once, at the cost of one extra frame, a single relayed handshake message, and a same-origin parent the app can read but which holds nothing.

**Why a separate origin rather than a stricter sandbox.** An opaque origin would be stronger on paper and does not work: it has no Cache Storage and no service worker, and the worker is the only server the bundle has. The per-app origin gets the same guarantee from a different direction — the app has a real, fully functional origin, it just is not anyone else's.

**Related.** [haven-handbook.md](haven-handbook.md) (sandbox / hosting mode), App SDK README (`havenBundle()`), [distributed-webapps.md](distributed-webapps.md) (apps that live in a MindooDB database, not Haven Cache Storage).
