// CRM slice 6 against a REAL Postgres: the People command center.
// OPT-IN AND LOCAL ONLY: LOOP_TEST_POSTGRES_URL. Synthetic data only (example.test addresses).
//
// Proves:
//   - human interpretation: state and next action set through the governed act, attributed, audited
//     and outboxed with NO typed text; refused for READ_ONLY, AI_EMPLOYEE and CREATOR; another
//     tenant's Party is NOT_FOUND and leaves no audit row;
//   - notes: recorded with provenance; a note or next action carrying a contact value is refused;
//   - exact Gmail association: the viewer's own correspondent links to the Person whose INDIVIDUAL
//     Contact Point holds the exact address; a near-miss address links to nothing (no fuzzy matching);
//     a ROLE_INBOX address links to the Company, never a Person; another organization's Contact
//     Point never links;
//   - the cadence over real rows: anchored on the actual send; a genuine reply stops it, an
//     out-of-office does not;
//   - calendar: a meeting with the Person's exact address is MEETING_SCHEDULED; it creates nothing;
//   - privacy: one viewer's mail never shapes another viewer's rows (§20.1); a viewer without
//     employeeIntelligence sees UNKNOWN, not NO_OUTREACH;
//   - stale Gmail: still "no reply observed" through the last read, flagged stale by the surface;
//   - Possible New People: surfaces a two-way contact, excludes the CRM's and internal addresses;
//     ADD TO PEOPLE creates and establishes one PERSON with one EMAIL Contact Point and an ORIGIN fact,
//     and NO Opportunity, Relationship, Participant or IdentityEvidence; a second add is ALREADY_EXISTS;
//     an address on a Company's role inbox is REATTRIBUTION_REQUIRED; EMPLOYEE cannot establish;
//     dismiss and restore are private and reversible;
//   - nothing typed or mail-derived reaches audit metadata or outbox payloads;
//   - offboarding erases the person's dismissals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { pageCrmPeople, EMPTY_CRM_PEOPLE_FILTERS } from '@emgloop/shared';

import { CrmOutreachService } from '../src/crm-outreach/crm-outreach.service';
import { CrmPeopleCommandService, type CrmViewerSources } from '../src/crm-outreach/crm-people-command.service';
import { CrmPeopleDiscoveryService } from '../src/crm-outreach/crm-people-discovery.service';
import { CrmContactPointService } from '../src/services/crm-contact-point.service';
import { WorkErasureRepository } from '../src/repositories/work-state/work-erasure.repository';

const LOCAL = (url: string) => /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL(URL) ? 'refusing a non-local database' : false;

const ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY', 'AI_EMPLOYEE', 'CREATOR'] as const;
type Role = (typeof ROLES)[number];
const NOW = new Date('2026-10-08T15:00:00Z');
const OPTS = { now: NOW, timeZone: 'UTC' };
const FRESH: CrmViewerSources = { gmail: { freshness: 'CURRENT', lastReadAt: new Date('2026-10-08T14:50:00Z') }, calendar: { freshness: 'CURRENT', lastReadAt: new Date('2026-10-08T14:50:00Z') } };
const sha = (address: string) => createHash('sha256').update(address.trim().toLowerCase(), 'utf8').digest('hex');

async function tenant(prisma: PrismaClient, label: string) {
  const organizationId = `0ppl_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `PPL ${label}`, slug: organizationId } });
  const users = {} as Record<Role, string>;
  for (const role of ROLES) {
    const id = `user_ppl_${role.toLowerCase()}_${randomUUID()}`;
    await prisma.user.create({ data: { id, organizationId, email: `${role.toLowerCase()}.${id.slice(-6)}@emg.example.test`, name: `${role} person`, status: 'ACTIVE', metadata: { systemRole: role } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId: id, systemRole: role, status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    users[role] = id;
  }
  const actor = (role: Role) => ({ organizationId, userId: users[role] });
  const party = async (type: 'PERSON' | 'COMPANY', displayName: string) =>
    (
      await prisma.cognitiveIdentity.create({
        data: { organizationId, entityType: type, canonicalKey: `party:${randomUUID()}`, displayName, status: 'KNOWN', establishedAt: new Date('2026-09-01T00:00:00Z'), establishmentBasis: 'MANUAL', establishedByUserId: users.OWNER },
      })
    ).id;
  const email = async (partyId: string, value: string, classification: 'INDIVIDUAL' | 'ROLE_INBOX' = 'INDIVIDUAL') => {
    const r = await new CrmContactPointService(prisma).add(actor('ADMIN'), { partyId, kind: 'EMAIL', classification, value, basis: 'OPERATOR_RECORDED' });
    assert.equal(r.outcome, 'RECORDED');
  };
  /** A correspondent and messages in ONE viewer's own mail. */
  const mail = async (role: Role, address: string, displayName: string | null, messages: { at: string; dir: 'INBOUND' | 'OUTBOUND'; subject?: string; labels?: string[]; cc?: boolean }[]) => {
    const userId = users[role];
    const h = sha(address);
    await prisma.workCorrespondent.upsert({
      where: { organizationId_userId_addressHash: { organizationId, userId, addressHash: h } },
      create: { organizationId, userId, addressHash: h, displayAddress: address.toLowerCase(), displayName, domain: address.split('@')[1]!.toLowerCase(), firstSeenAt: new Date(messages[0]!.at), lastSeenAt: new Date(messages[messages.length - 1]!.at), outboundCount: messages.filter((m) => m.dir === 'OUTBOUND').length, inboundCount: messages.filter((m) => m.dir === 'INBOUND').length },
      update: {},
    });
    const thread = `t_${randomUUID()}`;
    const own = sha(`${role.toLowerCase()}@emg.example.test`);
    for (const m of messages) {
      await prisma.workMessage.create({
        data: {
          organizationId, userId, provider: 'GOOGLE', messageId: `m_${randomUUID()}`, threadId: thread, internalDate: new Date(m.at), direction: m.dir,
          fromHash: m.dir === 'INBOUND' ? h : own, toHashes: m.dir === 'OUTBOUND' && !m.cc ? [h] : [own], ccHashes: m.dir === 'OUTBOUND' && m.cc ? [h] : [],
          subject: m.subject ?? 'Partnership', labels: m.labels ?? (m.dir === 'OUTBOUND' ? ['SENT'] : ['INBOX']),
        },
      });
    }
    return thread;
  };
  return { organizationId, users, actor, party, email, mail };
}

async function textLeaks(prisma: PrismaClient, organizationId: string, secrets: readonly string[]): Promise<string[]> {
  const [audits, outbox] = await Promise.all([
    prisma.auditLog.findMany({ where: { organizationId }, select: { metadata: true, before: true, after: true } }),
    prisma.stateChangeOutbox.findMany({ where: { organizationId }, select: { payload: true } }),
  ]);
  const blob = JSON.stringify([audits, outbox]).toLowerCase();
  return secrets.filter((s) => blob.includes(s.toLowerCase()));
}

test('human interpretation: governed, attributed, audited without text; refused for READ_ONLY, AI_EMPLOYEE, CREATOR; cross-tenant is NOT_FOUND', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'acts');
    const other = await tenant(prisma, 'acts_other');
    const jane = await t.party('PERSON', 'Jane Rivera');
    const foreign = await other.party('PERSON', 'Foreign Person');
    const svc = new CrmOutreachService(prisma);

    const set = await svc.setState(t.actor('EMPLOYEE'), jane, 'INTERESTED');
    assert.equal(set.outcome, 'RECORDED');
    assert.equal(set.outcome === 'RECORDED' && set.value.stateSetByUserId, t.users.EMPLOYEE);
    assert.equal((await svc.setState(t.actor('EMPLOYEE'), jane, 'INTERESTED')).outcome, 'UNCHANGED');
    const next = await svc.setNextAction(t.actor('MANAGER'), jane, { text: 'Send the rate card', dueAt: new Date('2026-10-10T00:00:00Z') });
    assert.equal(next.outcome, 'RECORDED');
    assert.equal((await svc.recordNote(t.actor('EMPLOYEE'), jane, 'Prefers a call before the shoot')).outcome, 'RECORDED');
    assert.equal((await svc.recordTitle(t.actor('EMPLOYEE'), jane, 'Head of Partnerships')).outcome, 'RECORDED');

    for (const role of ['READ_ONLY', 'AI_EMPLOYEE', 'CREATOR'] as const) {
      assert.equal((await svc.setState(t.actor(role), jane, 'PASSED')).outcome, 'NOT_AUTHORIZED', role);
      assert.equal((await svc.recordNote(t.actor(role), jane, 'x note')).outcome, 'NOT_AUTHORIZED', role);
    }
    assert.equal((await svc.setState(t.actor('EMPLOYEE'), jane, 'AWAITING_REPLY' as never)).outcome, 'INVALID', 'a fact-derived state is not settable');
    assert.deepEqual(await svc.recordNote(t.actor('EMPLOYEE'), jane, 'Write to jane@brand.example.test'), { outcome: 'INVALID', violation: 'CARRIES_CONTACT_VALUE' });
    assert.deepEqual(await svc.setNextAction(t.actor('EMPLOYEE'), jane, { text: 'Call 415 555 0100', dueAt: null }), { outcome: 'INVALID', violation: 'CARRIES_CONTACT_VALUE' });

    const auditsBefore = await prisma.auditLog.count({ where: { organizationId: t.organizationId } });
    assert.equal((await svc.setState(t.actor('OWNER'), foreign, 'PASSED')).outcome, 'NOT_FOUND', "another tenant's Party is indistinguishable from none");
    assert.equal((await svc.recordNote(t.actor('OWNER'), foreign, 'note')).outcome, 'NOT_FOUND');
    assert.equal(await prisma.auditLog.count({ where: { organizationId: t.organizationId } }), auditsBefore, 'no audit row for a write that did not happen');
    assert.equal(await prisma.crmOutreachState.count({ where: { partyId: foreign } }), 0);

    const events = await prisma.crmOutreachEvent.findMany({ where: { organizationId: t.organizationId, partyId: jane }, orderBy: { sequence: 'asc' } });
    assert.deepEqual(events.map((e) => [e.sequence, e.type]), [[1, 'STATE_SET'], [2, 'NEXT_ACTION_SET']]);
    assert.deepEqual(await textLeaks(prisma, t.organizationId, ['Send the rate card', 'Prefers a call', 'Head of Partnerships']), [], 'no typed text in audit or outbox');
    const outbox = await prisma.stateChangeOutbox.findMany({ where: { organizationId: t.organizationId, subjectType: 'CRM_OUTREACH' } });
    assert.equal(outbox.length, 4);

    // Retract: OWNER/ADMIN only; the fact stays in history, marked.
    const note = await prisma.crmSubjectContextFact.findFirstOrThrow({ where: { organizationId: t.organizationId, partyId: jane, kind: 'NOTE' } });
    assert.equal((await svc.retractFact(t.actor('EMPLOYEE'), note.id)).outcome, 'NOT_AUTHORIZED');
    assert.equal((await svc.retractFact(other.actor('OWNER'), note.id)).outcome, 'NOT_FOUND');
    assert.equal((await svc.retractFact(t.actor('ADMIN'), note.id)).outcome, 'RECORDED');
    assert.ok((await prisma.crmSubjectContextFact.findUniqueOrThrow({ where: { id: note.id } })).retractedAt);
  } finally {
    await prisma.$disconnect();
  }
});

test('exact Gmail association, cadence, calendar, privacy between viewers, and honest freshness', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'link');
    const other = await tenant(prisma, 'link_other');
    const jane = await t.party('PERSON', 'Jane Rivera');
    const sam = await t.party('PERSON', 'Sam Lee');
    const brand = await t.party('COMPANY', 'Lund Boats');
    const near = await t.party('PERSON', 'Near Miss');
    await t.email(jane, 'jane@lund.example.test');
    await t.email(sam, 'sam@brother.example.test');
    await t.email(brand, 'team@lund.example.test', 'ROLE_INBOX');
    await t.email(near, 'jane.r@lund.example.test');
    // The same address in ANOTHER organization's CRM never links here.
    const foreign = await other.party('PERSON', 'Foreign Sam');
    await other.email(foreign, 'pat@else.example.test');

    // OWNER's own mail: Jane got two sends (the second late) and no reply; Sam replied after an OOO.
    await t.mail('OWNER', 'Jane@Lund.example.test', 'Jane Rivera', [
      { at: '2026-09-20T10:00:00Z', dir: 'OUTBOUND' },
      { at: '2026-09-27T16:00:00Z', dir: 'OUTBOUND' },
    ]);
    await t.mail('OWNER', 'sam@brother.example.test', 'Sam Lee', [
      { at: '2026-10-01T10:00:00Z', dir: 'OUTBOUND' },
      { at: '2026-10-01T10:05:00Z', dir: 'INBOUND', subject: 'Automatic reply: Partnership' },
      { at: '2026-10-07T09:00:00Z', dir: 'INBOUND', subject: 'Re: Partnership' },
    ]);
    await t.mail('OWNER', 'team@lund.example.test', null, [{ at: '2026-10-02T10:00:00Z', dir: 'OUTBOUND' }]);
    await t.mail('OWNER', 'pat@else.example.test', 'Pat', [{ at: '2026-10-02T10:00:00Z', dir: 'OUTBOUND' }]);
    // A meeting with Sam on the OWNER's calendar.
    await prisma.workEvent.create({ data: { organizationId: t.organizationId, userId: t.users.OWNER, provider: 'GOOGLE', eventId: `e_${randomUUID()}`, startsAt: new Date('2026-10-10T16:00:00Z'), status: 'CONFIRMED', summary: 'Intro call', attendanceKnown: true, attendeeHashes: [sha('sam@brother.example.test')] } });

    const svc = new CrmPeopleCommandService(prisma);
    const owner = await svc.directory(t.actor('OWNER'), FRESH, OPTS);
    assert.equal(owner.outcome, 'OK');
    if (owner.outcome !== 'OK') return;
    const byId = new Map(owner.rows.map((r) => [r.partyId, r]));
    const j = byId.get(jane)!.outreach;
    assert.equal(j.state, 'AWAITING_REPLY');
    assert.equal(j.cadence.sends, 2);
    assert.equal(j.nextAction.label, 'Follow up: 3-day #2');
    assert.equal(j.nextAction.dueAt!.toISOString(), '2026-09-30T16:00:00.000Z', 'anchored on the ACTUAL late send');
    assert.equal(j.nextAction.bucket, 'OVERDUE');
    const s = byId.get(sam)!.outreach;
    assert.equal(s.state, 'REVIEW_REQUIRED', 'a genuine reply after an out-of-office is real, but metadata alone cannot say an answer is owed');
    assert.equal(s.reviewReason, 'REPLY_CONTENT_UNKNOWN');
    assert.equal(s.cadence.status, 'STOPPED');
    assert.equal(byId.get(sam)!.nextMeetingAt?.toISOString(), '2026-10-10T16:00:00.000Z');
    assert.equal(byId.get(near)!.outreach.state, 'NO_OUTREACH', 'a near-miss address links to nothing');
    assert.ok(!byId.has(brand), 'a Company is not a Person row');
    assert.equal(owner.rows.length, 3);
    assert.equal(owner.mail.linkedPeople, 2);
    assert.equal(await prisma.crmRelationship.count({ where: { organizationId: t.organizationId } }), 0, 'a meeting creates no Relationship');
    assert.equal(await prisma.crmOpportunity.count({ where: { organizationId: t.organizationId } }), 0, 'mail creates no Opportunity');

    // The same rows, for a different viewer with no mail of their own: none of OWNER's facts.
    const admin = await svc.directory(t.actor('ADMIN'), FRESH, OPTS);
    assert.equal(admin.outcome, 'OK');
    if (admin.outcome !== 'OK') return;
    const adminJane = admin.rows.find((r) => r.partyId === jane)!.outreach;
    assert.equal(adminJane.state, 'NO_OUTREACH', "OWNER's mail never shapes ADMIN's view");
    assert.equal(adminJane.cadence.sends, 0);

    // A human state set by anyone is shared: ADMIN sees OWNER's interpretation.
    await new CrmOutreachService(prisma).setState(t.actor('OWNER'), jane, 'ON_HOLD');
    const again = await svc.directory(t.actor('ADMIN'), FRESH, OPTS);
    assert.equal(again.outcome === 'OK' && again.rows.find((r) => r.partyId === jane)!.outreach.state, 'ON_HOLD');

    // No mail permission (AI_EMPLOYEE is refused outright; CREATOR too).
    assert.equal((await svc.directory(t.actor('AI_EMPLOYEE'), FRESH, OPTS)).outcome, 'NOT_AUTHORIZED');
    assert.equal((await svc.directory(t.actor('CREATOR'), FRESH, OPTS)).outcome, 'NOT_AUTHORIZED');

    // Gmail unavailable: UNKNOWN, never NO_OUTREACH.
    const none = await svc.directory(t.actor('OWNER'), { gmail: null, calendar: null }, OPTS);
    assert.equal(none.outcome === 'OK' && none.rows.find((r) => r.partyId === near)!.outreach.state, 'UNKNOWN');
    const stale = await svc.directory(t.actor('OWNER'), { gmail: { freshness: 'STALE', lastReadAt: new Date('2026-10-05T00:00:00Z') }, calendar: null }, OPTS);
    assert.equal(stale.outcome === 'OK' && stale.mail.gmail.state, 'STALE');
    // Stale: what was read still stands, and the status says the mail is stale (the surface adds the read time).
    assert.equal(stale.outcome === 'OK' && stale.rows.find((r) => r.partyId === jane)!.outreach.replyStatus, 'NO_REPLY_OBSERVED');

    // The page's summary and paging run over these rows.
    assert.equal(pageCrmPeople(owner.rows, EMPTY_CRM_PEOPLE_FILTERS, 1, NOW).totalCount, 3);

    // Person detail: a chronological timeline from the viewer's mail, with sources; meeting included.
    const detail = await svc.person(t.actor('OWNER'), sam, FRESH, OPTS);
    assert.equal(detail.outcome, 'OK');
    if (detail.outcome !== 'OK') return;
    assert.deepEqual(detail.timeline.map((e) => e.kind), ['MEETING', 'HUMAN_REPLY', 'AUTOMATED', 'QUALIFYING_SEND']);
    assert.ok(detail.timeline.every((e) => e.private && e.source !== 'IMPORT'));
    assert.equal(detail.nextMeeting?.title, 'Intro call');
    assert.equal((await svc.person(other.actor('OWNER'), sam, FRESH, OPTS)).outcome, 'NOT_FOUND', 'cross-tenant');

    assert.deepEqual(await textLeaks(prisma, t.organizationId, ['jane@lund', 'sam@brother', 'Intro call', 'Re: Partnership']), []);
  } finally {
    await prisma.$disconnect();
  }
});

test('Possible New People: surfaced from the viewer’s own mail; ADD TO PEOPLE is governed and creates nothing else; dismiss is private and reversible', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'disc');
    const brand = await t.party('COMPANY', 'Lund Boats');
    const known = await t.party('PERSON', 'Known Person');
    await t.email(known, 'known@lund.example.test');
    await t.email(brand, 'press@lund.example.test', 'ROLE_INBOX');

    await t.mail('OWNER', 'riley@newbrand.example.test', '"Riley Chen"', [
      { at: '2026-10-01T10:00:00Z', dir: 'OUTBOUND' },
      { at: '2026-10-02T10:00:00Z', dir: 'INBOUND', subject: 'Re: Hello' },
    ]);
    await t.mail('OWNER', 'known@lund.example.test', 'Known', [{ at: '2026-10-01T10:00:00Z', dir: 'OUTBOUND' }]);
    await t.mail('OWNER', 'pitch@cold.example.test', 'Cold Pitch', [{ at: '2026-10-01T10:00:00Z', dir: 'INBOUND' }]);
    await t.mail('OWNER', 'no-reply@service.example.test', null, [{ at: '2026-10-01T10:00:00Z', dir: 'OUTBOUND' }]);
    await t.mail('OWNER', `admin.${t.users.ADMIN.slice(-6)}@emg.example.test`, 'Colleague', [{ at: '2026-10-01T10:00:00Z', dir: 'OUTBOUND' }]);
    await t.mail('OWNER', 'cc.only@else.example.test', 'Copied', [{ at: '2026-10-01T10:00:00Z', dir: 'OUTBOUND', cc: true }]);
    // A role-inbox address that the CRM holds on a Company: in the CRM already, not a candidate.
    await t.mail('OWNER', 'press@lund.example.test', 'Press', [{ at: '2026-10-01T10:00:00Z', dir: 'OUTBOUND' }]);

    const read = new CrmPeopleCommandService(prisma);
    const q = await read.discovery(t.actor('OWNER'), FRESH, { now: NOW });
    assert.equal(q.outcome, 'OK');
    if (q.outcome !== 'OK') return;
    assert.deepEqual(q.candidates.map((c) => c.address), ['riley@newbrand.example.test']);
    const riley = q.candidates[0]!;
    assert.deepEqual(riley.reasons, ['YOU_EMAILED_THEM', 'THEY_REPLIED']);
    assert.equal(riley.proposedName, 'Riley Chen');
    assert.equal(riley.recentThread?.subject, 'Re: Hello');
    // Another viewer's queue holds none of it.
    const adminQ = await read.discovery(t.actor('ADMIN'), FRESH, { now: NOW });
    assert.equal(adminQ.outcome === 'OK' && adminQ.candidates.length, 0);

    const before = { opp: await prisma.crmOpportunity.count({ where: { organizationId: t.organizationId } }), rel: await prisma.crmRelationship.count({ where: { organizationId: t.organizationId } }), part: await prisma.crmParticipant.count({ where: { organizationId: t.organizationId } }), ev: await prisma.identityEvidence.count({ where: { organizationId: t.organizationId } }) };
    const disc = new CrmPeopleDiscoveryService(prisma);
    // EMPLOYEE may not establish a Person: refused, and nothing is left behind.
    const parties0 = await prisma.cognitiveIdentity.count({ where: { organizationId: t.organizationId } });
    await t.mail('EMPLOYEE', 'riley@newbrand.example.test', 'Riley Chen', [{ at: '2026-10-01T10:00:00Z', dir: 'OUTBOUND' }]);
    assert.equal((await disc.add(t.actor('EMPLOYEE'), riley.correspondentHash, 'Riley Chen')).outcome, 'NOT_AUTHORIZED');
    assert.equal(await prisma.cognitiveIdentity.count({ where: { organizationId: t.organizationId } }), parties0, 'the rolled-back create left no Party');
    assert.equal((await disc.add(t.actor('OWNER'), riley.correspondentHash, ' ')).outcome, 'NAME_REQUIRED');
    assert.equal((await disc.add(t.actor('OWNER'), 'f'.repeat(64), 'Nobody')).outcome, 'NOT_FOUND', 'only the viewer’s own correspondents');

    const added = await disc.add(t.actor('OWNER'), riley.correspondentHash, 'Riley Chen');
    assert.equal(added.outcome, 'ADDED');
    if (added.outcome !== 'ADDED') return;
    const person = await prisma.cognitiveIdentity.findUniqueOrThrow({ where: { id: added.partyId } });
    assert.deepEqual([person.entityType, person.displayName, person.establishmentBasis, person.establishedByUserId], ['PERSON', 'Riley Chen', 'MANUAL', t.users.OWNER]);
    const points = await prisma.crmContactPoint.findMany({ where: { organizationId: t.organizationId, partyId: added.partyId } });
    assert.deepEqual(points.map((p) => [p.kind, p.classification, p.basis, p.value]), [['EMAIL', 'INDIVIDUAL', 'OPERATOR_RECORDED', 'riley@newbrand.example.test']]);
    const origin = await prisma.crmSubjectContextFact.findMany({ where: { organizationId: t.organizationId, partyId: added.partyId } });
    assert.deepEqual(origin.map((f) => [f.kind, f.text, f.basis]), [['ORIGIN', 'Human-approved from Gmail discovery', 'OPERATOR_RECORDED']]);
    assert.deepEqual(
      { opp: await prisma.crmOpportunity.count({ where: { organizationId: t.organizationId } }), rel: await prisma.crmRelationship.count({ where: { organizationId: t.organizationId } }), part: await prisma.crmParticipant.count({ where: { organizationId: t.organizationId } }), ev: await prisma.identityEvidence.count({ where: { organizationId: t.organizationId } }) },
      before,
      'no Opportunity, Relationship, Participant or IdentityEvidence',
    );
    // Resolved: no longer a candidate; a second add routes to the existing Person.
    const after = await read.discovery(t.actor('OWNER'), FRESH, { now: NOW });
    assert.equal(after.outcome === 'OK' && after.candidates.length, 0);
    assert.deepEqual(await disc.add(t.actor('OWNER'), riley.correspondentHash, 'Riley Chen'), { outcome: 'ALREADY_EXISTS', partyId: added.partyId });
    // Reconciled: the new Person's history appears from the viewer's own mail at once.
    const row = await read.person(t.actor('OWNER'), added.partyId, FRESH, OPTS);
    assert.equal(row.outcome === 'OK' && row.row.outreach.state, 'REVIEW_REQUIRED');
    assert.equal(row.outcome === 'OK' && row.row.outreach.reviewReason, 'REPLY_CONTENT_UNKNOWN');

    // A Company role-inbox address is never silently turned into a Person.
    const pressHash = createHash('sha256').update('press@lund.example.test').digest('hex');
    assert.deepEqual(await disc.add(t.actor('OWNER'), pressHash, 'Press Person'), { outcome: 'REATTRIBUTION_REQUIRED', companyPartyId: brand });

    // Dismiss / restore: private, reversible, never audited.
    const audits = await prisma.auditLog.count({ where: { organizationId: t.organizationId } });
    const coldHash = createHash('sha256').update('pitch@cold.example.test').digest('hex');
    assert.equal(await disc.dismiss(t.actor('OWNER'), coldHash, 'NOT_RELEVANT'), 'DISMISSED');
    assert.equal(await disc.dismiss(t.actor('OWNER'), coldHash, 'BOGUS' as never), 'INVALID');
    assert.equal(await disc.dismiss(t.actor('ADMIN'), coldHash, 'IGNORE'), 'NOT_FOUND', "not in ADMIN's mail");
    const dismissedQ = await read.discovery(t.actor('OWNER'), FRESH, { now: NOW });
    assert.deepEqual(dismissedQ.outcome === 'OK' && dismissedQ.dismissed.map((d) => [d.displayAddress, d.reason]), [['pitch@cold.example.test', 'NOT_RELEVANT']]);
    assert.equal(await disc.restore(t.actor('OWNER'), coldHash), 'RESTORED');
    assert.equal(await disc.restore(t.actor('OWNER'), coldHash), 'NOT_FOUND');
    assert.equal(await prisma.auditLog.count({ where: { organizationId: t.organizationId } }), audits);
    await disc.dismiss(t.actor('OWNER'), coldHash, 'IGNORE');

    assert.deepEqual(await textLeaks(prisma, t.organizationId, ['riley@newbrand', 'pitch@cold', 'Re: Hello']), [], 'no address or subject in audit or outbox');

    // Offboarding erases the person's dismissals with the rest of their work state.
    const erased = await prisma.$transaction((tx) => new WorkErasureRepository(tx).eraseAll(t.actor('OWNER')));
    assert.equal(erased.crm_discovery_dismissals, 1);
    assert.equal(await prisma.crmDiscoveryDismissal.count({ where: { organizationId: t.organizationId } }), 0);
  } finally {
    await prisma.$disconnect();
  }
});
