// The Intelligence & Memory Foundation, proved as BEHAVIOR -- not tables.
//
// OBSERVE -> REMEMBER -> CONNECT -> NOTICE -> SURFACE -> HUMAN DECISION / OUTCOME -> USE IT NEXT TIME.
//
// Every scenario drives the real services end to end: the source-read dispatcher the scheduled
// cycle calls, the one outbox and its publisher, the CRM Relationship and Party authorities, the
// Decision Engine, the work-item authority, and the one surfaced-intelligence shape. Nothing here
// opens a page, calls a model or talks to Google.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { IamRepository } from '../src/repositories/iam.repository';
import { WorkGraphRepository, WorkItemRepository, type WorkPrincipal } from '../src/repositories/work-state';
import { PartyService } from '../src/services/party.service';
import { CrmRelationshipService } from '../src/services/crm-relationship.service';
import { StateChangePublisher } from '../src/services/cognitive';
import { DecisionEngine } from '../src/services/decision/decision-engine';
import {
  CREATOR_ONBOARDING_PRODUCER,
  SourceReadDispatcher,
  caseIntelligence,
  declareIntelligenceSubscriptions,
  mailAttentionDetector,
  personalIntelligence,
  sourceReadDetectors,
  type SourceReadDetector,
} from '../src/services/intelligence';

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const NOW = new Date('2026-09-20T15:00:00Z');
const H = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const hash = (address: string) => createHash('sha256').update(address.trim().toLowerCase()).digest('hex');

function world() {
  const fake: any = makeCognitivePrisma({ also: ['invitation', 'organizationMembership', 'customer', 'customerPartyLink', 'crmRelationship', 'crmRelationshipEvent', 'crmParticipant'] });
  const prisma = fake as PrismaClient;
  return {
    fake,
    prisma,
    iam: new IamRepository(prisma),
    graph: new WorkGraphRepository(prisma),
    items: new WorkItemRepository(prisma),
    engine: new DecisionEngine(prisma),
    parties: new PartyService(prisma),
    relationships: new CrmRelationshipService(prisma),
  };
}
type World = ReturnType<typeof world>;

let n = 0;
async function person(w: World, org: string, role = 'OWNER', name = 'Person'): Promise<WorkPrincipal> {
  n += 1;
  const u = await w.iam.createUser({ organizationId: org, email: `p${n}@loop.test`, name: `${name} ${n}`, systemRole: role });
  await w.iam.activateUser(org, u.id);
  return { organizationId: org, userId: u.id };
}

/** One inbound message someone owes a reply to, in `who`'s own mailbox. */
async function inbound(w: World, who: WorkPrincipal, threadId: string, from: string, at: Date, subject = 'Volume next week') {
  await w.graph.recordCorrespondent(who, { addressHash: hash(from), displayAddress: from, displayName: from.split('@')[0]!, domain: from.split('@')[1]!, seenAt: at, direction: 'INBOUND' });
  await w.graph.upsertMessage(who, { provider: 'GOOGLE', messageId: `${threadId}-m${at.getTime()}`, threadId, internalDate: at, direction: 'INBOUND', fromHash: hash(from), subject, labels: ['INBOX', 'UNREAD'], observedAt: at });
  await w.graph.upsertThread(who, { provider: 'GOOGLE', threadId, subject, participantHashes: [hash(from)], messageCount: 1, firstMessageAt: at, lastMessageAt: at, lastDirection: 'INBOUND', lastMessageId: `${threadId}-m${at.getTime()}`, labels: ['INBOX', 'UNREAD'] });
}

const read = (w: World, who: WorkPrincipal, at = NOW) =>
  new SourceReadDispatcher(sourceReadDetectors(w.prisma)).dispatch({ organizationId: who.organizationId, userId: who.userId, source: 'GMAIL', completedAt: at });

// --- SCENARIO 1: proactive -----------------------------------------------------------------------

test('1. new evidence arrives and nobody opens a page: the read itself raises the person’s work item', async () => {
  const w = world();
  const matt = await person(w, ORG_A, 'OWNER', 'Matt');
  await inbound(w, matt, 't-buyer', 'dana@buyer-one.test', ago(2 * H));
  assert.equal((await w.items.items(matt)).length, 0, 'nothing exists before the read completes');

  const runs = await read(w, matt);
  assert.deepEqual(runs.map((r) => [r.detector, r.result]), [['mail-attention', 'RAN']]);
  assert.equal(runs[0]!.counts.raised, 1);
  const [item] = await w.items.items(matt);
  assert.equal(item!.class, 'NEEDS_YOU');
  assert.equal(item!.subjectRef, 't-buyer');

  // The same event again changes nothing: detectors are idempotent.
  const again = await read(w, matt);
  assert.equal(again[0]!.counts.raised, 0);
  assert.equal((await w.items.items(matt)).length, 1);
});

test('1b. the dispatcher refuses a mis-scoped event and isolates a failing detector', async () => {
  const w = world();
  const matt = await person(w, ORG_A);
  const boom: SourceReadDetector = { id: 'boom', sources: ['GMAIL'], scope: 'PRIVATE', detect: async () => { throw new Error('Subject: Contract terms for Dana'); } };
  const dispatcher = new SourceReadDispatcher([boom, mailAttentionDetector(w.prisma)]);
  const privateWithoutPerson = await dispatcher.dispatch({ organizationId: ORG_A, userId: null, source: 'GMAIL', completedAt: NOW });
  assert.deepEqual(privateWithoutPerson.map((r) => r.result), ['REFUSED', 'REFUSED'], 'a private detector never runs without its person');
  const runs = await dispatcher.dispatch({ organizationId: ORG_A, userId: matt.userId, source: 'GMAIL', completedAt: NOW });
  assert.deepEqual(runs.map((r) => r.result), ['FAILED', 'RAN'], 'one failing detector never stops the next');
  assert.equal(JSON.stringify(runs).includes('Dana'), false, 'no stored content reaches the result');
});

// --- SCENARIO 2: cross-source, source ownership kept --------------------------------------------

test('2. Gmail and Calendar compose one item by the same correspondent key -- and neither source changes', async () => {
  const w = world();
  const matt = await person(w, ORG_A);
  await inbound(w, matt, 't-dana', 'dana@buyer-one.test', ago(3 * H));
  await w.graph.upsertEvent(matt, {
    provider: 'GOOGLE', eventId: 'ev-review', startsAt: new Date(NOW.getTime() + 20 * H), endsAt: new Date(NOW.getTime() + 21 * H),
    summary: 'Buyer review', status: 'CONFIRMED', kind: 'DEFAULT', blocking: 'BLOCKING', attendanceKnown: true, attendeeCount: 2, externalAttendeeCount: 1,
    organizerHash: hash('dana@buyer-one.test'), organizerIsSelf: false, observedAt: NOW,
  } as never);
  await w.graph.upsertEvent(matt, {
    provider: 'GOOGLE', eventId: 'ev-other', startsAt: new Date(NOW.getTime() + 22 * H), endsAt: new Date(NOW.getTime() + 23 * H),
    summary: 'Unrelated', status: 'CONFIRMED', kind: 'DEFAULT', blocking: 'BLOCKING', attendanceKnown: true, attendeeCount: 2, externalAttendeeCount: 1,
    organizerHash: hash('someone@else.test'), organizerIsSelf: false, observedAt: NOW,
  } as never);
  await read(w, matt);
  const before = JSON.stringify({ threads: w.fake.workThread.__rows, events: w.fake.workEvent.__rows });

  const [item] = await personalIntelligence(w.prisma, matt, NOW);
  assert.equal(item!.scope, 'PRIVATE');
  assert.deepEqual(item!.evidence.map((e) => [e.authority, e.kind, e.ref]), [['GMAIL', 'THREAD', 't-dana'], ['CALENDAR', 'EVENT', 'ev-review']]);
  assert.match(item!.remembers.join(' '), /dana organized a meeting with you on 2026-09-21/);
  assert.equal(item!.evidence.some((e) => e.ref === 'ev-other'), false, 'no name or similarity join: only the same address key');
  assert.equal(JSON.stringify({ threads: w.fake.workThread.__rows, events: w.fake.workEvent.__rows }), before, 'each source keeps its own evidence, untouched');
});

// --- SCENARIO 3 and 10: memory, and outcomes that change the next suggestion --------------------

const situation = (key: string, title: string, detectionKey: string, at: Date) => ({
  producer: 'callgrid',
  recurrenceKey: key,
  detectionKey,
  detectedAt: at,
  title,
  severity: 'HIGH' as const,
  evidence: [{ source: 'summary-report', metricKey: 'billableCalls', window: 'day', ruleId: key.split('::')[0], ruleVersion: 'v1', observedAt: at, entityType: 'buyer', entityId: key.split('::')[1], entityName: 'Buyer' }],
});
const SYSTEM = { type: 'HUMAN' as const, source: 'test' };

test('3. a situation seen again brings back what happened last time', async () => {
  const w = world();
  const matt = await person(w, ORG_A);
  const first = await w.engine.create(ORG_A, situation('volume-drop::buyer-7', 'Buyer 7 volume fell 40%', 'day:2026-09-10', new Date('2026-09-10T12:00:00Z')));
  await w.engine.resolve(ORG_A, first.decision.id, { outcome: 'RECOVERED', reason: 'came back by itself the next day', actor: { ...SYSTEM, userId: matt.userId } });
  // A later period: the same situation, raised again.
  await w.engine.create(ORG_A, situation('volume-drop::buyer-7', 'Buyer 7 volume fell 35%', 'day:2026-09-20', NOW));

  const item = await caseIntelligence(w.engine, ORG_A, first.decision.id);
  assert.equal(item!.scope, 'ORGANIZATION');
  assert.deepEqual(item!.previously.map((p) => [p.relation, p.outcome, p.reason]), [['SAME', 'RECOVERED', 'came back by itself the next day']]);
  assert.match(item!.remembers.join(' '), /Reopened 1 time after being closed/);
});

test('10. prior outcomes materially change the later suggestion, with the basis stated', async () => {
  const w = world();
  const matt = await person(w, ORG_A);
  // Two other buyers had the same pattern, and both times it went away without action.
  for (const [buyer, day] of [['buyer-1', '2026-09-05'], ['buyer-2', '2026-09-08']] as const) {
    const c = await w.engine.create(ORG_A, situation(`volume-drop::${buyer}`, `${buyer} volume fell`, `day:${day}`, new Date(`${day}T12:00:00Z`)));
    await w.engine.resolve(ORG_A, c.decision.id, { outcome: 'NO_ACTION_NEEDED', reason: null, actor: { ...SYSTEM, userId: matt.userId } });
  }
  const fresh = await w.engine.create(ORG_A, situation('volume-drop::buyer-9', 'Buyer 9 volume fell 30%', 'day:2026-09-20', NOW));
  const withHistory = await caseIntelligence(w.engine, ORG_A, fresh.decision.id);
  assert.equal(withHistory!.suggestedReview.posture, 'WATCH');
  assert.match(withHistory!.suggestedReview.basis ?? '', /resolved without action the last 2 times it was raised elsewhere/);

  // The same new situation in an organization with no such history keeps the producer's posture.
  const other = world();
  const lone = await other.engine.create(ORG_B, situation('volume-drop::buyer-9', 'Buyer 9 volume fell 30%', 'day:2026-09-20', NOW));
  const noHistory = await caseIntelligence(other.engine, ORG_B, lone.decision.id);
  assert.equal(noHistory!.suggestedReview.posture, 'REVIEW');
  assert.equal(noHistory!.suggestedReview.basis, null);
});

// --- SCENARIO 4: corrections compound ------------------------------------------------------------

test('4. a person closes it; the same unchanged evidence does not raise it again -- a newer message does', async () => {
  const w = world();
  const matt = await person(w, ORG_A);
  await inbound(w, matt, 't-lindsey', 'lindsey@brand.test', ago(5 * H));
  await read(w, matt);
  const [item] = await w.items.items(matt);
  await w.items.record(matt, item!.id, { state: 'RESOLVED', outcome: 'HANDLED', observationType: 'RESOLVED', occurredAt: ago(1 * H), actorType: 'HUMAN', actorUserId: matt.userId, reason: 'I replied by phone' });

  const unchanged = await read(w, matt);
  assert.equal(unchanged[0]!.counts.skippedClosed, 1, 'the correction holds against the same evidence');
  assert.equal((await w.items.item(matt, item!.id))!.state, 'RESOLVED');

  await inbound(w, matt, 't-lindsey', 'lindsey@brand.test', new Date(NOW.getTime() + H));
  const moved = await read(w, matt, new Date(NOW.getTime() + 2 * H));
  assert.equal(moved[0]!.counts.reopened, 1, 'new evidence reopens it');
  const log = await w.items.observations(matt, item!.id);
  // The unchanged read left no trace at all; the new message reopened and re-detected it.
  assert.deepEqual(log.map((o) => o.observationType), ['DETECTED', 'RESOLVED', 'REOPENED', 'REDETECTED'], 'history is appended, never rewritten');
  assert.ok(log.some((o) => o.observationType === 'RESOLVED' && o.reason === 'I replied by phone'), 'the person’s words are kept');
});

// --- SCENARIO 5: the creator foundation, from a real authority's event ---------------------------

async function establish(w: World, owner: WorkPrincipal, partyType: 'PERSON' | 'COMPANY', displayName: string) {
  const made = await w.parties.create(owner.organizationId, owner.userId, { partyType, displayName });
  const id = made.outcome === 'RECORDED' ? made.party.id : '';
  await w.parties.establish(owner.organizationId, owner.userId, id, 'MANUAL');
  return id;
}

async function brandWithContact(w: World, owner: WorkPrincipal, brandName: string, contactName: string) {
  const actor = { organizationId: owner.organizationId, userId: owner.userId, actorName: 'Owner' };
  const brand = await establish(w, owner, 'COMPANY', brandName);
  const contact = await establish(w, owner, 'PERSON', contactName);
  const client = await w.relationships.create(actor, { kind: 'CLIENT', sides: [{ side: 'COUNTERPARTY', partyId: brand, role: 'BRAND' }], occurredAt: ago(30 * 24 * H) } as never);
  const relationshipId = client.outcome === 'RECORDED' ? client.value.relationship.id : '';
  await w.relationships.addParticipant(actor, { relationshipId, partyId: contact, role: 'PRIMARY_CONTACT', actsForSide: 'COUNTERPARTY', occurredAt: ago(30 * 24 * H) } as never);
  return { brand, contact, relationshipId };
}

async function represent(w: World, owner: WorkPrincipal, creatorName: string) {
  const actor = { organizationId: owner.organizationId, userId: owner.userId, actorName: 'Owner' };
  const creator = await establish(w, owner, 'PERSON', creatorName);
  const talent = await w.relationships.create(actor, { kind: 'TALENT_REPRESENTATION', sides: [{ side: 'COUNTERPARTY', partyId: creator, role: 'CREATOR' }], occurredAt: NOW } as never);
  assert.equal(talent.outcome, 'RECORDED', 'the CRM authority recorded the representation');
  return creator;
}

const drain = (w: World, org: string, at = NOW) => new StateChangePublisher(w.prisma, {}).run(org, { now: at } as never);
const creatorCases = (w: World, org: string) => w.engine.list(org, { producer: CREATOR_ONBOARDING_PRODUCER });

test('5. EMG starts representing a creator; with no prompt, Loop surfaces the brand relationships worth reviewing', async () => {
  const w = world();
  const matt = await person(w, ORG_A);
  await declareIntelligenceSubscriptions(w.prisma, ORG_A, { apply: true });
  const { brand, contact, relationshipId } = await brandWithContact(w, matt, 'Glow Cosmetics', 'Rita Reyes');
  await drain(w, ORG_A); // the brand's own creation events: not a creator, nothing recorded
  assert.equal((await creatorCases(w, ORG_A)).length, 0);

  const creator = await represent(w, matt, 'Ava Creator');
  await drain(w, ORG_A);
  const [review] = await creatorCases(w, ORG_A);
  assert.ok(review, 'the publisher delivered the event and the review recorded one Case');
  assert.match(review!.title, /Ava Creator: 1 brand relationship worth reviewing/);
  assert.match(review!.summary ?? '', /Glow Cosmetics: EMG has an active client relationship\. Known contact: Rita Reyes \(primary contact\)\./);

  const item = await caseIntelligence(w.engine, ORG_A, review!.id);
  assert.deepEqual(item!.evidence.filter((e) => e.authority === 'CRM').map((e) => e.ref), [relationshipId], 'the CRM record stays the CRM’s, cited not copied');
  assert.deepEqual(item!.related.map((r) => [r.kind, r.ref, r.verified]), [['CREATOR', creator, true], ['BRAND', brand, true], ['CONTACT', contact, true]]);
  assert.equal(item!.humanState, 'NEW');

  // Redelivery, or the drain running again, records nothing twice.
  await drain(w, ORG_A);
  assert.equal((await creatorCases(w, ORG_A)).length, 1);
});

test('10b. what happened to the last suggestion of a brand comes back when the next creator arrives', async () => {
  const w = world();
  const matt = await person(w, ORG_A);
  await declareIntelligenceSubscriptions(w.prisma, ORG_A, { apply: true });
  await brandWithContact(w, matt, 'Glow Cosmetics', 'Rita Reyes');
  await represent(w, matt, 'Ava Creator');
  await drain(w, ORG_A);
  const [first] = await creatorCases(w, ORG_A);
  await w.engine.resolve(ORG_A, first!.id, { outcome: 'CONVERTED_TO_WORK', reason: 'pitched Ava to Glow', actor: { type: 'HUMAN', userId: matt.userId, source: 'test' } });

  await represent(w, matt, 'Ben Creator');
  await drain(w, ORG_A, new Date(NOW.getTime() + H));
  const ben = (await creatorCases(w, ORG_A)).find((c) => c.title.startsWith('Ben Creator'));
  assert.match(ben!.summary ?? '', /Last time Loop suggested Glow Cosmetics for a new creator, it became work\./);
});

// --- SCENARIO 6: no reason to act ----------------------------------------------------------------

test('6. evidence that changes nothing produces nothing: no noisy item, no Case', async () => {
  const w = world();
  const matt = await person(w, ORG_A);
  // Matt wrote last, a moment ago: nothing is owed and nothing has gone quiet.
  await w.graph.upsertThread(matt, { provider: 'GOOGLE', threadId: 't-sent', subject: 'Sent', participantHashes: [hash('a@b.test')], messageCount: 1, firstMessageAt: ago(0.5 * H), lastMessageAt: ago(0.5 * H), lastDirection: 'OUTBOUND', lastMessageId: 'm', labels: ['SENT'] });
  const runs = await read(w, matt);
  assert.equal(runs[0]!.counts.raised, 0);
  assert.equal((await w.items.items(matt)).length, 0);

  // A creator arrives, but the business has no brand relationship to review: no Case.
  await declareIntelligenceSubscriptions(w.prisma, ORG_A, { apply: true });
  await represent(w, matt, 'Cora Creator');
  await drain(w, ORG_A);
  assert.equal((await creatorCases(w, ORG_A)).length, 0);
});

// --- SCENARIO 7 and 8: isolation -----------------------------------------------------------------

test('7. Matt’s and Charlie’s private evidence and intelligence stay apart, in both directions, whoever is OWNER', async () => {
  const w = world();
  const matt = await person(w, ORG_A, 'OWNER', 'Matt');
  const charlie = await person(w, ORG_A, 'OWNER', 'Charlie');
  await inbound(w, matt, 't-matt', 'dana@buyer-one.test', ago(2 * H), 'MATT-ONLY renewal');
  await inbound(w, charlie, 't-charlie', 'kim@brand.test', ago(2 * H), 'CHARLIE-ONLY brief');
  await read(w, matt);
  await read(w, charlie);
  const mine = await personalIntelligence(w.prisma, matt, NOW);
  const theirs = await personalIntelligence(w.prisma, charlie, NOW);
  assert.deepEqual(mine.map((i) => i.evidence[0]!.ref), ['t-matt']);
  assert.deepEqual(theirs.map((i) => i.evidence[0]!.ref), ['t-charlie']);
  assert.equal(JSON.stringify(mine).includes('CHARLIE-ONLY'), false);
  assert.equal(JSON.stringify(theirs).includes('MATT-ONLY'), false);
  // Charlie's read never touches Matt's queue.
  const mattItemsBefore = JSON.stringify(await w.items.items(matt));
  await read(w, charlie);
  assert.equal(JSON.stringify(await w.items.items(matt)), mattItemsBefore);
});

test('8. one organization can neither trigger nor read another organization’s intelligence', async () => {
  const w = world();
  const a = await person(w, ORG_A);
  const b = await person(w, ORG_B);
  await declareIntelligenceSubscriptions(w.prisma, ORG_A, { apply: true });
  await declareIntelligenceSubscriptions(w.prisma, ORG_B, { apply: true });
  await brandWithContact(w, a, 'Glow Cosmetics', 'Rita Reyes');
  await represent(w, b, 'Dee Creator'); // Org B has no brand relationships of its own
  await drain(w, ORG_A);
  await drain(w, ORG_B);
  assert.equal((await creatorCases(w, ORG_B)).length, 0, 'Org A’s brands are not Org B’s memory');
  assert.equal((await creatorCases(w, ORG_A)).length, 0, 'Org B’s creator is not Org A’s event');

  const c = await w.engine.create(ORG_A, situation('volume-drop::buyer-7', 'Buyer 7 volume fell', 'day:x', NOW));
  assert.equal(await caseIntelligence(w.engine, ORG_B, c.decision.id), null, 'another organization’s Case is not found');
});

// --- SCENARIO 9: human authority -----------------------------------------------------------------

test('9. machine-started reasoning suggests and records; it executes nothing and establishes nothing', async () => {
  const w = world();
  const matt = await person(w, ORG_A);
  await declareIntelligenceSubscriptions(w.prisma, ORG_A, { apply: true });
  await brandWithContact(w, matt, 'Glow Cosmetics', 'Rita Reyes');
  await inbound(w, matt, 't-x', 'x@y.test', ago(3 * H));
  const before = {
    relationships: w.fake.crmRelationship.__rows.length,
    identities: w.fake.cognitiveIdentity.__rows.length,
    links: w.fake.identityResolutionLink.__rows.length,
    drafts: w.fake.workDraft.__rows.length,
  };
  await read(w, matt);
  await represent(w, matt, 'Eve Creator');
  // The person's own act: the representation, its side and the creator's Party.
  const afterRepresent = { relationships: w.fake.crmRelationship.__rows.length, participants: w.fake.crmParticipant.__rows.length, identities: w.fake.cognitiveIdentity.__rows.length };
  await drain(w, ORG_A);
  // Only the person's own act (the representation and its creator Party) changed CRM and identity.
  assert.equal(w.fake.crmRelationship.__rows.length, afterRepresent.relationships, 'the review wrote no Relationship');
  assert.equal(w.fake.crmParticipant.__rows.length, afterRepresent.participants, 'the review added no contact');
  assert.equal(w.fake.cognitiveIdentity.__rows.length, afterRepresent.identities, 'the review established no identity');
  assert.equal(w.fake.identityResolutionLink.__rows.length, before.links, 'no identity match was persisted');
  assert.equal(w.fake.workDraft.__rows.length, before.drafts, 'no draft, so nothing could be sent');
  const [review] = await creatorCases(w, ORG_A);
  const log = await w.engine.getHistory(ORG_A, review!.id);
  assert.ok(log.every((o) => o.actorType === 'SYSTEM'), 'recorded as the SYSTEM producer it is, never as a person');
  assert.equal(review!.state, 'NEEDS_REVIEW', 'a person decides what happens next');

  // And structurally: no intelligence module can reach a sender, a draft, the Brain or a provider.
  const dir = join(__dirname, '..', 'src', 'services', 'intelligence');
  const code = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  for (const forbidden of ['mail-send', 'MailSendService', 'sendGoogleGmail', 'WorkDraftRepository', 'brain', 'fetch(', 'googleapis', 'accessToken', 'establish(', 'IdentityResolutionLinkRepository', 'addParticipant', '.create(actor']) {
    assert.equal(code.includes(forbidden), false, `${forbidden} has no place in intelligence`);
  }
});
