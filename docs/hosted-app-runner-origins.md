# App-runner origins for hosted apps

Supersedes the single-origin hosted-app model described in [hosted-app-isolation.md](hosted-app-isolation.md), which this document exists to fix.

Status: the runner and the Haven-side launch path are implemented. Open items are marked as such — §11 (Public Suffix List) and the two wipe gaps in §4.

## 1) Why

Hosted app bundles are downloaded by Haven and stored in Cache Storage. Cache Storage is origin-scoped and is only readable through a service worker, and Chrome never makes a unique-origin document a service worker client. So a hosted app served out of Haven's own Cache Storage cannot have an opaque origin — the worker would never see its module, CSS or font requests, and the app would not load at all.

Haven currently resolves that by giving the app HTML a CSP `sandbox` with `allow-same-origin`. The app therefore shares Haven's origin. It can read Haven's `localStorage` and IndexedDB, reach `window.top.document` and Haven's JS globals, and register a service worker on Haven's origin. Network egress and self-navigation are still contained, but the origin barrier is not there. A hosted app is effectively trusted code.

The fix is to stop serving hosted apps from Haven's origin. Isolation should come from the origin itself, not from sandbox flags.

## 2) Shape

**Haven** keeps its origin: `haven.mindoodb.com` in production, `mindoodb-haven-develop.pages.dev` on develop.

**Every hosted app gets its own origin**, on a separate registrable domain so an app is cross-site to Haven rather than merely cross-origin. Same-site would leave domain-scoped cookies and some of the browser's partitioning behaviour treating the two as related.

The origin is derived deterministically from the `appInstanceId`:

```
app-<hash(appInstanceId)>-<env>.mindoodb-apprunner.com
```

`env` is `p` for production and `d` for develop, and it is a **suffix rather than a prefix** for a non-obvious reason — see the route patterns below.

This works because of two Cloudflare properties that hold on the free plan:

- **Workers support wildcard routes.** A proxied wildcard DNS record (`AAAA`, name `*`, value `100::` — the IPv6 discard prefix, meaning there is no origin server) plus the Worker route `*.mindoodb-apprunner.com/*` sends every subdomain to one Worker. Note that this is a *route*, not a Custom Domain: a Custom Domain binds one exact hostname to one Worker and cannot carry a wildcard, so it can neither express this nor be shared by the two environments. Cloudflare Pages cannot do this either; wildcard custom domains are on its known-issues list, which is why the app runner is a Worker rather than a Pages project.
- **Universal SSL covers the apex and one level of wildcard** — `*.mindoodb-apprunner.com` — automatically and for free. Exactly one level: `app-x.dev.mindoodb-apprunner.com` would not be covered and would need Advanced Certificate Manager.

Because the certificate only covers one level, the two environments are separated within the label rather than by a `dev.` prefix — `app-x-d.mindoodb-apprunner.com` stays inside the free wildcard, `app-x.dev.mindoodb-apprunner.com` would not.

One registered domain is enough. A Cloudflare route pattern belongs to exactly one Worker, so the two environments cannot both claim `*.mindoodb-apprunner.com/*`; they claim `*-p.mindoodb-apprunner.com/*` and `*-d.mindoodb-apprunner.com/*`, which keeps a develop deploy from touching production apps. A second registrable domain would buy nothing further: it would not separate cookies between apps within one environment, which is the actual residual risk (§11).

**This is why the environment marker goes last.** Cloudflare route patterns allow `*` only at the *beginning* of a hostname and reject infix wildcards outright, so `app-p-*.mindoodb-apprunner.com/*` is refused at deploy time with API error 10022 while `*-p.mindoodb-apprunner.com/*` is accepted. The label shape is therefore dictated by the routing layer, not chosen for looks; `appRunnerOrigin.ts` pins it with a test so it does not get "tidied" back into a prefix.

Deriving the origin from the `appInstanceId` rather than allocating from a pool means an app's origin never changes: its `localStorage` and IndexedDB are durable, the bundle is pushed into that origin once rather than on every launch, and there is no allocator, no LRU eviction, and no recycling to get wrong.

## 3) What the app runner serves

A Worker with Static Assets, deliberately tiny, containing **no Haven UI code at all**. That is a property worth protecting: a compromise inside an app cannot reach Haven's bundle, because Haven's bundle is not on that origin. Request volume is negligible — the Worker only ever answers the files below, since everything else is served by the service worker out of Cache Storage.

- `sw.js` — scope `/`. Serves `/__mindoodb_hosted_apps__/{bundleId}/*` from this origin's Cache Storage, applies the app CSP to HTML, and enforces the network allowlist. This is today's `hosted-apps-sw.js` / `hostedNetworkEnforce.ts` logic, moved.
- `__haven_installer__.html` and `installer.js` — a hidden iframe Haven embeds to manage this origin. It is the only way bytes get onto it, and it stays mounted for the life of the launch so it can relay worker messages up to Haven (see §7). Served with `frame-ancestors` naming the Haven deployment, so no other site can embed it and drive the protocol.
- `chunks/*` — the policy modules both entries share, content-hashed.
- A catch-all returning plain-text `404`. Nothing here may ever answer with HTML for an unknown path; that is the bug that produced Haven's rescue page inside the app frame. A request that reaches the Worker under the bundle prefix means no service worker is controlling that client yet, and 404 is the only correct answer.

`/` itself is deliberately empty.

The installer's postMessage API. Haven addresses it with an explicit `targetOrigin`, and it answers only to the ancestor origin passed in its query string:

- `ready` (unprompted, on load) → `{ controlled, version }`
- `list` → `{ bundleIds }`
- `install({ bundleId, files, final })` → writes Cache Storage, bytes transferred as `ArrayBuffer`s in size-capped batches
- `policy({ bundleId, patterns, allowPopups })`
- `delete({ bundleId })`
- `relay` (unprompted) → forwards a worker message verbatim

### Where the code lives

The runner is its own repository and its own deployment: **`mindoodb-haven-apprunner`**, a sibling checkout, deployed by Cloudflare Workers Builds on push.

It enforces the policy Haven writes, so the CSP builder, allowlist matcher, wrapper document and wire protocol are shared rather than reimplemented — that reimplementation is exactly how `public/hosted-apps-sw.js` drifted from the TypeScript it was transcribed from. They are **generated** into `src/vendor/` by `mindoodb-haven/scripts/apprunner-vendor.mjs`, which rewrites the `@/` import specifiers and records a hash manifest on both sides.

Three guards, because they catch different failures:

| Guard | Catches | Runs in |
| ----------------------------- | ----------------------------------------------- | ------------ |
| `apprunner-vendor.mjs --check` | policy changed, runner copies not regenerated | Haven CI |
| `check-vendor.mjs` | a generated file edited by hand | runner CI |
| `APP_RUNNER_PROTOCOL_VERSION` | Haven and the *deployed* runner disagree | runtime |

The third matters most and is the reason a shared repository would not have been enough: Haven and the runner deploy independently regardless of how the source is arranged, so a live version mismatch is normal rather than exotic. The installer reports the version it was built with in its `ready` message, and Haven refuses to launch on a mismatch with an operational error rather than a blank frame.

## 4) Haven keeps the master copy

Haven's own Cache Storage stays the canonical store for downloaded bundles. It keeps doing the manifest polling, the download, the hash verification, the backup and restore, and the inventory — unchanged. App origins are **derived caches**, populated by pushing bytes Haven already holds.

This is the single most useful simplification in the design. `hostedBundles.ts` keeps its current responsibilities and gains a push step, instead of every path through install, restore and inventory having to reach across an origin boundary. It also means the publisher's CORS headers stay pointed at Haven alone: Vega and the example app need no `_headers` change, because an app origin never fetches the publisher.

Two places have to reach across the boundary, and **both are only partly done**.

Uninstall deletes the bundle from the app origin and drops the installer frame, but only for an origin already brought up in this session — provisioning one purely to empty it would register a service worker for an app being removed. It also does not touch what the app itself wrote: its `localStorage` and IndexedDB survive, because deleting those needs a `wipe` command the installer protocol does not have yet. Adding one means bumping `APP_RUNNER_PROTOCOL_VERSION` and deploying both sides.

Factory reset does not wipe app origins at all yet. Doing so needs the same `wipe` command plus a persisted list of every origin Haven has ever provisioned, since a wiped registration list no longer says which ones existed.

Until both are closed, an app's own storage outlives its uninstall, and an app reinstalled under the same `appInstanceId` inherits it.

## 5) Launch sequence

1. Derive the app origin from the `appInstanceId`.
2. Mount the hidden installer iframe for that origin, or reuse one already mounted.
3. `hello`, and check the protocol version. Haven and the runner deploy independently, so a mismatch is possible and must produce a clear error rather than a blank frame.
4. `status`. If the bundle is absent or its `contentHash` differs, `install(...)` with the files and the allowlist policy, transferring the bytes as `ArrayBuffer`s.
5. Point Haven's iframe `src` straight at the wrapper URL on the app origin, sandboxed (see §6).

The `srcdoc` wrapper is retired. It only ever existed because a unique-origin frame is not a service worker client, so the wrapper document could not be fetched through the worker and had to be inlined by Haven. On the app origin the frame keeps a real origin, the worker controls it, and the wrapper is served from a normal URL again.

Steps 2 through 4 happen once per app and bundle version. Later launches go straight to step 5.

## 6) What changes in the isolation model

An app becomes cross-site to Haven and cross-origin to every other app. No Haven DOM, no Haven storage, no reaching another app's storage or DOM.

Cookies are the exception, and they are not covered by any of this — see §11.

**The HTML `sandbox` attribute comes back, and this is the crux of the design.** Haven's outer iframe is sandboxed again, `allow-same-origin` included. That token was poison on Haven's origin — it is what made a hosted app same-origin with Haven and handed it Haven's `localStorage` and DOM. Here it means *the app keeps its own origin*, which is an app runner subdomain and not Haven. So the same token that broke isolation before is what provides it now, and it is also what lets the worker control the frame.

That resolves the dilemma the single-origin model could not: previously, isolation (unique origin) and working asset delivery (worker control) were mutually exclusive, and the interim fix chose delivery. On a separate origin both hold at once.

Because the sandbox is on the outer iframe it covers the wrapper and the app alike, and it is what denies top-level navigation and popups — which a cross-origin frame could otherwise do with user activation. CSP `sandbox` stays on the app HTML as defence in depth for the case where the app document is somehow loaded outside Haven's frame. The inner iframe's `csp` attribute keeps carrying only the network directives and never `sandbox`.

The wrapper keeps containing self-navigation through `frame-src`, and gains one check: verify `event.origin` is the expected app origin before relaying the handshake upward.

`frame-src` has to name the worker script URL alongside the bundle prefix. The inner document is synthesised by the service worker rather than fetched, and Firefox checks that frame load against the URL of the worker that answered it, not the URL that was requested — with only the prefix listed, Firefox blocks the app outright and reports `/sw.js` as the blocked resource. Confirmed by A/B in Firefox; Chromium does not need it. The source is a specific URL and not `'self'`, so the app still cannot frame anything else on its origin, and `/sw.js` is a script file that a frame cannot escape through.

Testing any change to that policy needs the worker unregistered, not just reloaded: the worker that generates the header is the one whose own update is at stake, and neither a reload nor `registration.update()` swaps it reliably. A correct fix can look like a failure for that reason alone.

`script-src` keeps `'unsafe-inline'` for the boot-recovery script hosted `index.html` files ship. That is a far smaller concession once the document is fully origin-isolated.

The bridge guard gets simpler and stronger. `launch.targetOrigin` becomes the app origin, and the opaque-origin special cases in `hostedFrameStillOnBundle` — the `"null"` origin, the `about:srcdoc` handling — can be replaced with a real origin comparison. The service worker's "403 for Haven's own origin" special case also disappears, because a request from an app to Haven is now plainly cross-origin and denied by the allowlist default.

## 7) Network allowlist enforcement

Both existing layers survive, and both get stricter.

**CSP on the app HTML** keeps widening `connect-src`, `img-src`, `font-src`, `media-src` and `form-action` to the allowlist's origins. The difference is that `'self'` now resolves to the app's own origin, which holds nothing but its bundle. Today `'self'` is Haven, so `connect-src 'self'` implicitly permits the app to reach Haven's HTTP surface, and the worker has to special-case a `403` for Haven's origin outside the bundle prefix to close it. That case disappears: a request from an app to Haven is cross-origin and denied by the default.

**The service worker** keeps applying the stricter glob, including the path part that CSP cannot express. This is where the change matters most. A unique-origin document is never a service worker client, so on today's sandboxed path the worker sees nothing and only the origin-level CSP applies. As a normal same-origin client of its own origin's worker, an app's `fetch`, XHR, `sendBeacon`, images and fonts all pass through it, so a pattern like `https://api.open-meteo.com/v1/forecast*` is enforced as written.

Requests to allowed third parties now carry a real `Origin` header — `https://app-<hash>.mindoodb-apprunner.com` — instead of `Origin: null`. Many APIs reject `null` outright, so this removes a class of "works in external mode, fails when hosted" failures.

**Deny reporting has to be rerouted.** `useHostedNetworkBlockToast` currently listens on `navigator.serviceWorker`, which works because the enforcing worker is on Haven's origin. Once it moves to the app origin, its clients are the app frame and the installer frame, never Haven's window. The worker therefore posts the block to the installer frame, which relays it cross-origin to Haven, where it is handled by the same window-message path the `haven-hosted-navigation-blocked` toast already uses. The `navigator.serviceWorker` listener can then be dropped.

The unchanged caveats: a pattern with a mid-path `*` is still widened to its origin in the CSP header (the worker applies the stricter form), a granted popup remains the one general egress path, and WebRTC is not covered by either layer.

## 8) Migration

Transparent, on next launch. Haven already holds the verified bytes in its own Cache Storage, so migrating an installed app is a push to its derived origin with no re-download and no user action.

Once the runner is live, hosted-prefix handling comes out of Haven's `sw.ts` and `public/hosted-apps-sw.js` moves to the runner project. That removes the hosted-app serving surface from Haven's origin entirely, which is the point of the exercise.

Worth keeping the current same-origin path behind a flag until the runner is confirmed working.

## 9) Development

Two dev servers: Haven's Vite on `:4174` and the runner's `pnpm dev` on `:5174`. A different port is a different origin, so the boundary is real locally rather than simulated.

The runner's dev server is `wrangler dev` over a `vite build --watch`, not a static file server. The 404 catch-all, `Origin-Agent-Cluster` and the installer's `frame-ancestors` all live in the Worker, and those are precisely the parts worth exercising — a static preview would skip all three, including the 404 whose absence caused the original bug.

For per-app origins, Chrome and Firefox resolve any `*.localhost` name to loopback and treat the whole space as a secure context, so `app-<hash>-d.localhost:5174` gives the same one-origin-per-app shape against a single dev server, service worker included. Safari may need `/etc/hosts` entries per app.

Haven's `vite.hostedAppsDevPlugin` is gone, along with the `/__mindoodb_hosted_dev__/*` endpoints and the client-side republish that fed it. It existed only to serve bundle assets to an opaque-origin iframe that no service worker would ever control — a dev-only reimplementation of the worker, with its own drift risk. The app origin's real worker now does the job in development exactly as in production.

## 10) Residual risk

- Every app origin is served by one Worker deployment, so a compromise of that deployment affects every app. The Worker is tiny and contains no Haven code, which is the mitigation.
- An app still gets `'unsafe-inline'` inside its own document.
- The allowlist, popups, and WebRTC caveats from [hosted-app-isolation.md](hosted-app-isolation.md) are unchanged; this design addresses the origin boundary, not those.
- App origins accumulate browser storage, one per installed app, and the wipe paths that would reclaim it are incomplete — see §4. Today that data outlives the app.
- Apps can talk to each other through cookies scoped to the shared registrable domain — see §11.

## 11) Cookie boundary and the Public Suffix List

**Open item. Nothing in the implementation depends on it, and it is not done.**

Every app origin is a subdomain of one registered domain. The same-origin policy separates them for storage, DOM and workers, but cookies do not follow the same-origin policy — they follow the *registrable domain*. Any app can therefore set

```
Domain=mindoodb-apprunner.com
```

and every other app, in both the production and develop environments, can read it. This is the one channel the origin split does not close.

Scope of the problem: it lets two apps collude or correlate a user across each other. It does not reach Haven's data, which stays behind the per-launch `MessagePort`, and it does not depend on the two-environment split — all production apps share one registrable domain regardless of how many domains we buy, so buying more does not help.

Two mitigations:

**Shipped.** The Worker sends `Origin-Agent-Cluster: ?1` on every response, which forces an origin-keyed agent cluster and removes `document.domain` as a way for two sibling subdomains to reach into each other directly. It also sends `X-DNS-Prefetch-Control: off` on every edge response; the service worker repeats that on wrapper and app HTML so Chromium inherits the opt-out into the app frame.

**Not started: submit `mindoodb-apprunner.com` to the Public Suffix List.** A PSL entry makes browsers treat each subdomain as its own registrable domain, so `Domain=`-scoped cookies become unsettable across apps. This is what `pages.dev`, `github.io` and `workers.dev` do, and for the same reason: one registered domain hosting mutually untrusted content.

Cost and constraints, which are the reason this is filed rather than done:

- The list is maintained by volunteers who state explicitly that there are **no service-level agreements and no ETA**. Months is normal. A submission that gets the template or the alphabetical sorting wrong is closed or left pending rather than corrected for you.
- After a merge, consumers bundle their own snapshot, so browsers pick it up on their normal release cadence — another cycle or two before the behaviour actually changes.
- Private-section entries require **more than two years** remaining on the registration at submission time, plus a commitment to keep it above one year. A freshly registered one-year term does not qualify and has to be extended first.
- Authority is proven with a `_psl.mindoodb-apprunner.com` TXT record containing the pull request URL. This is the strongest signal available and materially speeds up review.
- It is awkward to reverse: removal is also a volunteer-reviewed change, and older browsers keep the old list for as long as they are in use.

Because of the lead time it is worth filing early even though nothing blocks on it. The alternative is a deliberate decision to accept an inter-app cookie channel, which is defensible — it should just be a decision rather than an oversight.
