// CHATS as a domain (2026-09-24, Chats Intelligence 2026-09-25): what Loop understands about a
// person's own chats, decided once by a pure composition (`composeChatsIntelligence`) over the
// viewer's own current CHATS digests, that the Chats page and Home both read.
//
// Behavioural where the code is pure: every state and its honest words, that no digest means "Loop
// hasn't generated Chats intelligence yet" and never a summary, that counts never become a summary,
// that "business" comes only from a digest's relevance, freshness through the governed coverage
// words, obligations kept apart, grouping by the source's own label, and at most two sentences.
// Source-level where the subject needs a session: the page's guard, the principal every read uses
// (the digest read is the principal-scoped `forDomain`, nothing organization-wide), and that Chats
// never links into Telegram and uses Connections only to connect, turn on triage, reconnect or
// manage. Rendered with fixtures: the view shows the interpretation, the obligations, and no body.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTimeView, intelligenceCoverageLabel, type DigestContent } from '@emgloop/shared';

import {
  NO_CHATS_INTELLIGENCE,
  UNNAMED_CONVERSATION,
  chatsConversationKeyOf,
  chatsNeedsConnections,
  composeChatsIntelligence,
  type ChatsActivity,
  type ChatsConnection,
  type ChatsDigest,
  type ChatsIntelligenceInput,
  type ChatsItem,
  type ChatsState,
} from '../src/daily-loop/chats-intelligence';
import { ChatsView } from '../src/app/app/chats/_chats/chats-view';
import { projectTiles, type TilesInput } from '../src/app/app/_home/tiles';

const NOW = new Date('2026-09-24T16:00:00Z');
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const time = createTimeView({ timeZone: 'America/New_York', source: 'device' }, NOW);
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const code = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const render = (el: unknown) => renderToStaticMarkup(el as never);
const sentences = (lines: readonly string[]) => lines.join(' ').split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== '');
const unescape = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

const READY: ChatsConnection = { configured: true, state: 'READY', label: 'Ready', contentAuthorized: true };
const activity = (conversations: number, messages = conversations * 4, hours = 24): ChatsActivity => ({ since: ago(hours * H), messages, conversations });

function item(over: Partial<ChatsItem> = {}): ChatsItem {
  return {
    provider: 'TELEGRAM',
    category: 'REQUEST',
    counterparty: 'Acme Buyers',
    topic: 'rate card',
    title: 'Asked for the updated rate card',
    nextStep: 'Send the updated rate card',
    deadline: null,
    at: ago(2 * H),
    conversationKey: 'ck_acme',
    ...over,
  };
}

function digest(over: Partial<ChatsDigest> & { content?: DigestContent } = {}): ChatsDigest {
  return {
    subjectRef: 'telegram_conversation:ck_acme',
    content: {
      relevance: 'BUSINESS',
      synthesis: 'Acme is weighing a higher cap and wants the new rate card first',
      developments: ['Acme raised the cap question again'],
      unresolved: ['Whether the cap moves this month'],
      commitments: ['You said you would send the rate card'],
      confidence: 'HIGH',
    },
    coverage: 'CONNECTED_SUFFICIENT',
    status: 'CURRENT',
    windowEnd: ago(H),
    expiresAt: new Date(NOW.getTime() + 29 * D),
    generatedAt: ago(H),
    lastEvidenceAt: ago(H),
    evidenceCount: 12,
    ...over,
  };
}

const input = (over: Partial<ChatsIntelligenceInput> = {}): ChatsIntelligenceInput => ({
  connection: READY,
  digests: [],
  items: [],
  activity24h: activity(5),
  activity7d: activity(12, 80, 24 * 7),
  latestActivity: new Map(),
  now: NOW,
  ...over,
});

const ALL_STATES: readonly [ChatsState, ChatsIntelligenceInput][] = [
  ['NOT_PERMITTED', input({ connection: null, activity24h: null, activity7d: null })],
  ['NOT_AVAILABLE', input({ connection: { ...READY, configured: false, state: 'NOT_CONNECTED', label: 'Not connected' } })],
  ['NOT_CONNECTED', input({ connection: { ...READY, state: 'NOT_CONNECTED', label: 'Not connected' } })],
  ['CONSENT_OFF', input({ connection: { ...READY, contentAuthorized: false } })],
  ['UNAVAILABLE', input({ connection: { ...READY, state: 'RECONNECT_REQUIRED', label: 'Reconnect required' }, digests: [digest()] })],
  ['NO_INTELLIGENCE_YET', input()],
  ['STALE', input({ digests: [digest({ status: 'STALE' })] })],
  ['CURRENT', input({ digests: [digest()], items: [item()] })],
];

describe('composeChatsIntelligence: states', () => {
  it('reaches every state from its own input, and each says what it is', () => {
    for (const [state, i] of ALL_STATES) assert.equal(composeChatsIntelligence(i).state, state, state);
  });

  it('NOT_PERMITTED: no status, no metric, and no digest is even considered', () => {
    const out = composeChatsIntelligence(input({ connection: null, digests: [digest()] }));
    assert.equal(out.state, 'NOT_PERMITTED');
    assert.deepEqual([out.status, out.metric, out.conversations.length, out.businessConversations], [null, null, 0, null]);
  });

  it('NOT_AVAILABLE when this deployment cannot connect Telegram', () => {
    const out = composeChatsIntelligence(input({ connection: { ...READY, configured: false, state: 'NOT_CONNECTED', label: 'Not connected' } }));
    assert.equal(out.status, 'Telegram · Not available on this deployment');
  });

  it('NOT_CONNECTED for never connected, disconnected, or sign-in not finished', () => {
    for (const state of ['NOT_CONNECTED', 'DISCONNECTED', 'CONNECTING', 'SETTING_UP']) {
      const out = composeChatsIntelligence(input({ connection: { ...READY, state, label: state } }));
      assert.equal(out.state, 'NOT_CONNECTED', state);
      assert.match(out.statement, /Telegram is not connected/);
      assert.equal(out.metric, null);
    }
  });

  it('UNAVAILABLE (connection) when it needs a reconnect or failed; earlier flags still counted, earlier readings not current', () => {
    const out = composeChatsIntelligence(input({ connection: { ...READY, state: 'RECONNECT_REQUIRED', label: 'Reconnect required' }, items: [item()], digests: [digest()] }));
    assert.deepEqual([out.state, out.unavailable, out.status], ['UNAVAILABLE', 'CONNECTION', 'Telegram · Reconnect required']);
    assert.match(out.owed!, /^1 conversation Loop flagged earlier still needs you/);
    assert.deepEqual(out.conversations.map((c) => [c.coverage, c.asCurrent]), [['DISCONNECTED', false]]);
    assert.equal(composeChatsIntelligence(input({ connection: { ...READY, state: 'FAILED', label: 'Problem' } })).state, 'UNAVAILABLE');
  });

  it('UNAVAILABLE (read failed) when Loop could not read its own digests: said, never read as "none yet"', () => {
    const out = composeChatsIntelligence(input({ digests: null, items: [item()] }));
    assert.deepEqual([out.state, out.unavailable], ['UNAVAILABLE', 'READ_FAILED']);
    assert.equal(out.statement, 'Loop could not read its Chats intelligence just now.');
    assert.notEqual(out.statement, NO_CHATS_INTELLIGENCE);
    assert.equal(out.obligations.length, 1, 'what the viewer owes is a separate read and still stands');
  });

  it('CONSENT_OFF: no intelligence, because triage is off -- the honest reason, never a summary', () => {
    const out = composeChatsIntelligence(input({ connection: { ...READY, contentAuthorized: false } }));
    assert.equal(out.status, 'Telegram · Ready · Triage off');
    assert.deepEqual(out.headline, [NO_CHATS_INTELLIGENCE, 'AI triage is off, so Loop reads no content from your chats, only who and when.']);
    assert.deepEqual(out.metric, { value: '5', label: 'active conversations since yesterday' });
  });

  it('NO_INTELLIGENCE_YET never shows a summary: the honest sentence and its reason, nothing drawn from counts', () => {
    const out = composeChatsIntelligence(input({ activity24h: activity(9, 70), activity7d: activity(20, 300, 24 * 7) }));
    assert.equal(out.statement, 'Loop hasn’t generated Chats intelligence yet.');
    assert.deepEqual(out.headline, [NO_CHATS_INTELLIGENCE, 'Loop writes its reading of a conversation after new messages arrive there, and no conversation has one yet.']);
    assert.deepEqual([out.conversations.length, out.businessConversations, out.coverage.words], [0, null, null]);
    for (const n of ['9', '70', '20', '300']) assert.equal(out.headline.join(' ').includes(n), false, `the count ${n} never becomes a summary`);
    assert.deepEqual(out.metric, { value: '9', label: 'active conversations since yesterday' }, 'activity is labelled active, never business');
  });

  it('STALE when digests exist and none is current: marked stale, newer activity than its window, or about to expire', () => {
    const cases: ChatsIntelligenceInput[] = [
      input({ digests: [digest({ status: 'STALE' })] }),
      input({ digests: [digest({ windowEnd: ago(5 * H) })], latestActivity: new Map([['ck_acme', ago(H)]]) }),
      input({ digests: [digest({ expiresAt: new Date(NOW.getTime() + 2 * H) })] }),
    ];
    for (const c of cases) {
      const out = composeChatsIntelligence(c);
      assert.equal(out.state, 'STALE');
      assert.equal(out.statement, `No Chats reading is current: ${intelligenceCoverageLabel('STALE').label.toLowerCase()}.`);
      assert.equal(out.conversations[0]!.coverageLabel, intelligenceCoverageLabel('STALE'));
    }
    // Newer activity in a DIFFERENT conversation does not make this one stale.
    assert.equal(composeChatsIntelligence(input({ digests: [digest({ windowEnd: ago(5 * H) })], latestActivity: new Map([['ck_other', ago(H)]]) })).state, 'CURRENT');
  });

  it('CURRENT leads with the most attention-worthy business conversation’s own synthesis, under Telegram’s own label', () => {
    const out = composeChatsIntelligence(
      input({
        digests: [
          digest({ subjectRef: 'telegram_conversation:ck_quiet', content: { relevance: 'BUSINESS', synthesis: 'A quiet vendor thread with nothing open', confidence: 'MEDIUM' } }),
          digest(),
        ],
        items: [item()],
      }),
    );
    assert.equal(out.state, 'CURRENT');
    assert.equal(out.statement, 'Acme Buyers: Acme is weighing a higher cap and wants the new rate card first.');
    assert.deepEqual(out.headline, [out.statement, 'Loop has a reading of 2 business conversations: 1 has new developments and 1 has something unresolved.']);
    assert.deepEqual(out.metric, { value: '2', label: 'business conversations' });
    assert.deepEqual(out.conversations.map((c) => c.label), ['Acme Buyers', null], 'a conversation with no obligation is not named');
    assert.deepEqual(out.conversations[0]!.flags, ['1 unresolved situation', '1 thing you owe here']);
    assert.equal(out.coverage.words, 'Up to date');
  });
});

describe('composeChatsIntelligence: what it may say', () => {
  it('"business" is only a digest’s relevance: activity, obligations and other digests never count', () => {
    const out = composeChatsIntelligence(
      input({
        activity24h: activity(40),
        items: [item(), item({ conversationKey: 'ck_b', counterparty: 'B' })],
        digests: [
          digest({ subjectRef: 'telegram_conversation:ck_1' }),
          digest({ subjectRef: 'telegram_conversation:ck_2' }),
          digest({ subjectRef: 'telegram_conversation:ck_3', content: { relevance: 'NOT_BUSINESS', synthesis: 'Family plans for the weekend' } }),
          digest({ subjectRef: 'telegram_conversation:ck_4', content: { relevance: 'UNCLEAR', synthesis: 'An intro between two people' } }),
        ],
      }),
    );
    assert.deepEqual([out.businessConversations, out.metric], [2, { value: '2', label: 'business conversations' }]);
    assert.equal(out.notBusiness, 1);
    assert.deepEqual(out.conversations.map((c) => c.relevance), ['BUSINESS', 'BUSINESS', 'UNCLEAR'], 'not-business conversations are counted, not shown');
    assert.equal(JSON.stringify(out).includes('Family plans'), false);
    // Without a digest there is no "business" anywhere.
    for (const [state, i] of ALL_STATES) {
      if (state === 'CURRENT' || state === 'STALE' || state === 'UNAVAILABLE') continue;
      const o = composeChatsIntelligence(i);
      assert.equal(/business/i.test([...o.headline, o.metric?.label ?? ''].join(' ')), false, state);
    }
  });

  it('no business conversation: said by relevance, never a summary', () => {
    const none = composeChatsIntelligence(input({ digests: [digest({ content: { relevance: 'NOT_BUSINESS', synthesis: 'Personal' } })] }));
    assert.deepEqual([none.statement, none.metric], ['None of the 1 conversation Loop has read looks like business.', { value: '0', label: 'business conversations' }]);
    const unclear = composeChatsIntelligence(input({ digests: [digest({ content: { relevance: 'UNCLEAR' } }), digest({ subjectRef: 'x2', content: { relevance: 'NOT_BUSINESS' } })] }));
    assert.equal(unclear.statement, 'Loop could not tell whether 1 of the 2 conversations it has read is business.');
  });

  it('an absence is "nothing" only under sufficient coverage; a partial reading says only how many it read', () => {
    const quiet = { relevance: 'BUSINESS' as const, synthesis: 'Routine check-ins only' };
    assert.equal(composeChatsIntelligence(input({ digests: [digest({ content: quiet })] })).headline[1], 'Loop has a reading of 1 business conversation; none has a new development or anything unresolved.');
    const partial = composeChatsIntelligence(input({ digests: [digest({ content: quiet, coverage: 'CONNECTED_PARTIAL' })] }));
    assert.equal(partial.headline[1], 'Loop has a reading of 1 business conversation.');
    assert.equal(partial.coverage.words, intelligenceCoverageLabel('CONNECTED_PARTIAL').label);
  });

  it('a digest that says a conversation needs the person now leads, and its own reason is carried as written', () => {
    const out = composeChatsIntelligence(
      input({
        items: [item()],
        digests: [
          digest(),
          digest({ subjectRef: 'telegram_conversation:ck_urgent', content: { relevance: 'BUSINESS', synthesis: 'A buyer paused all traffic pending a refund', attention: 'The buyer expects an answer on the refund today', operational: ['Traffic to the buyer is paused'] } }),
        ],
      }),
    );
    assert.equal(out.statement, 'A buyer paused all traffic pending a refund.');
    assert.deepEqual([out.conversations[0]!.attention, out.conversations[0]!.operational], ['The buyer expects an answer on the refund today', ['Traffic to the buyer is paused']]);
    assert.equal(out.conversations[1]!.attention, null, 'no reason is invented for a digest that gave none');
  });

  it('a digest without a synthesis is never given one: the headline counts instead', () => {
    const out = composeChatsIntelligence(input({ digests: [digest({ content: { relevance: 'BUSINESS', developments: ['A new buyer asked for terms'] } })] }));
    assert.deepEqual(out.headline, ['Loop has a reading of 1 business conversation: 1 has new developments.']);
  });

  it('mixed coverage is said in the governed words, per value', () => {
    const out = composeChatsIntelligence(input({ digests: [digest(), digest({ subjectRef: 's2', status: 'STALE' }), digest({ subjectRef: 's3', coverage: 'CONNECTED_INSUFFICIENT' })] }));
    assert.equal(out.coverage.words, ['CONNECTED_SUFFICIENT', 'CONNECTED_INSUFFICIENT', 'STALE'].map((c) => `1 ${intelligenceCoverageLabel(c as never).label.toLowerCase()}`).join(' · '));
  });

  it('links a digest to its conversation by key, with or without the derived-work prefix -- never by rendering the key', () => {
    assert.equal(chatsConversationKeyOf('telegram_conversation:ck_acme'), 'ck_acme');
    assert.equal(chatsConversationKeyOf('ck_acme'), 'ck_acme');
    const bare = composeChatsIntelligence(input({ digests: [digest({ subjectRef: 'ck_acme' })], items: [item()] }));
    assert.equal(bare.conversations[0]!.label, 'Acme Buyers');
  });

  it('obligations stay separate and keep their meaning: grouped by the source’s own label, most pressing first', () => {
    const out = composeChatsIntelligence(
      input({
        items: [
          item({ counterparty: 'Beta', category: 'FOLLOW_UP', at: ago(H) }),
          item({ counterparty: 'Acme', category: 'REQUEST', at: ago(4 * H) }),
          item({ counterparty: 'Acme', category: 'PROBLEM', at: ago(2 * H) }),
          item({ counterparty: 'Gamma', category: 'FOLLOW_UP', deadline: 'tomorrow', at: ago(8 * H) }),
          item({ counterparty: null, category: 'REQUEST', at: ago(H) }),
          item({ counterparty: '  ', category: 'REQUEST', at: ago(2 * H) }),
          item({ provider: 'TEAMS' }),
        ],
      }),
    );
    assert.deepEqual(out.obligations.map((c) => [c.label, c.items.length, c.hasDeadline]), [
      ['Gamma', 1, true],
      ['Acme', 2, false],
      [null, 1, false],
      [null, 1, false],
      ['Beta', 1, false],
    ]);
    assert.deepEqual(out.obligations[1]!.items.map((i) => i.category), ['PROBLEM', 'REQUEST']);
    assert.equal(out.owed, '5 conversations need you: 1 problem, 3 requests and 2 follow-ups; 1 carries a deadline.');
    assert.equal(out.state, 'NO_INTELLIGENCE_YET', 'obligations are not intelligence');
    assert.equal(out.statement, NO_CHATS_INTELLIGENCE);
  });

  it('never more than two sentences, in every state, and deterministic', () => {
    for (const [state, i] of ALL_STATES) {
      const out = composeChatsIntelligence(i);
      assert.ok(out.headline.length <= 2 && sentences(out.headline).length <= 2, `${state}: ${out.headline.join(' | ')}`);
      assert.equal(out.statement, out.headline[0]);
      assert.deepEqual(composeChatsIntelligence(i), out, state);
    }
  });

  it('carries no body, quote or link: nothing outside the digest contract survives', () => {
    const sneaky = { ...digest().content, body: 'SECRET-BODY', quote: 'SECRET-QUOTE' } as unknown as DigestContent;
    const out = composeChatsIntelligence(input({ digests: [digest({ content: sneaky })], items: [item()] }));
    assert.equal(/SECRET/.test(JSON.stringify(out)), false);
    const keys = new Set([...out.conversations.flatMap((c) => Object.keys(c)), ...out.obligations.flatMap((c) => c.items.flatMap((i) => Object.keys(i)))]);
    for (const forbidden of ['body', 'text', 'quote', 'message', 'content', 'href', 'url', 'link']) assert.equal(keys.has(forbidden), false, forbidden);
    assert.equal(/https?:|t\.me|tg:/.test(JSON.stringify(out)), false);
  });
});

// --- one composition, two surfaces ------------------------------------------------------------------

const NAV: TilesInput['groups'] = [
  { items: [{ href: '/app/chats', label: 'Chats', icon: 'chat' }, { href: '/app/connections', label: 'Connections', icon: 'plug' }] },
];
function tileFor(intel: ReturnType<typeof composeChatsIntelligence>) {
  return projectTiles({
    groups: NAV,
    today: { mail: { state: 'NOT_CONFIGURED' }, calendar: { state: 'NOT_CONFIGURED' } } as unknown as TilesInput['today'],
    mail: null,
    chats: { ok: true, value: intel },
    work: null,
    intake: null,
    creators: null,
    callgrid: null,
    callgridBrief: null,
    time,
  }).find((t) => t.key === 'chats') ?? null;
}

describe('Home’s Chats tile and /app/chats are one composition at two depths', () => {
  it('identical input gives identical statements: the tile says the page’s lead sentence, figure and freshness', () => {
    for (const [state, i] of ALL_STATES) {
      const intel = composeChatsIntelligence(i);
      const tile = tileFor(intel);
      const page = unescape(render(<ChatsView intel={composeChatsIntelligence(i)} time={time} />));
      if (state === 'NOT_PERMITTED') {
        assert.equal(tile, null);
        continue;
      }
      assert.ok(page.includes(intel.statement), `${state}: the page leads with the statement`);
      if (state === 'CURRENT' || state === 'STALE') {
        assert.deepEqual([tile!.lines, tile!.metric], [[intel.statement], intel.metric], state);
        assert.equal(tile!.status, `${intel.status} · ${intel.coverage.words}`);
      } else if (state !== 'NOT_CONNECTED') {
        assert.equal(tile!.stateLine, intel.statement, state);
      }
      if (intel.metric) assert.ok(page.includes(`<b>${intel.metric.value}</b> ${intel.metric.label}`), state);
    }
  });

  it('routing: Chats whenever Telegram is connected, intelligence or not; Connections only for setup or consent', () => {
    const expected: Record<ChatsState, string | null> = {
      NOT_PERMITTED: null,
      NOT_AVAILABLE: '/app/chats',
      NOT_CONNECTED: '/app/connections',
      CONSENT_OFF: '/app/connections',
      UNAVAILABLE: '/app/chats',
      NO_INTELLIGENCE_YET: '/app/chats',
      STALE: '/app/chats',
      CURRENT: '/app/chats',
    };
    for (const [state, i] of ALL_STATES) {
      assert.equal(tileFor(composeChatsIntelligence(i))?.href ?? null, expected[state], state);
      assert.equal(chatsNeedsConnections(state), expected[state] === '/app/connections', state);
    }
    assert.equal(tileFor(composeChatsIntelligence(ALL_STATES[3]![1]))!.linkLabel, 'Turn on AI triage in Connections');
    assert.equal(tileFor(composeChatsIntelligence(input({ digests: null })))!.href, '/app/chats', 'a failed digest read is still Chats');
  });

  it('every surface composes through the one function, and none keeps a Chats summary of its own', () => {
    const TILES = code(read('../src/app/app/_home/tiles.ts'));
    const NARRATIVE = code(read('../src/app/app/_home/narrative.ts'));
    for (const f of ['../src/app/app/chats/page.tsx', '../src/app/app/_home/admin-home.tsx', '../src/app/app/_home/module-home.tsx']) {
      const src = code(read(f));
      assert.match(src, /composeChatsIntelligence\(/, f);
      assert.equal(/\bchatsIntelligence\(/.test(src), false, f);
    }
    for (const src of [TILES, NARRATIVE]) {
      assert.equal(/composeChatsIntelligence\(|digestFreshness|\.content\b|synthesis|IntelligenceDigest/.test(src), false, 'the tile and the briefing read the composition, never digests');
    }
    assert.match(TILES, /lines: \[c\.statement\]/);
    assert.equal(/c\.conversations/.test(NARRATIVE), false, 'the briefing counts obligations, never conversation intelligence');
    assert.match(NARRATIVE, /c\.obligations\.length/);
  });
});

// --- the reads, at source level -----------------------------------------------------------------------

describe('the Chats page and its loader', () => {
  const PAGE = code(read('../src/app/app/chats/page.tsx'));
  const LOADER = code(read('../src/daily-loop/chats.ts'));
  const PURE = read('../src/daily-loop/chats-intelligence.ts');
  const VIEW = code(read('../src/app/app/chats/_chats/chats-view.tsx'));
  const FRONT = code(read('../src/app/app/_home/front-door-data.ts'));

  it('guards first, with the Connections page\'s gate, and builds the principal from the session only', () => {
    const body = PAGE.slice(PAGE.indexOf('export default async function ChatsPage'));
    const firstAwait = body.indexOf('await ');
    assert.equal(body.indexOf("await requirePermission('googleWorkspace', 'view')"), firstAwait, 'the guard is the first thing awaited');
    assert.match(body, /const principal = \{ organizationId: session\.organizationId, userId: session\.userId \};/);
    assert.equal(/searchParams|params|formData|headers\(/.test(body), false, 'nothing from the request names a person');
    assert.match(read('../src/app/app/connections/page.tsx'), /requirePermission\('googleWorkspace', 'view'\)/);
  });

  it('loads Needs You once, with the session principal, and hands it to the loader; the loader never loads it', () => {
    assert.equal(PAGE.match(/loadNeedsYou\(/g)?.length, 1);
    assert.match(PAGE, /loadNeedsYou\(principal, /);
    assert.match(PAGE, /loadChatsInput\(\{ session, principal, now, needsYou \}\)/);
    assert.equal(/loadNeedsYou\(/.test(LOADER), false);
    assert.match(PAGE, /export const dynamic = 'force-dynamic'/);
  });

  it('reads the digests for the session principal only: forDomain, CHATS, no organization or role path', () => {
    assert.match(LOADER, /new IntelligenceDigestRepository\(prisma\)\.forDomain\(principal, 'CHATS', \{ now \}\)/);
    assert.match(LOADER, /export async function loadChatsDigests\(principal: WorkPrincipal, now: Date\)/);
    assert.match(LOADER, /loadChatsDigests\(principal, now\)\.catch\(\(\) => null\)/, 'settled on its own: a failure is null, never an empty list');
    const digestCalls = [...LOADER.matchAll(/IntelligenceDigestRepository\(prisma\)\.(\w+)\(/g)].map((m) => m[1]);
    assert.deepEqual(digestCalls, ['forDomain']);
    for (const src of [LOADER, PAGE, FRONT, code(PURE), VIEW]) {
      for (const forbidden of ['organizationCounts', 'metadataFor', 'purgeExpired', 'markStale', 'upsert(', 'systemRole', 'isAdmin', "scope: 'ORGANIZATION'"]) assert.equal(src.includes(forbidden), false, forbidden);
      for (const call of src.matchAll(/\.(forDomain|current)\(([^)]*)\)/g)) assert.match(call[2]!, /^principal,/, 'every digest read names the session principal first');
    }
    // Home reads Chats through the same loader, gated by the rail and settled on its own.
    assert.match(FRONT, /navOffers\(groups, TILE_PATHS\.chats\) \? settle\(\(\) => loadChatsInput\(\{ session, principal, now: time\.now, needsYou \}\)\)/);
    assert.equal(FRONT.includes('IntelligenceDigestRepository'), false);
  });

  it('the loader reads activity for the principal\'s own user, and never throws for it', () => {
    const calls = LOADER.match(/\.(activitySince|recent)\(([^)]*)\)/g) ?? [];
    assert.ok(calls.length >= 2);
    for (const call of calls) assert.match(call, /\.(activitySince|recent)\(organizationId, principal\.userId, /);
    assert.match(LOADER, /\.catch\(\(\) => null\)/);
    assert.match(LOADER, /sourceConnections\(\)\.status\(\{ organizationId, userId: principal\.userId, name: session\.name \}\)/);
  });

  it('the pure module reads nothing: only the shared pure contract is imported', () => {
    const imports = PURE.match(/^import [\s\S]*? from '[^']+';$/gm) ?? [];
    assert.equal(imports.length, 1);
    assert.match(imports[0]!, /from '@emgloop\/shared';$/);
    assert.equal(/prisma|Repository|loadNeedsYou|server-only|fetch\(|new Date\(\)|Date\.now\(/.test(code(PURE)), false);
  });

  it('coverage is said in the governed words: no surface spells them itself', () => {
    const tiles = code(read('../src/app/app/_home/tiles.ts'));
    const chatsTile = tiles.slice(tiles.indexOf('function chatsTile'), tiles.indexOf('function calendarTile'));
    for (const src of [code(PURE), VIEW, chatsTile]) {
      for (const words of ['Up to date', 'Out of date', 'Partly read', 'Not enough to go on']) assert.equal(src.includes(words), false, words);
    }
    assert.match(code(PURE), /intelligenceCoverageLabel\(/);
    assert.match(code(PURE), /digestFreshness\(/);
  });

  it('never links into Telegram, and uses Connections only to connect, turn on triage, reconnect or manage', () => {
    assert.equal(/t\.me|tg:\/\/|telegram\.org|https?:/.test(VIEW), false);
    const hrefs = [...VIEW.matchAll(/href[=:]\s*\{?([A-Z_]+|'[^']*')/g)].map((m) => m[1]);
    assert.ok(hrefs.length > 0);
    for (const h of hrefs) assert.equal(h, 'CONNECTIONS_HREF');
    const labels = [...VIEW.matchAll(/label: '([^']+)', href: CONNECTIONS_HREF/g)].map((m) => m[1]).sort();
    assert.deepEqual(labels, ['Connect Telegram', 'Reconnect Telegram', 'Turn on AI triage']);
    assert.match(VIEW, /href=\{CONNECTIONS_HREF\}>\s*Manage connection/);
  });
});

describe('the Chats view, rendered', () => {
  it('leads with what Loop understands, then the interpretation with confidence and freshness, then what you owe, then coverage', () => {
    const intel = composeChatsIntelligence(
      input({
        digests: [
          digest({ content: { ...digest().content, opportunities: ['Acme may add a second vertical'], concerns: ['Payment terms are slipping'], operational: ['Invoices move to the new billing contact'], attention: 'Acme expects the rate card before Friday', limitations: ['Only the last 50 messages were read'], stateChange: 'The cap question reopened' } as DigestContent }),
          digest({ subjectRef: 'telegram_conversation:ck_old', status: 'STALE', content: { relevance: 'BUSINESS', synthesis: 'Ops were rerouting overflow calls', confidence: 'LOW' } }),
        ],
        items: [
          item({ category: 'DECISION_NEEDED', title: 'Wants a yes or no on the cap', deadline: 'by Friday' }),
          item({ counterparty: null, conversationKey: null, category: 'REQUEST', title: 'Asked for the invoice copy', topic: null, nextStep: null }),
        ],
      }),
    );
    const html = unescape(render(<ChatsView intel={intel} time={time} />));
    const at = (s: string) => {
      const i = html.indexOf(s);
      assert.ok(i >= 0, s);
      return i;
    };
    assert.ok(at(intel.statement) < at('Conversation intelligence') && at('Conversation intelligence') < at('What you owe') && at('What you owe') < at('Coverage and connection'));
    for (const s of ['Loop’s interpretation', 'High confidence', 'Low confidence', 'What changed: The cap question reopened', 'Acme may add a second vertical', 'Payment terms are slipping', 'Invoices move to the new billing contact', 'Why it needs you now: Acme expects the rate card before Friday', 'What Loop could not see or conclude: Only the last 50 messages were read']) at(s);
    // The knowledge basis the digest contract names, beside every list: an inference never reads as what was said.
    assert.match(html, /data-chats-reading="Developments" data-chats-basis="OBSERVED"[\s\S]*?as the conversation said it/);
    assert.match(html, /data-chats-reading="Concerns" data-chats-basis="INFERRED"[\s\S]*?Loop’s reading/);
    assert.match(html, /data-chats-card="true" data-chats-card-coverage="CONNECTED_SUFFICIENT"[\s\S]*?Up to date/);
    assert.match(html, /data-chats-card="true" data-chats-card-coverage="STALE"[\s\S]*?Out of date[\s\S]*?As of /);
    assert.ok(html.includes(UNNAMED_CONVERSATION), 'a conversation without a label is said to be unnamed');
    assert.equal(/ck_acme|ck_old|telegram_conversation:/.test(html), false, 'a key is never shown');
    assert.match(html, /data-chats-owe[\s\S]*?Wants a yes or no on the cap[\s\S]*?Deadline, as the conversation put it: by Friday/);
    assert.match(html, /Telegram · Ready · Triage on/);
    assert.match(html, /href="\/app\/connections"[^>]*>Manage connection</);
    assert.match(html, /20 messages across 5 active conversations/);
    assert.equal(/business conversations were active/.test(html), false);
    assert.equal(/t\.me|tg:\/\//.test(html), false);
    assert.equal((html.match(/href="/g) ?? []).length, (html.match(/href="\/app\/connections"/g) ?? []).length, 'every link is to Connections');
  });

  it('no intelligence yet: the honest sentence and reason, no cards, no summary', () => {
    const html = unescape(render(<ChatsView intel={composeChatsIntelligence(input())} time={time} />));
    assert.ok(html.includes(NO_CHATS_INTELLIGENCE));
    assert.match(html, /No conversation has a reading yet/);
    assert.equal(html.includes('data-chats-card'), false);
    assert.equal(html.includes('Conversation intelligence'), false);
  });

  it('not connected: the primary action is connecting in Connections; no coverage figures', () => {
    const html = render(<ChatsView intel={composeChatsIntelligence(input({ connection: { ...READY, state: 'NOT_CONNECTED', label: 'Not connected' } }))} time={time} />);
    assert.match(html, /Telegram is not connected/);
    assert.match(html, /class="loop-btn loop-btn--primary" href="\/app\/connections">Connect Telegram</);
    assert.equal(html.includes('Since yesterday'), false);
  });

  it('triage off, unavailable, a failed digest read and a failed page read each say what they are', () => {
    assert.match(render(<ChatsView intel={composeChatsIntelligence(input({ connection: { ...READY, contentAuthorized: false } }))} time={time} />), /AI triage is off[\s\S]*?Turn on AI triage/);
    assert.match(render(<ChatsView intel={composeChatsIntelligence(input({ connection: { ...READY, state: 'FAILED', label: 'Problem' } }))} time={time} />), /Reconnect Telegram/);
    const failed = render(<ChatsView intel={composeChatsIntelligence(input({ digests: null }))} time={time} />);
    assert.match(failed, /Loop could not read its Chats intelligence just now/);
    assert.equal(failed.includes('No conversation has a reading yet'), false, 'a failed read is not "none yet"');
    assert.match(render(<ChatsView intel="UNAVAILABLE" time={time} />), /Loop could not read your chats just now/);
    assert.match(render(<ChatsView intel={composeChatsIntelligence(input({ connection: null }))} time={time} />), /not available to you here/);
    assert.match(render(<ChatsView intel={composeChatsIntelligence(input({ activity24h: activity(0) }))} time={time} />), /Nothing in your chats is flagged for you/);
  });
});

describe('a digest written by the Chats Intelligence hydration', () => {
  // The hydration (connections worker, chats-hydration-orchestrator.ts) writes through the SAME
  // buildConversationDigest and IntelligenceDigestRepository.upsert as the forward sweep, so its row has
  // exactly this shape: the full v4 mapping, CONNECTED_SUFFICIENT, CURRENT, and evidence that may be days
  // old (no new message was needed). What it never has is an obligation: hydration writes no WorkItem.
  const hydrated: ChatsDigest = {
    subjectRef: 'telegram_conversation:ck_hydrated',
    content: {
      relevance: 'BUSINESS',
      synthesis: 'Dana is waiting on the countersigned contract',
      topics: ['Contract'],
      developments: ['Dana asked for the signed contract'],
      commitments: [],
      opportunities: ['Returning it closes the job'],
      concerns: [],
      operational: [],
      unresolved: ['The contract is not back yet'],
      attention: 'Dana is waiting on it',
      confidence: 'HIGH',
      limitations: [],
    },
    coverage: 'CONNECTED_SUFFICIENT',
    status: 'CURRENT',
    windowEnd: ago(9 * D),
    lastEvidenceAt: ago(9 * D),
    expiresAt: new Date(ago(9 * D).getTime() + 30 * D),
    generatedAt: ago(H),
    evidenceCount: 6,
  };

  it('renders through composeChatsIntelligence with no special-casing: identical to the same row from the forward path', () => {
    const intel = composeChatsIntelligence(input({ digests: [hydrated] }));
    assert.equal(intel.state, 'CURRENT');
    assert.equal(intel.conversations.length, 1);
    const card = intel.conversations[0]!;
    assert.equal(card.synthesis, 'Dana is waiting on the countersigned contract');
    assert.equal(card.asCurrent, true);
    assert.equal(card.owed, 0, 'no obligation: hydration writes none');
    assert.deepEqual(intel.obligations, []);
    assert.equal(intel.headline[0], 'Dana is waiting on the countersigned contract.');
    // The composition cannot tell which producer wrote the row: the same fields compose identically.
    const forward = composeChatsIntelligence(input({ digests: [{ ...hydrated }] }));
    assert.deepEqual(intel, forward);
    const html = unescape(render(<ChatsView intel={intel} time={time} />));
    assert.match(html, /Dana is waiting on the countersigned contract/);
    assert.match(html, /The contract is not back yet/);
  });
});
