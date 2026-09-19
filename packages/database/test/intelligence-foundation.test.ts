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
import { IdentitySuggestionService, IDENTITY_SUGGESTION_CONFIRMED_AUDIT_ACTION, IDENTITY_SUGGESTION_REJECTED_AUDIT_ACTION } from '../src/services/identity-suggestion.service';
import { IdentityEvidenceRepository, IdentitySuggestionRepository, IntelligenceHypothesisRepository } from '../src/repositories/cognitive';
import { WorkPreferencesRepository } from '../src/repositories/work-state/work-preferences.repository';
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
  reviewOnboardedCreator,
  sourceReadDetectors,
  type CreatorRelevanceSource,
  type SourceReadDetector,
} from '../src/services/intelligence';
import { CrmRelationshipReadModelRepository } from '../src/repositories/crm-relationship-read-model.repository';
import { PartyReadModelRepository } from '../src/repositories/party-read-model.repository';

// Identity suggestions compare only under a CONFIGURED identifier key (never the development
// fallback). This process is the test, so it configures one.
process.env.COGNITIVE_HASH_SECRET ||= 'test-identifier-key';

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
    evidence: new IdentityEvidenceRepository(prisma),
    suggestions: new IdentitySuggestionRepository(prisma),
    decisions: new IdentitySuggestionService(prisma, { now: () => NOW }),
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
async function inbound(w: World, who: WorkPrincipal, threadId: string, from: string, at: Date, subject = 'Volume next week', name: string | null = from.split('@')[0]!) {
  await w.graph.recordCorrespondent(who, { addressHash: hash(from), displayAddress: from, displayName: name, domain: from.split('@')[1]!, seenAt: at, direction: 'INBOUND' });
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
  assert.deepEqual(runs.map((r) => [r.detector, r.result]), [['mail-attention', 'RAN'], ['identity-suggestions', 'RAN']]);
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
  assert.match(item!.remembers.join(' '), /dana is waiting on your reply, and dana organized tomorrow's meeting\./);
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
  for (const forbidden of ['mail-send', 'MailSendService', 'sendGoogleGmail', 'WorkDraftRepository', 'brain', 'fetch(', 'googleapis', 'accessToken', 'establish(', 'IdentityResolutionLinkRepository', 'addParticipant', '.create(actor', 'IdentitySuggestionService', '.decide(', '.confirm(', 'IdentityEvidenceRepository', '.record(']) {
    assert.equal(code.includes(forbidden), false, `${forbidden} has no place in intelligence`);
  }
});

// --- D1: identity match suggestions (approved 2026-09-19) ---------------------------------------

/** An identifier the organization recorded on a Party: the only evidence a suggestion may rest on. */
const identify = (w: World, org: string, partyId: string, address: string, source = 'crm-entry') =>
  w.evidence.record(org, { identityId: partyId, evidenceType: 'EMAIL', rawValue: address, source, observedAt: ago(48 * H) });

async function danaAtAcme(w: World, owner: WorkPrincipal) {
  const made = await brandWithContact(w, owner, 'Acme Co', 'Dana Diaz');
  await identify(w, owner.organizationId, made.contact, 'dana@acme.test');
  return made;
}

const countsOf = (runs: readonly { detector: string; counts: Readonly<Record<string, number>> }[], id: string) => runs.find((r) => r.detector === id)!.counts;
const identityWrites = (w: World) => ({
  evidence: w.fake.identityEvidence.__rows.length,
  links: w.fake.identityResolutionLink.__rows.length,
  intakeLinks: w.fake.customerPartyLink.__rows.length,
  identities: w.fake.cognitiveIdentity.__rows.length,
  relationships: w.fake.crmRelationship.__rows.length,
  participants: w.fake.crmParticipant.__rows.length,
});

test('D1a. exact evidence -> PROPOSED -> a person confirms -> their intelligence uses the verified match', async () => {
  const w = world();
  const matt = await person(w, ORG_A, 'OWNER', 'Matt');
  const { brand, contact, relationshipId } = await danaAtAcme(w, matt);
  await inbound(w, matt, 't-dana', 'dana@acme.test', ago(3 * H), 'Renewal terms', 'Dana');
  const before = identityWrites(w);

  const runs = await read(w, matt);
  assert.equal(countsOf(runs, 'identity-suggestions').proposed, 1, 'the read itself proposed it');
  assert.deepEqual(identityWrites(w), before, 'proposing wrote no identity state');
  const [pending] = await w.suggestions.forOwner(matt);
  assert.equal(pending!.status, 'PROPOSED', 'a machine suggestion is created PROPOSED, never anything else');
  assert.equal(pending!.partyId, contact);
  assert.equal(pending!.basis.method, 'EXACT_EMAIL_KEY');
  assert.equal(pending!.basis.source, 'GMAIL');
  assert.match(pending!.basis.reason, /exactly matches an email identifier recorded on one established Party/);
  assert.equal(pending!.basis.observedAt, NOW.toISOString());
  assert.deepEqual(pending!.basis.refs.map((r) => [r.authority, r.kind]), [['GMAIL', 'CORRESPONDENT'], ['IDENTITY', 'IDENTITY_EVIDENCE']]);
  assert.equal(JSON.stringify(w.fake.intelligenceHypothesis.__rows).includes('dana@acme.test'), false, 'references and keys, never the address');

  // Unconfirmed: shown as a question, never as truth, and nothing is composed from it.
  let [item] = await personalIntelligence(w.prisma, matt, NOW);
  assert.deepEqual(item!.related.filter((r) => r.kind === 'PARTY').map((r) => [r.ref, r.label, r.verified]), [[contact, 'Dana Diaz', false]]);
  assert.match(item!.uncertainty.join(' '), /Dana may be Dana Diaz: .* Not confirmed -- confirm or reject the match\./);
  assert.ok(item!.evidence.some((e) => e.authority === 'IDENTITY' && e.kind === 'SUGGESTION' && e.ref === pending!.id));
  assert.equal(item!.evidence.some((e) => e.authority === 'CRM'), false, 'no relationship is composed from a guess');

  // More evidence while it is pending does not pile up a second question.
  await identify(w, ORG_A, contact, 'dana@acme.test', 'second-source');
  assert.equal(countsOf(await read(w, matt, new Date(NOW.getTime() + H)), 'identity-suggestions').standing, 1);
  assert.equal((await w.suggestions.forOwner(matt)).length, 1);

  const beforeDecision = identityWrites(w);
  const decided = await w.decisions.confirm({ organizationId: ORG_A, userId: matt.userId }, pending!.id);
  assert.equal(decided.outcome, 'CONFIRMED');
  [item] = await personalIntelligence(w.prisma, matt, NOW);
  assert.deepEqual(item!.related.filter((r) => r.kind === 'PARTY').map((r) => [r.ref, r.label, r.verified]), [[contact, 'Dana Diaz', true], [brand, 'Acme Co', true]]);
  assert.ok(item!.evidence.some((e) => e.authority === 'CRM' && e.kind === 'RELATIONSHIP' && e.ref === relationshipId), 'the CRM record is cited, not copied');
  assert.match(item!.remembers.join(' '), /You confirmed Dana is Dana Diaz: primary contact on the client relationship with Acme Co \(active\)\./);
  assert.deepEqual(item!.uncertainty, []);

  // A confirmation is the person's reading of their own evidence -- not an identity write.
  assert.deepEqual(identityWrites(w), beforeDecision, 'confirming wrote no evidence, resolution link, Intake link, Party or Relationship');
  const audit = w.fake.auditLog.__rows.filter((a: any) => a.action === IDENTITY_SUGGESTION_CONFIRMED_AUDIT_ACTION);
  assert.equal(audit.length, 1, 'the act is on the trail');
  const trail = JSON.stringify(audit);
  assert.equal(trail.includes(contact) || trail.includes(hash('dana@acme.test')) || trail.includes('Dana'), false, 'the trail names the act, not the Party or the correspondent');

  // Decided once.
  assert.equal((await w.decisions.reject({ organizationId: ORG_A, userId: matt.userId }, pending!.id, 'changed my mind')).outcome, 'ALREADY_DECIDED');
});

test('D1b. rejected: the same unchanged evidence never proposes it again; new evidence may, with the rejection kept', async () => {
  const w = world();
  const matt = await person(w, ORG_A, 'OWNER', 'Matt');
  const { contact } = await danaAtAcme(w, matt);
  await inbound(w, matt, 't-dana', 'dana@acme.test', ago(3 * H), 'Renewal terms', 'Dana');
  await read(w, matt);
  const [pending] = await w.suggestions.forOwner(matt);
  const actor = { organizationId: ORG_A, userId: matt.userId };
  assert.equal((await w.decisions.reject(actor, pending!.id, '  ')).outcome, 'REASON_REQUIRED', 'a rejection says why (identity §13)');
  assert.equal((await w.decisions.reject(actor, pending!.id, 'A different Dana -- this one is at the agency')).outcome, 'REJECTED');
  assert.equal(w.fake.auditLog.__rows.filter((a: any) => a.action === IDENTITY_SUGGESTION_REJECTED_AUDIT_ACTION).length, 1);

  // Read after read, new messages from the same person: the same evidence, so it does not come back.
  for (const at of [NOW, new Date(NOW.getTime() + H), new Date(NOW.getTime() + 2 * H)]) {
    await inbound(w, matt, 't-dana', 'dana@acme.test', at, 'Renewal terms', 'Dana');
    const counts = countsOf(await read(w, matt, at), 'identity-suggestions');
    assert.equal(counts.proposed + counts.reconsidered, 0, 'nothing re-proposed');
    assert.equal(counts.unchanged, 1, 'the rejection holds against unchanged evidence');
  }
  assert.deepEqual((await w.suggestions.forOwner(matt, ['PROPOSED', 'CONFIRMED', 'REJECTED'])).map((s) => s.status), ['REJECTED']);
  const [item] = await personalIntelligence(w.prisma, matt, NOW);
  assert.equal(item!.related.some((r) => r.kind === 'PARTY'), false, 'a rejected match is not shown');

  // Materially new evidence: another identifier record for this address, on the same Party.
  await identify(w, ORG_A, contact, 'Dana@Acme.test', 'signed-contract');
  const counts = countsOf(await read(w, matt, new Date(NOW.getTime() + 3 * H)), 'identity-suggestions');
  assert.equal(counts.reconsidered, 1, 'new evidence may reopen the question');
  const history = await w.suggestions.history(matt, hash('dana@acme.test'), contact);
  assert.deepEqual(history.map((s) => s.status), ['REJECTED', 'PROPOSED'], 'the rejection is kept; the new suggestion stands beside it');
  assert.equal(history[0]!.decisionReason, 'A different Dana -- this one is at the agency', 'the person’s words are kept');
  assert.deepEqual(history[1]!.basis.reconsiders, [history[0]!.id], 'the new suggestion names the rejection it reconsiders');
  assert.equal(history[1]!.basis.refs.filter((r) => r.kind === 'IDENTITY_EVIDENCE').length, 2);
});

test('D1c. no machine principal can turn a suggestion into a confirmed match', async () => {
  const w = world();
  const matt = await person(w, ORG_A, 'OWNER', 'Matt');
  const bot = await person(w, ORG_A, 'AI_EMPLOYEE', 'Agent');
  await danaAtAcme(w, matt);
  await inbound(w, matt, 't-dana', 'dana@acme.test', ago(3 * H), 'Renewal terms', 'Dana');
  await read(w, matt);
  const [pending] = await w.suggestions.forOwner(matt);

  // An AI employee -- even one somebody tried to grant the authority to -- is refused before anything is read.
  await w.fake.permission.create({ data: { organizationId: ORG_A, userId: bot.userId, resource: 'identityResolution', action: 'update', effect: 'ALLOW' } });
  assert.equal((await w.decisions.confirm(bot, pending!.id)).outcome, 'NOT_AUTHORIZED');
  // A system actor has no membership to act with.
  assert.equal((await w.decisions.confirm({ organizationId: ORG_A, userId: 'system' }, pending!.id)).outcome, 'NOT_AUTHORIZED');
  assert.equal((await w.decisions.confirm({ organizationId: ORG_A, userId: '' }, pending!.id)).outcome, 'INVALID');
  // The generic belief paths cannot reach it: not listed, not acceptable, not linkable to a Case.
  const beliefs = new IntelligenceHypothesisRepository(w.prisma);
  assert.equal(await beliefs.accept(ORG_A, pending!.id, 'system'), null);
  assert.equal(await beliefs.findById(ORG_A, pending!.id), null);
  assert.equal((await beliefs.list(ORG_A)).some((h) => h.id === pending!.id), false);
  const c = await w.engine.create(ORG_A, situation('volume-drop::buyer-7', 'Buyer 7 volume fell', 'day:x', NOW));
  await assert.rejects(() => w.engine.linkHypothesis(ORG_A, c.decision.id, { hypothesisId: pending!.id, actor: { ...SYSTEM, userId: matt.userId } } as never));
  // Reading again never promotes it.
  await read(w, matt, new Date(NOW.getTime() + H));
  assert.equal((await w.suggestions.find(matt, pending!.id))!.status, 'PROPOSED');
  // An AI employee's own mail proposes nothing; nor does an EMPLOYEE's, who may not confirm an attribution (§6).
  const erin = await person(w, ORG_A, 'EMPLOYEE', 'Erin');
  for (const who of [bot, erin]) {
    await inbound(w, who, `t-${who.userId}`, 'dana@acme.test', ago(3 * H));
    assert.deepEqual(countsOf(await read(w, who), 'identity-suggestions'), { notEligible: 1 });
    assert.equal((await w.suggestions.forOwner(who)).length, 0);
  }
  assert.equal((await w.decisions.confirm(erin, pending!.id)).outcome, 'NOT_AUTHORIZED');
});

test('D1d. a suggestion stays with the person whose mail it came from, and inside the organization', async () => {
  const w = world();
  const matt = await person(w, ORG_A, 'OWNER', 'Matt');
  const charlie = await person(w, ORG_A, 'OWNER', 'Charlie');
  await danaAtAcme(w, matt);
  await inbound(w, matt, 't-matt', 'dana@acme.test', ago(3 * H), 'MATT-ONLY renewal', 'Dana');
  await read(w, matt);
  const [mine] = await w.suggestions.forOwner(matt);
  assert.equal((await w.suggestions.forOwner(charlie)).length, 0, 'Charlie has no mail from Dana: nothing of Matt’s reaches him');
  assert.equal((await w.decisions.confirm(charlie, mine!.id)).outcome, 'NOT_FOUND', 'an OWNER can neither see nor decide a colleague’s private suggestion');
  assert.equal(await w.suggestions.find(charlie, mine!.id), null);

  // Both of them hear from Dana: two private suggestions, decided separately.
  await inbound(w, charlie, 't-charlie', 'dana@acme.test', ago(3 * H), 'CHARLIE-ONLY brief', 'Dana');
  await read(w, charlie);
  const [theirs] = await w.suggestions.forOwner(charlie);
  assert.notEqual(theirs!.id, mine!.id);
  assert.equal((await w.decisions.confirm(matt, mine!.id)).outcome, 'CONFIRMED');
  assert.equal((await w.suggestions.find(charlie, theirs!.id))!.status, 'PROPOSED', 'Matt’s confirmation is not Charlie’s');
  const charlieItems = await personalIntelligence(w.prisma, charlie, NOW);
  assert.equal(charlieItems.flatMap((i) => i.related).some((r) => r.kind === 'PARTY' && r.verified), false);
  assert.equal(JSON.stringify(charlieItems).includes('MATT-ONLY'), false);

  // Another organization: the same address, no identifier of its own, and no reach into Org A.
  const olga = await person(w, ORG_B, 'OWNER', 'Olga');
  await inbound(w, olga, 't-olga', 'dana@acme.test', ago(3 * H), 'Org B thread', 'Dana');
  assert.equal(countsOf(await read(w, olga), 'identity-suggestions').proposed, 0, 'Org A’s identifiers are not Org B’s evidence');
  assert.equal((await w.suggestions.forOwner(olga)).length, 0);
  assert.equal((await w.decisions.confirm(olga, theirs!.id)).outcome, 'NOT_FOUND');
});

test('D1e. exact identifiers only: a shared address, a lookalike name or an unestablished record proposes nothing', async () => {
  const w = world();
  const matt = await person(w, ORG_A, 'OWNER', 'Matt');
  const first = await establish(w, matt, 'PERSON', 'Sam Shared');
  const second = await establish(w, matt, 'PERSON', 'Sam Also');
  await identify(w, ORG_A, first, 'office@shared.test');
  await identify(w, ORG_A, second, 'office@shared.test');
  const dana = await establish(w, matt, 'PERSON', 'Dana Diaz');
  await identify(w, ORG_A, dana, 'dana.diaz@elsewhere.test');
  const draft = await w.parties.create(ORG_A, matt.userId, { partyType: 'PERSON', displayName: 'Nora' });
  await identify(w, ORG_A, draft.outcome === 'RECORDED' ? draft.party.id : '', 'nora@studio.test');

  await inbound(w, matt, 't-office', 'office@shared.test', ago(3 * H), 'Office', 'Sam');
  await inbound(w, matt, 't-dana', 'dana@acme.test', ago(3 * H), 'Hello', 'Dana Diaz'); // the same name, another address
  await inbound(w, matt, 't-nora', 'nora@studio.test', ago(3 * H), 'Hi', 'Nora');
  const counts = countsOf(await read(w, matt), 'identity-suggestions');
  assert.equal(counts.conflicting, 1, 'two Parties carry the address: a person decides, nothing is proposed');
  assert.equal(counts.notReferenceable, 1, 'a record nobody established is not a match');
  assert.equal(counts.proposed, 0, 'a matching name is not evidence');
  assert.equal((await w.suggestions.forOwner(matt)).length, 0);
});

// --- D2: calendar attendee keys (approved 2026-09-19) --------------------------------------------

/** A conversation `who` is waiting on: they wrote last, three days ago. */
async function outbound(w: World, who: WorkPrincipal, threadId: string, to: string, at: Date, subject: string, name: string | null) {
  await w.graph.recordCorrespondent(who, { addressHash: hash(to), displayAddress: to, displayName: name, domain: to.split('@')[1]!, seenAt: at, direction: 'OUTBOUND' });
  await w.graph.upsertThread(who, { provider: 'GOOGLE', threadId, subject, participantHashes: [hash(to)], messageCount: 2, firstMessageAt: new Date(at.getTime() - 24 * H), lastMessageAt: at, lastDirection: 'OUTBOUND', lastMessageId: `${threadId}-m`, labels: ['SENT'] });
}

const meeting = (eventId: string, startsAt: Date, over: Record<string, unknown> = {}) =>
  ({
    provider: 'GOOGLE', eventId, startsAt, endsAt: new Date(startsAt.getTime() + H), summary: 'Quarterly review', status: 'CONFIRMED', kind: 'DEFAULT', blocking: 'BLOCKING',
    attendanceKnown: true, attendeeCount: 3, externalAttendeeCount: 2, organizerHash: hash('me@emg.test'), organizerIsSelf: true, observedAt: NOW, ...over,
  }) as never;

test('D2a. "You’re waiting on Dana, and Dana is in tomorrow’s meeting" -- two private sources, one key, no address', async () => {
  const w = world();
  const matt = await person(w, ORG_A, 'OWNER', 'Matt');
  await outbound(w, matt, 't-dana', 'dana@acme.test', ago(3 * 24 * H), 'Proposal', 'Dana');
  await w.graph.upsertEvent(matt, meeting('ev-review', new Date(NOW.getTime() + 20 * H), { attendeeHashes: [hash('lee@other.test'), hash('dana@acme.test')] }));
  await w.graph.upsertEvent(matt, meeting('ev-unrelated', new Date(NOW.getTime() + 22 * H), { attendeeHashes: [hash('lee@other.test')] }));
  await read(w, matt);

  const [item] = await personalIntelligence(w.prisma, matt, NOW);
  assert.equal(item!.scope, 'PRIVATE');
  assert.deepEqual(item!.remembers, ["You're waiting on Dana, and Dana is in tomorrow's meeting."]);
  assert.deepEqual(item!.evidence.map((e) => [e.authority, e.kind, e.ref]), [['GMAIL', 'THREAD', 't-dana'], ['CALENDAR', 'EVENT', 'ev-review']]);
  assert.deepEqual(item!.related.map((r) => [r.kind, r.label, r.verified]), [['CORRESPONDENT', 'Dana', true]]);
  assert.equal(item!.related.some((r) => r.kind === 'PARTY'), false, 'an attendee is never matched to a Party');
  assert.equal(JSON.stringify(item).includes('dana@acme.test'), false, 'the address appears nowhere in the item');
  const stored = w.fake.workEvent.__rows.find((r: any) => r.eventId === 'ev-review');
  assert.deepEqual(stored.attendeeHashes, [hash('lee@other.test'), hash('dana@acme.test')], 'keys are stored');
  assert.equal(JSON.stringify(w.fake.workEvent.__rows).includes('@'), false, 'no address is');
});

test('D2b. the day is the person’s own day, and a correspondent without a name is never named by their address', async () => {
  const w = world();
  const matt = await person(w, ORG_A);
  await new WorkPreferencesRepository(w.prisma).set(matt, { timeZone: 'America/Los_Angeles' });
  await outbound(w, matt, 't-kim', 'kim@brand.test', ago(3 * 24 * H), 'Brief', null);
  // 05:00 UTC on the 21st is tomorrow in UTC, but still the 20th -- today -- in Los Angeles.
  await w.graph.upsertEvent(matt, meeting('ev-late', new Date('2026-09-21T05:00:00Z'), { attendeeHashes: [hash('kim@brand.test')] }));
  await read(w, matt);
  const [item] = await personalIntelligence(w.prisma, matt, NOW);
  assert.deepEqual(item!.remembers, ["You're waiting on someone on this conversation, and they are in today's meeting."]);
  assert.deepEqual(item!.related.map((r) => [r.kind, r.label]), [['CORRESPONDENT', null]]);
  assert.equal(JSON.stringify(item).includes('kim@brand.test'), false);
});

test('D2c. one person’s calendar never joins another person’s mail, even for the same attendee', async () => {
  const w = world();
  const matt = await person(w, ORG_A, 'OWNER', 'Matt');
  const charlie = await person(w, ORG_A, 'OWNER', 'Charlie');
  await outbound(w, matt, 't-dana', 'dana@acme.test', ago(3 * 24 * H), 'Proposal', 'Dana');
  await w.graph.upsertEvent(charlie, meeting('ev-charlie', new Date(NOW.getTime() + 20 * H), { summary: 'CHARLIE-ONLY meeting', attendeeHashes: [hash('dana@acme.test')] }));
  await read(w, matt);
  const [item] = await personalIntelligence(w.prisma, matt, NOW);
  assert.equal(item!.evidence.some((e) => e.authority === 'CALENDAR'), false, 'Charlie’s meeting is not Matt’s evidence');
  assert.equal(JSON.stringify(item).includes('CHARLIE-ONLY'), false);
  assert.deepEqual(await personalIntelligence(w.prisma, charlie, NOW), [], 'and Matt’s mail raises nothing for Charlie');
});

test('D1/D2 offboarding: ending a membership erases the person’s attendee keys and every suggestion from their mail', async () => {
  const w = world();
  const matt = await person(w, ORG_A, 'OWNER', 'Matt');
  const charlie = await person(w, ORG_A, 'OWNER', 'Charlie');
  await danaAtAcme(w, matt);
  for (const who of [matt, charlie]) {
    await inbound(w, who, 't-dana', 'dana@acme.test', ago(3 * H), 'Renewal', 'Dana');
    await w.graph.upsertEvent(who, meeting('ev', new Date(NOW.getTime() + 20 * H), { attendeeHashes: [hash('dana@acme.test')] }));
    await read(w, who);
  }
  const [theirs] = await w.suggestions.forOwner(charlie);
  assert.equal((await w.decisions.reject(charlie, theirs!.id, 'not the Dana I know')).outcome, 'REJECTED');
  const [mine] = await w.suggestions.forOwner(matt);
  assert.equal((await w.decisions.confirm(matt, mine!.id)).outcome, 'CONFIRMED');
  const organizationIdentifiers = w.fake.identityEvidence.__rows.length;

  await w.iam.removeMember(ORG_A, charlie.userId, { userId: matt.userId });
  assert.equal(w.fake.workEvent.__rows.filter((r: any) => r.userId === charlie.userId).length, 0, 'their attendee keys went with their events');
  assert.equal(w.fake.intelligenceHypothesis.__rows.filter((r: any) => r.privateToUserId === charlie.userId).length, 0, 'every suggestion from their mail is gone, rejected ones included');
  assert.equal(w.fake.workEvent.__rows.filter((r: any) => r.userId === matt.userId).length, 1, 'a colleague keeps theirs');
  assert.deepEqual((await w.suggestions.forOwner(matt)).map((s) => s.status), ['CONFIRMED']);
  assert.equal(w.fake.identityEvidence.__rows.length, organizationIdentifiers, 'the organization’s identifier records are not a person’s data');
  const erased = w.fake.auditLog.__rows.find((a: any) => a.action === 'work_state.erased');
  assert.equal(erased.metadata.privateSuggestions, 1);
  assert.equal(erased.metadata.erased.work_events, 1);
});

// --- Creator contract: relevance only as the owning authority's evidence -------------------------

test('creator contract: relevance is accepted only as Creator Hub evidence; without it no fit is claimed', async () => {
  const w = world();
  const matt = await person(w, ORG_A);
  const { brand } = await brandWithContact(w, matt, 'Glow Cosmetics', 'Rita Reyes');
  const deps = { relationships: new CrmRelationshipReadModelRepository(w.prisma), parties: new PartyReadModelRepository(w.prisma), cases: w.engine };

  const ava = await establish(w, matt, 'PERSON', 'Ava Creator');
  await reviewOnboardedCreator(ORG_A, { creatorPartyId: ava, relationshipId: null, eventId: 'e-ava' }, deps, NOW);
  const plain = (await creatorCases(w, ORG_A)).find((c) => c.title.startsWith('Ava Creator'))!;
  assert.doesNotMatch(plain.summary ?? '', /Creator Hub|fit|relevan|audience|categor/i, 'nothing owns creator context today, so nothing claims a fit');

  // Standing in for the future Creator Hub: its statement and its records are cited as its own.
  const hub: CreatorRelevanceSource = {
    async relevanceFor(_organizationId, _creatorPartyId, brandPartyIds) {
      return [
        {
          brandPartyId: brandPartyIds[0]!,
          statement: 'Beauty creator; audience overlap with Glow is 62% (audience report).',
          refs: [
            { authority: 'CREATOR_HUB', kind: 'AUDIENCE_OVERLAP', ref: 'report-1', label: 'Audience overlap', observedAt: NOW },
            { authority: 'LOOP', kind: 'GUESS', ref: 'loop-guess', label: 'not the owning authority', observedAt: null },
          ],
        },
      ];
    },
  };
  const bea = await establish(w, matt, 'PERSON', 'Bea Creator');
  await reviewOnboardedCreator(ORG_A, { creatorPartyId: bea, relationshipId: null, eventId: 'e-bea' }, { ...deps, relevance: hub }, NOW);
  const cited = (await creatorCases(w, ORG_A)).find((c) => c.title.startsWith('Bea Creator'))!;
  assert.match(cited.summary ?? '', /Glow Cosmetics: EMG has an active client relationship\. Known contact: Rita Reyes \(primary contact\)\. Creator Hub: Beauty creator; audience overlap with Glow is 62%/);
  const item = await caseIntelligence(w.engine, ORG_A, cited.id);
  assert.deepEqual(item!.evidence.filter((e) => e.authority === 'CREATOR_HUB').map((e) => e.ref), ['report-1']);
  assert.equal(item!.evidence.some((e) => e.ref === 'loop-guess'), false, 'relevance from anything but its owning authority is dropped');
  assert.equal(item!.related.find((r) => r.kind === 'BRAND')!.ref, brand);
});

test('D1f. without the configured identifier key the detector compares nothing, and says so', async () => {
  const w = world();
  const matt = await person(w, ORG_A, 'OWNER', 'Matt');
  await danaAtAcme(w, matt);
  await inbound(w, matt, 't-dana', 'dana@acme.test', ago(3 * H), 'Renewal terms', 'Dana');
  const configured = process.env.COGNITIVE_HASH_SECRET;
  delete process.env.COGNITIVE_HASH_SECRET;
  try {
    const counts = countsOf(await read(w, matt), 'identity-suggestions');
    assert.equal(counts.keyUnavailable, 1, 'a fallback key could never match real evidence: it refuses rather than finds nothing');
    assert.equal(counts.checked, 0);
    assert.equal((await w.suggestions.forOwner(matt)).length, 0);
  } finally {
    process.env.COGNITIVE_HASH_SECRET = configured;
  }
});
