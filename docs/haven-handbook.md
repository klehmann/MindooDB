# The Haven Handbook

A complete, friendly guide to MindooDB Haven — the browser-based workspace for encrypted, offline-first collaboration on MindooDB.

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

A user identity is your account inside Haven. It is a password-protected file that holds your public details and your encrypted private keys. Identities are created locally in your browser and never leave it unless you choose to export them. Haven can keep several identities side by side and switch between them from the top bar. Losing the password to an identity is permanent — there is no reset link, because nobody outside your device has the key.

A tenant is your team's private workspace inside MindooDB. Everyone who can see a particular set of databases is a member of the same tenant. Tenants contain a directory database (where user registrations and tenant-wide settings live), one or more application databases, and a set of encryption keys. Tenants are created entirely client-side and can be published to a server when you are ready to collaborate.

A local replica is the browser-local synced copy of a tenant's databases. This is what makes Haven feel instant. Working from the local replica is fast, works offline, and is the recommended way to browse and edit.

A database is a collection of related documents inside a tenant — contacts, invoices, notes, whatever the team needs. A document is one item inside that database. Every document is an Automerge CRDT, which is the technology that lets two people edit the same document at the same time and have their changes merged automatically without a conflict dialog.

Every change to a document is signed with the author's private key and appended to the document's history. Each change is also cryptographically linked to the change that came before it, a bit like a blockchain, so the chain of edits forms a tamper-evident sequence rather than a bag of loose revisions. That history is what Haven shows in the Database Browser and the Document History view. Because changes are signed and chained, nobody can quietly rewrite the past: altering or dropping an earlier change would break every link that follows.

A KeyBag is a local, password-protected store of the encryption keys a tenant needs. Each user keeps their own KeyBag in their browser. A default key is shared with every member of a tenant; named keys are extra keys that can be given to a smaller group for sensitive documents.

A virtual view is a spreadsheet-like tree that filters, categorizes, sorts, and totals documents. A view can pull from one database, several databases, or even several tenants, which is how you answer questions across data rather than just inside one database.

The Workspace is made of tiles on pages, grouped into groups. A tile — sometimes called a chicklet — is a draggable, resizable card that opens a database, launches an app, or shows a note, a web page, a video, or a diagram. A page is a tab full of tiles. A group clusters related tiles under a shared, color-coded header.

An application registration is the saved Haven-side definition of a MindooDB app: where it lives, how it runs, and which databases or views it is allowed to see. When an app launches, it talks to Haven through a bridge (sometimes called the app connector), which is the secure channel that lets Haven enforce the permissions you granted. The sandbox is the browser-enforced isolation that prevents an app from reaching Haven's storage, cookies, or other apps.

Those are the pieces. Everything else in Haven is a screen for working with them.

## Getting around Haven

Haven has a steady layout. A sidebar on the left, a slim top bar across the top, and your content in the middle.

The left sidebar is the main navigation. It has five destinations: Workspace, Applications, Sync, Virtual Views, and Preferences. A small button at the bottom of the rail collapses the sidebar to icons when you need more room on screen, and a separate mobile menu opens the rail on phones and narrow viewports.

The top bar is the same on every screen. On the right you will find three things: an identity chip that shows the currently active user (press it to open the identity switcher, right-click it to flip between light and dark mode), and a Help button that opens a contextual help drawer for whatever screen you are on. Every screen in Haven has its own help article written in the same friendly style as this handbook, and if you ever feel lost the Help button is the first thing to try. On a phone or tablet, Haven will occasionally nudge you from the top bar to add it to your home screen for a better mobile experience.

There is one more piece of the top chrome that is easy to miss the first time: the Running Apps panel. When you launch a MindooDB app "inside Haven" — more on that under Applications — the app keeps running in the background while you navigate elsewhere. A small arrow handle appears at the top of the content area, and clicking it slides down a drawer that lists every app you have running. From the drawer you can jump back into any running app, use the "Back to Workspace" shortcut to return to where you were, sync that app's local databases against the server, reload the app, open an info dialog about it, or close it. The drawer is available from any route, not just from the app runner page, so you never have to hunt for a running app.

When you install Haven on a phone and launch it from the home screen, it opens in standalone mode, which removes the browser's address bar and tab strip. Certain screens inside Haven — mostly immersive ones like a full-screen running app — also hide the top bar for the same reason.

## Your first 10 minutes

The first time you open Haven, it greets you with a Welcome page that turns the whole setup — identity, admin, tenant, or joining an existing team — into a short guided flow. You can do all of this by hand later through Preferences → User ids and Preferences → Tenants, but the Welcome page is by far the easiest path, so use it whenever you can.

The Welcome page opens with a short pitch (end-to-end encrypted, offline-first, zero-trust servers) and three big buttons: Create a tenant, Join a team, and Open tenants. Below those, two cards explain what each path actually does. If Haven already has an unlocked identity, a small banner tells you so — the wizard will happily reuse it and skip the identity step if you want.

### Path one: starting your own tenant

If you are starting fresh, press Create a tenant. The wizard walks you through four steps on a single page.

Step one, create your personal user identity. This is your account inside Haven — a small, password-protected file that holds your public details and your encrypted private keys. You can either reuse the identity that is already unlocked in the top bar, or create a brand-new one by entering a username (for example `cn=user/o=acme`) and a strong password. The password encrypts your private keys; Haven will ask for it every time you use this identity later, and there is no recovery flow, so save it in a password manager before you continue.

Step two, set up a separate admin identity. MindooDB deliberately keeps the tenant admin and the everyday app user apart, so that a single compromised password cannot take over both directory management and day-to-day document work. The wizard creates the admin identity for you with its own username and password.

Step three, create the tenant itself. Haven generates the encryption keys for the new tenant, stores them in your local KeyBag, and wires up both identities. Everything stays locally in your browser at this stage — nothing has been pushed to a server yet.

Step four, you are all set. Haven drops you into your empty Workspace, already unlocked, already inside the new tenant. When you are ready to collaborate, publish the tenant to a MindooDB server from Preferences → Tenants.

### Path two: joining an existing team

If a teammate has already set up a tenant on a MindooDB server, press Join a team instead. The wizard uses the same four-step layout but follows MindooDB's three-step join handshake, where your private keys never leave this device.

Step one, create your personal user identity (or reuse the active one), just like in the other path.

Step two, send a join request. Haven builds a join-request URL from your public keys — no secrets — and shows it to you with a Copy URL button. Send that URL to the tenant administrator through any channel you like (email, chat, a ticket system); it is safe to share openly because it contains only your public keys. The administrator will open their Haven, run Grant tenant access on your request, and send back two things: a join-response URL and a short shared password. Important: the shared password must come through a separate, secure channel — a phone call, a different messenger, or in person — because the response carries the encryption keys for the workspace.

Step three, complete the join. Paste the join-response URL into the wizard, enter the server URL that hosts the tenant (there are one-click shortcuts for known servers), and type the shared password the administrator gave you separately. Haven validates the server, pulls the initial directory data, and adds the tenant to your Haven.

Step four, you are in. Haven drops you into the freshly joined tenant and the Workspace is ready to fill with tiles.

### After the wizard

Once the Welcome wizard is done, the day-to-day path is the same whichever route you took.

Open the Workspace. The first time there will be no tiles on it. Use the Add button in the top right of the Workspace page to create a new database tile pointing at one of the databases in your tenant. Double-click the tile to open the Database Browser and see its documents.

Run a sync. Go to the Sync screen and press Sync All, or use the per-row Sync if you only want to refresh a single database. Once the status column shows a green check, your local replica is up to date with the server.

Come back to the Workspace and keep adding tiles — applications, notes, web pages, dashboards, anything that makes your workspace feel like home.

If any step feels abstract, open the Help button on that screen. The in-app help has a "spotlight" walkthrough that highlights exactly what to click. And you can always revisit the Welcome page later — it is happy to reuse an existing identity or help you create additional ones.

### Haven is multi-tenant by design

Nothing stops at one tenant. The Welcome wizard can be run again at any time, and each new tenant is cryptographically independent from every other — its own encryption keys, its own KeyBag entry, its own admin chain, its own signed history. That independence is what makes it safe to keep very different contexts under one roof.

A common setup is to run three or four tenants in parallel: one for work, one for personal topics like household planning or a side project, and another one shared with a partner company for cross-organisation collaboration. You can use the same user identity across all of them or create a dedicated identity per tenant — the choice is yours, because nothing links the tenants together except the fact that they happen to live in the same browser.

Haven is genuinely multi-tenant, not single-tenant-with-switching. You can have several tenants unlocked and active at the same time, mix their data inside a single workspace page, and map databases from different tenants behind separate logical handles to the same application so it can work across organisational boundaries without ever seeing more than it should. Virtual views take this one step further: a single view can pull from several databases across several tenants and categorize, sort, and total their documents as if they were one data set. For example, a personal planning view can combine your private to-do list with the work tasks assigned to you in the company tenant, even though the two data sets are encrypted with completely different keys and synced to completely different servers.

Add tenants whenever a new context appears. Leaving them side by side is cheap, and the cryptographic separation means you never have to worry about data leaking from one into another.

## Workspace

The Workspace is your daily home. You arrange databases, applications, notes, web pages, videos, and diagrams as draggable tiles across multiple pages, like home screens on a phone. The layout is personal: it is stored only in this browser, so it loads instantly and works offline.

Pages are the tabs across the top of the Workspace. Each page has its own grid of tiles, and you can have as many pages as you like — one per project, one per role, one for daily dashboards, one for personal links. Right-click a page tab to rename, reorder, or delete it. A special page called All shows every tile from every page in one read-only overview, which is handy when your Workspace has grown past a few pages.

Tiles are the cards on the grid. Drag a tile by its header to move it, drag the corner to resize it, or right-click for the full context menu. Drop a tile onto another page tab to move it there. Drop a tile onto another tile to start a group.

Groups cluster related tiles under a shared, color-coded header. A group is a great way to keep the tiles for one project visually together — for example, the database, the running app, and a reference note for the same team. Right-click the group header to rename it, change its color, or ungroup the tiles back into normal cards.

Several kinds of tile live on the same grid.

A database tile points at one MindooDB database. Double-click it to open the Database Browser. Use the context menu to switch which copy of the database the tile is showing — a local replica for speed and offline, or a live server target for the freshest state. Database tiles remember the tenant, the database, and the source you last used, so they are also a handy bookmark back into the rest of MindooDB.

An application tile launches a MindooDB app. There are three runtime modes and you pick the one that fits the app. Embedded in the tile runs the app right inside its workspace card, which is perfect for small glanceable tools like a capture form or a mini dashboard. Inside Haven opens the app full-width inside the Haven window and uses the Running Apps drawer for switching; apps opened this way keep running in the background while you navigate elsewhere, so their scroll position, unsaved edits, and open tabs are still there when you switch back. In a separate browser tab opens the app as a standalone page, useful for a second monitor or for browsing Haven and the app at the same time.

Text tiles hold formatted notes. Web tiles embed any URL as a mini browser, which is how you keep a partner system or another team's dashboard next to the MindooDB data it documents. Video tiles play YouTube content for tutorials and walkthroughs. Mermaid tiles render live architecture diagrams and flowcharts right on the grid. These content tiles are personal — they live in this browser only — so they are ideal for cheat sheets, daily links, and live reference material.

A search bar across the top of the Workspace filters tiles across pages by name, database, tenant, tag, or server. On the All page you can also sort tiles by last used, tenant, alphabet, or connection, which becomes the fastest way to find something when the workspace has grown.

## Applications

Applications is the screen where team admins register MindooDB apps so Haven can launch them securely. Regular users never need to visit this screen; they just use the apps their admin set up from their workspace.

Each row in the catalog is one application registration. A registration is a contract between Haven and the app: Haven promises to launch the app in the way the registration describes and to expose only the data the mappings allow, and the app agrees to go through Haven's SDK connector for every read and write. Changing a mapping takes effect the next time the app starts; no code changes are required in the app itself.

The catalog lets you create a new registration with the New button (it is a dropdown, so you can pick between adding a new external URL and importing a hosted bundle), or bring in a pre-packaged registration with the Import button. Each row has four actions: Launch to start the app with the active user, Edit to change its settings or mappings, Info to view its metadata (like its app id and current version), and Remove to unregister it. A small RUNNING badge next to the name tells you that an instance of this app is already alive inside Haven; in that case Launch takes you into the existing session instead of starting a second one.

Two things define how Haven serves an app. First, where the code lives. An external URL points at a dev server or a deployed web app running somewhere else; you will use this while developing or when another team hosts the app. A hosted bundle is a packaged set of web assets imported into Haven itself. Once stored locally, Haven can deliver the bundle through its own service worker, which means the app launches from local storage even when there is no network — this is the route to truly offline-capable apps. Second, how it runs. Embedded mode sits inside a workspace tile. Window mode opens the app in its own browser tab or popup.

The part of the registration that actually protects you is the data mapping. For every database you want the app to see, you choose the logical name the app will address it by and the capabilities you are granting: read-only or read/write, whether to allow deletion, attachments, revision history, and the creation of app-defined virtual views. You can also map databases from different tenants or different servers behind separate logical handles, which lets a single app work across boundaries without ever seeing more than it should.

When an app launches, it does not talk to MindooDB storage directly. It calls the SDK connector, which opens a session with Haven, and every read, write, query, attachment operation, or history call flows through that connector. Haven validates each request against the mapping and permissions you configured, so even if the app tried to misbehave, the bridge would refuse.

Registrations can be exported as JSON packages and imported again in another browser, for a teammate, or in a different environment. Exports can optionally include the hosted bundle files, which makes it practical to promote an app from local development to a reusable Haven package without rebuilding the registration by hand.

A good rule of thumb when registering a new app: start with read-only access and a single database, get the app running, and only then widen the capabilities. It is much easier to add write access later than to take it away in a hurry.

## Sync

Sync is how the data in your local replicas stays in step with the server. Everybody can sync the databases they already have access to — you do not need to be an admin.

The screen lists every tracked database in every local replica the active user can see. Rows are grouped by tenant. For each row you see which server, tenant, replica, and database it belongs to, the direction of sync (push only, pull only, or bidirectional), and the last sync result. A small "synced before" badge appears on rows that have previously completed at least once, which makes it easy to spot the databases that have never been pulled yet.

There are three ways to trigger sync. The per-row Sync button refreshes just that database. The Sync tenant button (on each tenant's header) refreshes every database in that tenant. The Sync All button at the top of the page refreshes everything in one go. While a sync is running, the status column shows live progress, including how many batches have been transferred. A green check means the row finished without errors. A red badge means something went wrong; when that happens, Haven leaves the row as it was before the sync started, so you never end up with half-applied changes.

A Stop button appears while a sync is running. It sends a cooperative stop signal to the current run. The current row is allowed to finish or roll back cleanly, so you do not end up with half-written data. There is one caveat worth knowing: if you press Stop while a specific row is mid-transfer, that row may end up with only some of the new data, so the next read could mix recent and old values. After a stop, re-run that row before trusting any numbers from it.

When should you sync? The short answer is: before you trust a number you are about to share. Run sync before generating an export from a virtual view, before walking into a meeting based on a dashboard, and any time the network has been down for a while. Sync All is always safe — it only ever pulls new data and pushes your queued changes; it never deletes work you have not yet committed.

One small gotcha: if you expected a database to appear in the queue and it is missing, the usual reason is that the user identity holding the replica is not unlocked yet. Sync needs the keys from the local KeyBag, and the KeyBag only opens once the active identity is unlocked from the top bar.

## Virtual Views

Virtual views are the analytical surface of Haven. They give you a spreadsheet-like tree that filters, categorizes, sorts, and totals documents across one database, several databases, or even several tenants. They are how you answer questions across your data rather than just inside one database.

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

When the plain revision list is not enough to explain what happened, open the Document History view. This is Haven's DAG explorer: a graph rendering of every signed change ever applied to the document. The graph reads top-down (or left-right, depending on layout): each node is one signed change, and edges show how changes followed each other. Branches appear when two people edited the document at the same time, and they meet again at a merge node when the next sync brought their work together.

Hovering a node shows who made the change, when, from which device, and which fields were touched. Clicking a node opens a side panel with a before-and-after diff for the document, with only the fields that changed highlighted — even very small edits are easy to spot. When two branches meet at a merge node, the side panel describes how each conflicting field was resolved, because MindooDB's Automerge engine uses a deterministic rule rather than guessing.

Nothing in the Document History view can be edited. It is a faithful, read-only record of history. That is also what makes it useful for compliance: every node is signed by the user who made the change, so it is the source of truth when a reviewer asks who changed this and when.

## Preferences

Preferences is the one screen that is organized as a tab bar instead of a single page. It has five tabs: General, User ids, Tenants, Backup, and Stats. Everything on these tabs lives in this browser and, with a few exceptions in Tenants, does not touch the server.

### General

General is where you adjust how Haven looks and how it launches on your device. All of it is personal and applies immediately — there is no Save button.

At the top, a Start page setting lets you pick which page Haven opens when you visit the root URL. If you always land on the same screen first thing in the morning, point Start page at it and skip the extra click.

Current theme lets you pick a color preset (for example Mindoo or Aura) and switch between light and dark mode. The preset changes accent colors throughout the app; the light/dark toggle controls the background and text contrast. The same theme choice is reflected in the identity chip's right-click menu and is propagated live to any embedded MindooDB app so they match Haven's look without reloading.

Add Haven to your home screen is a one-tap card that offers a shortcut to the install guide for your platform. On iPhone it links to Safari's Add to Home Screen flow; on Android it triggers the browser's Install prompt or points you at the Install app action in the browser menu. If Haven is already running from its installed icon, the card simply confirms that and shows a Review install steps button in case you want to add another copy.

An Optimize for iOS multitasking toggle near the bottom of the tab tells Haven that it is used in iPad split-screen or slide-over mode, where the system adds window controls that overlap Haven's mobile menu button. Turning the toggle on shifts Haven's navigation button to the right so it stops colliding with the system chrome.

### User ids

A user identity is your account inside Haven, and this tab is where you manage your stored identities. Each row is one identity with its username and creation date. The Switch action makes that identity the active one for this Haven session. Only one identity is unlocked at a time — if something on another screen complains that it cannot read a tenant, the wrong identity is usually unlocked.

Create generates a brand-new identity directly in the browser. Haven asks for a username and a password; the password encrypts the new private keys before they are stored. Import brings in a .json file that was previously exported from Haven (for example on another device or by a teammate) and asks for the password that was used when the file was exported.

Change password re-encrypts an identity's private keys and the tenant KeyBags that depend on it. Haven does this in one step so the new password works everywhere immediately. Pick a strong password and store it somewhere you can find again, because there is no reset link: if you forget the new password, every tenant tied to this identity becomes unreadable, even on devices that already had the data. Save the password to a password manager before pressing Save.

### Tenants

A tenant is your team's private workspace, and this tab lists every tenant Haven knows about for the active user identity. For each row you see the tenant id, the current user, the admin user, and any servers the tenant has been published to.

Opening a tenant shows its key fingerprints and where it is currently published. The fingerprints come from the local KeyBag for the active user, so they only appear once that user is unlocked. Treat fingerprints as proof of identity for the tenant's encryption keys: if two team members compare them in person and they match, you can be confident nobody swapped a key in between.

New tenants always start in this browser for the active user. Publishing pushes the tenant to a MindooDB server so other team members can join. Deleting from a server removes the tenant location from that server only — the local copy stays put. Publishing and deleting on a server require a system admin password, because they touch shared infrastructure; if you are not the platform admin, ask them to run the action with you.

Be careful with delete-on-server. It wipes that server's view of the tenant for every user, not just yours, and other clients may suddenly fail to sync. Confirm it with the platform admin and any other team admins first, and make sure a current encrypted backup exists before pressing the button.

### Backup

Haven keeps almost everything in this browser. The Backup tab is the safety net: you can back that up to an encrypted file, restore a backup later, or wipe Haven entirely.

An encrypted backup is a single file that contains everything Haven keeps in this browser: saved users, tenants, applications, hosted app files, workspace layout, virtual views, and the local IndexedDB content. You choose a backup password, and Haven uses it to encrypt the file before it is downloaded. The password itself is never stored anywhere — Haven cannot show it to you later and cannot help you recover the backup if you lose it. Downloads use the .mdbhaven-backup extension so they are easy to spot in a downloads folder.

Restore happens in two steps, both deliberate. The first step, Preview, decrypts the file just enough to show you a summary of what is inside: counts of identities, tenants, applications, IndexedDB databases, and any restore warnings. Nothing local is touched yet. Some backups contain databases that cannot be moved across browsers as-is; the preview shows a warning per affected database with whether it will be rebuilt empty or skipped. Rebuild means the database will be created empty and refilled from sync. Skip means it will not be restored at all and you will need to reconnect that source manually.

The second step, Restore and reload, wipes the current Haven state in this browser and writes the backup back. Haven reloads automatically and you end up signed in to the restored data. Because restore deletes the current state first, anything that was not exported and not synced will be gone. Export a fresh encrypted backup of the current state before pressing Restore, just in case.

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

Every user has a cryptographic identity made of an Ed25519 signing key and an RSA-OAEP encryption key. Both private keys are encrypted with a password you choose, stored locally in the browser, and never transmitted. That identity is what unlocks tenants and signs your changes.

Each tenant has a KeyBag — a password-protected store of encryption keys. The default key is shared with every member of the tenant and encrypts documents unless a more specific key is chosen. Named keys give fine-grained access to a smaller group for especially sensitive documents. All of this lives on your device; the server never sees keys.

Every document is an Automerge CRDT stored in a content-addressed store. Every change is signed with your Ed25519 key and encrypted with AES-256-GCM before it ever leaves the browser. The server stores and relays ciphertext and can never read your data, even if it is fully compromised. Transport adds a second layer of per-user RSA-OAEP encryption, and TLS wraps the whole thing as a third layer. Access control is enforced through encryption, which means if you do not have the key, the document is just ciphertext — there is no trusted server to ask for permission and be tricked into giving it.

Because every change is signed and appended to a chain, history cannot be rewritten quietly. Haven's Document History view is a direct rendering of that chain, and Automerge merges concurrent edits deterministically so two people can work on the same document without a conflict dialog.

Apps that run inside Haven are wrapped in the browser's sandbox on their own origin. Hosted apps get an even stricter opaque-origin sandbox. An app cannot reach Haven's storage, cookies, or other apps; it only sees the databases you mapped and the capabilities you granted. Every call the app makes — read, write, attachments, history — flows through Haven's SDK bridge, which validates it against the mapping before it touches any data.

That, in a minute, is why Haven is private by design rather than by policy.

## Glossary

These are the terms Haven uses across its screens and its help drawer. They are listed roughly in the order you are likely to meet them, not strictly alphabetically, because most of them build on the ones before.

User identity — your account inside Haven. Created locally, protected by a password, and is what unlocks tenants and signs your changes. The Preferences tab calls it User ids.

Tenant — your team's private workspace inside MindooDB. Groups users, encryption keys, and databases together so a team can share data securely.

Tenant admin — a privileged identity inside a tenant. Can register or revoke other users and change tenant-wide settings.

App user — a regular user identity inside a tenant. Does everyday document work but cannot register or revoke other users.

System admin — a server-level identity used to manage a MindooDB server itself: connecting Haven to it, trusting other servers, and bootstrapping new tenants.

KeyBag — a local, password-protected key store that holds the encryption keys a tenant needs. Each user keeps their own in this browser.

Default key — the encryption key shared with every member of a tenant. If a document does not specify a named key, it is encrypted with the default key.

Named key — an extra encryption key shared only with selected users. Useful for sensitive documents that should not be visible to the whole tenant.

Signed change — every edit to a document is signed with the author's private key. This proves who made the change and prevents anyone from forging history later.

Local replica — a browser-local synced copy of a tenant's databases. Fast, works offline, and is the recommended way to browse and edit.

Live source — a source mode that pulls fresh data from a MindooDB server before using it. Slower than the local replica but useful when you need the very latest state.

IndexedDB — the browser's built-in database. Haven stores almost everything inside IndexedDB so it can work offline.

Payload bytes — an approximate measurement of how much real content Haven keeps in this browser. It excludes the overhead the browser itself adds.

Local tenant cache — a per-tenant browser cache that helps Haven reopen work faster, resume sync, and reuse local query data. Can be cleared and rebuilt automatically.

Server target cache — a cache scoped to one tenant and one server. Speeds up live sync against that server and can be cleared safely.

Virtual view cache — stores a virtual view's materialized results plus its resumable indexing state, so the view reopens quickly. Clearing it rebuilds the view next time you open it.

Protected database — a database that Haven needs in order to operate (for example, the tenant directory). It cannot be deleted from the storage panel.

Tile — a draggable, resizable card on the workspace grid. Each tile holds a database, an application, a note, an embedded web page, a video, or a diagram. Also called a chicklet.

Page — a workspace tab that contains its own grid of tiles. Use multiple pages like home screens on a smartphone.

Group — a visual container that clusters related tiles under a shared, color-coded header. Drag one tile onto another to create a group.

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

Application registration — the saved Haven-side definition of a MindooDB app: where to launch it from, how to run it, and which databases or views it is allowed to see.

Hosted bundle — a packaged set of web assets imported into Haven so it can serve the app locally, even when offline.

External URL — a web address for an app hosted outside Haven, such as a local development server or a deployed web app.

App connector (bridge) — the secure channel between a MindooDB app and Haven. Apps never talk to your data directly; every read or write goes through this connector so Haven can enforce the permissions you granted.

Launch context — the initial information an app receives from Haven when it starts: theme, viewport, current user, launch parameters, and the databases it has been granted.

Runtime mode — how an app is presented: embedded inside a Haven tile, or opened in its own browser window or tab.

Sandbox — the browser-enforced isolation that wraps every app. The app cannot reach Haven's storage, cookies, or other apps unless you explicitly share data with it.

Theme preset — a named color palette for Haven (for example Mindoo or Aura). Switching the preset changes accent colors throughout the app.

Light / dark mode — whether Haven uses a light or dark background. The choice is remembered in this browser only.

Standalone mode — a display mode where Haven launches without normal browser controls, like a dedicated app. Available after you add Haven to a phone home screen.

Add to Home Screen — the browser action that saves Haven as a launchable icon on a phone or tablet home screen.

Install prompt — the browser-native sheet that confirms adding a progressive web app like Haven to the device.

Encrypted backup — a single file containing everything Haven keeps in this browser, scrambled with a password you choose. Without that password the file is unreadable.

Backup password — the password used to encrypt and later decrypt a backup file. Haven never stores it; if you lose it the backup cannot be restored.

Preview restore — a safe step that decrypts a backup file just enough to show you what it contains, before any local data is touched.

Restore warning — a note shown during preview when a backup contains databases that will need to be rebuilt empty or skipped during restore.

Factory reset — wipes all Haven data from this browser, including identities, tenants, applications, hosted apps, virtual views, and synced MindooDB data. Cannot be undone.

## Editions, pricing, and the open platform

Haven comes in two editions, and the one most people will ever need is free.

Haven Community is the free edition of Haven, in beta, available today at [haven.mindoodb.com](https://haven.mindoodb.com). It is the same client the MindooDB team develops, deploys, and uses in-house. "Beta" here means it is usable for real work, not a mockup — it is actively evolving, feedback feeds directly into the roadmap, and there is no formal SLA yet. If you need guaranteed response times, that is what the commercial support tier is for.

Haven Community works in three deployment topologies. Local-only, where everything lives in your browser and there is no server at all — perfect for personal notes and offline demos; in this mode the Preferences → Backup tab doubles as your transfer mechanism, because an encrypted `.mdbhaven-backup` file contains your user identities, settings, and MindooDB databases, so you can move a complete local-only Haven from one browser to another by exporting and restoring. Connected to the hosted Mindoo demo server, which lets you publish a local tenant and test real multi-user collaboration; demo-server data is wiped periodically, so it is for evaluation rather than production. And self-hosted, where you point Haven at a MindooDB server you run yourself, with full setup instructions in [`README-server.md`](https://github.com/klehmann/MindooDB/blob/main/README-server.md) in the MindooDB repository. The choice is yours and you can move between topologies at any time.

Haven Community is also a complete platform for custom app development. You can build MindooDB apps by hand using the App SDK, or let an AI agent generate them from the structured `llms-full.txt` on mindoodb.com plus the public reference app repositories. Two free productivity apps ship pre-configured in the Applications page's New dropdown so you can install them in one click and see what a polished MindooDB app looks like. Mindoo Vega renders the same tree of nodes as either a Mindmap or a Kanban board, with task fields, attachments, and full-text search — handy for project planning where the same data needs both a big-picture and a lane-by-lane view. Mindoo TodoManager turns Covey's four-quadrant method (important/not important, urgent/not urgent) into a visual task workflow for staying focused on what matters most. A third ready-to-use app, [Mindoo Weather](https://github.com/klehmann/mindoodb-app-weather), is a beautiful iOS-Weather-style tile that shows a 10-day forecast plus air quality for one or more locations configured through a launch parameter — it adapts live to the tile size Haven reports (narrow: one swipeable card with dots; wider: two to four at a time) and pulls all data from keyless Open-Meteo APIs, so it doubles as a reference for the UX side of the SDK. All three are free to use; the same dropdown also carries the SDK Example App for developers who want a living reference of every SDK feature.

The underlying MindooDB platform is open source under the Apache 2.0 license. That matters beyond the price tag: there is no data lock-in. The data model, the content-addressed store, and the sync protocol are all documented and reimplementable, which means a team can take their encrypted data with them at any time — and it is even possible to build entirely alternative clients on top of the same platform if Haven is not the right fit for a particular use case. Haven is the official client; it is not the only possible one.

Haven Enterprise is a commercial edition in development at Mindoo GmbH, built on exactly the same MindooDB core. It adds the features organisations tend to ask for when Haven is rolled out across teams, departments, and devices: custom branding (logo, colors, product name, and domain so Haven feels like your own product), a managed user interface with organisation-specific defaults, managed workspace templates pushed to users so they land in a configured environment, an in-house app store for curating internal and third-party MindooDB apps, workspace roaming across devices and browser profiles, automatic scheduled backups of in-browser data, first-class backup tooling for the tenant data stored on your server, and inline editing of common Office and text attachments without having to download them. The list continues to grow as the Enterprise client matures — customer feedback shapes the roadmap directly.

Choosing Haven Enterprise never takes you off the open platform. The MindooDB core and the Haven PWA remain free and open; Enterprise is a separate, commercial client layered on top. You can start on Community, move to Enterprise later, and in either direction your data and your server stay exactly where they were.

For current details, pricing, and the early-access list for Haven Enterprise, see the Haven pricing page at [mindoodb.com/haven/pricing](https://mindoodb.com/haven/pricing).

## Where to go next

Haven is an active product and it is also the public face of MindooDB. A few resources are worth bookmarking.

The easiest way to actually try Haven is to open [haven.mindoodb.com](https://haven.mindoodb.com) in a modern browser — it is the live Community client.

The product pages at [mindoodb.com/haven](https://mindoodb.com/haven) go into more detail on the positioning and the security model, and cover the parts of the story that a handbook cannot — screenshots, roadmap, and the wider MindooDB platform.

The [MindooDB App SDK on GitHub](https://github.com/klehmann/mindoodb-app-sdk) is the TypeScript library for building apps that run inside Haven. Two companion open-source projects show what production-quality apps built on it look like: the [example project](https://github.com/klehmann/mindoodb-app-example) is a Vue 3 reference app that demonstrates every SDK feature across three tabs (Databases, Views, Events) — its live demo is at [app-example.mindoodb.com](https://app-example.mindoodb.com) and can be registered in Haven with an external URL for a few minutes of hands-on exploration; and [`mindoodb-app-weather`](https://github.com/klehmann/mindoodb-app-weather) focuses on the UX side of the SDK, showing launch parameters, viewport events, and responsive embedding through a polished iOS-Weather-style tile.

Inside Haven itself, remember the Help button in the top bar. Every screen has its own help article, written in the same friendly style as this handbook, and a short spotlight walkthrough that highlights the important controls. When in doubt on a screen you have not used before, open it first — it is usually faster than reading about it elsewhere.

That is Haven. A local-first, end-to-end encrypted, app-hosting workspace in a browser tab. Private by design, calm by default, and ready whether you are online or not.
