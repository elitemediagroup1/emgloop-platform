// The People command center's pure contract (CRM slice 6): the cadence, message qualification, the
// outreach derivation (facts, derived state and human interpretation kept apart), text rules, the
// directory filters/presets/summary/paging, and Possible New People decisions.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CRM_HUMAN_CONVERSATION_STATES,
  CRM_OUTREACH_ACT_ROLES,
  CRM_REDACTED_CONTACT_VALUE,
  EMPTY_CRM_PEOPLE_FILTERS,
  computeCrmCadence,
  compareCrmPeopleRows,
  crmCadenceDueAt,
  crmCadenceStage,
  crmCadenceTouch,
  crmCadenceTouchLabel,
  crmDiscoveryProposedName,
  crmDueBucket,
  crmInternalDomains,
  crmOutreachActPermitted,
  crmPeopleHref,
  decideCrmDiscovery,
  deriveCrmOutreach,
  isCrmHumanConversationState,
  pageCrmPeople,
  parseCrmPeopleFilters,
  qualifyCrmMessage,
  redactCrmContactValues,
  summarizeCrmPeople,
  validateCrmOutreachText,
  type CrmOutreachInput,
  type CrmPeopleRow,
} from '../src/index';

const D = (iso: string) => new Date(iso);
const DAY = 86_400_000;
const NOW = D('2026-10-08T15:00:00Z');
const FRESH = { state: 'FRESH' as const, observedFrom: D('2026-09-01T00:00:00Z'), observedThrough: D('2026-10-08T14:45:00Z') };

function input(over: Partial<CrmOutreachInput> = {}): CrmOutreachInput {
  return { mail: FRESH, sends: [], humanReplies: [], automated: [], uncertain: [], importedLastContact: null, human: null, nextMeetingAt: null, now: NOW, timeZone: 'UTC', ...over };
}

// --- Grants ------------------------------------------------------------------------------------

test('the act table: every human role views; EMPLOYEE+ sets state, next action and notes; OWNER/ADMIN retract and backfill; AI_EMPLOYEE and CREATOR nothing', () => {
  for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY']) assert.equal(crmOutreachActPermitted({ act: 'VIEW', role, actorType: 'HUMAN' }), true, role);
  assert.equal(crmOutreachActPermitted({ act: 'SET_STATE', role: 'READ_ONLY', actorType: 'HUMAN' }), false);
  assert.equal(crmOutreachActPermitted({ act: 'SET_STATE', role: 'EMPLOYEE', actorType: 'HUMAN' }), true);
  assert.equal(crmOutreachActPermitted({ act: 'BACKFILL_CONTEXT', role: 'MANAGER', actorType: 'HUMAN' }), false);
  assert.equal(crmOutreachActPermitted({ act: 'BACKFILL_CONTEXT', role: 'OWNER', actorType: 'HUMAN' }), true);
  for (const act of Object.keys(CRM_OUTREACH_ACT_ROLES)) {
    assert.equal(crmOutreachActPermitted({ act, role: 'AI_EMPLOYEE', actorType: 'HUMAN' }), false, act);
    assert.equal(crmOutreachActPermitted({ act, role: 'CREATOR', actorType: 'HUMAN' }), false, act);
    assert.equal(crmOutreachActPermitted({ act, role: 'OWNER', actorType: 'AI_AGENT' }), false, act);
  }
  assert.equal(crmOutreachActPermitted({ act: 'SOMETHING_ELSE', role: 'OWNER', actorType: 'HUMAN' }), false);
});

test('a person can set only interpretation states, never a fact-derived one', () => {
  for (const s of ['NO_OUTREACH', 'AWAITING_REPLY', 'REPLIED_NEEDS_RESPONSE', 'REVIEW_REQUIRED', 'UNKNOWN']) assert.equal(isCrmHumanConversationState(s), false, s);
  for (const s of CRM_HUMAN_CONVERSATION_STATES) assert.equal(isCrmHumanConversationState(s), true, s);
});

// --- Cadence -----------------------------------------------------------------------------------

test('the locked cadence: Initial, 3-day x3, 7-day x3, 14-day x3, then monthly forever', () => {
  const touches = Array.from({ length: 13 }, (_, i) => crmCadenceTouch(i));
  assert.deepEqual(touches, [
    'INITIAL', 'THREE_DAY_1', 'THREE_DAY_2', 'THREE_DAY_3', 'SEVEN_DAY_1', 'SEVEN_DAY_2', 'SEVEN_DAY_3',
    'FOURTEEN_DAY_1', 'FOURTEEN_DAY_2', 'FOURTEEN_DAY_3', 'MONTHLY', 'MONTHLY', 'MONTHLY',
  ]);
  assert.deepEqual([1, 3, 4, 6, 7, 9, 10].map((i) => crmCadenceStage(crmCadenceTouch(i))), ['THREE_DAY', 'THREE_DAY', 'SEVEN_DAY', 'SEVEN_DAY', 'FOURTEEN_DAY', 'FOURTEEN_DAY', 'MONTHLY']);
  assert.deepEqual([0, 1, 4, 7, 10, 12].map(crmCadenceTouchLabel), ['Initial outreach', '3-day #1', '7-day #1', '14-day #1', 'Monthly #1', 'Monthly #3']);
  const t = D('2026-01-31T15:04:00Z');
  assert.equal(crmCadenceDueAt(t, 1).getTime() - t.getTime(), 3 * DAY);
  assert.equal(crmCadenceDueAt(t, 3).getTime() - t.getTime(), 3 * DAY);
  assert.equal(crmCadenceDueAt(t, 4).getTime() - t.getTime(), 7 * DAY);
  assert.equal(crmCadenceDueAt(t, 9).getTime() - t.getTime(), 14 * DAY);
  // A month from Jan 31 is the last day of February, same time.
  assert.equal(crmCadenceDueAt(t, 10).toISOString(), '2026-02-28T15:04:00.000Z');
});

test('each interval runs from the ACTUAL previous send, not from when it was due', () => {
  const initial = D('2026-09-01T10:00:00Z');
  const lateFollowUp = D('2026-09-09T17:30:00Z'); // due Sep 4, sent five days late
  const c = computeCrmCadence({ sends: [lateFollowUp, initial], humanReplies: [] });
  assert.equal(c.status, 'ACTIVE');
  assert.equal(c.sends, 2);
  assert.equal(c.nextTouch, 'THREE_DAY_2');
  assert.equal(c.nextDueAt!.toISOString(), '2026-09-12T17:30:00.000Z');
});

test('a human reply after the first send stops the cadence; one before it does not', () => {
  const sends = [D('2026-09-01T10:00:00Z'), D('2026-09-04T10:00:00Z')];
  assert.equal(computeCrmCadence({ sends, humanReplies: [D('2026-09-05T08:00:00Z')] }).status, 'STOPPED');
  assert.equal(computeCrmCadence({ sends, humanReplies: [D('2026-08-20T08:00:00Z')] }).status, 'ACTIVE');
  assert.equal(computeCrmCadence({ sends: [], humanReplies: [] }).status, 'NOT_STARTED');
});

test('due buckets follow the viewer’s calendar day', () => {
  assert.equal(crmDueBucket(D('2026-10-07T23:00:00Z'), NOW, 'UTC'), 'OVERDUE');
  assert.equal(crmDueBucket(D('2026-10-08T23:00:00Z'), NOW, 'UTC'), 'TODAY');
  assert.equal(crmDueBucket(D('2026-10-09T01:00:00Z'), NOW, 'UTC'), 'UPCOMING');
  // 01:00Z on the 9th is still the 8th in New York.
  assert.equal(crmDueBucket(D('2026-10-09T01:00:00Z'), NOW, 'America/New_York'), 'TODAY');
  assert.equal(crmDueBucket(null, NOW, 'UTC'), 'NONE');
});

// --- Qualification -----------------------------------------------------------------------------

test('a qualifying send: sent by the viewer, the person in To, not a draft, spam or trash', () => {
  assert.equal(qualifyCrmMessage({ direction: 'OUTBOUND', labels: ['SENT'], subject: 'Hello', personInTo: true }), 'QUALIFYING_SEND');
  assert.equal(qualifyCrmMessage({ direction: 'OUTBOUND', labels: ['SENT'], subject: 'Hello', personInTo: false }), 'NOT_OUTREACH');
  assert.equal(qualifyCrmMessage({ direction: 'OUTBOUND', labels: ['DRAFT'], subject: 'Hello', personInTo: true }), 'NOT_OUTREACH');
  assert.equal(qualifyCrmMessage({ direction: 'OUTBOUND', labels: ['TRASH'], subject: 'Hello', personInTo: true }), 'NOT_OUTREACH');
});

test('bounces, out-of-office, delivery/read receipts and normalized automation headers are never a reply; a bulk tab is UNCERTAIN', () => {
  const inbound = (subject: string | null, labels: string[] = ['INBOX'], senderAddress = 'jane@brand.example') => qualifyCrmMessage({ direction: 'INBOUND', labels, subject, senderAddress });
  for (const s of ['Automatic reply: Partnership', 'Out of Office: back Monday', 'OOO until 10/12', 'Undeliverable: Hello', 'Delivery Status Notification (Failure)', 'Read: Proposal', 'Auto: away', 'Mail delivery failed: returning message']) {
    assert.equal(inbound(s), 'AUTOMATED', s);
  }
  assert.equal(inbound('Hello', ['INBOX'], 'mailer-daemon@brand.example'), 'AUTOMATED');
  assert.equal(inbound('Hello', ['INBOX'], 'no-reply@brand.example'), 'AUTOMATED');
  assert.equal(inbound('Hello', ['SPAM']), 'AUTOMATED');
  assert.equal(qualifyCrmMessage({ direction: 'INBOUND', labels: ['INBOX'], subject: 'Re: Partnership', senderAddress: 'jane@brand.example', automationClass: 'AUTO_SUBMITTED' }), 'AUTOMATED', 'ordinary-subject OOO from Auto-Submitted does not stop cadence');
  assert.equal(qualifyCrmMessage({ direction: 'INBOUND', labels: ['INBOX'], subject: 'Partnership news', senderAddress: 'jane@brand.example', automationClass: 'MAILING_LIST' }), 'AUTOMATED');
  assert.equal(qualifyCrmMessage({ direction: 'INBOUND', labels: ['INBOX'], subject: 'Partnership update', senderAddress: 'jane@brand.example', automationClass: 'BULK' }), 'AUTOMATED');
  assert.equal(inbound('Re: Partnership', ['CATEGORY_UPDATES']), 'UNCERTAIN');
  // A human writing about an out-of-office is still a human.
  assert.equal(inbound('Re: out of office plans for the shoot'), 'HUMAN_REPLY');
  assert.equal(inbound(null), 'HUMAN_REPLY');
});

// --- Derivation --------------------------------------------------------------------------------

test('no reply: AWAITING_REPLY with the cadence as the next action, and "no reply observed" only through a completed read', () => {
  const sent = D('2026-10-01T09:00:00Z');
  const d = deriveCrmOutreach(input({ sends: [sent] }));
  assert.equal(d.state, 'AWAITING_REPLY');
  assert.equal(d.basis, 'GMAIL');
  assert.equal(d.replyStatus, 'NO_REPLY_OBSERVED');
  assert.equal(d.nextAction.kind, 'CADENCE');
  assert.equal(d.nextAction.label, 'Follow up: 3-day #1');
  assert.equal(d.nextAction.dueAt!.toISOString(), '2026-10-04T09:00:00.000Z');
  assert.equal(d.nextAction.bucket, 'OVERDUE');
  const stale = deriveCrmOutreach(input({ sends: [sent], mail: { state: 'STALE', observedFrom: null, observedThrough: D('2026-10-02T00:00:00Z') } }));
  assert.equal(stale.replyStatus, 'NO_REPLY_OBSERVED', 'true through the last read; the surface states that time and that it is stale');
});

test('a genuine reply stops the cadence and asks for a response; an automated one does not', () => {
  const sent = D('2026-10-01T09:00:00Z');
  const replied = deriveCrmOutreach(input({ sends: [sent], humanReplies: [D('2026-10-07T12:00:00Z')] }));
  assert.equal(replied.state, 'REPLIED_NEEDS_RESPONSE');
  assert.equal(replied.cadence.status, 'STOPPED');
  assert.equal(replied.nextAction.kind, 'RESPOND');
  assert.equal(replied.replyStatus, 'AWAITING_OUR_RESPONSE');
  const ooo = deriveCrmOutreach(input({ sends: [sent], automated: [D('2026-10-01T09:01:00Z')] }));
  assert.equal(ooo.state, 'AWAITING_REPLY');
  assert.equal(ooo.cadence.status, 'ACTIVE');
});

test('answered replies are an ACTIVE_CONVERSATION with no invented next action', () => {
  const d = deriveCrmOutreach(input({ sends: [D('2026-10-01T09:00:00Z'), D('2026-10-03T09:00:00Z')], humanReplies: [D('2026-10-02T09:00:00Z')] }));
  assert.equal(d.state, 'ACTIVE_CONVERSATION');
  assert.equal(d.replyStatus, 'REPLIED');
  assert.equal(d.nextAction.kind, 'NONE');
});

test('an UNCERTAIN inbound is REVIEW_REQUIRED, never a reply', () => {
  const d = deriveCrmOutreach(input({ sends: [D('2026-10-01T09:00:00Z')], uncertain: [D('2026-10-02T09:00:00Z')] }));
  assert.equal(d.state, 'REVIEW_REQUIRED');
  assert.equal(d.reviewReason, 'UNCERTAIN_INBOUND');
  assert.equal(d.replyStatus, 'NO_REPLY_OBSERVED');
});

test('a human state wins over derived facts -- until a newer reply arrives -- and stops the cadence', () => {
  const setAt = D('2026-10-05T09:00:00Z');
  const human = { state: 'ON_HOLD' as const, stateSetAt: setAt, nextAction: 'Circle back after the holidays', nextActionDueAt: D('2026-11-01T00:00:00Z') };
  const held = deriveCrmOutreach(input({ sends: [D('2026-10-01T09:00:00Z')], human }));
  assert.equal(held.state, 'ON_HOLD');
  assert.equal(held.basis, 'HUMAN');
  assert.equal(held.cadence.status, 'STOPPED');
  assert.equal(held.cadence.stoppedBy, 'HUMAN_STATE');
  assert.equal(held.nextAction.kind, 'HUMAN');
  assert.equal(held.nextAction.label, 'Circle back after the holidays');
  const newer = deriveCrmOutreach(input({ sends: [D('2026-10-01T09:00:00Z')], humanReplies: [D('2026-10-06T09:00:00Z')], human }));
  assert.equal(newer.state, 'REPLIED_NEEDS_RESPONSE');
  assert.equal(newer.humanState, 'ON_HOLD', 'the interpretation is kept beside the fact, not erased');
  const older = deriveCrmOutreach(input({ sends: [D('2026-10-01T09:00:00Z')], humanReplies: [D('2026-10-02T09:00:00Z')], human }));
  assert.equal(older.state, 'ON_HOLD');
});

test('INTERESTED appears only when a person set it: no rule derives it from mail', () => {
  const many = deriveCrmOutreach(input({ sends: [D('2026-10-01T09:00:00Z')], humanReplies: [D('2026-10-02T09:00:00Z'), D('2026-10-03T09:00:00Z')] }));
  assert.notEqual(many.state, 'INTERESTED');
});

test('a meeting on the viewer’s calendar is MEETING_SCHEDULED, with the meeting as the next action', () => {
  const at = D('2026-10-10T16:00:00Z');
  const d = deriveCrmOutreach(input({ sends: [D('2026-10-01T09:00:00Z')], nextMeetingAt: at }));
  assert.equal(d.state, 'MEETING_SCHEDULED');
  assert.equal(d.basis, 'CALENDAR');
  assert.equal(d.nextAction.kind, 'MEETING');
  assert.equal(d.nextAction.dueAt!.getTime(), at.getTime());
});

test('imported history alone is REVIEW_REQUIRED with an UNKNOWN cadence position -- never a guessed step', () => {
  const d = deriveCrmOutreach(input({ importedLastContact: { at: D('2026-09-20T00:00:00Z'), precision: 'DATE' } }));
  assert.equal(d.state, 'REVIEW_REQUIRED');
  assert.equal(d.reviewReason, 'IMPORTED_HISTORY_ONLY');
  assert.equal(d.basis, 'IMPORT');
  assert.equal(d.cadence.status, 'UNKNOWN');
  assert.equal(d.nextAction.dueAt, null);
  assert.deepEqual(d.lastTouch, { at: D('2026-09-20T00:00:00Z'), source: 'IMPORT', precision: 'DATE' });
});

test('Gmail is stronger than the import where the thread is present', () => {
  const d = deriveCrmOutreach(input({ sends: [D('2026-10-01T09:00:00Z')], importedLastContact: { at: D('2026-09-20T00:00:00Z'), precision: 'DATE' } }));
  assert.equal(d.state, 'AWAITING_REPLY');
  assert.equal(d.lastTouch!.source, 'GMAIL');
});

test('unreadable mail is UNKNOWN, never NO_OUTREACH; readable and empty is NO_OUTREACH', () => {
  assert.equal(deriveCrmOutreach(input({ mail: { state: 'UNAVAILABLE' }, sends: [D('2026-10-01T09:00:00Z')] })).state, 'UNKNOWN');
  assert.equal(deriveCrmOutreach(input({ mail: { state: 'UNAVAILABLE' } })).replyStatus, 'UNKNOWN');
  assert.equal(deriveCrmOutreach(input()).state, 'NO_OUTREACH');
});

// --- Text --------------------------------------------------------------------------------------

test('typed next actions and notes refuse contact values; imported text has them redacted and counted', () => {
  assert.deepEqual(validateCrmOutreachText('Email jane@brand.example on Monday', 200), { ok: false, violation: 'CARRIES_CONTACT_VALUE' });
  assert.deepEqual(validateCrmOutreachText('Call +1 (415) 555-0100', 200), { ok: false, violation: 'CARRIES_CONTACT_VALUE' });
  assert.deepEqual(validateCrmOutreachText('Follow up on 2026-10-12 about rates', 200), { ok: true, value: 'Follow up on 2026-10-12 about rates' });
  assert.deepEqual(validateCrmOutreachText('  ', 200), { ok: false, violation: 'EMPTY' });
  assert.deepEqual(validateCrmOutreachText('x'.repeat(201), 200), { ok: false, violation: 'TOO_LONG' });
  const r = redactCrmContactValues('Spoke 2026-09-01; reach Jane at jane@brand.example or 415.555.0100, budget 5k');
  assert.equal(r.redactions, 2);
  assert.equal(r.value, `Spoke 2026-09-01; reach Jane at ${CRM_REDACTED_CONTACT_VALUE} or ${CRM_REDACTED_CONTACT_VALUE}, budget 5k`);
  assert.equal(validateCrmOutreachText(r.value, 2000).ok, true, 'what is stored would pass the operator rule');
});

// --- Directory ---------------------------------------------------------------------------------

function row(id: string, over: Partial<CrmPeopleRow> & { o?: Partial<CrmOutreachInput> } = {}): CrmPeopleRow {
  const { o, ...rest } = over;
  return {
    partyId: id,
    displayName: `Person ${id}`,
    establishedAt: D('2026-10-01T00:00:00Z'),
    title: null,
    company: null,
    creator: null,
    origin: 'IMPORTED',
    latestNote: null,
    sourceStatus: null,
    outreach: deriveCrmOutreach(input(o)),
    workedByUserId: null,
    humanStateSetAt: null,
    nextMeetingAt: o?.nextMeetingAt ?? null,
    lastHumanReplyAt: o?.humanReplies?.[0] ?? null,
    ...rest,
  };
}

const ROWS: CrmPeopleRow[] = [
  row('a', { o: { sends: [D('2026-10-01T09:00:00Z')] } }), // overdue 3-day #1
  row('b', { o: { sends: [D('2026-10-05T15:00:00Z')] } }), // due today
  row('c', { o: { sends: [D('2026-10-01T09:00:00Z')], humanReplies: [D('2026-10-07T09:00:00Z')] } }), // reply needs response
  row('d', { o: { human: { state: 'INTERESTED', stateSetAt: D('2026-10-06T00:00:00Z'), nextAction: null, nextActionDueAt: null } }, humanStateSetAt: D('2026-10-06T00:00:00Z'), workedByUserId: 'u1' }),
  row('e', { o: { human: { state: 'PASSED', stateSetAt: D('2026-10-06T00:00:00Z'), nextAction: null, nextActionDueAt: null } }, humanStateSetAt: D('2026-10-06T00:00:00Z') }),
  row('f', { o: { human: { state: 'ON_HOLD', stateSetAt: D('2026-10-06T00:00:00Z'), nextAction: null, nextActionDueAt: null } } }),
  row('g', { o: { sends: [D('2026-10-02T09:00:00Z')], nextMeetingAt: D('2026-10-10T16:00:00Z') } }),
  row('h', { origin: 'MANUAL', title: { text: 'Head of Partnerships', basis: 'IMPORTED' }, company: { partyId: 'co1', name: 'Acme Beverages' }, creator: { label: 'Kai', partyId: null } }),
  row('i', { o: { sends: Array.from({ length: 5 }, (_, k) => D(`2026-09-0${k + 1}T09:00:00Z`)) } }), // next is 7-day #2
];

test('summary counts trace to rows', () => {
  const s = summarizeCrmPeople(ROWS, NOW);
  assert.equal(s.totalPeople, 9);
  assert.equal(s.awaitingReply, 3); // a, b, i
  assert.equal(s.overdue, 3); // a, i, and c's reply waiting since yesterday
  assert.equal(s.dueToday, 1); // b
  assert.equal(s.repliesNeedingResponse, 1);
  assert.equal(s.activeOrInterested, 1);
  assert.equal(s.meetingsUpcoming, 1);
  assert.equal(s.onHold, 1);
  assert.equal(s.recentlyClosed, 1);
  assert.equal(s.activeContacts, 6); // a b c d g i
  assert.equal(s.newRepliesThisWeek, 1);
});

test('presets and filters combine (AND), are server-side and stable', () => {
  const ids = (sp: Record<string, string>) => {
    const p = parseCrmPeopleFilters(sp);
    assert.equal(p.ok, true);
    return pageCrmPeople(ROWS, p.ok ? p.filters : EMPTY_CRM_PEOPLE_FILTERS, 1, NOW).rows.map((r) => r.partyId);
  };
  assert.deepEqual(ids({ preset: 'overdue' }), ['i', 'a', 'c'], 'a reply unanswered since yesterday is overdue too');
  assert.deepEqual(ids({ preset: 'needs-follow-up-today' }), ['b']);
  assert.deepEqual(ids({ preset: 'replied-needs-response' }), ['c']);
  assert.deepEqual(ids({ preset: 'interested' }), ['d']);
  assert.deepEqual(ids({ preset: 'passed' }), ['e']);
  assert.deepEqual(ids({ preset: 'on-hold' }), ['f']);
  assert.deepEqual(ids({ preset: 'meetings-this-week' }), ['g']);
  assert.deepEqual(ids({ preset: 'three-day' }).sort(), ['a', 'b']);
  assert.deepEqual(ids({ preset: 'seven-day' }), ['i']);
  assert.deepEqual(ids({ preset: 'no-reply' }).sort(), ['a', 'b', 'i']);
  assert.deepEqual(ids({ q: 'acme' }), ['h']);
  assert.deepEqual(ids({ q: 'partnerships' }), ['h']);
  assert.deepEqual(ids({ title: 'head' }), ['h']);
  assert.deepEqual(ids({ company: 'co1' }), ['h']);
  assert.deepEqual(ids({ creator: 'kai' }), ['h']);
  assert.deepEqual(ids({ origin: 'manual' }), ['h']);
  assert.deepEqual(ids({ owner: 'u1' }), ['d']);
  assert.deepEqual(ids({ group: 'closed' }), ['e']);
  assert.deepEqual(ids({ preset: 'overdue', stage: 'SEVEN_DAY' }), ['i'], 'AND');
  assert.deepEqual(ids({ state: 'NOT_A_STATE' }).length, ROWS.length, 'an unknown value is dropped, not guessed');
});

test('search text shaped like a contact value is refused, never searched', () => {
  assert.equal(parseCrmPeopleFilters({ q: 'jane@brand.example' }).ok, false);
  assert.equal(parseCrmPeopleFilters({ q: '415 555 0100' }).ok, false);
  assert.equal(parseCrmPeopleFilters({ title: 'x@y.co' }).ok, false);
});

test('paging: real pages over the filtered set, a stable order, totals reported', () => {
  const many = Array.from({ length: 120 }, (_, i) => row(`p${String(i).padStart(3, '0')}`));
  const p1 = pageCrmPeople(many, EMPTY_CRM_PEOPLE_FILTERS, 1, NOW);
  const p3 = pageCrmPeople(many, EMPTY_CRM_PEOPLE_FILTERS, 3, NOW);
  assert.deepEqual([p1.rows.length, p1.pages, p1.filteredCount, p1.totalCount], [50, 3, 120, 120]);
  assert.equal(p3.rows.length, 20);
  assert.equal(pageCrmPeople(many, EMPTY_CRM_PEOPLE_FILTERS, 99, NOW).page, 3, 'past the end is the last page');
  const again = pageCrmPeople([...many].reverse(), EMPTY_CRM_PEOPLE_FILTERS, 1, NOW);
  assert.deepEqual(again.rows.map((r) => r.partyId), p1.rows.map((r) => r.partyId), 'order does not depend on input order');
  assert.ok(compareCrmPeopleRows(ROWS[0]!, ROWS[7]!) < 0, 'overdue before undated');
  assert.equal(crmPeopleHref('/app/crm/people', { preset: 'overdue', q: 'acme' }, 2), '/app/crm/people?q=acme&preset=overdue&page=2');
});

// --- Possible New People -----------------------------------------------------------------------

const CTX = { ownAddresses: new Set(['matt@emg.example']), memberAddresses: new Set(['charlie@emg.example', 'pat@gmail.com']), internalDomains: crmInternalDomains(['charlie@emg.example', 'pat@gmail.com']), inCrm: false, dismissed: false };
const FACTS = { address: 'jane@brand.example', domain: 'brand.example', directSends: 2, humanInbound: 1, nonHumanInbound: 0, suppressed: false };

test('discovery surfaces a real two-way contact with its reasons', () => {
  assert.deepEqual(decideCrmDiscovery(FACTS, CTX), { surfaced: true, reasons: ['YOU_EMAILED_THEM', 'THEY_REPLIED'] });
  assert.deepEqual(decideCrmDiscovery({ ...FACTS, humanInbound: 0 }, CTX), { surfaced: true, reasons: ['YOU_EMAILED_THEM'] });
});

test('discovery excludes own, internal, existing, dismissed, suppressed, automated and list/role addresses while allowing a human inbound-first contact', () => {
  const ex = (f: Partial<typeof FACTS>, c: Partial<typeof CTX> = {}) => {
    const d = decideCrmDiscovery({ ...FACTS, ...f }, { ...CTX, ...c });
    return d.surfaced ? 'SURFACED' : d.exclusion;
  };
  assert.equal(ex({ address: 'Matt@EMG.example' }), 'OWN_ADDRESS');
  assert.equal(ex({ address: 'charlie@emg.example' }), 'INTERNAL');
  assert.equal(ex({ address: 'someone@emg.example', domain: 'emg.example' }), 'INTERNAL');
  assert.equal(ex({ address: 'friend@gmail.com', domain: 'gmail.com' }), 'SURFACED', 'a colleague on gmail.com does not make gmail.com internal');
  assert.equal(ex({}, { inCrm: true }), 'ALREADY_IN_CRM');
  assert.equal(ex({}, { dismissed: true }), 'DISMISSED');
  assert.equal(ex({ suppressed: true }), 'SUPPRESSED');
  assert.equal(ex({ address: 'no-reply@brand.example' }), 'AUTOMATED_SENDER');
  assert.equal(ex({ address: 'info@brand.example' }), 'ROLE_OR_LIST_MAILBOX');
  assert.equal(ex({ address: 'team-request@brand.example' }), 'ROLE_OR_LIST_MAILBOX');
  assert.equal(ex({ directSends: 0, humanInbound: 1 }), 'SURFACED', 'a legitimate human inbound is reviewable before we reply');
  assert.deepEqual(decideCrmDiscovery({ ...FACTS, directSends: 0, humanInbound: 1 }, CTX), { surfaced: true, reasons: ['THEY_CONTACTED_YOU'] });
  assert.equal(ex({ directSends: 0, humanInbound: 0, nonHumanInbound: 0 }), 'NO_DIRECT_EXCHANGE');
  assert.equal(ex({ directSends: 0, humanInbound: 0, nonHumanInbound: 3 }), 'ONLY_AUTOMATED_MAIL');
});

test('a proposed name comes from the display name the mail carried -- never from the address', () => {
  assert.equal(crmDiscoveryProposedName('"Jane Doe"'), 'Jane Doe');
  assert.equal(crmDiscoveryProposedName('jane@brand.example'), null);
  assert.equal(crmDiscoveryProposedName(null), null);
  assert.equal(crmDiscoveryProposedName('A'), null);
});
