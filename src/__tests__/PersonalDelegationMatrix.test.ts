/**
 * Rights over time for delegated personal databases, against a real server
 * over HTTP (konzepte/mail-kalender-schluessel-konzept.md §13, level M).
 *
 * Jane owns `mmail_` and `mcal_` with one group document each (her account)
 * and a deposit key per group. Bob and Carol are colleagues she delegates to
 * and takes it away from again, Eve is a member who never gets anything, the
 * gateway delivers. Every document carries a marker. After every step each
 * actor pulls what the server lets them pull, and the markers they can read are
 * compared with what an oracle computes from the history of rights alone:
 *
 * - Jane reads every marker the server accepted;
 * - a delegate reads the markers of a kind while they hold a right for it and
 *   are a member of its group; joined with `history: "none"` only those
 *   written after joining (deliveries: to a deposit key created after joining);
 * - after removal nothing, also not what was there before (honest client);
 * - Eve and the gateway read nothing; the server stores no marker in clear.
 *
 * Writes of a delegate are accepted only while they may edit, judged when they
 * are pushed (an offline write pushed after the right was taken away is refused).
 */
import fs from "fs";
import { Server } from "http";

import { IsolatedInMemoryStoreFactory } from "./_helpers/multiDevice";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { MindooDBServer } from "../node/server/MindooDBServer";
import {
  PUBLIC_INFOS_KEY_ID,
  StoreKind,
  USER_DIRECTORY_DB_ID,
  type MindooDB,
  type MindooDoc,
  type MindooTenant,
  type MindooTenantDirectory,
  type PrivateUserId,
} from "../core/types";
import type { ServerConfig } from "../server/types";
import { fingerprintPublicKeyPem } from "../core/userkeys/fingerprint";

const PASSWORD = "member-pass";
const SYSTEM_ADMIN_PASSWORD = "sysadmin-pass";
const SERVER_PASSWORD = "server-matrix-pass";

type Kind = "mail" | "calendar";
type Right = "read" | "edit";
type Actor = "jane" | "bob" | "carol" | "eve" | "gateway";
const PREFIX: Record<Kind, string> = { mail: "mmail_", calendar: "mcal_" };
const DEPOSIT_ID: Record<Kind, string> = { mail: "memo", calendar: "cinv" };

async function startServer(server: MindooDBServer): Promise<{ httpServer: Server; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const httpServer = server.getApp().listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to determine test server port"));
        return;
      }
      resolve({ httpServer, baseUrl: `http://127.0.0.1:${address.port}` });
    });
    httpServer.on("error", reject);
  });
}

/** What the oracle knows about one written document. */
interface Written {
  marker: string;
  author: Actor;
  kind: Kind;
  step: number;
  /** Deliveries: the step at which the deposit key they were sealed to was created. */
  keyStep?: number;
  accepted: boolean;
}

/** Per delegate and kind: right and group membership over time. */
interface Membership {
  right: Right | null;
  member: boolean;
  /** Step of the latest joining; with history "none", the first readable step. */
  joinedStep: number;
  historyNone: boolean;
}

describe("delegation rights over time (real server, matrix)", () => {
  jest.setTimeout(600000);
  const crypto = new NodeCryptoAdapter();
  let httpServer: Server;
  let baseUrl: string;
  let dataDir: string;
  let systemAdmin: PrivateUserId;

  beforeEach(async () => {
    const factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    dataDir = `/tmp/mindoodb-delegation-matrix-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    fs.mkdirSync(dataDir, { recursive: true });
    const serverIdentity = await factory.createUserId("CN=matrix-server", SERVER_PASSWORD);
    fs.writeFileSync(`${dataDir}/server.identity.json`, JSON.stringify(serverIdentity, null, 2), "utf-8");
    fs.writeFileSync(`${dataDir}/trusted-servers.json`, "[]", "utf-8");
    systemAdmin = await factory.createUserId("cn=sysadmin/o=matrix", SYSTEM_ADMIN_PASSWORD);
    const config: ServerConfig = {
      capabilities: {
        "ALL:/system/*": [{ username: systemAdmin.username, publicsignkey: systemAdmin.userSigningKeyPair.publicKey as string }],
      },
    };
    ({ httpServer, baseUrl } = await startServer(new MindooDBServer(dataDir, SERVER_PASSWORD, undefined, config)));
  }, 60000);

  afterEach(async () => {
    if (httpServer) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    if (dataDir && fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const openDb = (tenant: MindooTenant, dbId: string) =>
    tenant.openDB(dbId, dbId === "directory" ? { adminOnlyDb: true } : undefined);

  async function pull(tenant: MindooTenant, dbId: string) {
    const local = await openDb(tenant, dbId);
    await local.pullChangesFrom(await tenant.connectToServer(baseUrl, dbId, StoreKind.docs));
    await local.syncStoreChanges();
    return local;
  }

  async function push(tenant: MindooTenant, dbId: string, auth?: { user: PrivateUserId; password: string }) {
    const local = await openDb(tenant, dbId);
    return local.pushChangesTo(await tenant.connectToServer(baseUrl, dbId, StoreKind.docs), auth ? { networkAuthOverride: auth } : undefined);
  }

  /** Jane, Bob, Carol and Eve as full members, the gateway with $publicinfos and deposit rights. */
  async function setup() {
    const tenantId = `matrix-${Date.now().toString(16)}${Math.random().toString(16).slice(2, 6)}`;
    const founderFactory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
    const admin = await founderFactory.createUserId(`cn=admin/o=${tenantId}`, PASSWORD);
    const janeUser = await founderFactory.createUserId(`cn=jane/o=${tenantId}`, PASSWORD);
    await founderFactory.ensureUserKeyPair(janeUser, PASSWORD);
    const { tenant: jane } = await founderFactory.createTenant({
      tenantId,
      adminUser: admin,
      adminPassword: PASSWORD,
      appUser: janeUser,
      userPassword: PASSWORD,
    });
    jane.noteUserDirectoryFetched!();
    await jane.reconcileUserKeys!({ allowSelfCreate: true });
    await jane.publishToServer(baseUrl, {
      systemAdminUser: systemAdmin,
      systemAdminPassword: SYSTEM_ADMIN_PASSWORD,
      adminUsername: admin.username,
      adminSigningKey: admin.userSigningKeyPair.privateKey,
      adminPassword: PASSWORD,
    });
    const adminAuth = { user: admin, password: PASSWORD };
    const pushDirectory = async () => {
      await push(jane, "directory", adminAuth);
      await push(jane, USER_DIRECTORY_DB_ID);
    };
    await pushDirectory();

    async function join(name: string, options: { publicInfosOnly?: boolean; depositPrefixes?: string[] } = {}) {
      const factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
      const user = await factory.createUserId(`cn=${name}/o=${tenantId}`, PASSWORD);
      await factory.ensureUserKeyPair(user, PASSWORD);
      await jane.approveJoinRequest(factory.createJoinRequest(user, { label: name }), {
        adminSigningKey: admin.userSigningKeyPair.privateKey,
        adminPassword: PASSWORD,
        adminUsername: admin.username,
        label: name,
        username: user.username,
        serverUrl: baseUrl,
        ...(options.publicInfosOnly ? { sharedDocKeyIds: [PUBLIC_INFOS_KEY_ID] } : {}),
        ...(options.depositPrefixes ? { depositPrefixes: options.depositPrefixes } : {}),
      });
      await pushDirectory();
      const delivery = (await factory.discoverTenantsOnServer(baseUrl, { user, password: PASSWORD })).find((d) => d.tenantId === tenantId)!;
      const tenant = (await factory.bootstrapTenantFromDelivery(delivery, { user, password: PASSWORD, serverUrl: baseUrl })).tenant;
      await pull(tenant, "directory");
      await pull(tenant, USER_DIRECTORY_DB_ID);
      tenant.noteUserDirectoryFetched!();
      await tenant.reconcileUserKeys!({ allowSelfCreate: false });
      await push(tenant, USER_DIRECTORY_DB_ID);
      return { tenant, username: user.username };
    }

    const bob = await join("bob");
    const carol = await join("carol");
    const eve = await join("eve");
    const gateway = await join("mail-gateway", { publicInfosOnly: true, depositPrefixes: ["mmail_", "mcal_"] });
    for (const t of [jane, bob.tenant, carol.tenant, eve.tenant, gateway.tenant]) {
      await pull(t, "directory");
      await pull(t, USER_DIRECTORY_DB_ID);
    }
    const directory = (await jane.openDirectory()) as MindooTenantDirectory;
    const grantOf = async (username: string) => (await directory.findGrantAccessDocuments!(username)).find((d) => !d.isDeleted())!.getId();
    const janeGrant = await grantOf(janeUser.username);
    const tenants: Record<Actor, MindooTenant> = { jane, bob: bob.tenant, carol: carol.tenant, eve: eve.tenant, gateway: gateway.tenant };
    const usernames: Record<Actor, string> = {
      jane: janeUser.username,
      bob: bob.username,
      carol: carol.username,
      eve: eve.username,
      gateway: gateway.username,
    };
    const grants = {} as Record<Actor, string>;
    for (const actor of Object.keys(usernames) as Actor[]) grants[actor] = await grantOf(usernames[actor]);
    /** A second device of `who`, added with a device certificate ("Add device", not on the grant). */
    async function certifiedDevice(who: "bob" | "carol"): Promise<MindooTenant> {
      const owner = tenants[who];
      const ownerDirectory = (await jane.openDirectory()) as MindooTenantDirectory & {
        setDeviceSelfGrant(username: string, key: string | null, adminKey: unknown, password: string): Promise<void>;
      };
      await ownerDirectory.setDeviceSelfGrant(usernames[who], await owner.getDeviceSelfGrantPublicKey!(), admin.userSigningKeyPair.privateKey, PASSWORD);
      await push(jane, "directory", adminAuth);
      await pull(owner, "directory");
      const factory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), crypto);
      const device = await factory.createUserId(usernames[who], PASSWORD);
      await owner.issueDeviceCertificate!({ signingPublicKey: device.userSigningKeyPair.publicKey, encryptionPublicKey: device.userEncryptionKeyPair.publicKey }, "Tablet");
      await push(owner, USER_DIRECTORY_DB_ID);
      const delivery = (await factory.discoverTenantsOnServer(baseUrl, { user: device, password: PASSWORD })).find((d) => d.tenantId === tenantId)!;
      const joined = (await factory.bootstrapTenantFromDelivery(delivery, { user: device, password: PASSWORD, serverUrl: baseUrl })).tenant;
      await pull(joined, "directory");
      await pull(joined, USER_DIRECTORY_DB_ID);
      joined.noteUserDirectoryFetched!();
      await joined.reconcileUserKeys!();
      return joined;
    }
    return { tenantId, tenants, usernames, grants, janeGrant, certifiedDevice };
  }

  /** Runs a scenario: a list of steps, each followed by the oracle check. */
  async function scenario(name: string, steps: Array<(w: World) => Promise<void>>) {
    const world = await World.create(await setup(), name);
    for (const [index, step] of steps.entries()) {
      world.step = index + 1;
      await step(world);
      await world.check();
    }
    world.assertServerHasNoPlaintext(dataDir);
  }

  class World {
    step = 0;
    written: Written[] = [];
    members: Record<"bob" | "carol", Record<Kind, Membership>> = {
      bob: { mail: { right: null, member: false, joinedStep: 0, historyNone: false }, calendar: { right: null, member: false, joinedStep: 0, historyNone: false } },
      carol: { mail: { right: null, member: false, joinedStep: 0, historyNone: false }, calendar: { right: null, member: false, joinedStep: 0, historyNone: false } },
    };
    groups = {} as Record<Kind, MindooDoc>;
    /** Per kind: the current deposit key (public half) and the step it was created at. */
    keys = {} as Record<Kind, { publicKey: string; fingerprint: string; step: number }>;
    /** Delegate writes not pushed yet (offline). */
    pending: Array<{ actor: Actor; kind: Kind; written: Written }> = [];
    private counter = 0;

    private constructor(
      readonly t: Awaited<ReturnType<typeof setup>>,
      readonly name: string,
    ) {}

    static async create(t: Awaited<ReturnType<typeof setup>>, name: string): Promise<World> {
      const world = new World(t, name);
      for (const kind of ["mail", "calendar"] as Kind[]) {
        const db = await world.db("jane", kind);
        world.groups[kind] = await db.createDocument({ recipients: [], initialValues: { name: `group ${kind}` } });
        const key = await db.createDepositKey!(world.groups[kind].getId());
        world.keys[kind] = { publicKey: key.publicKeyPem, fingerprint: key.fingerprint, step: 0 };
        await push(t.tenants.jane, world.dbId(kind));
      }
      await world.publish();
      return world;
    }

    dbId(kind: Kind) {
      return `${PREFIX[kind]}${this.t.janeGrant}`;
    }

    db(actor: Actor, kind: Kind): Promise<MindooDB> {
      return openDb(this.t.tenants[actor], this.dbId(kind));
    }

    marker(actor: Actor, kind: Kind) {
      return `MKR-${this.name}-${this.step}-${actor}-${kind}-${++this.counter}`;
    }

    /** Jane's record from the oracle's rights, with the current deposit keys. */
    async publish() {
      const delegates = (["bob", "carol"] as const)
        .map((who) => {
          const rights: Record<string, string> = {};
          for (const kind of ["mail", "calendar"] as Kind[]) {
            const m = this.members[who][kind];
            if (m.right) rights[PREFIX[kind]] = m.right;
          }
          return { grant: this.t.grants[who], rights };
        })
        .filter((d) => Object.keys(d.rights).length > 0) as Array<{ grant: string; rights: Record<string, "read" | "edit"> }>;
      const depositKeys = Object.fromEntries(
        (["mail", "calendar"] as Kind[]).map((kind) => [PREFIX[kind], { publicKey: this.keys[kind].publicKey, fingerprint: this.keys[kind].fingerprint }]),
      );
      await this.t.tenants.jane.publishPersonalShares!({ delegates, depositKeys });
      await push(this.t.tenants.jane, USER_DIRECTORY_DB_ID);
      for (const actor of ["bob", "carol", "eve", "gateway"] as Actor[]) await pull(this.t.tenants[actor], USER_DIRECTORY_DB_ID);
    }

    /** Jane gives `who` a right on `kind` (joining the group if needed). */
    async grant(who: "bob" | "carol", kind: Kind, right: Right, history: "all" | "none" = "all") {
      const m = this.members[who][kind];
      const db = await this.db("jane", kind);
      if (!m.member) {
        await db.addRecipients!(this.groups[kind], [this.t.usernames[who]], { history });
        m.member = true;
        m.joinedStep = this.step;
        m.historyNone = history === "none";
        if (history === "none") await this.newDepositKey(kind);
      }
      m.right = right;
      await push(this.t.tenants.jane, this.dbId(kind));
      await this.publish();
    }

    /** Jane takes `kind` away from `who`: rotation, new deposit key, record. */
    async revoke(who: "bob" | "carol", kind: Kind) {
      const m = this.members[who][kind];
      const db = await this.db("jane", kind);
      if (m.member) {
        const removed = await db.removeRecipients!(this.groups[kind], [this.t.usernames[who]]);
        expect(removed.rotated).toBe(true);
        m.member = false;
        await this.newDepositKey(kind);
      }
      m.right = null;
      await push(this.t.tenants.jane, this.dbId(kind));
      await this.publish();
    }

    /** Only the server right changes (record), not the group: e.g. edit → read. */
    async setRight(who: "bob" | "carol", kind: Kind, right: Right) {
      this.members[who][kind].right = right;
      await this.publish();
    }

    async newDepositKey(kind: Kind) {
      const db = await this.db("jane", kind);
      const key = await db.createDepositKey!(this.groups[kind].getId());
      this.keys[kind] = { publicKey: key.publicKeyPem, fingerprint: key.fingerprint, step: this.step };
    }

    /** A document in the group's key series, by Jane or a delegate. */
    async write(actor: "jane" | "bob" | "carol", kind: Kind, options: { offline?: boolean } = {}) {
      const written: Written = { marker: this.marker(actor, kind), author: actor, kind, step: this.step, accepted: false };
      const db = await this.db(actor, kind);
      if (actor !== "jane") await pull(this.t.tenants[actor], this.dbId(kind)).catch(() => undefined);
      // Without the group's key there is nothing to write with: refused locally already.
      await db.createDocument({ groupKeyDocId: this.groups[kind].getId(), initialValues: { marker: written.marker } });
      this.written.push(written);
      if (options.offline) {
        this.pending.push({ actor, kind, written });
        return;
      }
      await this.pushWrite(actor, kind, written);
    }

    async pushWrite(actor: Actor, kind: Kind, written: Written) {
      const result = await push(this.t.tenants[actor], this.dbId(kind)).catch((error: unknown) => ({ error }));
      const refused = "error" in result || (result.rejectedEntries ?? []).length > 0;
      written.accepted = !refused;
    }

    /** Push what was written offline, with the rights as they are now. */
    async goOnline() {
      for (const { actor, kind, written } of this.pending.splice(0)) await this.pushWrite(actor, kind, written);
    }

    /** The gateway delivers into `kind`, sealed to the deposit key it finds in Jane's record now. */
    async deliver(kind: Kind, options: { staleKey?: { publicKey: string; step: number } } = {}) {
      const directory = (await this.t.tenants.gateway.openDirectory()) as MindooTenantDirectory;
      const record = await directory.getPersonalShares!(this.t.janeGrant);
      const current = record!.depositKeys[PREFIX[kind]]!;
      const key = options.staleKey ?? { publicKey: current.publicKey, step: this.keys[kind].fingerprint === current.fingerprint ? this.keys[kind].step : -1 };
      expect(key.step).toBeGreaterThanOrEqual(0);
      const written: Written = { marker: this.marker("gateway", kind), author: "gateway", kind, step: this.step, keyStep: key.step, accepted: false };
      this.written.push(written);
      const db = await this.db("gateway", kind);
      await db.createDocument({
        idPrefix: DEPOSIT_ID[kind],
        recipients: [{ devicePem: key.publicKey, label: "deposit" }],
        recipientOptions: { includeSelf: false },
        initialValues: { marker: written.marker },
      });
      await this.pushWrite("gateway", kind, written);
      expect(written.accepted).toBe(true);
    }

    expected(actor: Actor, kind: Kind): string[] {
      const accepted = this.written.filter((w) => w.kind === kind && w.accepted);
      if (actor === "jane") return accepted.map((w) => w.marker).sort();
      if (actor !== "bob" && actor !== "carol") return [];
      const m = this.members[actor][kind];
      if (!m.right || !m.member) return [];
      // Their own writes the server refused stay on their replica while they can read the group.
      const ownRefused = this.written.filter((w) => w.kind === kind && w.author === actor && !w.accepted);
      return [
        ...accepted.filter((w) => !m.historyNone || (w.keyStep !== undefined ? w.keyStep >= m.joinedStep : w.step >= m.joinedStep)),
        ...ownRefused,
      ]
        .map((w) => w.marker)
        .sort();
    }

    async visible(actor: Actor, kind: Kind): Promise<string[]> {
      let db: MindooDB;
      try {
        db = await pull(this.t.tenants[actor], this.dbId(kind));
      } catch {
        // Refused by the server. A removed delegate never receives the rotation
        // that would hide the group's documents; MindooDB removes the replica
        // itself (dropReplicaIfAccessRevoked). What is left here is checked.
        db = await this.db(actor, kind).catch(() => null as never);
        if (!db) return [];
        await db.syncStoreChanges();
      }
      const markers: string[] = [];
      for (const id of await db.getAllDocumentIds()) {
        try {
          const marker = (await db.getDocument(id)).getData().marker;
          if (typeof marker === "string" && marker.startsWith("MKR-")) markers.push(marker);
        } catch {
          // not readable
        }
      }
      return markers.sort();
    }

    async check() {
      for (const actor of ["jane", "bob", "carol", "eve", "gateway"] as Actor[]) {
        for (const kind of ["mail", "calendar"] as Kind[]) {
          const label = `${this.name} step ${this.step}: ${actor} ${kind}`;
          // Removed delegates keep a refused replica; it must not show anything new or old.
          const seen = await this.visible(actor, kind);
          expect({ label, seen }).toEqual({ label, seen: this.expected(actor, kind) });
        }
      }
    }

    assertServerHasNoPlaintext(dir: string) {
      const files = fs.readdirSync(dir, { recursive: true }) as string[];
      for (const file of files) {
        const full = `${dir}/${file}`;
        if (!fs.statSync(full).isFile()) continue;
        expect({ file, plaintext: fs.readFileSync(full).includes("MKR-") }).toEqual({ file, plaintext: false });
      }
    }
  }

  test("read: the delegate reads Jane's and delivered documents, cannot write", () =>
    scenario("read", [
      async (w) => {
        await w.write("jane", "mail");
        await w.deliver("mail");
      },
      async (w) => w.grant("bob", "mail", "read"),
      async (w) => {
        await w.deliver("mail");
        await w.write("bob", "mail");
      },
    ]));

  test("history none: only what comes after joining, also for deliveries", () =>
    scenario("nohistory", [
      async (w) => {
        await w.write("jane", "mail");
        await w.deliver("mail");
      },
      async (w) => w.grant("bob", "mail", "read", "none"),
      async (w) => {
        await w.write("jane", "mail");
        await w.deliver("mail");
      },
    ]));

  test("edit, then back to read: writes are accepted only while editing", () =>
    scenario("edit", [
      async (w) => w.grant("bob", "mail", "edit"),
      async (w) => w.write("bob", "mail"),
      async (w) => w.setRight("bob", "mail", "read"),
      async (w) => w.write("bob", "mail"),
    ]));

  test("removal: everything disappears for the delegate, also deliveries to the old key", () =>
    scenario("remove", [
      async (w) => {
        await w.grant("bob", "mail", "read");
        await w.write("jane", "mail");
        await w.deliver("mail");
      },
      async (w) => {
        const old = { publicKey: w.keys.mail.publicKey, step: w.keys.mail.step };
        await w.revoke("bob", "mail");
        // A gateway that has not seen the new record yet.
        await w.deliver("mail", { staleKey: old });
        await w.deliver("mail");
        await w.write("jane", "mail");
      },
      async (w) => {
        // Bob's device tried to sync (check above) and removed its copy: no entries left at all.
        const bobDb = await w.db("bob", "mail");
        expect(await bobDb.getStore().getAllIds()).toEqual([]);
      },
    ]));

  test("removed and added again with the history: everything readable again", () =>
    scenario("readd", [
      async (w) => {
        await w.grant("bob", "mail", "read");
        await w.write("jane", "mail");
      },
      async (w) => {
        await w.revoke("bob", "mail");
        await w.write("jane", "mail");
        await w.deliver("mail");
      },
      async (w) => w.grant("bob", "mail", "read", "all"),
    ]));

  test("an offline write pushed after the right was taken away is refused", () =>
    scenario("offline", [
      async (w) => w.grant("bob", "mail", "edit"),
      async (w) => w.write("bob", "mail", { offline: true }),
      async (w) => {
        await w.revoke("bob", "mail");
        await w.goOnline();
      },
    ]));

  test("calendar only: the delegate sees requests and appointments, not the mailbox", () =>
    scenario("calendar", [
      async (w) => {
        await w.grant("carol", "calendar", "edit");
        await w.write("jane", "mail");
        await w.deliver("mail");
        await w.deliver("calendar");
      },
      async (w) => {
        await w.write("carol", "calendar");
        await expect(w.write("carol", "mail")).rejects.toThrow(/does not exist|not a member/);
      },
      async (w) => w.revoke("carol", "calendar"),
    ]));

  test("a device the delegate certified themselves gets the same rights, and loses them with the delegation", () =>
    scenario("certified", [
      async (w) => {
        await w.grant("bob", "mail", "edit");
        await w.write("jane", "mail");
        await w.deliver("mail");
      },
      async (w) => {
        const tablet = await w.t.certifiedDevice("bob");
        const dbId = w.dbId("mail");
        const db = await pull(tablet, dbId);
        const markers: string[] = [];
        for (const id of await db.getAllDocumentIds()) {
          const marker = (await db.getDocument(id)).getData().marker;
          if (typeof marker === "string") markers.push(marker);
        }
        expect(markers.sort()).toEqual(w.expected("bob", "mail"));
        // Writing from the tablet counts as Bob, who may edit.
        await db.createDocument({ groupKeyDocId: w.groups.mail.getId(), initialValues: { marker: w.marker("bob", "mail") + "-tablet" } });
        const pushed = await push(tablet, dbId);
        expect(pushed.rejectedEntries ?? []).toEqual([]);
        // Taken away: the tablet is refused and drops its copy as well.
        await w.revoke("bob", "mail");
        await pull(tablet, USER_DIRECTORY_DB_ID);
        await expect(pull(tablet, dbId)).rejects.toThrow(/denied|ACCESS_DENIED|deposit sealed documents only/i);
        expect(await (await openDb(tablet, dbId)).getStore().getAllIds()).toEqual([]);
        // Jane reads what the tablet wrote while it was allowed.
        w.written.push({ marker: (await findMarker(w, "-tablet"))!, author: "bob", kind: "mail", step: w.step, accepted: true });
      },
    ]));

  test("a withdrawn device certificate ends the device's access while the delegation stays", () =>
    scenario("certrevoked", [
      async (w) => {
        await w.grant("bob", "mail", "edit");
        await w.deliver("mail");
      },
      async (w) => {
        const tablet = await w.t.certifiedDevice("bob");
        const dbId = w.dbId("mail");
        await pull(tablet, dbId);
        expect((await (await openDb(tablet, dbId)).getStore().getAllIds()).length).toBeGreaterThan(0);
        // Bob withdraws the tablet's certificate; Bob himself keeps the delegation.
        const bob = w.t.tenants.bob as MindooTenant & { revokeOwnDeviceCertificate(fp: string): Promise<number> };
        const tabletKey = (await tablet.getCurrentUserId()).userSigningPublicKey;
        const fingerprint = await fingerprintPublicKeyPem(tabletKey, crypto.getSubtle());
        expect(await bob.revokeOwnDeviceCertificate(fingerprint)).toBe(1);
        await push(w.t.tenants.bob, USER_DIRECTORY_DB_ID);
        // The withdrawn device is no device of Bob's any more: the server does
        // not even let it sign in, for any database. (What it holds locally is
        // a lost device's problem: remote wipe, docs/accesscontrol.md §6.5.)
        await expect(pull(tablet, USER_DIRECTORY_DB_ID)).rejects.toThrow(/not yet in the tenant directory|denied|revoked/i);
        await expect(pull(tablet, dbId)).rejects.toThrow();
        // A job written on the tablet now is refused as well.
        const db = await openDb(tablet, dbId);
        await db.createDocument({ groupKeyDocId: w.groups.mail.getId(), initialValues: { marker: "MKR-certrevoked-late" } }).catch(() => undefined);
        await expect(push(tablet, dbId)).rejects.toThrow();
      },
    ]));

  async function findMarker(w: World, suffix: string): Promise<string | undefined> {
    const db = await pull(w.t.tenants.jane, w.dbId("mail"));
    for (const id of await db.getAllDocumentIds()) {
      const marker = (await db.getDocument(id)).getData().marker;
      if (typeof marker === "string" && marker.endsWith(suffix)) return marker;
    }
    return undefined;
  }

  test("two delegates, one removed: the other keeps reading", () =>
    scenario("two", [
      async (w) => {
        await w.grant("bob", "mail", "read");
        await w.grant("carol", "mail", "edit");
        await w.deliver("mail");
      },
      async (w) => {
        await w.revoke("bob", "mail");
        await w.deliver("mail");
        await w.write("carol", "mail");
      },
    ]));
});
