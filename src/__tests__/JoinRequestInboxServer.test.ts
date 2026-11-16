/**
 * HTTP end-to-end for the invitation / join-request inbox (docs/invitations.md):
 *
 * admin creates a personal and an open invitation → pushes directory → a new
 * person's device reads the invitation, checks the key against the link and
 * posts a join request → the server stores a sealed `jr_` document → the admin
 * pulls the admin-only inbox with the admin key, the request matches its list
 * row → admit → the device finds its grant by discovery → the decided request
 * is purged on the server and on the admin device.
 */
import fs from "fs";
import { Server } from "http";

import { IsolatedInMemoryStoreFactory } from "./_helpers/multiDevice";
import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { NodeCryptoAdapter } from "../node/crypto/NodeCryptoAdapter";
import { MindooDBServer } from "../node/server/MindooDBServer";
import { decryptPrivateKey } from "../core/crypto/privateKeyEncryption";
import { USER_DIRECTORY_DB_ID, type MindooTenant, type PrivateUserId } from "../core/types";
import type { ServerConfig } from "../server/types";
import {
  admitJoinRequests,
  createInvitation,
  fetchInvitationForLink,
  invitationLinkFragment,
  listInvitations,
  listJoinRequests,
  submitJoinRequest,
  syncJoinRequestInbox,
  unlockInvitationAdmin,
  setJoinRequestStatus,
  endInvitation,
  fetchJoinRequestStatus,
  withdrawJoinRequest,
  fetchJoinRequestSummary,
  InvitationRequestError,
} from "../core/joinrequests/invitations";
import { parseInvitationLinkFragment } from "../core/joinrequests/crypto";
import { JOIN_REQUESTS_DB_ID } from "../core/joinrequests/types";

const PASSWORD = "inbox-pass";
const SYSTEM_ADMIN_PASSWORD = "sysadmin-pass";
const SERVER_PASSWORD = "server-inbox-pass";

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

async function pushDb(tenant: MindooTenant, baseUrl: string, dbId: string, auth?: { user: PrivateUserId; password: string }) {
  const local = await tenant.openDB(dbId, dbId === "directory" ? { adminOnlyDb: true } : undefined);
  const remote = await tenant.connectToServer(baseUrl, dbId);
  const result = await local.pushChangesTo(remote, auth ? { networkAuthOverride: auth } : undefined);
  expect(result.cancelled).toBe(false);
}

async function deviceSigningKey(cryptoAdapter: NodeCryptoAdapter, user: PrivateUserId, password: string): Promise<CryptoKey> {
  const pkcs8 = await decryptPrivateKey(cryptoAdapter, user.userSigningKeyPair.privateKey, password, "signing");
  return cryptoAdapter.getSubtle().importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
}

describe("join-request inbox over local HTTP server", () => {
  jest.setTimeout(300000);

  test("personal link: request, match, admit, discover, purge", async () => {
    const cryptoAdapter = new NodeCryptoAdapter();
    const dataDir = `/tmp/mindoodb-join-inbox-${Date.now()}`;
    fs.mkdirSync(dataDir, { recursive: true });

    const bootstrapFactory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), cryptoAdapter);
    const serverIdentity = await bootstrapFactory.createUserId("CN=join-inbox-server", SERVER_PASSWORD);
    fs.writeFileSync(`${dataDir}/server.identity.json`, JSON.stringify(serverIdentity, null, 2), "utf-8");
    fs.writeFileSync(`${dataDir}/trusted-servers.json`, "[]", "utf-8");
    const systemAdmin = await bootstrapFactory.createUserId("cn=sysadmin/o=join-inbox", SYSTEM_ADMIN_PASSWORD);
    const config: ServerConfig = {
      joinRequests: { maxRequestsPerIpPerHour: 6 },
      capabilities: {
        "ALL:/system/*": [
          { username: systemAdmin.username, publicsignkey: systemAdmin.userSigningKeyPair.publicKey as string },
        ],
      },
    };
    const server = new MindooDBServer(dataDir, SERVER_PASSWORD, undefined, config);
    const { httpServer, baseUrl } = await startServer(server);

    try {
      const tenantId = `inbox-${Date.now().toString(16)}`;
      const adminFactory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), cryptoAdapter);
      const adminUser = await adminFactory.createUserId(`cn=admin/o=${tenantId}`, PASSWORD);
      const founder = await adminFactory.createUserId(`cn=karsten/o=${tenantId}`, PASSWORD);
      await adminFactory.ensureUserKeyPair(founder, PASSWORD);
      const { tenant: adminTenant } = await adminFactory.createTenant({
        tenantId,
        adminUser,
        adminPassword: PASSWORD,
        appUser: founder,
        userPassword: PASSWORD,
      });
      adminTenant.noteUserDirectoryFetched!();
      await adminTenant.reconcileUserKeys!({ allowSelfCreate: true });
      await adminTenant.publishToServer(baseUrl, {
        systemAdminUser: systemAdmin,
        systemAdminPassword: SYSTEM_ADMIN_PASSWORD,
        adminUsername: adminUser.username,
      });
      const adminAuth = { user: adminUser, password: PASSWORD };

      const admin = await unlockInvitationAdmin(cryptoAdapter, adminUser, PASSWORD);
      const personal = await createInvitation(adminTenant, admin, {
        kind: "personal",
        serverUrl: baseUrl,
        label: "Kollegium",
        rows: [
          { firstName: "Jane", lastName: "Doe", username: `Jane Doe/${tenantId}`, email: "jane@example.com" },
          { firstName: "Max", lastName: "Muster", username: `Max Muster/${tenantId}` },
        ],
      });
      expect(personal.rows).toHaveLength(2);
      expect(personal.rows![0].username).toBe(`cn=Jane Doe/o=${tenantId}`);
      const open = await createInvitation(adminTenant, admin, { kind: "open", serverUrl: baseUrl, maxUses: 1 });
      await pushDb(adminTenant, baseUrl, "directory", adminAuth);
      await pushDb(adminTenant, baseUrl, USER_DIRECTORY_DB_ID);

      // The list is sealed: another identity cannot open it.
      const listedAsNobody = await listInvitations(adminTenant);
      expect(listedAsNobody.every((view) => view.rows === undefined)).toBe(true);

      const janeRow = personal.rows![0];
      const link = parseInvitationLinkFragment(
        `https://haven.example/welcome/join#${invitationLinkFragment(tenantId, personal, janeRow)}`,
      )!;
      expect(link.nonce).toBe(janeRow.nonce);
      // The tenant label rides in the fragment; the server's answer does not carry it.
      const labelled = parseInvitationLinkFragment(
        invitationLinkFragment(tenantId, personal, janeRow, { tenantLabel: "Schule am See" }),
      )!;
      expect(labelled.tenantLabel).toBe("Schule am See");
      expect(await fetchInvitationForLink(cryptoAdapter, labelled)).not.toHaveProperty("tenantLabel");

      // A server handing out another key is caught by the fingerprint.
      await expect(
        fetchInvitationForLink(cryptoAdapter, { ...link, keyFingerprint: "AAAAAAAAAAAAAAAAAAAAAA" }),
      ).rejects.toThrow(/does not match/);

      // Jane's device: keys created here, request posted to the inbox.
      const janeFactory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), cryptoAdapter);
      const jane = await janeFactory.createUserId(`cn=jane-device/o=${tenantId}`, PASSWORD);
      await janeFactory.ensureUserKeyPair(jane, PASSWORD);
      const janeRequestUri = janeFactory.createJoinRequest(jane, { format: "uri", label: "Jane Laptop" }) as string;
      const janeSigningKey = await deviceSigningKey(cryptoAdapter, jane, PASSWORD);
      const submitted = await submitJoinRequest(cryptoAdapter, {
        link,
        joinRequestUri: janeRequestUri,
        deviceSigningKey: janeSigningKey,
        message: "Hallo!",
      });
      expect(submitted.id).toMatch(/^jr_/);

      // Resubmitting from the same device replaces the old request.
      const resubmitted = await submitJoinRequest(cryptoAdapter, {
        link,
        joinRequestUri: janeRequestUri,
        deviceSigningKey: janeSigningKey,
        message: "Hallo nochmal!",
      });
      expect(resubmitted.id).not.toBe(submitted.id);
      expect((await fetchJoinRequestStatus(baseUrl, tenantId, submitted.id)).status).toBe("replaced");
      expect((await fetchJoinRequestStatus(baseUrl, tenantId, resubmitted.id)).status).toBe("pending");

      // Another device cannot reuse Jane's personal link.
      const thiefFactory = new BaseMindooTenantFactory(new IsolatedInMemoryStoreFactory(), cryptoAdapter);
      const thief = await thiefFactory.createUserId(`cn=thief/o=${tenantId}`, PASSWORD);
      await expect(
        submitJoinRequest(cryptoAdapter, {
          link,
          joinRequestUri: thiefFactory.createJoinRequest(thief, { format: "uri" }) as string,
          deviceSigningKey: await deviceSigningKey(cryptoAdapter, thief, PASSWORD),
        }),
      ).rejects.toMatchObject({ status: 409, code: "nonce_used" });

      // A member sees how many requests wait, a stranger does not.
      expect(
        await fetchJoinRequestSummary(cryptoAdapter, {
          serverUrl: baseUrl,
          tenantId,
          deviceSigningPublicKey: founder.userSigningKeyPair.publicKey,
          deviceSigningKey: await deviceSigningKey(cryptoAdapter, founder, PASSWORD),
        }),
      ).toEqual({ pending: 1 });
      await expect(
        fetchJoinRequestSummary(cryptoAdapter, {
          serverUrl: baseUrl,
          tenantId,
          deviceSigningPublicKey: thief.userSigningKeyPair.publicKey,
          deviceSigningKey: await deviceSigningKey(cryptoAdapter, thief, PASSWORD),
        }),
      ).rejects.toMatchObject({ status: 403 });

      // A non-admin cannot read the inbox.
      const founderDb = await adminTenant.openDB(JOIN_REQUESTS_DB_ID);
      const founderRemote = await adminTenant.connectToServer(baseUrl, JOIN_REQUESTS_DB_ID);
      await expect(founderDb.pullChangesFrom(founderRemote)).rejects.toThrow();

      // Admin pulls the inbox with the admin key and finds Jane matched to her row.
      await syncJoinRequestInbox(adminTenant, baseUrl, admin);
      const items = await listJoinRequests(adminTenant, admin);
      expect(items).toHaveLength(1);
      const item = items[0];
      expect(item.docId).toBe(resubmitted.id);
      expect(item.match).toBe("match");
      expect(item.problems).toEqual([]);
      expect(item.row?.rowId).toBe(janeRow.rowId);
      expect(item.username).toBe(`cn=Jane Doe/o=${tenantId}`);
      expect(item.message).toBe("Hallo nochmal!");
      expect(item.invitationLabel).toBe("Kollegium");

      const results = await admitJoinRequests(adminTenant, admin, items, { serverUrl: baseUrl });
      expect(results).toEqual([{ docId: item.docId, ok: true, username: `cn=Jane Doe/o=${tenantId}` }]);
      await pushDb(adminTenant, baseUrl, "directory", adminAuth);
      await pushDb(adminTenant, baseUrl, USER_DIRECTORY_DB_ID);
      await syncJoinRequestInbox(adminTenant, baseUrl, admin);

      const after = await listInvitations(adminTenant, admin);
      const janeAfter = after.find((view) => view.invitationId === personal.invitationId)!.rows!.find(
        (row) => row.rowId === janeRow.rowId,
      )!;
      expect(janeAfter.status).toBe("admitted");
      expect(janeAfter.joinRequestDocId).toBe(item.docId);

      // Jane's device finds the grant by discovery (unchanged return path).
      const deliveries = await janeFactory.discoverTenantsOnServer(baseUrl, { user: jane, password: PASSWORD });
      const delivery = deliveries.find((d) => d.tenantId === tenantId)!;
      expect(delivery).toBeTruthy();
      const joined = await janeFactory.bootstrapTenantFromDelivery(delivery, { user: jane, password: PASSWORD, serverUrl: baseUrl });
      expect(joined.user.username).toBe(`cn=Jane Doe/o=${tenantId}`);

      // The decided request is gone from the server (sweep after the status
      // push) and the next inbox sync forgets the local copy.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await syncJoinRequestInbox(adminTenant, baseUrl, admin);
      const inboxDb = await adminTenant.openDB(JOIN_REQUESTS_DB_ID);
      expect(await inboxDb.getAllDocumentIds()).toEqual([]);
      expect((await fetchJoinRequestStatus(baseUrl, tenantId, item.docId)).status).toBe("accepted");

      // Open link: no nonce, shows a verification code, capped by maxUses.
      const openLink = parseInvitationLinkFragment(invitationLinkFragment(tenantId, open))!;
      expect(openLink.nonce).toBeUndefined();
      const bob = await janeFactory.createUserId(`cn=bob/o=${tenantId}`, PASSWORD);
      const bobSubmitted = await submitJoinRequest(cryptoAdapter, {
        link: openLink,
        joinRequestUri: janeFactory.createJoinRequest(bob, { format: "uri" }) as string,
        deviceSigningKey: await deviceSigningKey(cryptoAdapter, bob, PASSWORD),
      });
      const eve = await janeFactory.createUserId(`cn=eve/o=${tenantId}`, PASSWORD);
      await expect(
        submitJoinRequest(cryptoAdapter, {
          link: openLink,
          joinRequestUri: janeFactory.createJoinRequest(eve, { format: "uri" }) as string,
          deviceSigningKey: await deviceSigningKey(cryptoAdapter, eve, PASSWORD),
        }),
      ).rejects.toBeInstanceOf(InvitationRequestError);
      await syncJoinRequestInbox(adminTenant, baseUrl, admin);
      const openItems = await listJoinRequests(adminTenant, admin);
      expect(openItems).toHaveLength(1);
      expect(openItems[0].match).toBe("unverified");
      expect(openItems[0].verificationCode).toBe(bobSubmitted.verificationCode);

      // Only Bob's device can take his request back.
      await expect(
        withdrawJoinRequest(cryptoAdapter, {
          serverUrl: baseUrl,
          tenantId,
          requestId: bobSubmitted.id,
          deviceSigningPublicKey: eve.userSigningKeyPair.publicKey,
          deviceSigningKey: await deviceSigningKey(cryptoAdapter, eve, PASSWORD),
        }),
      ).rejects.toMatchObject({ status: 403 });
      await withdrawJoinRequest(cryptoAdapter, {
        serverUrl: baseUrl,
        tenantId,
        requestId: bobSubmitted.id,
        deviceSigningPublicKey: bob.userSigningKeyPair.publicKey,
        deviceSigningKey: await deviceSigningKey(cryptoAdapter, bob, PASSWORD),
      });
      expect((await fetchJoinRequestStatus(baseUrl, tenantId, bobSubmitted.id)).status).toBe("withdrawn");
      await syncJoinRequestInbox(adminTenant, baseUrl, admin);
      expect(await listJoinRequests(adminTenant, admin)).toEqual([]);
      void setJoinRequestStatus;

      // An ended invitation takes no more requests.
      await endInvitation(adminTenant, admin, personal.invitationId);
      await pushDb(adminTenant, baseUrl, "directory", adminAuth);
      const maxRow = personal.rows![1];
      const max = await janeFactory.createUserId(`cn=max/o=${tenantId}`, PASSWORD);
      await expect(
        submitJoinRequest(cryptoAdapter, {
          link: parseInvitationLinkFragment(invitationLinkFragment(tenantId, personal, maxRow))!,
          joinRequestUri: janeFactory.createJoinRequest(max, { format: "uri" }) as string,
          deviceSigningKey: await deviceSigningKey(cryptoAdapter, max, PASSWORD),
        }),
      ).rejects.toMatchObject({ status: 410, code: "invitation_ended" });

      // That was request 6 from this IP; the 7th is refused before anything else.
      await expect(
        submitJoinRequest(cryptoAdapter, {
          link: parseInvitationLinkFragment(invitationLinkFragment(tenantId, personal, maxRow))!,
          joinRequestUri: janeFactory.createJoinRequest(max, { format: "uri" }) as string,
          deviceSigningKey: await deviceSigningKey(cryptoAdapter, max, PASSWORD),
        }),
      ).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
