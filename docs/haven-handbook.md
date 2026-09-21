# The Haven Handbook

A complete, friendly guide to MindooDB Haven — the browser-based workspace for encrypted, local-first collaboration on MindooDB.

This handbook walks through everything Haven does, in the order you are likely to encounter it. It is written for three overlapping audiences: everyday users who spend their time in the Workspace, team admins who set up tenants and register apps, and platform admins who run a MindooDB server. You do not have to read it front to back. If you already know the basics, the section headers will let you jump straight to what you need. If you are brand new, start at the beginning and follow the first-ten-minutes walkthrough.

## What Haven is and why it exists

Haven is the visual front door to MindooDB. MindooDB on its own is a database engine: it stores encrypted documents on a server somewhere, syncs them across devices, and keeps a cryptographically signed history of every change. Haven is the graphical workspace you actually look at. It runs entirely in a web browser, bundles everything you need to use MindooDB day to day, and keeps your data on your own device whenever it can.

A few things make Haven different from a typical web app.

Haven is local-first. Almost everything you see is served from a copy — a local replica — stored inside this browser. Browsing, editing, searching, and even building virtual views all happen against the local replica, so Haven is fast and stays usable when the network is gone. The server is only contacted when you sync, and the data on the wire is always end-to-end encrypted.

Haven is a progressive web app. It can be installed on phones and tablets, including iPhone, iPad, and Android, and launched directly from the home screen like a native application. Once installed, it opens in standalone mode without browser chrome, which gives you more screen space and a calmer feel. On iPhone you can even add Haven to your home screen more than once — each installed copy gets its own private storage, which is a clean way to keep personal, work, and demo data fully separate on a single device.

Haven is a runtime home for MindooDB apps. MindooDB apps are small web tools built with the MindooDB App SDK. Haven launches each one inside a sandboxed iframe on a separate origin, hands it a scoped view of the data you chose to share, and brokers every read and write through a secure bridge. Hosted apps can even be served by Haven's own service worker and keep running when the network is gone.

Haven ships with light and dark themes that follow the system preference by default and can be toggled manually. The active theme is propagated live to any MindooDB app that runs inside Haven, so embedded apps automatically match Haven's look without any extra work.

Underneath all of this is the same promise MindooDB makes everywhere else: keys stay on devices, servers only ever see ciphertext, and a complete server breach still yields nothing readable. Haven is designed to be the most convenient way to live with that promise.

## Core ideas in five minutes

If you understand these handful of words, the rest of the handbook reads naturally.

A user identity is your account inside Haven. It is a locally encrypted file that holds your public details and your encrypted private keys, unlocked either by a passkey on your device or by a password you chose. Identities are created locally in your browser and never leave it unless you choose to export them. Haven can keep several identities side by side and switch between them from the top bar. Losing every secret that unlocks an identity is permanent — there is no reset link, because nobody outside your device has the key.

A tenant is your team's private workspace inside MindooDB. Everyone who can see a particular set of databases is a member of the same tenant. Tenants contain a directory database (where user registrations and tenant-wide settings live), one or more application databases, and a set of encryption keys. Tenants are created entirely client-side and can be published to a server when you are ready to collaborate.

A local replica is the browser-local synced copy of a tenant's databases. This is what makes Haven feel instant. Working from the local replica is fast, works offline, and is the recommended way to browse and edit.

A database is a collection of related documents inside a tenant — contacts, invoices, notes, whatever the team needs. A document is one item inside that database. Every document is an Automerge CRDT, which is the technology that lets two people edit the same document at the same time and have their changes merged automatically without a conflict dialog.

Every change to a document is signed with the author's private key and appended to the document's history. Each change is also cryptographically linked to the change that came before it, a bit like a blockchain, so the chain of edits forms a tamper-evident sequence rather than a bag of loose revisions. That history is what Haven shows in the Database Browser and the Document History view. Because changes are signed and chained, nobody can quietly rewrite the past: altering or dropping an earlier change would break every link that follows.

A KeyBag is a local, encrypted store of the encryption keys a tenant needs, opened by the identity that owns it. Each user keeps their own KeyBag in their browser. A default key is shared with every member of a tenant; named keys are extra keys that can be given to a smaller group for sensitive documents.

A virtual view is a spreadsheet-like tree that filters, categorizes, sorts, and totals documents. A view can pull from one database, several databases, or even several tenants, which is how you answer questions across data rather than just inside one database.

The Workspace is made of tiles on pages, grouped into groups. A tile — sometimes called a chicklet — is a draggable, resizable card that opens a database, launches an app, or shows a note, a web page, a video, or a diagram. A page is a tab full of tiles. A group clusters related tiles under a shared, color-coded header.

An application registration is the saved Haven-side definition of a MindooDB app: where it lives, how it runs, and which databases or views it is allowed to see. When an app launches, it talks to Haven through a bridge (sometimes called the app connector), which is the secure channel that lets Haven enforce the permissions you granted. The sandbox is the browser-enforced isolation that prevents an app from reaching Haven's storage, cookies, or other apps.

Those are the pieces. Everything else in Haven is a screen for working with them.

## Getting around Haven

Haven puts everything on one surface. A slim top bar runs across the top, and below it sits the Workspace — the page you start on, come back to, and navigate from. There is no sidebar and no separate menu tree to learn.

The top bar is the same on every screen. On the left, the MindooDB Haven wordmark is a link back to the Workspace from wherever you happen to be. On the right sit two things: an identity chip showing the currently active user, and a Help button. Press the chip to open the identity switcher; right-click or long-press it for a quick menu that flips between light and dark mode or locks the session. The Help button opens a contextual help drawer for whatever screen you are on. Every screen has its own article, written in the same friendly style as this handbook, plus a short spotlight walkthrough that highlights the controls worth knowing — if you ever feel lost, that button is the first thing to try. On a phone or tablet, Haven will occasionally nudge you from the top bar to add it to your home screen.

The Workspace opens on a tab called Start, and Start is Haven's front door. Across the top of it runs a row of six shortcut tiles, one for each of Haven's own screens: Setup wizard for a new environment, Haven App Store, Sync with server, Quick Scan, Virtual Views, and Preferences. Each gets its own section later in this handbook. Below the shortcuts, Start lists one tile for every application you have installed, so it doubles as the catalog of what is available to you. Double-click any tile to open it, or use the ⋮ button in its corner for the actions belonging to it.

Start is deliberately fixed. The six shortcuts are always in the same place and cannot be moved, removed, or rearranged, and Start is not where your own tiles go — it is the one page you can rely on looking the same tomorrow. Everything you arrange yourself lives on the pages you create next to Start, described under Workspace below.

The App Drawer is how you move between the things you have open. Whenever an application is running or a Haven screen is open, a small arrow handle appears at the top of the content area; clicking it slides down a drawer in two parts. Views lists the Haven screens you have open — Sync, Preferences, Virtual Views, the setup wizard — and Apps lists the MindooDB applications currently running. Above both sits a Back to Workspace entry. From an application's tile in the drawer you can also sync that app's local databases against the server, reload it, open an info dialog, or close it.

Two shortcuts make the drawer worth learning properly. Cmd+Shift+Enter returns you to the Workspace from anywhere, including from inside a running application, and Cmd+Shift+Space opens and closes the drawer. On Windows and Linux, press Ctrl instead of Cmd. Haven forwards both to embedded applications, so they keep working even when an app has the keyboard focus.

What you open stays open. Launch an application or open the Sync page, wander off somewhere else, and it is still sitting in the drawer when you come back, with its scroll position, unsaved edits, and open tabs untouched.

When you install Haven on a phone and launch it from the home screen, it opens in standalone mode, which removes the browser's address bar and tab strip. Certain screens inside Haven — mostly immersive ones like a full-screen running app — also hide the top bar for the same reason.

## Your first 10 minutes

The first time you open Haven there is nothing to find and nothing to configure: it takes you straight into the setup wizard, which turns the whole beginning — identity, admin, tenant, or joining an existing team — into a short guided flow. Haven decides this by looking at the device. Once it finds both a named user identity and a tenant, opening Haven lands you on the Workspace; until then it lands you in the wizard. You can return to it whenever you like from the Setup wizard for a new environment tile on Start, which is also how you add a second tenant later on. Everything the wizard does can be done by hand through Preferences → User ids and Preferences → Tenants, but the wizard is by far the easiest path, so use it whenever you can.

The wizard opens with a short pitch (end-to-end encrypted, local-first, zero-trust servers) and three big buttons: Create a tenant, Join a team, and Open tenants. Below those, two cards explain what each path actually does. If Haven already has an unlocked identity, a small banner tells you so — the wizard will happily reuse it and skip the identity step if you want.

### Path one: starting your own tenant

If you are starting fresh, press Create a tenant. The wizard walks you through four steps on a single page.

Step one, create your personal user identity. This is your account inside Haven — a small, locally encrypted file that holds your public details and your encrypted private keys. You can either reuse the identity that is already unlocked in the top bar, or create a brand-new one by entering a username (for example `cn=user/o=acme`).

Then pick how you want to unlock that identity from day to day. Haven pre-selects Passkey when your browser supports it, because it is both the easier and the stronger option: your device asks for Face ID, Touch ID, Windows Hello, or a security key, and derives the key that opens your private keys locally. Password is the alternative, and it is the right choice on a shared device where someone else knows the unlock code, or when you want the same identity to work in the console. Either way the secret stays on this device — there is no recovery flow and no server that can unlock your identity for you, so save whichever secret you chose before you continue. You can add the other method later from Preferences → User ids.

Step two, set up a separate admin identity. MindooDB deliberately keeps the tenant admin and the everyday app user apart, so that a single compromised secret cannot take over both directory management and day-to-day document work. You choose here how the admin identity is protected: have Haven generate a six-word passphrase, or type a password of your own with the usual repeat field. The generated one is shown once, with buttons to copy it or download it as a text file, and a checkbox confirming you have saved it so you cannot skip past it by accident. Either way it is deliberately not a passkey: an admin you can only unlock with this device's Face ID is an admin you lose together with the device, and admin work is exactly what you need after replacing a laptop. Keep it where you keep your other emergency credentials.

Step three, create the tenant itself. Haven generates the tenant id for you, and it cannot be changed afterwards. That is deliberate: once several teams share a MindooDB server, tenant ids have to be unique, and an id somebody typed by hand is an id that eventually collides with somebody else's. What you do choose is the tenant label — a short, memorable name so you can recognise this tenant later — and any admin can rename it at any time, because the label is only there for humans. Haven then generates the tenant's encryption keys, a default key for your content and a second one for the access directory, stores them in your local KeyBag, and wires up both identities. Everything stays locally in your browser at this stage; nothing has been pushed to a server yet.

Step four, you are all set. Haven drops you into your empty Workspace, already unlocked, already inside the new tenant. When you are ready to collaborate, publish the tenant to a MindooDB server: the Sync page offers a Push to server button for any tenant that is still local-only, and the same thing lives in Preferences → Tenants.

### Path two: joining an existing team

If a teammate has already set up a tenant on a MindooDB server, press Join a team instead. The wizard uses the same four-step layout but follows MindooDB's three-step join handshake, where your private keys never leave this device.

Step one, create your personal user identity (or reuse the active one), just like in the other path.

Step two, send a join request. Haven builds a join-request URL from your public keys — no secrets — and shows it to you with a Copy URL button. Send that URL to the tenant administrator through any channel you like (email, chat, a ticket system); it is safe to share openly because it contains only your public keys. The administrator will open their Haven, run Grant tenant access on your request, and send back two things: a join-response URL and a short shared password. Important: the shared password must come through a separate, secure channel — a phone call, a different messenger, or in person — because the response carries the encryption keys for the workspace.

Step three, complete the join. Paste the join-response URL into the wizard, enter the server URL that hosts the tenant (there are one-click shortcuts for known servers), and type the shared password the administrator gave you separately. Haven validates the server, pulls the initial directory data, and adds the tenant to your Haven.

Step four, you are in. Haven drops you into the freshly joined tenant and the Workspace is ready to fill with tiles.

### After the wizard

Once the Welcome wizard is done, the day-to-day path is the same whichever route you took.

Open the Workspace. Start already has its six shortcut tiles; what it does not have yet is anything of yours. Add a page next to Start from the Add menu, then use the same menu to put a database tile on it pointing at one of the databases in your tenant. Double-click the tile to open the Database Browser and see its documents.

Install an app. Open Haven App Store from Start, pick something that looks useful, and install it. It appears as a tile on Start straight away, and you can place it on one of your own pages from there.

Run a sync. Open Sync with server from Start and press Sync All, or use the per-row Sync if you only want to refresh a single database. Once the status column shows a green check, your local replica is up to date with the server.

Come back to the Workspace and keep adding tiles — applications, notes, web pages, dashboards, anything that makes your workspace feel like home.

If any step feels abstract, open the Help button on that screen. The in-app help has a "spotlight" walkthrough that highlights exactly what to click. And you can always reopen the setup wizard from its tile on Start — it is happy to reuse an existing identity or help you create additional ones.

### Haven is multi-tenant by design

Nothing stops at one tenant. The Welcome wizard can be run again at any time, and each new tenant is cryptographically independent from every other — its own encryption keys, its own KeyBag entry, its own admin chain, its own signed history. That independence is what makes it safe to keep very different contexts under one roof.

A common setup is to run three or four tenants in parallel: one for work, one for personal topics like household planning or a side project, and another one shared with a partner company for cross-organisation collaboration. You can use the same user identity across all of them or create a dedicated identity per tenant — the choice is yours, because nothing links the tenants together except the fact that they happen to live in the same browser.

Haven is genuinely multi-tenant, not single-tenant-with-switching. You can have several tenants unlocked and active at the same time, mix their data inside a single workspace page, and map databases from different tenants behind separate logical handles to the same application so it can work across organisational boundaries without ever seeing more than it should. Virtual views take this one step further: a single view can pull from several databases across several tenants and categorize, sort, and total their documents as if they were one data set. For example, a personal planning view can combine your private to-do list with the work tasks assigned to you in the company tenant, even though the two data sets are encrypted with completely different keys and synced to completely different servers.

Add tenants whenever a new context appears. Leaving them side by side is cheap, and the cryptographic separation means you never have to worry about data leaking from one into another.

## Using Haven on more than one device

Haven keeps your data in the browser it runs in. That is what makes it fast and what keeps your keys off other people's servers, but it also means a second browser — Safari on your iPhone, a work laptop, another installed copy of Haven on the same phone — starts out as a stranger. It has its own storage, its own device keys, and no way to read anything until a device you already trust lets it in. This section is about that moment.

Two different permissions are involved, and keeping them apart is what makes the model safe. The first is permission to sync: a tenant admin grants your username access, and from then on the server is willing to hand your devices encrypted data. The second is permission to read: the keys that turn that ciphertext back into documents. A server can grant the first, because it is only moving bytes around, but it can never grant the second, since it has never held a key. So a brand-new device can finish a sync, hold every byte of a database locally, and still have nothing in it that it can read. Haven never lists a document it cannot decrypt, so the symptom is not a row that refuses to open: it is a database that looks empty, or a view that is much shorter than you expected, on a device that just reported a successful sync. That is not a bug and not a half-finished join; it is the design, and the banner described below is what tells the two apart. The Database Browser also puts a number on it: its heading counts the documents you can read and, when this device holds documents your keys cannot open, says how many are hidden — "Documents (3) · 7 hidden" is a device that has ten and can read three. The number counts what has arrived here, not what the tenant holds, so it grows as a sync brings more in.

What bridges the gap is your user key. Every person in a tenant has exactly one — an encryption keypair that belongs to you rather than to a device or to the tenant itself. Its public half is published inside the tenant so teammates and admins can encrypt for you, which is how the tenant's default key reaches you in the first place. Its private half exists only on the devices you have approved. Approving a device means writing one more copy of that private half into the tenant's user directory, wrapped so that only the new device's own key can open it. The server stores and relays that copy like everything else, without ever being able to read it.

On the new device you will see a banner along the bottom of the screen: This device is waiting for approval. It names which access is stuck — for example "Tenant acme · on Server1/ACME", where the second half is the server's own canonical name, the same one the Servers tab shows, falling back to its address if it never reported one — because the same tenant can be synced through more than one server at once, and a bare "waiting" tells you nothing in that situation. Underneath, it names the keys you are missing, so you know what will come back when the wait is over: documents that need the default key stay hidden until then. If you joined several tenants from this device, a line tells you how many more are queued behind this one. The banner deliberately sits on every page rather than only in the workspace, because a device without keys is locked out everywhere and the way out has to stay in reach. Check again re-reads the directory on the spot; Open restore leads to the last resort described at the end of this section.

On a device that is already approved, the other half of the handshake arrives as a dialog shortly after you unlock: Approve a new device. It shows the device's label, the same tenant-and-server line so you can see what you are about to hand out, and when the device was added. Approve this device writes the wrapped copy of your user key and pushes it out. Not now postpones the question until the next time Haven starts, which is the right answer when you are mid-task and the device is genuinely yours. Don't ask again is the firm answer: the device is recorded as declined, every approved device stops asking about it, and it appears as Hidden in your device list. Declining does not throw the device off the tenant — it can still sync — it simply never receives keys, so everything it syncs stays invisible to it. When several devices are waiting, Haven asks about them one at a time.

Approval travels through the tenant's user directory, which makes it a sync rather than a live handshake. The two devices never talk to each other directly and the approving device does not have to stay open: the approval is written, pushed to the server, and picked up by the waiting device the next time it pulls — on the next directory sync, when you press Check again, or when Haven next starts. If neither device can reach the server, nothing moves until one of them can.

Preferences → User ids has the full picture under Your devices, and that is where you go when a dialog was dismissed or a decline needs undoing. Each row is one device with its label, when it was added, which tenant it belongs to, and its status: Approved, Waiting for approval, or Hidden. Waiting devices get an Approve button, hidden ones an Allow anyway button that puts the device back into the waiting state so it can be approved normally. One rule surprises people the first time: approval has to come from a device that is already approved. A device still waiting for its own approval sees that sentence instead of a button and cannot let itself in — if it could, the whole mechanism would be decoration. It also means the second device on a published tenant has to be approved from the first one, so approve it while you still have both.

If a tenant was never published, none of this appears. There is no user directory on a server to consult and no other device to ask, so the first device seals its own user key and gets on with it. The flow starts mattering the moment a tenant lives on a server and a second device shows up.

There is one more case where Haven asks nothing at all. If you grant the join request for your new device yourself, from a device that already holds your user key, the copy is written as part of granting access and the newcomer arrives able to read straight away. Silence is the good outcome there, not a missing step. It is when somebody else approves the join — a tenant admin registering you, typically — that the new device lands in the waiting state and needs one of your own devices to finish the job.

Sometimes Haven cannot tell. An amber banner saying Haven could not yet tell whether this device is approved means the user directory could not be read at all — usually because the server is unreachable — rather than that somebody declined you. Check the network and press Check again. Where re-checking could never change the answer, Haven stays quiet instead of leaving a banner up forever.

The one situation this flow cannot repair is losing every approved device at once, because then nobody is left to approve the replacement. That is what the tenant recovery printout on the Backup tab is for, and why the waiting banner links straight to the Restore tab. Print one per tenant while things are calm; the section on Backup and Restore explains what it holds.

## Workspace

The Workspace is your daily home. You arrange databases, applications, notes, web pages, videos, and diagrams as draggable tiles across multiple pages, like home screens on a phone. The layout is personal: by default it is stored only in this browser, so it loads instantly and works offline. If you want the same arrangement on your other devices, the Roamed workspace setting under Preferences → General saves it into your tenant, encrypted for you alone.

Pages are the tabs across the top of the Workspace. The first one is always Start, described under Getting around Haven: Haven's own six shortcuts plus a tile for every installed application. Start is read-only, so you cannot drop your own tiles on it or rearrange what is there, and it is the one page that always looks the same.

Everything else is yours. Add as many pages next to Start as you like — one per project, one per role, one for daily dashboards, one for personal links — each with its own grid of tiles. Right-click a page tab to rename, reorder, or delete it.

Tiles are the cards on the grid. Drag a tile by its header to move it, drag the corner to resize it, or right-click for the full context menu. Drop a tile onto another page tab to move it there. Drop a tile onto another tile to start a group.

Groups cluster related tiles under a shared, color-coded header. A group is a great way to keep the tiles for one project visually together — for example, the database, the running app, and a reference note for the same team. Right-click the group header to rename it, change its color, or ungroup the tiles back into normal cards.

Several kinds of tile live on the same grid.

A database tile points at one MindooDB database. Double-click it to open the Database Browser. Use the context menu to switch which copy of the database the tile is showing — a local replica for speed and offline, or a live server target for the freshest state. Database tiles remember the tenant, the database, and the source you last used, so they are also a handy bookmark back into the rest of MindooDB.

An application tile launches a MindooDB app, and two separate settings decide how it behaves. The tile's own Display mode is either Launcher, a card you double-click, or Embedded, which runs the app right inside the workspace card and is perfect for small glanceable tools like a capture form or a mini dashboard. The registration's Runtime mode then decides what a launch actually does: Embed in Haven opens the app full-width inside the Haven window, where the App Drawer handles switching, while Open in new window gives it a standalone browser tab — useful for a second monitor, or for reading Haven and the app side by side. Apps opened inside Haven keep running in the background while you navigate elsewhere, so their scroll position, unsaved edits, and open tabs are still there when you switch back.

Text tiles hold formatted notes. Web tiles embed any URL as a mini browser, which is how you keep a partner system or another team's dashboard next to the MindooDB data it documents. Video tiles play YouTube content for tutorials and walkthroughs. Mermaid tiles render live architecture diagrams and flowcharts right on the grid. These content tiles are personal — they live in this browser only — so they are ideal for cheat sheets, daily links, and live reference material.

A search bar across the top of the Workspace filters tiles across pages by name, database, tenant, tag, or server. On Start you can also sort what is listed there by last used, by tenant, or alphabetically, which becomes the fastest way to find something once you have installed more than a handful of applications.

## Applications and the Haven App Store

MindooDB apps are small web tools that run inside Haven with a scoped view of your data. Getting one is a single click in the Haven App Store; everything afterwards — launching, configuring, updating, removing — happens from the app's own tile on Start.

The Haven App Store is the catalog of ready-made MindooDB applications, and it opens as a dialog on top of the Workspace rather than taking you somewhere else. Browse the catalog, open an entry to read its description, screenshots, and version, then press Install. Haven asks which tenant the app should work in and what to call it, and Install now finishes the job. There is no registration form to fill in: Haven writes one for you from the catalog entry, grants the app the databases it declares, and the app appears as a tile on Start ready to launch. If a hosted app has a newer build waiting, the App Store tile carries a small badge with the number of available updates.

A registration is the saved contract between Haven and an app: Haven promises to launch it the way the registration describes and to expose only the data its mappings allow, and the app agrees to go through Haven's SDK connector for every read and write. Installing from the App Store produces one automatically, which is why most people never have to think about the concept at all. It starts mattering the day you want to change what an app is allowed to see.

Everything you can do with an installed app hangs off the ⋮ menu on its Start tile. Launch application starts it with the active user, or takes you into the existing session if it is already running rather than starting a second one. Configure application opens the registration for editing, which is where the hosting, runtime, and data mappings described below live; changes take effect the next time the app starts, and no code changes are needed in the app itself. About this application shows its metadata, such as the app id and current version. Check for updates appears on apps served from a hosted bundle and pulls a newer build if the publisher shipped one. Remove application uninstalls it again. The App Store tile carries one extra entry of its own, Import application, for bringing in a pre-packaged registration that did not come from the catalog.

Two things define how Haven serves an app. First, where the code lives. An external URL points at a dev server or a deployed web app running somewhere else; you will use this while developing or when another team hosts the app. A hosted bundle is a packaged set of web assets imported into Haven itself. Once stored locally, Haven can deliver the bundle through its own service worker, which means the app launches from local storage even when there is no network — this is the route to truly offline-capable apps. Hosted mode also applies a network allowlist you control; empty means no external network. See [hosted-app isolation](hosted-app-isolation.md) for the sandbox, the Vite plugin, and why local `vite dev` stays on an external entry URL. Second, how it runs. Embed in Haven runs the app in an iframe inside the Haven window, where the App Drawer handles switching. Open in new window launches it as a standalone browser tab instead, which is useful for a second monitor.

The part of the registration that actually protects you is the data mapping. For every database you want the app to see, you choose the logical name the app will address it by and the capabilities you are granting: read-only or read/write, whether to allow deletion, attachments, revision history, and the creation of app-defined virtual views. You can also map databases from different tenants or different servers behind separate logical handles, which lets a single app work across boundaries without ever seeing more than it should.

When an app launches, it does not talk to MindooDB storage directly. It calls the SDK connector, which opens a session with Haven, and every read, write, query, attachment operation, or history call flows through that connector. Haven validates each request against the mapping and permissions you configured, so even if the app tried to misbehave, the bridge would refuse.

Registrations travel as JSON packages. Export application, inside the Configure application dialog, writes one; Import application on the App Store tile reads it back. A package can carry the hosted bundle files along with the definition, so an app developed in one browser can be handed to a teammate or moved into another environment without anyone rebuilding the registration by hand.

Not every app comes from the catalog, and the store's New app menu covers the rest. From URL registers an app that lives at an address you paste — a fork, a preview deployment, or a builder running on your own machine; Haven reads the app's `haven-app.json` from that address and shows you what it asks for before writing anything. New blank app opens an empty registration when you want to fill in the hosting and mappings by hand. Custom, built by AI leads to the App Builder, which the next section is about.

A good rule of thumb when you widen an app's access: start with read-only on a single database, get the app running, and only then grant more. It is much easier to add write access later than to take it away in a hurry.

## Building an app with the App Builder

One app in the store exists to produce other apps. The App Builder takes a description of the tool your team is missing — a task board, a booking list, a shift plan — and turns it into a working Haven application: an AI agent writes the code, it is published to the web at its own address, and Haven offers it for installation. Nothing on your side involves programming, and what comes out is a real application rather than a demo.

You install it from the Haven App Store like anything else. The first run asks you to connect three accounts, and that is the only technical part of the whole business. GitHub keeps the app's source code, Cloudflare publishes it, and Cursor supplies the AI that writes it. GitHub and Cloudflare connect through their own consent screens in a click each, with no account id or owner name to look up anywhere. Cursor has no consent flow, so you paste an API key from its dashboard — and the cloud agents the builder starts are not included in Cursor's free plan. That is also the one you can postpone: without a Cursor key the project is still created and published, it simply arrives empty.

From then on, building an app is a name, one sentence about its purpose, and a brief describing what it should do, written in ordinary language rather than technical wording. Pressing the button sets four things in motion. The project is created from the official starter template, which already carries the App SDK documentation and a best-practices guide, so the agent works from the interfaces that actually exist instead of guessing at them. The app gets its own web address, wired to Cloudflare's build pipeline so every later push redeploys it by itself. A cloud agent picks up the brief and starts writing, generating a matching app icon as it goes. And when it finishes, the builder hands the app to Haven.

You can watch all of it. Each step reports what it did, and the agent's work is visible while it runs, so you follow along and give feedback rather than waiting on a black box. That channel stays open afterwards: asking for the next feature is another brief against the same project, and the agent picks up where it left off.

Haven installs the result the way it installs anything else. It reads the finished app's own description and asks you first, listing the databases, permissions, and network access the new app wants. Once you approve, it is a tile on your Workspace like any other, ready to run full-screen or embedded in the card.

What you own at the end is worth being explicit about. The code is an ordinary Git repository in your own GitHub account, built on the same App SDK the first-party apps use, with the whole platform open to it: databases, virtual views, offline operation, real-time sync, Haven's theme. The AI is replaceable — point Claude Code, Codex, or your own hands at the repository instead, and Cloudflare republishes whatever arrives, whoever wrote it. And because the app lives at a public address, a colleague you send the link to can add the same app to their own Haven.

The credentials get careful treatment, because there are three of them and they are powerful. They live in a single document in your own App Builder database, encrypted for you personally, so a shared database does not expose them and the next app does not ask for them again. The GitHub token never leaves the browser tab at all. The Cloudflare token and the Cursor key do reach the builder's server, for the calls a browser is not permitted to make, and nothing is kept afterwards. No credential is ever handed to the coding agent: publishing runs through Cloudflare's own Git integration, which needs no token hand-off, precisely so that a cloud machine is never given something that can deploy.

The App Builder asks Haven for one unusual permission, propose applications, which is what lets it offer the app it just built instead of making you copy a URL by hand. It also needs to open pop-up windows, because GitHub's and Cloudflare's consent screens arrive in one. Haven still asks you before installing anything, every time.

The builder is itself open source, and the hosted copy is a convenience rather than a requirement. If you would rather the Cursor key never passed through a server you do not run, clone [`mindoodb-app-builder`](https://github.com/klehmann/mindoodb-app-builder) and run it yourself; it serves on a loopback address, which counts as a secure origin, so an HTTPS Haven can still embed it. Point Haven at your own copy with New app → From URL in the App Store, using the loopback address it prints on start, instead of installing the catalog entry. It is the same application, and the Cursor key then never leaves your machine.

## Sync

Sync is how the data in your local replicas stays in step with the server. Everybody can sync the databases they already have access to — you do not need to be an admin.

The screen lists every tracked database in every local replica the active user can see. Rows are grouped by tenant. For each row you see which server, tenant, replica, and database it belongs to, the direction of sync (push only, pull only, or bidirectional), and the last sync result. A small "synced before" badge appears on rows that have previously completed at least once, which makes it easy to spot the databases that have never been pulled yet.

A tenant that exists only on this device has no rows to list, because there is no server to sync against yet. Rather than leave it out, Sync gives it a card of its own with a Push to server button, which opens the same publish dialog as Preferences → Tenants. This is the usual way to take a tenant from the setup wizard to a shared one: the card sits where you would go looking for sync anyway, and it disappears once the tenant is on a server and its databases show up as ordinary rows.

There are three ways to trigger sync. The per-row Sync button refreshes just that database. The Sync tenant button (on each tenant's header) refreshes every database in that tenant. The Sync All button at the top of the page refreshes everything in one go. While a sync is running, the status column shows live progress, including how many batches have been transferred. A green check means the row finished without errors. A red badge means something went wrong; when that happens, Haven leaves the row as it was before the sync started, so you never end up with half-applied changes.

Sync All is a split button, and its dropdown holds one option worth finding: Auto-push changes to servers. With it on, Haven sends your changes up as you make them instead of waiting for the next manual sync, which takes most of the "did I remember to sync?" out of a working day. It covers the outbound half only, and it is remembered per user identity rather than per device.

The inbound half needs no setting, because it is always on. For every server and tenant holding at least one row set to pull or bidirectional, Haven keeps a live change feed open and listens. When the server announces a change to a database you track, Haven pulls it a couple of seconds later through the ordinary sync runner, so the row shows the same progress and the same green check as a sync you started yourself. An announcement does not force a transfer: Haven compares heads first, so news about something you already have costs one cheap request. A dropped feed reconnects on its own. What the feed does depend on is what sync always depends on — the Haven tab open and the active identity unlocked — and rows set to push only or switched off are left out, since nothing about them is waiting to come down. Over an ordinary server connection the feed arrives as server-sent events; over an Iroh connection it uses an Iroh stream instead. A server too old to offer a change feed simply does not get one, and its rows stay on manual sync.

With both halves in place, a server connection keeps itself current in both directions, and the manual Sync buttons become what you reach for when you want certainty at a particular moment rather than what moves your data.

A Stop button appears while a sync is running. It sends a cooperative stop signal to the current run. The current row is allowed to finish or roll back cleanly, so you do not end up with half-written data. There is one caveat worth knowing: if you press Stop while a specific row is mid-transfer, that row may end up with only some of the new data, so the next read could mix recent and old values. After a stop, re-run that row before trusting any numbers from it.

When should you sync? The short answer is: before you trust a number you are about to share. Run sync before generating an export from a virtual view, before walking into a meeting based on a dashboard, and any time the network has been down for a while. Sync All is always safe — it only ever pulls new data and pushes your queued changes; it never deletes work you have not yet committed.

One small gotcha: if you expected a database to appear in the queue and it is missing, the usual reason is that the user identity holding the replica is not unlocked yet. Sync needs the keys from the local KeyBag, and the KeyBag only opens once the active identity is unlocked from the top bar.

### Peer-to-peer sync without a server

Sync does not have to go through a server at all. Two Haven devices in the same tenant can exchange data directly, and that turns out to matter in two quite different situations. The obvious one is a server outage: the team keeps working and the data keeps moving, because nothing in the path depends on the server being up. The subtler one is ordinary drafting. Two people working through the same document can sync straight to each other while they iterate and push the finished result to the server once, instead of routing every intermediate state through it.

You start it from the ⋮ menu on a tenant's header on the Sync page, under Peer-to-peer sync without a server. The dialog that opens is called Sync with another device and lists the devices of that tenant — yours under Your devices, everyone else's grouped by the member they belong to. Each row gives the device label, its Endpoint, its Signing key, and whether it is currently Reachable. Pick one and press Add device.

The device on the other end has to be expecting you. In Preferences → General there is a card called Device-to-device sync holding a checkbox: Accept incoming device sync. Turning it on lets other devices of this tenant sync directly with this one — including devices belonging to other members, not only your own. Two conditions come with that. The listener exists only while the Haven tab is open, and the session has to be unlocked; a tab sitting at the unlock dialog answers but refuses to sync, which is exactly what Haven reports back to the other side when it happens.

What makes devices findable is an endpoint id. Haven generates one per device the first time it starts and publishes it in the tenant's user directory database, which is also where the Sync with another device dialog reads its list from — that is why it can show you a legible user name and device label instead of a bare identifier. Publishing happens whether or not you accept incoming sync, deliberately so: the whole point is that devices can still find each other when the server is down and nothing new can be published. The flip side is that a device only knows about peers whose directory entry it has already pulled, so a tenant that has never been synced on this device has nobody to offer yet.

Underneath, this runs on the Iroh network. In the browser Haven reaches the other device through an Iroh relay — a consequence of what a web page is permitted to do with the network, not a design preference — while a native Haven build can connect directly when both devices sit on the same network. The same transport is available between client and server, if the MindooDB server has been configured to join Iroh; [`README-server.md`](https://github.com/klehmann/MindooDB/blob/main/README-server.md) covers that side of the setup.

That client-server case is worth a second look, because it changes what a server has to be. Reached over HTTP, a server has to be reachable: a hostname, a certificate, and a port that something on the internet is allowed to open. Over Iroh none of that applies. The server can sit inside a network nothing can dial into — a machine at home behind a NAT router, with no forwarded port — and Haven still gets to it, because neither side has to accept an incoming connection: they find each other through a relay, which either helps them open a direct path or carries the traffic itself when the router will not allow one. In place of an `https://` address you enter the `iroh:` locator the server prints when it starts, and sync runs as it always does, live change feed included. A relay in the path sees no more than the server does: what passes through is ciphertext, and the relay learns only that two endpoints are talking.

While other devices are syncing with yours, the Sync page grows a panel headed Incoming peer-to-peer sync with a count of the sessions, listing which device transferred what and in which direction. It is cleared on reload, and it is the place to look when you want to confirm a direct sync really happened.

## Quick Scan

Quick Scan is a document scanner built into Haven, and it turns a sheet of paper into a clean file without anything leaving the browser tab. Open it from Start and it appears as an overlay on the workspace rather than a screen you have to navigate back out of.

Point the camera at a page, or pick an image you already have. Haven finds the edges of the sheet, corrects the perspective so the result looks like a scan rather than a photograph taken at an angle, and lets you straighten, crop, and rotate afterwards. If the automatic edge detection picks the wrong rectangle — a patterned tablecloth will do it — drag the corners yourself or press Re-detect edges to try again. Page presets such as A4 and Letter keep the output at a sensible aspect ratio.

A scan does not have to be a single sheet. Press Add page and capture the next one, and keep going until the stack is done. A filmstrip along the edge shows the pages you have so far and numbers them; select one to rotate it, or drop it and capture that page again. A multi-page scan comes out as a single PDF, while one page can also be a PNG or a JPEG. There is also an Extract text action that runs OCR over the page when you want the words rather than the picture.

All of it happens in the browser tab. Quick Scan works offline, nothing is uploaded to a service for processing, and the image never leaves the device except through the download or share you choose yourself.

What Quick Scan does not do is file the result for you. It has two ways out — a download button and the system share sheet — and both hand you a file; nothing is written into a database. When you want the scan to land inside a document instead, start it from whatever owns that document. The Database Browser scans directly onto the document you have open, and an application can open the same scanner through the App SDK and attach the result to one of its own documents. It is the same scanner and the same perspective correction in all three places; only the last step differs.

## Virtual Views

Virtual views are the analytical surface of Haven. They give you a spreadsheet-like tree that filters, categorizes, sorts, and totals documents across one database, several databases, or even several tenants. They are how you answer questions across your data rather than just inside one database.

They have a second job that is easy to overlook: a view makes a good data source for an application. Granting an app a whole database is sometimes more than it needs and more than you want to hand over. Build a view that exposes exactly the documents and columns the app should work with, map the app to the view instead of the database, and the app gets what it needs while the rest stays out of reach.

The Virtual Views screen has two parts: the catalog of saved views at the top and the builder canvas that opens below it when you select or create one. The catalog offers New view, Open view, Edit view, Duplicate view, and Remove view, plus Import and Export buttons for moving view definitions between environments. Each row shows the view name and its data sources.

The builder canvas is where the view is actually composed. At the top you give the view a name, an optional description, and a categorization style (for example, categories before documents). Below that comes the Sources section, where each source gets an origin label (so rows in the result can tell you which database they came from) and is connected to a tenant and a database. Below Sources comes the column list, where you add category columns, sorted columns, and totaled columns, either with the visual builder for common cases or with a small piece of sandboxed code for advanced calculations. A live preview rebuilds as you go so you can see the impact of each change immediately.

Each source can read from a local replica or from a live remote source. Local replica sources are the fastest and work offline; live sources pull fresh data from the server before indexing, which is slower but gives you the most recent server-side state. A single view can mix both. As a default, use local replica sources and only switch individual ones to live when freshness matters more than speed.

Because a view can span millions of rows, Haven indexes it locally and incrementally. Each saved view owns its own materialized index in this browser. From the view header you can pause the current indexing job at the next clean checkpoint, resume it from where it left off, or rebuild it from scratch. Pause and resume cover almost every situation; rebuild is only needed after you change the view's columns or sources, because those changes invalidate the cache. Rebuilding otherwise throws away work the cache could have reused.

In the result tree you can expand categories, drill into documents, and use the checkboxes to build a selection. Selecting a category implicitly selects every visible descendant document under it. Export Selection produces a real .xlsx workbook: it keeps the matching category rows above the selected documents and includes both the source metadata and any computed view columns, so you can hand the file straight to a non-MindooDB tool.

## Database Browser and Document History

The Database Browser is for digging into a single database. It is where you list documents, browse history, compare any two revisions side by side, and edit the live one. It is the most useful screen when you are debugging data, checking what changed, or pulling an attachment out of a specific revision.

The document list has three modes: All, Existing, and Deleted. The filter box accepts a single id, comma-separated ids, or one id per line, which is handy when you have a list of ids from a colleague or a script. Each row shows the current revision plus a small badge for documents that still have open history.

Clicking a document expands its full revision history, newest first. The history includes the live current revision, every prior revision, and the deletion event where there is one. For large histories the rows load in batches; scrolling inside the expansion panel fetches more.

A side-by-side compare is one of the browser's most useful tricks. Pick one history row for the left pane and another for the right pane, and Haven highlights exactly which fields changed. Selection is shared across the page, so you can compare two revisions of the same document, or compare two completely different documents. This is the easiest way to confirm what an automated change actually did before merging anything by hand.

Editing is allowed only on the live current revision. Historical and deleted revisions stay strictly read-only by design — Haven will not let you overwrite history. Attachments, however, can be downloaded from any revision, including deleted ones, so you can recover a file that was once attached and then removed.

Every pane, filter, and comparison is reflected in the URL, so a bookmark or a shared link brings you back to the same view.

When the plain revision list is not enough to explain what happened, open the Document History view. This is Haven's DAG explorer: a graph rendering of every signed lifecycle entry ever applied to the document. The graph reads top-down (or left-right, depending on layout): each node is one signed entry, and edges show how entries followed each other. Branches appear when two people edited the document at the same time, and they meet again at a merge node when the next sync brought their work together.

Each node is labeled with the kind of entry it represents. Create marks the very first entry of the document. Change is a normal edit that touched fields or attachments. Delete is a tombstone entry — the previous body is preserved, only the lifecycle state changes. Undelete restores a deleted document and points back to the Delete entry it reverts. Snapshot nodes are periodic compaction snapshots and are read-only here; you cannot click them to materialize a separate branch.

Hovering a node shows who made the change, when, from which device, and which fields were touched. Clicking a non-snapshot node opens a side panel with a before-and-after diff for the document, with only the fields that changed highlighted — even very small edits are easy to spot. When two branches meet at a merge node, the side panel describes how each conflicting field was resolved, because MindooDB's Automerge engine uses a deterministic rule rather than guessing.

Nothing in the Document History view can be edited. It is a faithful, read-only record of history. That is also what makes it useful for compliance: every node is signed by the user who made the change, so it is the source of truth when a reviewer asks who changed this and when.

## Preferences

Preferences is the one screen that is organized as a tab bar instead of a single page. It has six tabs: General, User ids, Tenants, Backup, Restore, and Stats. Everything on these tabs lives in this browser, with a few deliberate exceptions: the actions in Tenants, the opt-in Roamed workspace setting, and the endpoint that Device-to-device sync publishes so other devices can find this one.

### General

General is where you adjust how Haven looks and how it launches on your device. All of it is personal and applies immediately — there is no Save button.

At the top, Display language sets the language Haven itself speaks — its navigation, preferences, dialogs, and help. It does not touch your documents, and applications running inside Haven bring their own translations.

Current theme lets you pick a color preset (for example Mindoo or Aura) and switch between light and dark mode. The preset changes accent colors throughout the app; the light/dark toggle controls the background and text contrast. The same theme choice is reflected in the identity chip's right-click menu and is propagated live to any embedded MindooDB app so they match Haven's look without reloading.

Add Haven to your home screen is a one-tap card that offers a shortcut to the install guide for your platform. On iPhone it links to Safari's Add to Home Screen flow; on Android it triggers the browser's Install prompt or points you at the Install app action in the browser menu. If Haven is already running from its installed icon, the card simply confirms that and shows a Review install steps button in case you want to add another copy.

An Optimize for iOS multitasking toggle tells Haven that it is used in iPad split-screen or slide-over mode, where the system adds window controls that overlap Haven's own chrome. Turning it on shifts Haven's controls clear of them. Under Motion, Reduce animations strips out Haven's transitions for anyone who finds them distracting or whose system already asks for less movement.

Device-to-device sync is where the receiving half of peer-to-peer sync lives. The checkbox is Accept incoming device sync, and the card also shows this device's endpoint — the identifier other devices dial to reach it — along with whether anyone can currently see it. The section on peer-to-peer sync under Sync explains what the two sides do; this is the switch that makes this device one of them.

Roamed workspace is the one setting on this tab that leaves the browser, and it is off until you turn it on. It makes the workspace pages, tiles, groups and the application list of the active user id follow you to your other devices, and it lets you keep several environments and switch between them — office and home, or desktop and mobile. It is a Haven Enterprise feature: without an active license the toggle stays off, this device neither saves its workspace nor takes one over, and environments you set up earlier are left exactly as they are until a license is imported again. Switching the toggle on reveals two fields: the tenant the workspace is synced through, and the name of the saved workspace. The name is how devices find each other, so "office" on your laptop and "office" on your phone share one workspace; the field opens a drop-down of the names already saved for this user id, and typing a name that is not in that list starts a new one. Neither field takes effect while you edit it — Apply commits both, Cancel puts back what is in force. What Apply does follows from the name: a new one is created from this device's workspace, an existing one is taken over, and the tabs and tiles arranged here are replaced by it. That replacement only costs you something when roaming was off, so that is the single case Haven asks about first; once roaming is on, this device's state is already in its saved workspace and moving to another name is free. Switching the toggle off stops roaming right away and leaves every saved workspace untouched.

What travels is only the arrangement: pages and their order, every tile with its position and size, groups, the grid and sorting settings, and your application registrations. What stays local is deliberately left out — which page you are looking at right now, so a second device cannot yank your view around. Apps your tenant admin distributes by policy are also left out, because every device already gets those from the tenant directory.

The saved workspace is an ordinary MindooDB document in the tenant's user directory, encrypted for you alone — teammates and admins sync its bytes like everything else and cannot read a word of it, and only your own devices can change or delete it. Because it is a document, it travels exactly like your data does: a change is written locally and reaches the other device on the next sync, so both devices need to be able to reach the server, not each other, and neither has to be open at the same time. Two devices editing at once merge rather than overwrite — moving a tile here while renaming a page there keeps both edits, and the same tile dragged on both devices settles on one position. You can keep several saved workspaces per user id, follow one of them per device, and delete one for good from the same card; devices that were following it simply stop roaming and keep the layout they have. The list stays visible with roaming switched off and covers every tenant this user id reaches, so each entry names its tenant next to the name of the saved workspace, and when it was last written by whichever of your devices wrote it — a workspace nobody has touched for months is easy to spot before you delete it.

### User ids

A user identity is your account inside Haven, and this tab is where you manage your stored identities. Each row is one identity with its username, what it unlocks with, and its creation date; admin identities are marked with an Administrator tag so they are easy to tell apart from everyday users. The Switch action makes that identity the active one for this Haven session — for a passkey identity that is a single button and a Face ID prompt instead of a typed password. Only one identity is unlocked at a time; if something on another screen complains that it cannot read a tenant, the wrong identity is usually unlocked.

Create generates a brand-new identity directly in the browser and offers the same passkey-or-password choice as the Welcome wizard. Import brings in a .json file that was previously exported from Haven or created by the MindooDB console (for example on another device or by a teammate) and asks for the password that was used when the file was exported.

The Unlocks with column tells you which secrets currently open an identity, and one button changes that: Sign-in options. It repeats what opens the selected identity today and then offers only the changes that fit it: an identity that already has a password is not offered a second one, and an identity without a passkey has none to remove, so the list is two or three entries rather than a wall of greyed-out buttons. The exception is an action that does fit the identity but that a rule forbids — that one stays in the list with the reason written in place of its description, because the reason is usually the way forward. An administrator identity says why it stays password-only, and Remove password on an identity that has no passkey yet says to add one first instead of simply refusing.

Add a passkey registers this device's authenticator for an identity that only had a password; your password keeps working exactly as before, so this is a safe thing to do on every device you use. Remove passkeys drops the registered authenticators again. Add a password does the reverse, and matters mainly for exports: the console and the SDK run in Node, where there is no authenticator to ask, so a passkey-only identity cannot be opened outside this browser. If you ask for a full export of a passkey-only identity, Haven does not grey the menu item out — it asks for a password first, adds it alongside the passkey, and then writes the file. Nothing is re-encrypted in the process; the identity simply gains a second way in.

Remove password is the option to think about twice. It leaves an identity that only its passkey opens, which is the stronger setup — there is no typed secret left to phish, reuse, or forget — but it also narrows the ways back in down to one. Haven refuses outright unless a passkey is registered, because an identity with no unlock method left is unrecoverable: the key that opens the private keys exists only inside those wrappers. Even with a passkey in place, keep an encrypted backup: a passkey that does not sync lives in this one authenticator, and the backup file is what turns a lost laptop into "restore and type the backup password" instead of a lost identity. Full identity export stays blocked while no password exists, for the Node reason above, and adding one back is a two-field dialog away.

Change password sits in the same list. For an identity whose unlock methods are wrappers around an internal key — anything created recently, and anything that has ever had a passkey — Haven replaces only the password wrapper, so every registered passkey stays valid and no KeyBag has to be rebuilt. For an older identity whose password encrypts the private keys directly, Haven re-encrypts those and the tenant KeyBags that depend on them in one step, so the new password works everywhere immediately. Either way, pick a strong password and store it somewhere you can find again, because there is no reset link: if you forget the new password, every tenant tied to this identity becomes unreadable, even on devices that already had the data. Save it to a password manager before pressing Save.

If an identity was created with a password before passkeys existed, Haven offers to add one the next time you unlock it. Accepting takes one Face ID prompt and leaves the password in place as a fallback. Choosing Keep using the password is a permanent answer for this device: Haven remembers it and never asks again for that identity, and Sign-in options on this tab stays available if you change your mind later. Closing the dialog with the X or Escape only postpones the question, so you can decide at the next unlock. Removing a passkey again also counts as an answer — Haven will not start offering one on every unlock afterwards.

Below the identity table, once an identity is unlocked, Your devices lists every device that holds — or is waiting to hold — that person's user key, one row per device and tenant, with an Approve or Allow anyway action where you are allowed to use it. This is the panel behind the approval flow described under Using Haven on more than one device, and the place to go when you dismissed the approval dialog too quickly.

### Tenants

A tenant is your team's private workspace, and this tab lists every tenant Haven knows about for the active user identity. For each row you see the tenant id, the current user, the admin user, and any servers the tenant has been published to.

Opening a tenant shows its key fingerprints and where it is currently published. The fingerprints come from the local KeyBag for the active user, so they only appear once that user is unlocked. Treat fingerprints as proof of identity for the tenant's encryption keys: if two team members compare them in person and they match, you can be confident nobody swapped a key in between.

Actions that touch the tenant directory — publishing a tenant, or granting a teammate access from a join request — are signed by the admin identity, so Haven asks for its passphrase. Because those tasks usually come in batches, the prompt offers to unlock the admin for this session: tick it once and the following steps stop asking. Unlocking an admin this way does not switch your active identity, so your everyday user stays the one doing document work, and a Lock administrator action ends it early when you are done.

New tenants always start in this browser for the active user. Publishing pushes the tenant to a MindooDB server so other team members can join; the Sync page offers the same step as a Push to server button while a tenant is still local-only, so most people meet it there first. Deleting from a server removes the tenant location from that server only — the local copy stays put. Publishing and deleting on a server require a system admin password, because they touch shared infrastructure; if you are not the platform admin, ask them to run the action with you.

Be careful with delete-on-server. It wipes that server's view of the tenant for every user, not just yours, and other clients may suddenly fail to sync. Confirm it with the platform admin and any other team admins first, and make sure a current encrypted backup exists before pressing the button.

### Backup

Haven keeps almost everything in this browser. The Backup tab is the safety net, and it offers two very different nets: an encrypted file that holds everything, and a paper printout that can bring a single tenant back from nothing. Putting either one back — and wiping Haven — happens on the Restore tab next door.

An encrypted backup is a single file that contains everything Haven keeps in this browser: saved users, tenants, applications, hosted app files, workspace layout, virtual views, and the local IndexedDB content. You choose a backup password, and Haven uses it to encrypt the file before it is downloaded. There is exactly one backup password for the whole file, no matter how many identities are inside it. The password itself is never stored anywhere — Haven cannot show it to you later and cannot help you recover the backup if you lose it. Downloads use the .mdbhaven-backup extension so they are easy to spot in a downloads folder.

Identities that unlock with a passkey need one extra consideration, because a passkey cannot leave the device that holds it — that is the whole point of a passkey, and it is also why restoring on a new laptop would otherwise hand you an identity nobody can open. Haven solves this inside the file rather than by weakening your device: for each passkey-only identity it adds a copy of the unlock key that opens with your backup password. Your local identity is untouched and keeps its passkey. If any of those identities are currently locked, Haven asks for the passkey once while the download is being prepared. The practical consequence is that the backup password is as valuable as the identities in the file: treat it like a master key and store it accordingly.

The second card on the tab is the tenant recovery printout, and it answers a different question: what survives when no browser does. It covers one tenant at a time and holds only what cannot be downloaded again — the user and admin identities you select, their KeyBag keys, the server URL, and the sync setup — so that a later sync can fetch the actual documents from the server. It deliberately contains no document data, which also means it is of no use for a tenant that was never published. You choose a secret question, which is printed on the sheet, and an answer, which is not; the answer is what decrypts the sheet later. Haven then spreads the encrypted payload across eight QR codes with enough redundancy that any six of them suffice, so a coffee stain or a torn corner does not cost you the tenant. Store it where you keep passports, not where you keep printouts.

### Restore

The Restore tab is where a backup comes back, and where Haven can be wiped when nothing else helps.

Restoring an encrypted backup file happens in two steps, both deliberate. The first step, Preview, decrypts the file just enough to show you a summary of what is inside: counts of identities, tenants, applications, IndexedDB databases, and any restore warnings. Nothing local is touched yet. Some backups contain databases that cannot be moved across browsers as-is; the preview shows a warning per affected database with whether it will be rebuilt empty or skipped. Rebuild means the database will be created empty and refilled from sync. Skip means it will not be restored at all and you will need to reconnect that source manually.

The second step, Restore and reload, wipes the current Haven state in this browser and writes the backup back. Haven reloads automatically and you end up signed in to the restored data. Because restore deletes the current state first, anything that was not exported and not synced will be gone. Export a fresh encrypted backup of the current state before pressing Restore, just in case.

After a restore on a different device or browser, identities that used to unlock with a passkey will ask for the backup password instead, and the unlock dialog says so. The passkey stayed on the old device, so this is expected rather than a sign that something went wrong. Unlock the identity once with the backup password and then use Add a passkey to register the new device's authenticator; from that point on the identity behaves exactly as it did before.

Restoring from a tenant recovery printout uses the second card and the same two-step caution. Scan the QR codes with the device's camera or paste their contents, answer the secret question, and Haven puts the identities, KeyBag material, server URL, and sync setup back. Nothing else travels on paper, so run a sync afterwards to pull the tenant's documents down again. This is also the way back when every approved device for a tenant is gone and there is nobody left to approve a new one.

Factory reset is at the bottom of the tab. It wipes everything Haven knows in this browser — identities, tenants, applications, hosted app files, virtual views, workspace layout, and all synced MindooDB data — and returns Haven to its brand-new state. Because it is irreversible, Haven asks you to type a confirmation phrase before the button becomes active, and then asks the browser for one more confirmation. Treat factory reset as a last resort and only after a known-good backup exists.

### Stats

The Stats tab shows how much room Haven is using inside this browser and lets you free space safely. Browsers cap how much storage a single site may use, so understanding what is taking up space keeps Haven fast.

A big number at the top sums everything Haven currently keeps in this browser: every local database, every cache, every hosted app file. A Refresh button recalculates after big operations like a sync, a delete, or a cache clear. Numbers do not auto-refresh because measuring large stores can be slow.

Below the total, a By tenant section shows one block per tenant. Each tenant header has its combined size plus a Clear cache button that removes only the rebuildable parts — caches and indexes that Haven will refill the next time you use the tenant. Clear cache does not delete documents or attachments.

Inside each tenant, every row is one local database. Docs is the encrypted document content, Attachments is encrypted attachment chunks, and Total is the sum of the two. Delete wipes that database's local content in this browser only — the server copy is not touched. The protected directory database cannot be deleted because Haven needs it to operate. Before you delete, open the database and run Sync; if there are unsynced local changes, deleting loses them. Prefer Clear cache when you only want to free space, because it is reversible.

Below each tenant's databases you will also see its caches: a local tenant cache for general per-tenant state, a server target cache for each MindooDB server the tenant talks to, and a virtual view cache for each saved view. Each cache shows its own size, and virtual view caches can be cleared individually if one particular view has grown too large.

A Global caches block at the bottom covers shared Haven caches that live outside any single tenant, such as the service worker caches for hosted apps. These have the same size readout as tenant-level caches.

## Install Haven on a phone

Haven is a progressive web app, which means every modern mobile browser can install it as if it were a native app. Once installed it opens in standalone mode, without the browser's address bar or tab strip, which is cleaner and gives you more screen space.

On iPhone and iPad, open Haven in Safari and tap the Share button — the icon that looks like a square with an arrow pointing up. Scroll the Share sheet until you see Add to Home Screen and tap it. iOS already has Haven's icon and name, so it will fill those in for you. Confirm the name and tap Add, and a Haven icon appears on your home screen.

iOS has a neat bonus: you can add Haven to the home screen more than once. Each installed copy gets its own private storage on the device, so the data inside one copy is completely separate from the others. This is a great way to keep different worlds apart on the same iPhone — one copy for personal notes, one for work, one for demos — without ever logging in and out. Before tapping Add the second time, change the suggested name (for example to Haven - Work) so the home screen icons are easy to tell apart. Each copy starts empty and needs its own user identity, tenants, and synced databases. Note that encrypted backups are per-copy too: restore a backup inside the same copy you exported it from, otherwise you will overwrite a different environment.

On Android, open Haven in a modern browser like Chrome or Edge. If Haven shows an Install button, accept it and your browser will add Haven to the home screen and the app drawer in one step. If there is no prompt, open the browser menu (usually three dots in the corner) and look for Install app or Add to Home screen — different browsers word it differently but the result is the same. Confirm the browser's prompt and Haven appears on the home screen as a normal Android app icon.

After install, always launch Haven from the home screen icon when you are on a phone — it is a noticeably nicer experience than a browser tab.

## Security model at a glance

If you want to explain Haven to someone in one minute, this is the summary.

Every user has a cryptographic identity made of an Ed25519 signing key and an RSA-OAEP encryption key. Both private keys are encrypted with a secret only you hold, stored locally in the browser, and never transmitted. That identity is what unlocks tenants and signs your changes.

The secret can be a password or a passkey, and both end up in the same place. Haven gives each identity one internal random key that encrypts the private keys, then wraps that key once per unlock method: a password wrap derived with PBKDF2, and a passkey wrap derived from the WebAuthn PRF extension. Adding or removing an unlock method only adds or removes a wrapper, which is why you can have both at once and why neither one ever learns the other's secret. The same mechanism is what makes a YubiKey work: to WebAuthn a security key and a built-in Face ID sensor are the same kind of authenticator, so Haven does not exclude roaming keys — pick a YubiKey if you want the unlock secret to live on something you can put in a drawer rather than on the laptop itself. What does not exist is a cloud copy: nothing is escrowed to MindooDB, to Apple, or to your browser vendor, and a passkey is not synced into an iCloud or Google device backup in a form Haven could recover. That is the deliberate trade — no server can be compelled to unlock your data, and no server can help you if you lose every secret you had. Your encrypted backup file is the recovery story, which is why the Backup tab is not optional.

Each tenant has a KeyBag — an encrypted store of encryption keys, opened by the identity that owns it. The default key is shared with every member of the tenant and encrypts documents unless a more specific key is chosen. Named keys give fine-grained access to a smaller group for especially sensitive documents. All of this lives on your device; the server never sees keys.

Every document is an Automerge CRDT stored in a content-addressed store. Every change is signed with your Ed25519 key and encrypted with AES-256-GCM before it ever leaves the browser. The server stores and relays ciphertext and can never read your data, even if it is fully compromised. Transport adds a second layer of per-user RSA-OAEP encryption, and TLS wraps the whole thing as a third layer. Access control is enforced through encryption, which means if you do not have the key, the document is just ciphertext — there is no trusted server to ask for permission and be tricked into giving it.

Because every change is signed and appended to a chain, history cannot be rewritten quietly. Haven's Document History view is a direct rendering of that chain, and Automerge merges concurrent edits deterministically so two people can work on the same document without a conflict dialog.

Apps that run inside Haven are wrapped in the browser's sandbox on their own origin. Hosted apps get an even stricter opaque-origin sandbox. An app cannot reach Haven's storage, cookies, or other apps; it only sees the databases you mapped and the capabilities you granted. Every call the app makes — read, write, attachments, history — flows through Haven's SDK bridge, which validates it against the mapping before it touches any data. Hosted apps also cannot call the internet unless you listed the URL; the default is deny. The full model, leftover risks, and the difference from apps stored inside a MindooDB database are in [hosted-app isolation](hosted-app-isolation.md).

That, in a minute, is why Haven is private by design rather than by policy.

## Glossary

These are the terms Haven uses across its screens and its help drawer. They are listed roughly in the order you are likely to meet them, not strictly alphabetically, because most of them build on the ones before.

User identity — your account inside Haven. Created locally, protected by a passkey or a password, and is what unlocks tenants and signs your changes. The Preferences tab calls it User ids.

Passkey — an unlock method backed by your device's authenticator: Face ID, Touch ID, Windows Hello, or a security key such as a YubiKey. Haven derives the key that opens your private keys from it locally, so the secret never leaves the device and is never sent to a server.

Passphrase — several random words used instead of a password. Haven offers a generated six-word passphrase for admin identities because it is both stronger than a typical typed password and easy to write down; typing your own password instead stays available.

Tenant — your team's private workspace inside MindooDB. Groups users, encryption keys, and databases together so a team can share data securely.

Tenant label — the human-readable name of a tenant. Haven generates the tenant id itself and it never changes; the label is the part you pick, and an admin can rename it whenever it stops fitting.

Tenant admin — a privileged identity inside a tenant. Can register or revoke other users and change tenant-wide settings.

App user — a regular user identity inside a tenant. Does everyday document work but cannot register or revoke other users.

System admin — a server-level identity used to manage a MindooDB server itself: connecting Haven to it, trusting other servers, and bootstrapping new tenants.

KeyBag — a local, encrypted key store that holds the encryption keys a tenant needs, opened by the identity that owns it. Each user keeps their own in this browser.

Default key — the encryption key shared with every member of a tenant. If a document does not specify a named key, it is encrypted with the default key.

Named key — an extra encryption key shared only with selected users. Useful for sensitive documents that should not be visible to the whole tenant.

User key — an encryption keypair that belongs to a person rather than to a device or a tenant. Its public half is published in the tenant so others can encrypt for you (this is how the default key reaches you); its private half lives only on the devices you approved. One user key per person, one wrapped copy per approved device.

Device approval — the step that lets a new browser or phone read a tenant's documents. An already-approved device writes a copy of your user key for the newcomer; until that happens the new device can sync ciphertext but not open it. Approval always has to come from a device that is already approved.

Tenant recovery printout — a printable sheet of redundant QR codes for one tenant, holding identities, KeyBag keys, and the server and sync setup, but no documents. Created on the Backup tab, restored on the Restore tab, and the only way back when every approved device is gone.

Signed change — every edit to a document is signed with the author's private key. This proves who made the change and prevents anyone from forging history later.

Local replica — a browser-local synced copy of a tenant's databases. Fast, works offline, and is the recommended way to browse and edit.

Live source — a source mode that pulls fresh data from a MindooDB server before using it. Slower than the local replica but useful when you need the very latest state.

Change feed — the stream a server uses to announce new writes to the clients listening on it. Haven keeps one open per server and tenant it pulls from, which is what makes incoming work arrive on its own. Always on; no setting of its own.

Peer-to-peer sync — a direct sync between two devices of the same tenant with no server in the path. Runs over the Iroh network. The receiving device needs Accept incoming device sync switched on, and its tab open and unlocked.

Endpoint — the address a device is dialled at for peer-to-peer sync. Haven generates one per device and publishes it in the tenant's user directory, so devices can still find each other while the server is unreachable.

Iroh — the network Haven uses when there is no reachable address to connect to. It carries peer-to-peer sync between two devices, and it can also carry ordinary client-server sync to a MindooDB server that has joined it — one behind a NAT router, say, with no forwarded port and no certificate. Both ends meet through a relay, which sees that they are talking but not what they say.

Quick Scan — Haven's built-in document scanner. Finds the edges of a page, corrects the perspective, and takes as many pages as you need into one scan. Runs entirely in the browser tab, offline included. It hands the result out as a file — a multi-page PDF, or a PNG or JPEG for one page — through a download or the system share sheet; attaching a scan to a document is done from the Database Browser or by an app through the App SDK.

IndexedDB — the browser's built-in database. Haven stores almost everything inside IndexedDB so it can work offline.

Payload bytes — an approximate measurement of how much real content Haven keeps in this browser. It excludes the overhead the browser itself adds.

Local tenant cache — a per-tenant browser cache that helps Haven reopen work faster, resume sync, and reuse local query data. Can be cleared and rebuilt automatically.

Server target cache — a cache scoped to one tenant and one server. Speeds up live sync against that server and can be cleared safely.

Virtual view cache — stores a virtual view's materialized results plus its resumable indexing state, so the view reopens quickly. Clearing it rebuilds the view next time you open it.

Protected database — a database that Haven needs in order to operate (for example, the tenant directory). It cannot be deleted from the storage panel.

Start — the fixed first tab of the Workspace. Carries Haven's six shortcut tiles and one tile per installed application. It cannot be rearranged; your own tiles go on the pages next to it.

Tile — a draggable, resizable card on the workspace grid. Each tile holds a database, an application, a note, an embedded web page, a video, or a diagram. Also called a chicklet.

Page — a workspace tab that contains its own grid of tiles. Use multiple pages like home screens on a smartphone.

Group — a visual container that clusters related tiles under a shared, color-coded header. Drag one tile onto another to create a group.

App Drawer — the panel behind the arrow handle at the top of the content area. Lists the Haven screens you have open and the applications currently running, with a way back to the Workspace above both. Cmd+Shift+Space opens it and Cmd+Shift+Enter returns to the Workspace; press Ctrl instead of Cmd on Windows and Linux.

Database — a collection of related documents inside a tenant. A tenant can have many databases (for example contacts, invoices, notes).

Directory database — a special protected database in every tenant that stores user registrations and tenant-wide settings.

Document — a single item of data inside a database. Encrypted on this device before sync, so the server only ever sees ciphertext.

Revision — a point-in-time version of a document. Every change creates a new revision; older revisions stay readable as long as history is kept.

Attachment — a file attached to a document. Stored in encrypted chunks and streamed on demand.

Automerge — the conflict-free merging engine MindooDB uses under the hood. Two people can edit the same document at the same time and Automerge merges their changes automatically.

Change graph — a graph view of every change ever applied to a document, including how concurrent edits were merged together. Also called the DAG explorer.

Virtual view — a spreadsheet-like tree view over your documents that filters, categorizes, sorts, and totals them. Can pull from one database, several databases, or even several tenants.

Origin — an identifier that marks which database (or tenant) a row in a virtual view came from. Useful when one view combines several sources.

Materialized index — the pre-computed view results stored in this browser so a virtual view can be reopened instantly.

Haven App Store — the catalog of ready-made MindooDB applications, opened from Start. Installing an entry writes its registration for you and puts the app on Start.

App Builder — the app in the store that builds other apps. You describe what you need; it creates the repository, publishes the app, has an AI agent write it, and hands it to Haven for installation. The result is an ordinary MindooDB app with source code in your own GitHub account.

Application registration — the saved Haven-side definition of a MindooDB app: where to launch it from, how to run it, and which databases or views it is allowed to see.

Hosted bundle — a packaged set of web assets imported into Haven so it can serve the app locally, even when offline.

External URL — a web address for an app hosted outside Haven, such as a local development server or a deployed web app.

App connector (bridge) — the secure channel between a MindooDB app and Haven. Apps never talk to your data directly; every read or write goes through this connector so Haven can enforce the permissions you granted.

Launch context — the initial information an app receives from Haven when it starts: theme, viewport, current user, launch parameters, and the databases it has been granted.

Runtime mode — how a registered app is launched: embedded in the Haven window, or opened in its own browser tab. Distinct from a tile's display mode, which decides whether the tile is a launcher you double-click or runs the app inside the card itself.

Sandbox — the browser-enforced isolation that wraps every app. The app cannot reach Haven's storage, cookies, or other apps unless you explicitly share data with it.

Theme preset — a named color palette for Haven (for example Mindoo or Aura). Switching the preset changes accent colors throughout the app.

Light / dark mode — whether Haven uses a light or dark background. The choice is remembered in this browser only.

Standalone mode — a display mode where Haven launches without normal browser controls, like a dedicated app. Available after you add Haven to a phone home screen.

Add to Home Screen — the browser action that saves Haven as a launchable icon on a phone or tablet home screen.

Install prompt — the browser-native sheet that confirms adding a progressive web app like Haven to the device.

Encrypted backup — a single file containing everything Haven keeps in this browser, scrambled with a password you choose. Without that password the file is unreadable.

Backup password — the single password used to encrypt and later decrypt a backup file, whatever the identities inside it unlock with. It also opens any passkey-only identity restored from that file on a new device. Haven never stores it; if you lose it the backup cannot be restored.

Preview restore — a safe step that decrypts a backup file just enough to show you what it contains, before any local data is touched.

Restore warning — a note shown during preview when a backup contains databases that will need to be rebuilt empty or skipped during restore.

Factory reset — wipes all Haven data from this browser, including identities, tenants, applications, hosted apps, virtual views, and synced MindooDB data. Cannot be undone.

## Editions, pricing, and the open platform

Haven comes in two editions, and the one most people will ever need is free.

Haven Community is the free edition of Haven, in beta, available today at [haven.mindoodb.com](https://haven.mindoodb.com). It is the same client the MindooDB team develops, deploys, and uses in-house. "Beta" here means it is usable for real work, not a mockup — it is actively evolving, feedback feeds directly into the roadmap, and there is no formal SLA yet. If you need guaranteed response times, that is what the commercial support tier is for.

Haven Community works in three deployment topologies. Local-only, where everything lives in your browser and there is no server at all — perfect for personal notes and offline demos; in this mode the Preferences → Backup tab doubles as your transfer mechanism, because an encrypted `.mdbhaven-backup` file contains your user identities, settings, and MindooDB databases, so you can move a complete local-only Haven from one browser to another by exporting and restoring. Connected to the hosted Mindoo demo server, which lets you publish a local tenant and test real multi-user collaboration; demo-server data is wiped periodically, so it is for evaluation rather than production. And self-hosted, where you point Haven at a MindooDB server you run yourself, with full setup instructions in [`README-server.md`](https://github.com/klehmann/MindooDB/blob/main/README-server.md) in the MindooDB repository. The choice is yours and you can move between topologies at any time.

Haven Community is also a complete platform for custom app development. You can build MindooDB apps by hand using the App SDK, or let an AI agent generate them from the structured `llms-full.txt` on mindoodb.com plus the public reference app repositories. The Haven App Store ships with a catalog of finished apps you can install in one click, both to use and to see what a polished MindooDB app looks like. Mindoo Vega renders the same tree of nodes as a mindmap, a Kanban board, a Gantt chart, or a spreadsheet, with task fields, attachments, time travel through the document history, and full-text search — handy for project planning where the same data needs a big-picture view one minute and a lane-by-lane or date-by-date one the next. Mindoo TodoManager turns Covey's four-quadrant method (important/not important, urgent/not urgent) into a visual task workflow for staying focused on what matters most. [Mindoo Weather](https://github.com/klehmann/mindoodb-app-weather) is an iOS-Weather-style tile that shows a 10-day forecast plus air quality for one or more locations configured through a launch parameter — it adapts live to the tile size Haven reports (narrow: one swipeable card with dots; wider: two to four at a time) and pulls all data from keyless Open-Meteo APIs, so it doubles as a reference for the UX side of the SDK. The catalog also carries the App Builder, which writes, publishes, and installs a new app from a description you type, and the SDK Example App for developers who want a living reference of every SDK feature. All of them are free to use.

The underlying MindooDB platform is open source under the Apache 2.0 license. That matters beyond the price tag: there is no data lock-in. The data model, the content-addressed store, and the sync protocol are all documented and reimplementable, which means a team can take their encrypted data with them at any time — and it is even possible to build entirely alternative clients on top of the same platform if Haven is not the right fit for a particular use case. Haven is the official client; it is not the only possible one.

Haven Enterprise is a commercial edition in development at Mindoo GmbH, built on exactly the same MindooDB core. It adds the features organisations tend to ask for when Haven is rolled out across teams, departments, and devices: custom branding (logo, colors, product name, and domain so Haven feels like your own product), a managed user interface with organisation-specific defaults, managed workspace templates pushed to users so they land in a configured environment, an in-house app store for curating internal and third-party MindooDB apps, workspace roaming across devices and browser profiles, automatic scheduled backups of in-browser data, first-class backup tooling for the tenant data stored on your server, and inline editing of common Office and text attachments without having to download them. The list continues to grow as the Enterprise client matures — customer feedback shapes the roadmap directly.

Choosing Haven Enterprise never takes you off the open platform. The MindooDB core and the Haven PWA remain free and open; Enterprise is a separate, commercial client layered on top. You can start on Community, move to Enterprise later, and in either direction your data and your server stay exactly where they were.

For current details, pricing, and the early-access list for Haven Enterprise, see the Haven pricing page at [mindoodb.com/haven/pricing](https://mindoodb.com/haven/pricing).

## Where to go next

Haven is an active product and it is also the public face of MindooDB. A few resources are worth bookmarking.

The easiest way to actually try Haven is to open [haven.mindoodb.com](https://haven.mindoodb.com) in a modern browser — it is the live Community client.

The product pages at [mindoodb.com](https://mindoodb.com) go into more detail on the positioning and the security model, and cover the parts of the story that a handbook cannot — screenshots, roadmap, and the wider MindooDB platform.

The [MindooDB App SDK on GitHub](https://github.com/klehmann/mindoodb-app-sdk) is the TypeScript library for building apps that run inside Haven. Two companion open-source projects show what production-quality apps built on it look like: the [example project](https://github.com/klehmann/mindoodb-app-example) is a Vue 3 reference app that demonstrates every SDK feature across three tabs (Databases, Views, Events) — its live demo is at [app-example.mindoodb.com](https://app-example.mindoodb.com) and can be registered in Haven with an external URL for a few minutes of hands-on exploration; and [`mindoodb-app-weather`](https://github.com/klehmann/mindoodb-app-weather) focuses on the UX side of the SDK, showing launch parameters, viewport events, and responsive embedding through a polished iOS-Weather-style tile.

Inside Haven itself, remember the Help button in the top bar. Every screen has its own help article, written in the same friendly style as this handbook, and a short spotlight walkthrough that highlights the important controls. When in doubt on a screen you have not used before, open it first — it is usually faster than reading about it elsewhere.

That is Haven. A local-first, end-to-end encrypted, app-hosting workspace in a browser tab. Private by design, calm by default, and ready whether you are online or not.
