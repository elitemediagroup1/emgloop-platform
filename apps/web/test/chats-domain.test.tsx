// CHATS as a domain (2026-09-24): what is happening in a person's own chats, decided once by a pure
// projection (`chatsIntelligence`) that the Chats page and Home both read.
//
// Behavioural where the code is pure: every state, the wording with triage on and off, activity that
// could not be read (said, never zero), Telegram-only items, grouping by the source's own label, and at
// most two sentences. Source-level where the subject needs a session: the page's guard, the principal
// every read uses, and that Chats never links into Telegram and uses Connections only to connect or
// manage. Rendered with fixtures: the view shows the summary and the conversations, and no body.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTimeView } from '@emgloop/shared';

import {
  UNNAMED_CONVERSATION,
  chatsIntelligence,
  type ChatsActivity,
  type ChatsConnection,
  type ChatsIntelligenceInput,
  type ChatsItem,
} from '../src/daily-loop/chats-intelligence';
import { ChatsView } from '../src/app/app/chats/_chats/chats-view';

const NOW = new Date('2026-09-24T16:00:00Z');
const H = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const time = createTimeView({ timeZone: 'America/New_York', source: 'device' }, NOW);
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const code = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const render = (el: unknown) => renderToStaticMarkup(el as never);
const sentences = (lines: readonly string[]) => lines.join(' ').split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== '');

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
    ...over,
  };
}

const input = (over: Partial<ChatsIntelligenceInput> = {}): ChatsIntelligenceInput => ({
  connection: READY,
  items: [],
  activity24h: activity(5),
  activity7d: activity(12, 80, 24 * 7),
  ...over,
});

describe('chatsIntelligence: states', () => {
  it('NOT_PERMITTED when the person may not view connections: no status, no metric', () => {
    const out = chatsIntelligence(input({ connection: null, activity24h: null, activity7d: null }));
    assert.equal(out.state, 'NOT_PERMITTED');
    assert.equal(out.status, null);
    assert.equal(out.metric, null);
  });

  it('NOT_AVAILABLE when this deployment cannot connect Telegram', () => {
    const out = chatsIntelligence(input({ connection: { ...READY, configured: false, state: 'NOT_CONNECTED', label: 'Not connected' } }));
    assert.equal(out.state, 'NOT_AVAILABLE');
    assert.equal(out.status, 'Telegram · Not available on this deployment');
  });

  it('NOT_CONNECTED for never connected, disconnected, or sign-in not finished', () => {
    for (const state of ['NOT_CONNECTED', 'DISCONNECTED', 'CONNECTING', 'SETTING_UP']) {
      const out = chatsIntelligence(input({ connection: { ...READY, state, label: state } }));
      assert.equal(out.state, 'NOT_CONNECTED', state);
      assert.match(out.summary[0]!, /Telegram is not connected/);
    }
  });

  it('UNAVAILABLE when the connection needs a reconnect or failed; earlier flags still counted', () => {
    const out = chatsIntelligence(input({ connection: { ...READY, state: 'RECONNECT_REQUIRED', label: 'Reconnect required' }, items: [item()] }));
    assert.equal(out.state, 'UNAVAILABLE');
    assert.equal(out.status, 'Telegram · Reconnect required');
    assert.equal(out.summary.length, 2);
    assert.match(out.summary[1]!, /^1 conversation Loop flagged earlier still needs you/);
    assert.equal(chatsIntelligence(input({ connection: { ...READY, state: 'FAILED', label: 'Problem' } })).state, 'UNAVAILABLE');
  });

  it('QUIET when live with nothing owed and nothing active since yesterday; ACTIVE otherwise', () => {
    assert.equal(chatsIntelligence(input({ activity24h: activity(0) })).state, 'QUIET');
    assert.equal(chatsIntelligence(input({ activity24h: null })).state, 'QUIET');
    assert.equal(chatsIntelligence(input({ activity24h: activity(3) })).state, 'ACTIVE');
    assert.equal(chatsIntelligence(input({ activity24h: activity(0), items: [item()] })).state, 'ACTIVE');
    assert.equal(chatsIntelligence(input({ connection: { ...READY, state: 'CONNECTED_LIMITED', label: 'Connected (limited)' } })).state, 'ACTIVE');
  });
});

describe('chatsIntelligence: what it says', () => {
  it('with triage on and nothing owed: activity, then that nothing needs them', () => {
    const out = chatsIntelligence(input());
    assert.deepEqual(out.summary, [
      '5 business conversations were active since yesterday.',
      'None currently contains an unresolved obligation Loop has identified for you.',
    ]);
    assert.equal(out.status, 'Telegram · Ready · Triage on');
    assert.deepEqual(out.metric, { value: '5', label: 'business conversations active since yesterday' });
  });

  it('with triage off: Loop observes activity but flags nothing, because triage is off', () => {
    const out = chatsIntelligence(input({ connection: { ...READY, contentAuthorized: false } }));
    assert.equal(out.status, 'Telegram · Ready · Triage off');
    assert.deepEqual(out.summary, [
      '5 business conversations were active since yesterday.',
      'Loop observes this activity but flags nothing, because AI triage is off.',
    ]);
  });

  it('activity that could not be read is said, never drawn as zero', () => {
    const out = chatsIntelligence(input({ activity24h: null, activity7d: null }));
    assert.equal(out.summary[0], 'Activity could not be read.');
    assert.equal(out.metric, null);
    assert.equal(out.summary.some((s) => /\b0\b/.test(s)), false);
    const html = render(<ChatsView intel={out} time={time} />);
    assert.match(html, /Could not be read/);
  });

  it('what is owed: conversations, kinds most pressing first, deadlines, the latest change and activity -- in two sentences', () => {
    const out = chatsIntelligence(
      input({
        items: [
          item({ counterparty: 'Acme Buyers', category: 'REQUEST', at: ago(3 * H) }),
          item({ counterparty: 'Acme Buyers', category: 'DECISION_NEEDED', title: 'Wants a yes or no on the cap', deadline: 'by Friday', at: ago(H) }),
          item({ counterparty: 'Ops Group', category: 'PROBLEM', title: 'Reported a routing fault', at: ago(5 * H) }),
          item({ counterparty: 'Ops Group', category: 'BUSINESS_CHANGE', topic: 'new payout terms', title: 'Said payout terms change', at: ago(30 * 60_000) }),
          item({ counterparty: null, category: 'FOLLOW_UP', title: 'Waiting on a reply', at: ago(6 * H) }),
        ],
      }),
    );
    assert.equal(out.state, 'ACTIVE');
    assert.deepEqual(out.metric, { value: '3', label: 'conversations need you' });
    assert.deepEqual(out.summary, [
      '3 conversations need you: 1 decision, 1 problem, 1 request and 1 follow-up; 1 carries a deadline.',
      'The latest change named in Ops Group is about new payout terms; 5 business conversations were active since yesterday.',
    ]);
    assert.ok(sentences(out.summary).length <= 2);
  });

  it('only Telegram items count', () => {
    const out = chatsIntelligence(input({ items: [item({ provider: 'TEAMS' }), item({ provider: 'GMAIL' })] }));
    assert.equal(out.conversations.length, 0);
    assert.equal(out.metric?.label, 'business conversations active since yesterday');
  });

  it('groups by the source\'s own label, most pressing first; an unnamed item is its own conversation', () => {
    const out = chatsIntelligence(
      input({
        items: [
          item({ counterparty: 'Beta', category: 'FOLLOW_UP', at: ago(H) }),
          item({ counterparty: 'Acme', category: 'REQUEST', at: ago(4 * H) }),
          item({ counterparty: 'Acme', category: 'PROBLEM', at: ago(2 * H) }),
          item({ counterparty: 'Gamma', category: 'FOLLOW_UP', deadline: 'tomorrow', at: ago(8 * H) }),
          item({ counterparty: null, category: 'REQUEST', at: ago(H) }),
          item({ counterparty: '  ', category: 'REQUEST', at: ago(2 * H) }),
        ],
      }),
    );
    assert.deepEqual(out.conversations.map((c) => [c.label, c.items.length, c.hasDeadline]), [
      ['Gamma', 1, true],
      ['Acme', 2, false],
      [null, 1, false],
      [null, 1, false],
      ['Beta', 1, false],
    ]);
    assert.deepEqual(out.conversations[1]!.items.map((i) => i.category), ['PROBLEM', 'REQUEST']);
  });

  it('never more than two sentences, in every state', () => {
    const cases: ChatsIntelligenceInput[] = [
      input(), input({ connection: null }), input({ connection: { ...READY, configured: false } }),
      input({ connection: { ...READY, state: 'NOT_CONNECTED' }, items: [item()] }),
      input({ connection: { ...READY, state: 'FAILED' }, items: [item(), item({ counterparty: 'B' })] }),
      input({ items: [item({ category: 'BUSINESS_CHANGE' })], activity24h: null }),
      input({ connection: { ...READY, contentAuthorized: false }, activity24h: activity(0) }),
    ];
    for (const c of cases) {
      const out = chatsIntelligence(c);
      assert.ok(out.summary.length <= 2 && sentences(out.summary).length <= 2, out.summary.join(' | '));
    }
  });

  it('carries no body and no link: the projection has no field for either', () => {
    const out = chatsIntelligence(input({ items: [item()] }));
    const keys = new Set(out.conversations.flatMap((c) => c.items.flatMap((i) => Object.keys(i))));
    for (const forbidden of ['body', 'text', 'content', 'href', 'url', 'link']) assert.equal(keys.has(forbidden), false, forbidden);
    assert.equal(/https?:|t\.me|tg:/.test(JSON.stringify(out)), false);
  });
});

describe('the Chats page', () => {
  const PAGE = code(read('../src/app/app/chats/page.tsx'));
  const LOADER = code(read('../src/daily-loop/chats.ts'));
  const PURE = read('../src/daily-loop/chats-intelligence.ts');
  const VIEW = code(read('../src/app/app/chats/_chats/chats-view.tsx'));

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

  it('the loader reads activity for the principal\'s own user, and never throws for it', () => {
    const calls = LOADER.match(/\.activitySince\(([^)]*)\)/g) ?? [];
    assert.ok(calls.length >= 1);
    for (const call of calls) assert.match(call, /\.activitySince\(organizationId, principal\.userId, /);
    assert.match(LOADER, /\.catch\(\(\) => null\)/);
    assert.match(LOADER, /sourceConnections\(\)\.status\(\{ organizationId, userId: principal\.userId, name: session\.name \}\)/);
  });

  it('the pure module reads nothing: no prisma, repository, loader or server-only import', () => {
    const imports = PURE.match(/^import .*$/gm) ?? [];
    assert.deepEqual(imports, []);
    assert.equal(/prisma|Repository|loadNeedsYou|server-only|fetch\(/.test(code(PURE)), false);
  });

  it('never links into Telegram, and uses Connections only to connect, reconnect or manage', () => {
    assert.equal(/t\.me|tg:\/\/|telegram\.org|https?:/.test(VIEW), false);
    const hrefs = [...VIEW.matchAll(/href[=:]\s*\{?([A-Z_]+|'[^']*')/g)].map((m) => m[1]);
    assert.ok(hrefs.length > 0);
    for (const h of hrefs) assert.equal(h, 'CONNECTIONS_HREF');
    const labels = [...VIEW.matchAll(/label: '([^']+)', href: CONNECTIONS_HREF/g)].map((m) => m[1]).sort();
    assert.deepEqual(labels, ['Connect Telegram', 'Reconnect Telegram']);
    assert.match(VIEW, /href=\{CONNECTIONS_HREF\}>\s*Manage connection/);
  });
});

describe('the Chats view, rendered', () => {
  it('shows the summary, the status with Manage connection, the conversations and the activity -- and no body or Telegram link', () => {
    const intel = chatsIntelligence(
      input({
        items: [
          item({ counterparty: 'Acme Buyers', category: 'DECISION_NEEDED', title: 'Wants a yes or no on the cap', deadline: 'by Friday' }),
          item({ counterparty: null, category: 'REQUEST', title: 'Asked for the invoice copy', topic: null, nextStep: null }),
        ],
      }),
    );
    const html = render(<ChatsView intel={intel} time={time} />);
    for (const line of intel.summary) assert.ok(html.includes(line.replace(/'/g, '&#x27;')), line);
    assert.match(html, /Telegram · Ready · Triage on/);
    assert.match(html, /href="\/app\/connections"[^>]*>Manage connection</);
    assert.match(html, /Acme Buyers/);
    assert.ok(html.includes(UNNAMED_CONVERSATION));
    assert.match(html, /Decision/);
    assert.match(html, /Wants a yes or no on the cap/);
    assert.match(html, /Deadline, as the conversation put it: by Friday/);
    assert.match(html, /In Telegram/);
    assert.match(html, /20 messages across 5 conversations/);
    assert.equal(/t\.me|tg:\/\//.test(html), false);
    assert.equal((html.match(/href="/g) ?? []).length, (html.match(/href="\/app\/connections"/g) ?? []).length, 'every link is to Connections');
  });

  it('not connected: the primary action is connecting in Connections; no activity panel', () => {
    const html = render(<ChatsView intel={chatsIntelligence(input({ connection: { ...READY, state: 'NOT_CONNECTED', label: 'Not connected' } }))} time={time} />);
    assert.match(html, /Telegram is not connected/);
    assert.match(html, /class="loop-btn loop-btn--primary" href="\/app\/connections">Connect Telegram</);
    assert.equal(html.includes('aria-label="Activity"'), false);
  });

  it('triage off, quiet, unavailable and a failed read each say what they are', () => {
    assert.match(render(<ChatsView intel={chatsIntelligence(input({ connection: { ...READY, contentAuthorized: false } }))} time={time} />), /AI triage is off/);
    assert.match(render(<ChatsView intel={chatsIntelligence(input({ activity24h: activity(0) }))} time={time} />), /Nothing in your chats needs you/);
    assert.match(render(<ChatsView intel={chatsIntelligence(input({ connection: { ...READY, state: 'FAILED', label: 'Problem' } }))} time={time} />), /Reconnect Telegram/);
    assert.match(render(<ChatsView intel="UNAVAILABLE" time={time} />), /Loop could not read your chats just now/);
    assert.match(render(<ChatsView intel={chatsIntelligence(input({ connection: null }))} time={time} />), /not available to you here/);
  });
});
