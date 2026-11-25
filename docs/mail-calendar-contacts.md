# Mail, calendar and contacts

This document explains what MindooDB, Haven and Mindoo Mail do with a person's mail, appointments and contacts: what is possible, where the data lives, and how cryptography keeps every reader where they belong. It is written for people who decide about or operate a tenant, not only for developers. Technical details are in [userkeys.md](userkeys.md) (keys, groups, deposit keys) and [accesscontrol.md](accesscontrol.md) §6.10 and §6.11 (who may sync what).

## 1. What is possible

- **Mail between members** of a tenant, without a mail server. The sender's device delivers a copy into each recipient's mailbox.
- **Mail with the internet** through a mail gateway the tenant runs (an ordinary mail server in front, the gateway behind it). Incoming mail is delivered into the mailbox; outgoing mail is picked up from the person's outbox and sent.
- **Appointments and invitations**: a calendar of one's own, invitations to colleagues and to people outside, answers, updates, cancellations, recurring meetings.
- **Free/busy and calendar sharing**: colleagues see when someone is busy, and, if the person allows it, the titles and places of business appointments or of all appointments.
- **Contacts**: an address book per account, contact groups, and the people of the tenant directory.
- **Accounts of other providers** (Microsoft 365, Domino, IMAP servers such as GMX): Mindoo Mail mirrors their mail, calendars and contacts into the same storage, so everything is in one place and readable offline.
- **Delegation**: a person can let a colleague read or edit their mailbox, calendar or contacts, per account, and let them send on their behalf. They can also give access to a service they run themselves, for example an IMAP service so that the mail shows in the mail app of a phone.

What does not exist on purpose:

- **"Send as"** without showing who really wrote: a colleague always sends *on behalf of* the owner, and recipients see both names.
- **Editing mirrored accounts by delegates**: an account mirrored from Microsoft 365 or Domino can only be delegated for reading. Changes would have to go back to that provider, and only the owner's own devices can reach it.

## 2. Where the data lives

Each person has a few databases of their own, named after their entry in the tenant directory:

| Database | Holds | Who may sync it |
|---|---|---|
| Mailbox | messages, folders, drafts, account settings | the owner, delegates for mail, the tenant administrator (encrypted only) |
| Calendar | appointments, meetings, invitation requests | the owner, delegates for the calendar, the administrator (encrypted only) |
| Contacts | contacts and contact groups | the owner, delegates for contacts, the administrator (encrypted only) |
| Outbox | outgoing mail and its delivery status | the owner, the mail gateway, delegates who may send (only new outgoing mail) |
| Free/busy | busy times per week, shared calendar weeks | the owner writes; colleagues read |

The sync server enforces who may sync each of these databases. Everybody else is refused, even though they are members of the same tenant. Others may only *deliver* into some of them (see §3.3).

What the server, the gateway and the administrator can see:

- **The sync server** stores everything, but encrypted. It sees which databases exist, how many documents they hold, their sizes and times, who delegated to whom (by directory entry, not by name), and the public halves of keys. It never sees content.
- **The mail gateway** sees mail on the short way from the internet to the tenant and back, as every mail server does. Once a message is delivered, the gateway can no longer read it, nor anything else in the mailbox.
- **The tenant administrator** can back up and purge the databases, but they hold no key to read them.

## 3. How cryptography keeps the rights

### 3.1 Two locks that work together

Every access is protected twice:

1. **Who may sync.** The sync server only hands out and accepts a database to people the rules allow: the owner, and the delegates the owner listed in a small published record. This lock decides what reaches a device at all.
2. **Who can decrypt.** The content is encrypted with keys that only the owner and the delegates hold. This lock decides what a device can read, even if it holds the data.

Either lock alone would be weaker. Without the first, every member would sync everyone's encrypted mail and could at least count it. Without the second, the server, the administrator or anyone who copied the server's disk could read everything. Together, a mistake in one of them does not expose content.

### 3.2 One key per account, shared by its readers

Every account of a person has a **group** in each database: one for its mail, one for its appointments, one for its contacts. A group is a small document that holds a series of keys, sealed for each of its members with that member's personal key. Everything the account stores in that database is encrypted with the group's newest key.

- **Delegating** means adding a person to the group. With the history, they get all earlier keys and read everything that is there. Without the history, the group first moves to a fresh key and the new reader gets only that one: what was written before stays unreadable for them, not merely hidden.
- **Taking delegation away** means removing the person from the group. The group moves to a fresh key that the removed person does not get, so they cannot read anything written afterwards. What they had already synced, they keep: no system can take back what has already been shown to someone.
- **Rights** (read or edit) are recorded on the group and in the published record. The server accepts changes only from people who may edit at the moment the change arrives.

### 3.3 Delivering without reading

Mail from the internet and from colleagues has to get *into* a mailbox without the sender being able to read that mailbox. A group key cannot do this: whoever can encrypt with it can also decrypt. So each receiving group also has a **deposit key**, a key pair of the kind used for sending encrypted mail:

- The **public half** is published. The gateway and the devices of colleagues seal each delivery with it.
- The **private half** is stored inside the mailbox, encrypted with the group's key. Only members of the group can open it, and with it the deliveries.

The sender can encrypt but never decrypt, not even the message it just delivered once it has forgotten it. The owner's delegates read new mail at once, even while all of the owner's devices are switched off. When a delegate is removed, a new deposit key is created; a gateway that still uses the old one for a little while does no harm, because the remaining members can still open it and the removed person can no longer sync the mailbox.

Deliveries are also limited by the server: into a mailbox only messages, into a calendar only invitation requests, never appointments, folders or settings. Each delivery may be sealed for exactly one key.

### 3.4 Invitations

The gateway and colleagues never write appointments into someone's calendar. An invitation arrives twice: as a message in the mailbox, and as an **invitation request** in the calendar. A member of the calendar who may edit it (the owner, or a delegate, for example an assistant) checks who sent it and only then creates or updates the appointment. People to whom only the calendar is delegated thus see and answer invitations without seeing the mailbox.

### 3.5 Who wrote what

Every change is signed by the device that made it, and devices belong to people through the tenant directory. Readers use this:

- A document that was *delivered* counts only as a delivery, whatever it claims to be: a message, or an invitation request.
- Appointments, folders and settings count only if the owner or a delegate who may edit wrote them.
- Mail from a colleague must name that colleague as sender. Otherwise it goes to a separate folder instead of the inbox, and an invitation in it is not applied.
- When a delegate sends on the owner's behalf, the gateway checks at sending time that the owner still allows it; the message goes out with the owner as author and the delegate as sender.

## 4. Typical flows

**A message from the internet.** The mail server hands it to the gateway. The gateway looks up the recipient, seals the message with the deposit key of the recipient's mailbox, and delivers it. If the message contains an invitation, it also delivers an invitation request into the calendar. Only then does it confirm the message to the sending server.

**A message between colleagues.** The sender's Haven writes the message into the sender's outbox and, as soon as it can reach the server, delivers a sealed copy into each recipient's mailbox (and an invitation request into the calendar), and files the sent copy in the sender's mailbox.

**Delegating a mailbox.** The owner picks a colleague and the right in the account settings. Haven adds the colleague to the account's groups, records the right in the published record, and, without history, creates a new deposit key. On the colleague's next sync the mailbox appears under "shared with me".

**Taking it away.** Haven removes the colleague from the groups (new keys), creates new deposit keys and updates the record. From then on the server refuses the colleague's sync. Because the colleague's device can no longer receive the key change, MindooDB on that device deletes its copy of that mailbox by itself at the next sync attempt, as soon as the server refuses and its own copy of the directory shows that the delegation has ended. A device that stays offline keeps showing the old copy until then.

**Sending on someone's behalf.** The delegate writes the outgoing message into the owner's outbox, sealed for the owner, the delegate and the gateway. The server accepts only new outgoing messages from them there. The gateway checks the right at sending time and sends the message with both names.

**A phone mail app through a service of one's own.** The person runs a small IMAP service as a member of the tenant and delegates the mailbox to it, usually with the whole history. The service decrypts the mail for the phone. This is a deliberate decision: that service can read all of the person's mail. The tenant administrator can forbid delegation altogether.

## 5. Limits, honestly

- **What someone has seen, they can keep.** Taking delegation away protects everything written afterwards; earlier content that a delegate already synced stays on their devices until they remove it. The same is true for every system that lets people read.
- **Metadata is visible to the server**: which databases exist, their sizes and timing, who delegated to whom, and public keys.
- **Directory entries are identified by hashes** in some places. A server that guesses a name can check whether the guess is right for older hashes. This was already the case before delegation existed.
- **Mail from outside is readable in transit** on the mail server and the gateway, as with any mail server.
- **Free/busy** is published by the owner's devices only. Changes a delegate makes show in free/busy after the owner's next sync (or the background refresh on phones).

## 6. For administrators

- **Delegation** can be allowed for everyone (default), restricted to members matched by rules, or switched off for the tenant (policy setting `mailDelegation`).
- **Internal mail** and **free/busy** have their own settings (who may deliver to whom, who may read busy times).
- **The mail gateway** needs the right to deliver into mailboxes and calendars, and to read outboxes. Haven sets these when the gateway joins.
- Everything described here is part of the open core: it works the same on every server, with or without an enterprise license.
