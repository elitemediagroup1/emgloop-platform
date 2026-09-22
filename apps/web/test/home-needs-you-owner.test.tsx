// NEEDS YOU reaches the OWNER's Home, and stays the OWNER's own.
//
// THE DEFECT THIS GUARDS. Until 2026-09-22 the page built the "Needs you" element only for the module
// Home. OWNER, ADMIN and MANAGER resolve to the ADMIN workspace role and render the executive Home,
// which never received it -- so an OWNER whose Telegram triage had raised three OPEN, employee-private
// WorkItems saw none of them (staging, 2026-09-22). The items were real, scoped correctly, and invisible.
//
// TWO PROPERTIES, PROVED SEPARATELY:
//   1. ROLE: an OWNER lands on the executive Home, and that Home now places the SAME element the module
//      Home does -- built once by the page, from one loader, with the session's principal. There is no
//      second "Needs you" implementation, and the element is not folded into the executive "Needs
//      attention" feed, which lists organization decisions, not a person's private items.
//   2. SCOPE: the loader the OWNER's Home uses returns the OWNER's own items and nobody else's. It is
//      driven here through the REAL WorkItemRepository (its own (organizationId, userId) scope), over a
//      fake database that holds another employee's items in the same organization and an item in
//      another organization. Authority does not widen a private read: an OWNER sees only their own.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import { createTimeView } from '@emgloop/shared';

import { NeedsYou } from '../src/app/app/_home/needs-you';
import { loadNeedsYou } from '../src/daily-loop/needs-you';
import { resolveWorkspaceRole } from '../src/workspaces/role-router';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ').replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');

const ORG = 'org_home';
const OTHER_ORG = 'org_elsewhere';
const OWNER = { organizationId: ORG, userId: 'user_matt' };
const EMPLOYEE = { organizationId: ORG, userId: 'user_charlie' };

/** One OPEN, MODEL-produced, Telegram-tagged NEEDS_YOU row, as the content-triage sweep writes it. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: 'w_' + Math.random().toString(36).slice(2, 8),
    organizationId: ORG,
    userId: OWNER.userId,
    recurrenceKey: 'telegram.content.triage:ck_' + Math.random().toString(36).slice(2, 8),
    class: 'NEEDS_YOU',
    subjectKind: 'THREAD',
    subjectRef: 'telegram_conversation:ck',
    title: 'Client asks to move the Thursday call',
    producerKind: 'MODEL',
    producerId: 'telegram.content.triage',
    producerVersion: '1.1.0',
    evidence: { provider: 'TELEGRAM', category: 'REQUEST' },
    firstDetectedAt: new Date('2026-09-22T04:00:00Z'),
    lastDetectedAt: new Date('2026-09-22T04:01:00Z'),
    detectionCount: 1,
    state: 'OPEN',
    stateChangedAt: new Date('2026-09-22T04:00:00Z'),
    snoozedUntil: null,
    resolvedAt: null,
    outcome: null,
    ...over,
  };
}

/**
 * A database of work items that honours the equality filters `WorkItemRepository.items` sends
 * (organizationId, userId, state) and records every query. It is deliberately dumb: it does not know
 * who is asking, so anything it withholds was withheld by the repository's own scope.
 */
function fakeDb(rows: ReturnType<typeof row>[]) {
  const queries: Array<Record<string, unknown>> = [];
  const client = {
    workItem: {
      async findMany(args: { where: Record<string, unknown>; take?: number }) {
        queries.push(args.where);
        const matches = rows.filter((r) => Object.entries(args.where).every(([k, v]) => (r as Record<string, unknown>)[k] === v));
        return matches.slice(0, args.take ?? matches.length);
      },
    },
  };
  return { client: client as never, queries };
}

describe('an OWNER sees their own "Needs you" items on the executive Home', () => {
  it('OWNER, ADMIN and MANAGER resolve to the executive Home; EMPLOYEE to the module Home', () => {
    for (const systemRole of ['OWNER', 'ADMIN', 'MANAGER'] as const) assert.equal(resolveWorkspaceRole({ systemRole }), 'ADMIN', systemRole);
    assert.equal(resolveWorkspaceRole({ systemRole: 'EMPLOYEE' }), 'EMPLOYEE');
  });

  it('the page builds ONE element from ONE loader with the session principal, and hands it to BOTH Homes', () => {
    const page = code(read('../src/app/app/page.tsx'));
    // Loaded once, as the viewer, for every role -- before the branch.
    assert.match(page, /settle\(\(\) => loadNeedsYou\(principal\)\)/);
    assert.match(page, /const principal = \{ organizationId: session\.organizationId, userId: session\.userId \};/);
    const built = page.match(/const needsYouElement = <NeedsYou items=\{needsYou\} time=\{time\} \/>;/g) ?? [];
    assert.equal(built.length, 1, 'the element is built exactly once');
    // ...and the SAME element reaches the executive Home (the OWNER branch) and the module Home.
    const adminBranch = page.slice(page.indexOf("role === 'ADMIN'"), page.indexOf('<ModuleHome'));
    assert.match(adminBranch, /<AdminHome[\s\S]*?needsYou=\{needsYouElement\}/, 'the executive Home receives it');
    const moduleBranch = page.slice(page.indexOf('<ModuleHome'));
    assert.match(moduleBranch, /needsYou=\{needsYouElement\}/, 'the module Home receives the same element');
    // No second element and no second loader anywhere on the page.
    assert.equal((page.match(/<NeedsYou /g) ?? []).length, 1);
    assert.equal((page.match(/loadNeedsYou\(/g) ?? []).length, 1);
  });

  it('the executive Home places it with the person\'s own day and mail -- never inside the executive feeds', () => {
    const home = code(read('../src/app/app/_home/admin-home.tsx'));
    // It only PLACES the element: it neither loads it nor renders its own copy.
    assert.equal(home.includes('loadNeedsYou'), false, 'no second loader in the executive Home');
    assert.equal(home.includes('<NeedsYou'), false, 'no second element in the executive Home');
    assert.match(home, /needsYou\?: ReactNode;/, 'it accepts the element the page built');

    const body = home.slice(home.indexOf('export async function AdminHome'));
    const aside = body.slice(body.indexOf('className="loop-exec__side"'), body.indexOf('</aside>'));
    assert.match(aside, /\{needsYou\}/, 'rendered inside the personal aside, beside the day and the mailbox');
    // The executive feeds list organization decisions; a private, source-tagged item is not one.
    const feeds = body.slice(body.indexOf('className="loop-exec__feeds"'), body.indexOf('loop-exec__ops'));
    assert.equal(feeds.includes('needsYou'), false, 'not mixed into Key updates or Needs attention');
    const attention = home.slice(home.indexOf('function NeedsAttention'), home.indexOf('export async function AdminHome'));
    assert.equal(attention.includes('needsYou'), false, 'the Needs attention feed does not read it');
  });

  it('the element an OWNER receives renders their items, source-labelled and minimized', () => {
    const time = createTimeView({ timeZone: 'America/New_York', source: 'device' }, new Date('2026-09-22T05:00:00Z'));
    const html = renderToStaticMarkup(
      <NeedsYou
        items={[{ id: 'w1', provider: 'TELEGRAM', sourceLabel: 'Telegram', title: 'Client asks to move the Thursday call', category: 'REQUEST', counterparty: null, topic: null, nextStep: null, deadline: null, at: new Date('2026-09-22T04:01:00Z'), detectionCount: 1 }]}
        time={time}
      />,
    );
    assert.match(html, /Needs you/);
    assert.match(html, /data-needs-you-provider="TELEGRAM"/);
    assert.match(html, /Client asks to move the Thursday call/);
  });
});

describe('an OWNER\'s "Needs you" is the OWNER\'s own, and widens to nobody else\'s', () => {
  const mine = [row({ id: 'w_mine_1', title: 'Client asks to move the Thursday call' }), row({ id: 'w_mine_2', title: 'Supplier confirms the new cap' })];
  const charlies = [row({ id: 'w_charlie', userId: EMPLOYEE.userId, title: 'Charlie: vendor wants a decision by Friday' })];
  const elsewhere = [row({ id: 'w_elsewhere', organizationId: OTHER_ORG, userId: OWNER.userId, title: 'Another organization entirely' })];

  it('the OWNER gets exactly their own open items -- not another employee\'s, not another organization\'s', async () => {
    const db = fakeDb([...mine, ...charlies, ...elsewhere]);
    const items = await loadNeedsYou(OWNER, 6, db.client);
    assert.deepEqual(items.map((i) => i.id).sort(), ['w_mine_1', 'w_mine_2']);
    for (const item of items) assert.equal(item.provider, 'TELEGRAM');
    // Items raised before the v2.1 fields existed load with those fields absent -- never invented.
    for (const item of items) assert.deepEqual([item.counterparty, item.topic, item.nextStep, item.deadline], [null, null, null, null]);
    const titles = items.map((i) => i.title).join('\n');
    assert.equal(titles.includes('Charlie'), false, "another employee's private item is not the OWNER's to see");
    assert.equal(titles.includes('Another organization'), false, 'nor is another organization\'s');
  });

  it('the read is scoped by BOTH ids at the data layer, for an OWNER as for anyone', async () => {
    const db = fakeDb([...mine, ...charlies]);
    await loadNeedsYou(OWNER, 6, db.client);
    assert.equal(db.queries.length, 1);
    assert.deepEqual(db.queries[0], { organizationId: ORG, userId: OWNER.userId, state: 'OPEN' });
  });

  it('the same loader gives the other employee only theirs: authority runs neither way', async () => {
    const db = fakeDb([...mine, ...charlies]);
    const items = await loadNeedsYou(EMPLOYEE, 6, db.client);
    assert.deepEqual(items.map((i) => i.id), ['w_charlie']);
    assert.deepEqual(db.queries[0], { organizationId: ORG, userId: EMPLOYEE.userId, state: 'OPEN' });
  });

  it('a closed item, a rule-raised item, and an item whose evidence names no source are not shown', async () => {
    const db = fakeDb([
      row({ id: 'w_resolved', state: 'RESOLVED', resolvedAt: new Date(), outcome: 'HANDLED' }),
      row({ id: 'w_rule', producerKind: 'RULE', producerId: 'mail.needs-reply' }),
      row({ id: 'w_untagged', evidence: {} }),
      row({ id: 'w_shown' }),
    ]);
    const items = await loadNeedsYou(OWNER, 6, db.client);
    assert.deepEqual(items.map((i) => i.id), ['w_shown']);
  });
});
