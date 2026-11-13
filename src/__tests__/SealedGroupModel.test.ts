/**
 * Model-based test of group documents: random sequences of membership changes
 * and writes, checked after every step against a small reference model.
 *
 * The model knows, per person, which key generations (epochs) they ever held
 * and from which epoch their honest client reads. The engine must agree twice:
 *  - cryptographically: a {@link KeyHoarder} of each person decrypts a message
 *    iff the model says they ever held the epoch it was written in;
 *  - honestly: each member's `getAllDocumentIds` lists exactly the messages from
 *    their first epoch on, and non-members see nothing.
 *
 * fast-check shrinks a failing sequence to the shortest one and prints the seed;
 * rerun it with `FC_SEED=<seed> FC_PATH=<path>`.
 */
import fc from "fast-check";

import { BaseMindooTenantFactory } from "../core/BaseMindooTenantFactory";
import { USER_DIRECTORY_DB_ID, type MindooDB, type MindooTenant } from "../core/types";
import { KeyHoarder } from "./_helpers/adversary";
import { addPerson, makeTenant, syncAll, type DeviceHandle, type MultiDeviceFixture } from "./_helpers/multiDevice";

type Command =
  | { kind: "write"; actor: number }
  | { kind: "add"; actor: number; target: number; history: "all" | "none" }
  | { kind: "remove"; actor: number; target: number }
  | { kind: "reveal"; actor: number; target: number };

const PEOPLE = 4; // index 0 owns the group and is never removed

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("write" as const), actor: fc.nat(PEOPLE - 1) }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("add" as const),
      actor: fc.nat(PEOPLE - 1),
      target: fc.integer({ min: 1, max: PEOPLE - 1 }),
      history: fc.constantFrom("all" as const, "none" as const),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("remove" as const),
      actor: fc.nat(PEOPLE - 1),
      target: fc.integer({ min: 1, max: PEOPLE - 1 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("reveal" as const),
      actor: fc.nat(PEOPLE - 1),
      target: fc.integer({ min: 1, max: PEOPLE - 1 }),
    }),
  },
);

interface PersonModel {
  member: boolean;
  /** First epoch the honest client holds (1 = whole history). */
  from: number;
  /** Every epoch this person ever held: what a hoarder can decrypt. */
  known: Set<number>;
}

describe("group documents: model-based membership and history", () => {
  jest.setTimeout(1200000);

  let fixture: MultiDeviceFixture;
  let people: DeviceHandle[];
  let hoardSessions: MindooTenant[];
  let run = 0;

  beforeAll(async () => {
    fixture = await makeTenant({ tenantId: "tenant-group-model" });
    people = [];
    for (const name of ["alice", "bob", "carol", "dave"]) {
      people.push(await addPerson(fixture, name, "laptop"));
    }
    await syncAll(fixture, "directory");
    for (const device of people) {
      await device.factory.ensureUserKeyPair!(device.user, device.password);
      device.tenant.noteUserDirectoryFetched!();
      await device.tenant.reconcileUserKeys!({ allowSelfCreate: true });
    }
    await syncAll(fixture, USER_DIRECTORY_DB_ID);
    // The attackers work in sessions of their own, so the honest views stay untouched.
    hoardSessions = [];
    for (const device of people) {
      const factory = new BaseMindooTenantFactory(device.storeFactory, fixture.crypto);
      const tenant = await factory.openTenant(
        fixture.tenantId,
        fixture.adminUser.userSigningKeyPair.publicKey,
        fixture.adminUser.userEncryptionKeyPair.publicKey,
        device.user,
        device.password,
        device.keyBag,
      );
      await tenant.openDB(USER_DIRECTORY_DB_ID);
      await tenant.reconcileUserKeys!();
      hoardSessions.push(tenant);
    }
  });

  it("random add / remove / reveal / write sequences match the model", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(commandArb, { minLength: 3, maxLength: 12 }), async (commands) => {
        const dbId = `group-model-${run++}`;
        const dbs: MindooDB[] = [];
        for (const device of people) dbs.push(await device.tenant.openDB(dbId));

        // Start: Alice and Bob are members, epoch 1.
        const group = await dbs[0].createDocument({ recipients: [people[1].username], initialValues: { n: 1 } });
        const groupId = group.getId();
        let epoch = 1;
        const model: PersonModel[] = people.map((_, index) => ({
          member: index <= 1,
          from: 1,
          known: new Set(index <= 1 ? [1] : []),
        }));
        const messages: Array<{ id: string; epoch: number }> = [];
        const hoarders = people.map((device, index) => new KeyHoarder(device, hoardSessions[index]));
        const full = (index: number) => model[index].member && model[index].from === 1;
        const allEpochs = () => Array.from({ length: epoch }, (_, i) => i + 1);

        const check = async (step: string) => {
          await syncAll(fixture, dbId);
          for (let index = 0; index < people.length; index++) {
            const label = `${step}: ${people[index].username}`;
            await (await hoardSessions[index].openDB(dbId)).syncStoreChanges();
            await hoarders[index].harvest(dbId, groupId);
            for (const message of messages) {
              const readable = (await hoarders[index].readableEntries(dbId, message.id)).every((e) => e.readable);
              expect({ label, message: message.epoch, readable }).toEqual({
                label,
                message: message.epoch,
                readable: model[index].known.has(message.epoch),
              });
            }
            await dbs[index].syncStoreChanges();
            const visible = new Set(await dbs[index].getAllDocumentIds());
            const expected = messages
              .filter((message) => model[index].member && message.epoch >= model[index].from)
              .map((message) => message.id)
              .sort();
            expect({ label, visible: messages.map((m) => m.id).filter((id) => visible.has(id)).sort() }).toEqual({
              label,
              visible: expected,
            });
            expect({ label, group: visible.has(groupId) }).toEqual({ label, group: model[index].member });
          }
        };

        await check("start");
        for (const [position, command] of commands.entries()) {
          const step = `#${position} ${JSON.stringify(command)}`;
          const actorDb = dbs[command.actor];
          await actorDb.syncStoreChanges();
          if (command.kind === "write") {
            const write = actorDb.createDocument({ groupKeyDocId: groupId, initialValues: { text: step } });
            if (!model[command.actor].member) {
              await expect(write).rejects.toThrow();
              continue;
            }
            messages.push({ id: (await write).getId(), epoch });
          } else {
            const target = people[command.target].username;
            const loadGroup = () => actorDb.getDocument(groupId);
            if (!model[command.actor].member) {
              await expect(loadGroup()).rejects.toThrow();
              continue;
            }
            const groupDoc = await loadGroup();
            if (!full(command.actor)) {
              // Whoever lacks the earlier history cannot re-seal for the others.
              const change =
                command.kind === "add"
                  ? actorDb.addRecipients!(groupDoc, [target], { history: command.history })
                  : command.kind === "remove"
                    ? actorDb.removeRecipients!(groupDoc, [target])
                    : actorDb.revealHistory!(groupDoc, [target]);
              if (command.kind === "add" && model[command.target].member) {
                // Adding someone who is a member already changes nothing (and may be a no-op re-seal).
                await change.catch(() => undefined);
              } else {
                await expect(change).rejects.toThrow(/whole history/);
              }
              continue;
            }
            const person = model[command.target];
            if (command.kind === "add") {
              await actorDb.addRecipients!(groupDoc, [target], { history: command.history });
              if (!person.member) {
                if (command.history === "none") {
                  epoch += 1;
                  for (const other of model) if (other.member) other.known.add(epoch);
                  person.member = true;
                  person.from = epoch;
                  person.known.add(epoch);
                } else {
                  person.member = true;
                  person.from = 1;
                  for (const e of allEpochs()) person.known.add(e);
                }
              }
            } else if (command.kind === "remove") {
              if (command.target === command.actor) continue; // nobody removes themselves here
              await actorDb.removeRecipients!(groupDoc, [target]);
              if (person.member) {
                person.member = false;
                epoch += 1;
                for (const other of model) if (other.member) other.known.add(epoch);
              }
            } else {
              await actorDb.revealHistory!(groupDoc, [target]);
              if (person.member && person.from > 1) {
                person.from = 1;
                for (const e of allEpochs()) person.known.add(e);
              }
            }
          }
          await check(step);
        }
      }),
      {
        numRuns: Number(process.env.FC_RUNS ?? 12),
        ...(process.env.FC_SEED ? { seed: Number(process.env.FC_SEED), path: process.env.FC_PATH } : {}),
      },
    );
  });
});
