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

import { composeBriefing } from '../src/app/app/_home/briefing';
import { NeedsAttention } from '../src/app/app/_home/briefing-view';
import { loadNeedsYou, type NeedsYouItem } from '../src/daily-loop/needs-you';
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

  it('the page reads the items ONCE, from ONE loader, with the session principal, and hands the same items to BOTH Homes', () => {
    const page = code(read('../src/app/app/page.tsx'));
    assert.match(page, /settle\(\(\) => loadNeedsYou\(principal\)\)/);
    assert.match(page, /const principal = \{ organizationId: session\.organizationId, userId: session\.userId \};/);
    assert.equal((page.match(/loadNeedsYou\(/g) ?? []).length, 1, 'read exactly once');
    assert.match(page, /const needsYou = needsYouResult\.ok \? needsYouResult\.value : \[\];/);
    assert.match(page, /<AdminHome[^>]*needsYou=\{needsYou\}/, 'the executive Home receives the items');
    assert.match(page, /<ModuleHome[^>]*needsYou=\{needsYou\}/, 'the module Home receives the same items');
    assert.equal(page.includes('<CreatorHome seat={creatorSeat} time={time} />'), true, 'the creator Home receives nothing of them');
  });

  it('the executive Home carries them as data into the pure composer -- it neither loads them nor lets the executive review read them', () => {
    const home = code(read('../src/app/app/_home/admin-home.tsx'));
    assert.equal(home.includes('loadNeedsYou'), false, 'no second loader in the executive Home');
    assert.match(home, /needsYou: readonly NeedsYouItem\[\];/, 'it accepts the items the page read');
    assert.match(home, /composeBriefing\(\{[\s\S]*?needsYou,/, 'handed to the composer as data');
    const review = code(read('../src/app/app/_home/review-data.ts'));
    assert.equal(review.includes('needsYou'), false, 'the executive review never reads or counts them');
    assert.equal(review.includes('loadNeedsYou'), false);
    const composer = code(read('../src/app/app/_home/briefing.ts'));
    for (const forbidden of ["from '@emgloop/database'", 'prisma', 'loadNeedsYou', 'fetch(']) assert.equal(composer.includes(forbidden), false, forbidden);
    // Interleaved for display only: each row keeps its provider, and the review's own totals are untouched.
    assert.match(composer, /provider: 'TELEGRAM',/);
    assert.match(composer, /attentionElsewhere: input\.review\?\.attentionElsewhere \?\? \[\],/);
  });

  it('the rows an OWNER receives render their items, source-labelled, minimized and without a fabricated link', () => {
    const item: NeedsYouItem = { id: 'w1', provider: 'TELEGRAM', sourceLabel: 'Telegram', title: 'Client asks to move the Thursday call', category: 'REQUEST', counterparty: null, topic: null, nextStep: null, deadline: null, at: new Date('2026-09-22T04:01:00Z'), detectionCount: 1 };
    const time = createTimeView({ timeZone: 'America/New_York', source: 'device' }, new Date('2026-09-22T12:00:00Z'));
    const briefing = composeBriefing({ now: time.now, review: null, period: null, headlines: null, needsYou: [item], day: null, dayFailed: false, mail: null, mailFailed: false, callgrid: null, workDue: [], connectionsHref: '/app/connections', headlinesHref: '/app/admin/headlines' });
    const html = renderToStaticMarkup(<NeedsAttention briefing={briefing} time={time} />);
    assert.match(html, /Needs your attention/);
    assert.match(html, /data-briefing-provider="TELEGRAM"/);
    assert.match(html, /Client asks to move the Thursday call/);
    assert.match(html, /Telegram/);
    assert.match(html, /In Telegram/);
    assert.equal(html.includes('href='), false, 'a private chat has no link, so none is invented');
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
