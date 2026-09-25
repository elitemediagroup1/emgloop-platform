// Chats v5 (Loop Intelligence Phase B, 2026-09-26): what needs whom, from the viewer's own items and
// digests only.
//
//   - who owes it decides the group: the person (Needs your attention), someone in a GROUP chat (Needs
//     team attention, named only by Telegram's label), the other side of a private chat (Waiting on
//     others) -- and nothing others owe is counted as something the person owes;
//   - Loop's own arithmetic: "no reply from you since", and gone quiet after CHATS_QUIET_DAYS;
//   - typed signals land where their kind says (decisions pending, open, stalled, developments);
//   - an ITEM carries the person's own actions and a content-free evidence drill-down; a SIGNAL does not;
//   - no invented assignment: no Loop user, no role and no "team" is ever named -- only source labels.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTimeView, type DigestContent, type IntelligenceSignal } from '@emgloop/shared';

import {
  CHATS_QUIET_DAYS,
  composeChatsIntelligence,
  type ChatsConnection,
  type ChatsDigest,
  type ChatsIntelligenceInput,
  type ChatsItem,
} from '../src/daily-loop/chats-intelligence';
import { ChatsView } from '../src/app/app/chats/_chats/chats-view';

const NOW = new Date('2026-09-26T16:00:00Z');
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const time = createTimeView({ timeZone: 'America/New_York', source: 'device' }, NOW);
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const READY: ChatsConnection = { configured: true, state: 'READY', label: 'Ready', contentAuthorized: true };

function item(over: Partial<ChatsItem> = {}): ChatsItem {
  return {
    provider: 'TELEGRAM',
    category: 'REQUEST',
    counterparty: 'Premier Buyers',
    topic: 'allocation',
    title: 'Premier asked for the revised allocation',
    nextStep: 'Send Premier the revised allocation',
    deadline: null,
    at: ago(2 * H),
    conversationKey: 'ck_premier',
    id: 'wi_1',
    lane: 'NEEDS_YOU',
    owedBy: 'VIEWER',
    who: null,
    repliedAfter: false,
    conversationKind: 'PRIVATE',
    ...over,
  };
}

const sig = (over: Partial<IntelligenceSignal> & Record<string, unknown>): IntelligenceSignal =>
  ({ key: 'k', kind: 'CHANGE', knowledge: 'INFERRED', statement: 'x', evidenceRefs: ['telegram_message:m1'], severity: 'MEDIUM', ...over }) as IntelligenceSignal;

function digest(ref: string, content: DigestContent, over: Partial<ChatsDigest> = {}): ChatsDigest {
  return {
    subjectRef: `telegram_conversation:${ref}`,
    content: { relevance: 'BUSINESS', synthesis: 'Something is happening.', confidence: 'MEDIUM', ...content },
    coverage: 'CONNECTED_SUFFICIENT',
    status: 'CURRENT',
    windowEnd: ago(H),
    expiresAt: new Date(NOW.getTime() + 25 * D),
    generatedAt: ago(H),
    lastEvidenceAt: ago(H),
    evidenceCount: 6,
    ...over,
  };
}

const input = (over: Partial<ChatsIntelligenceInput> = {}): ChatsIntelligenceInput => ({
  connection: READY,
  digests: [],
  items: [],
  activity24h: null,
  activity7d: null,
  latestActivity: new Map(),
  now: NOW,
  ...over,
});

const groupOf = (intel: ReturnType<typeof composeChatsIntelligence>, key: string) => intel.groups.find((g) => g.key === key);

describe('who owes it decides the group -- and nothing others owe is counted as the person\'s', () => {
  it('VIEWER -> Needs your attention; OTHER in a group -> Needs team attention (Telegram\'s label); OTHER in a private chat -> Waiting on others', () => {
    const intel = composeChatsIntelligence(
      input({
        digests: [digest('ck_premier', { label: 'Premier Buyers' }), digest('ck_crew', { label: 'Ops Crew' }), digest('ck_dana', { label: 'Dana Reyes' })],
        items: [
          item(),
          item({ id: 'wi_2', lane: 'WAITING_ON_THEM', owedBy: 'OTHER', who: 'Charlie', conversationKind: 'GROUP', conversationKey: 'ck_crew', counterparty: 'Ops Crew', title: 'Charlie said he would fix the tracking numbers' }),
          item({ id: 'wi_3', lane: 'WAITING_ON_THEM', owedBy: 'OTHER', who: 'Dana Reyes', conversationKind: 'PRIVATE', conversationKey: 'ck_dana', counterparty: 'Dana Reyes', title: 'Dana will send the signed contract' }),
        ],
      }),
    );
    assert.deepEqual(groupOf(intel, 'YOU')!.entries.map((e) => e.itemId), ['wi_1']);
    const team = groupOf(intel, 'TEAM')!.entries;
    assert.deepEqual(team.map((e) => [e.itemId, e.who, e.conversation]), [['wi_2', 'Charlie', 'Ops Crew']]);
    assert.deepEqual(groupOf(intel, 'WAITING')!.entries.map((e) => [e.itemId, e.who]), [['wi_3', 'Dana Reyes']]);
    // What the person OWES is their own lane only: the headline and obligations never count others'.
    assert.equal(intel.obligations.flatMap((c) => c.items).length, 1);
    assert.match(intel.owed ?? '', /^1 conversation needs you/);
  });

  it('an item raised before v5 (no owedBy) is read as the person\'s own -- the only reading v4 had', () => {
    const intel = composeChatsIntelligence(input({ items: [item({ owedBy: null, lane: undefined, repliedAfter: null })] }));
    assert.equal(groupOf(intel, 'YOU')!.entries.length, 1);
    assert.deepEqual(groupOf(intel, 'YOU')!.entries[0]!.facts, [], 'no arithmetic without the fact');
  });
});

describe('Loop\'s own arithmetic, not the model\'s', () => {
  it('"No reply from you since" when the person wrote nothing after the ask; "You replied, but it is still open" otherwise', () => {
    const intel = composeChatsIntelligence(input({ items: [item(), item({ id: 'wi_4', repliedAfter: true, conversationKey: 'ck_x', counterparty: 'X' })] }));
    const facts = Object.fromEntries(groupOf(intel, 'YOU')!.entries.map((e) => [e.itemId, e.facts]));
    assert.deepEqual(facts.wi_1, ['No reply from you since']);
    assert.deepEqual(facts.wi_4, ['You replied, but it is still open']);
  });

  it(`gone quiet: something still open and no new message for ${CHATS_QUIET_DAYS} days; not before`, () => {
    const open = { signals: [sig({ key: 'u', kind: 'UNRESOLVED', statement: 'The pricing question has no answer' })], unresolved: ['The pricing question has no answer'] };
    const quiet = composeChatsIntelligence(input({ digests: [digest('ck_q', { ...open, label: 'Pricing chat' }, { lastEvidenceAt: ago(5 * D), windowEnd: ago(5 * D) })] }));
    const q = groupOf(quiet, 'QUIET')!.entries;
    assert.equal(q.length, 1);
    assert.deepEqual(q[0]!.facts, ['No new messages for 5 days']);
    const recent = composeChatsIntelligence(input({ digests: [digest('ck_q', { ...open, label: 'Pricing chat' }, { lastEvidenceAt: ago(1 * D) })] }));
    assert.equal(groupOf(recent, 'QUIET'), undefined, 'one day is not quiet');
    const calm = composeChatsIntelligence(input({ digests: [digest('ck_q', { label: 'Pricing chat' }, { lastEvidenceAt: ago(9 * D) })] }));
    assert.equal(groupOf(calm, 'QUIET'), undefined, 'nothing open: silence is not a finding');
  });
});

describe('typed signals land where their kind says', () => {
  it('DECISION_PENDING, UNRESOLVED, STALLED, developments at MEDIUM/HIGH only; the attention reason leads', () => {
    const d = digest('ck_p', {
      label: 'Premier Buyers',
      attention: 'Premier is waiting on the allocation before Monday',
      signals: [
        sig({ key: 'dp', kind: 'DECISION_PENDING', statement: 'Whether to lower the floor price is undecided', severity: 'HIGH' }),
        sig({ key: 'un', kind: 'UNRESOLVED', statement: 'The call-quality complaint has no answer' }),
        sig({ key: 'st', kind: 'STALLED', statement: 'The replacement-source discussion stopped' }),
        sig({ key: 'ch', kind: 'CHANGE', knowledge: 'OBSERVED', statement: 'Premier moved volume to a second vendor', severity: 'HIGH' }),
        sig({ key: 'lo', kind: 'OPERATIONAL', statement: 'A minor schedule note', severity: 'LOW' }),
      ],
    });
    const intel = composeChatsIntelligence(input({ digests: [d] }));
    assert.equal(groupOf(intel, 'DECISIONS')!.entries[0]!.statement, 'Whether to lower the floor price is undecided');
    assert.equal(groupOf(intel, 'OPEN')!.entries[0]!.statement, 'The call-quality complaint has no answer');
    assert.equal(groupOf(intel, 'QUIET')!.entries[0]!.statement, 'The replacement-source discussion stopped');
    assert.deepEqual(groupOf(intel, 'DEVELOPMENTS')!.entries.map((e) => [e.statement, e.basis]), [['Premier moved volume to a second vendor', 'OBSERVED']]);
    assert.equal(groupOf(intel, 'YOU')!.entries[0]!.statement, 'Premier is waiting on the allocation before Monday');
    for (const g of intel.groups) for (const e of g.entries) assert.equal(e.itemId, null, 'a reading is not actionable Work state');
    assert.deepEqual(intel.groups.map((g) => g.key), ['YOU', 'DECISIONS', 'OPEN', 'QUIET', 'DEVELOPMENTS'], 'fixed order, empty groups omitted');
  });

  it('an obligation the triage also raised as an item is shown once, as the item; a NOT_BUSINESS reading shows nothing', () => {
    const d = digest('ck_premier', { signals: [sig({ key: 'ob', kind: 'OBLIGATION', knowledge: 'OBSERVED', owedBy: 'VIEWER', statement: 'You said you would send the allocation' })] });
    const intel = composeChatsIntelligence(input({ digests: [d], items: [item()] }));
    assert.equal(groupOf(intel, 'YOU')!.entries.length, 1);
    assert.equal(groupOf(intel, 'YOU')!.entries[0]!.source, 'ITEM');
    const smallTalk = composeChatsIntelligence(input({ digests: [digest('ck_s', { relevance: 'NOT_BUSINESS', signals: [sig({ kind: 'DECISION_PENDING' })] })] }));
    assert.equal(smallTalk.groups.length, 0);
  });
});

describe('the page: actions on items only, a content-free drill-down, and no invented assignment', () => {
  it('renders the groups; ITEM entries carry Handled / Not now / Not mine; SIGNAL entries do not', () => {
    const intel = composeChatsIntelligence(
      input({
        digests: [digest('ck_premier', { label: 'Premier Buyers', signals: [sig({ key: 'dp', kind: 'DECISION_PENDING', statement: 'The floor price is undecided' })] })],
        items: [item(), item({ id: 'wi_2', lane: 'WAITING_ON_THEM', owedBy: 'OTHER', who: 'Charlie', conversationKind: 'GROUP', conversationKey: 'ck_crew', counterparty: 'Ops Crew', title: 'Charlie said he would fix tracking' })],
      }),
    );
    const html = renderToStaticMarkup(<ChatsView intel={intel} time={time} />);
    for (const title of ['Needs your attention', 'Needs team attention', 'Decisions pending']) assert.ok(html.includes(title), title);
    assert.ok(html.includes('Waiting on Charlie'));
    assert.ok(html.includes('No reply from you since'));
    assert.equal((html.match(/data-chats-actions/g) ?? []).length, 2, 'one action row per ITEM, none for a signal');
    assert.ok(html.includes('value="wi_1"') && html.includes('value="wi_2"'));
    assert.ok(html.includes('Why Loop shows this'));
    assert.ok(html.includes('Loop keeps no message text'));
  });

  it('the actions are the person\'s own, on their own items, through the WorkItem state machine -- and create no Work', () => {
    const actions = code(read('../src/app/app/chats/actions.ts'));
    assert.match(actions, /^'use server';/m);
    assert.match(actions, /requirePermission\('employeeIntelligence', 'update'\)/);
    assert.match(actions, /new WorkItemRepository\(prisma\), \{ organizationId: session\.organizationId, userId: session\.userId \}/);
    for (const forbidden of ['createWorkItem', 'WorkRepository', 'organizationId: form', "form.get('organizationId')", "form.get('userId')", 'prisma.workItem']) {
      assert.equal(actions.includes(forbidden), false, forbidden);
    }
  });

  it('the composition names nobody Loop did not see: no user id, no role, no "team member" -- only labels the source showed', () => {
    const pure = code(read('../src/daily-loop/chats-intelligence.ts'));
    for (const forbidden of ['userId', 'systemRole', 'assignee', 'ownerUserId', 'teammate']) assert.equal(pure.includes(forbidden), false, forbidden);
  });
});
