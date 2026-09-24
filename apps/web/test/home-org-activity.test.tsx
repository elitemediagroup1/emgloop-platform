// Home's Recent activity reads the organization's Universal Activity feed (2026-09-24).
//
// Before: the executive Home read the latest 20 audit rows directly -- without `audit:view`
// (universal-activity.md §6) -- and filtered them to four action prefixes, so an organization whose
// CallGrid, channel and Brain work was all live read "No business activity recorded yet."
//
// After: Home reads the governed ActivityService for the ORGANIZATION subject, composed from an
// allowlist of organization-level observable-event adapters, with the signed-in viewer and the
// workspace authority the session resolves to. These tests prove:
//   - only allowlisted organization-lane adapters are composed; a private adapter is never a
//     candidate and is never run (a recording fake proves it was not called);
//   - the service still decides: an adapter whose guard the viewer lacks is not run either;
//   - the false "none" is gone when qualifying rows exist, and a failed read is never "none";
//   - the direct, ungated audit read is retired -- audit survives only as one adapter.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PrismaClient } from '@prisma/client';
import {
  ACTIVITY_CONTRACT_VERSION,
  createTimeView,
  deriveIdentitySubject,
  validateActivityItem,
  type ActivityCategory,
  type ActivityItemV1,
} from '@emgloop/shared';
import { ActivityReadModelRepository, ActivityService, type ActivityAdapter } from '@emgloop/database';
import { ACTIVITY_ON_HOME, RecentActivityPanel } from '../src/app/app/_home/front-door-view';
import {
  HOME_ACTIVITY_DOMAINS,
  ORG_ACTIVITY_LIMIT,
  activityEntries,
  auditUpdates,
  homeActivityAdapters,
  type OrgActivity,
} from '../src/app/app/_home/org-activity';

const NY = 'America/New_York';
const NOW = new Date('2026-09-24T15:30:00Z');
const time = createTimeView({ timeZone: NY, source: 'device' }, NOW);
const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const SRC = fileURLToPath(new URL('../src', import.meta.url));
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const ORG = 'org_a';

// --- fixtures ----------------------------------------------------------------------------------------

type Req = { resource: string; action: 'view' };
function item(over: {
  domain: string;
  recordType: string;
  id: string;
  category: ActivityCategory;
  type: string;
  title: string;
  at: string;
  requires: Req[];
  workspace?: string | null;
  userId?: string | null;
  actorKind?: ActivityItemV1['actor']['kind'];
  organizationId?: string;
}): ActivityItemV1 {
  return {
    contractVersion: ACTIVITY_CONTRACT_VERSION,
    key: `${over.recordType}:${over.id}`,
    organizationId: over.organizationId ?? ORG,
    category: over.category,
    type: over.type,
    authority: { domain: over.domain, recordType: over.recordType, recordId: over.id, sequence: null, href: null },
    time: { occurredAt: over.at, occurredAtBasis: 'PROVIDER_REPORTED', recordedAt: over.at, window: null },
    actor: { kind: over.actorKind ?? (over.userId ? 'HUMAN' : 'PROVIDER'), userId: over.userId ?? null, producer: null, producerVersion: null },
    subjects: [],
    participants: [],
    identity: deriveIdentitySubject([]),
    provenance: { source: over.domain, transport: null, epistemic: 'RECORDED', ruleId: null, ruleVersion: null, evidenceCount: null, limitations: [] },
    display: { title: over.title, channel: null, direction: null, stateChange: null, semanticStatus: null },
    access: { requires: over.requires, workspace: over.workspace ?? null },
    sensitivity: { class: 'OPERATIONAL', rawValuesInSource: false, contentInline: false },
  };
}

const callItem = (id: string, at: string) =>
  item({ domain: 'callgrid', recordType: 'marketplace-call', id, category: 'FACT', type: 'COMPLETED', title: 'call completed', at, requires: [{ resource: 'intelligence', action: 'view' }], workspace: 'ADMIN' });
const auditItem = (id: string, action: string, at: string, userId = 'u_dana') =>
  item({ domain: 'audit', recordType: 'audit-log', id, category: 'AUDIT', type: action, title: action, at, requires: [{ resource: 'audit', action: 'view' }], userId });
const channelItem = (id: string, at: string) =>
  item({ domain: 'channel', recordType: 'interaction', id, category: 'COMMUNICATION', type: 'PHONE_CALL', title: 'inbound phone call', at, requires: [{ resource: 'customers', action: 'view' }, { resource: 'intelligence', action: 'view' }] });
const brainItem = (id: string, at: string) =>
  item({ domain: 'brain-execution', recordType: 'brain-event', id, category: 'STATE_CHANGE', type: 'brain.job.succeeded', title: 'Brain analysis completed', at, requires: [{ resource: 'intelligence', action: 'view' }], workspace: 'ADMIN', actorKind: 'SYSTEM' });

/** A recording adapter: says what it requires, and records whether it was ever asked for a page. */
function fakeAdapter(domain: string, opts: { workspace?: string | null; requires: Req[]; items: ActivityItemV1[]; lanes?: string[] }) {
  const calls: string[] = [];
  const adapter: ActivityAdapter = {
    domain,
    workspace: opts.workspace ?? null,
    categories: ['FACT', 'COMMUNICATION', 'AUDIT', 'STATE_CHANGE', 'WORK'],
    supports: (s) => (opts.lanes ?? ['ORGANIZATION']).includes(s.kind),
    requiresFor: () => opts.requires as unknown as ReturnType<ActivityAdapter['requiresFor']>,
    async page() {
      calls.push(domain);
      return { items: opts.items, rowsRead: opts.items.length, suppressed: 0, limitations: [] };
    },
  };
  return { adapter, calls };
}

const GRANTS_ADMIN = new Set(['customers:view', 'intelligence:view', 'audit:view', 'commercialIntelligence:view', 'work:view']);
const iamWith = (grants: ReadonlySet<string>) => ({
  canEach: async (_org: string, _user: string, checks: readonly { resource: string; action: string }[]) => checks.map((c) => grants.has(`${c.resource}:${c.action}`)),
});
const NO_PRISMA = {} as PrismaClient;

function world(grants: ReadonlySet<string> = GRANTS_ADMIN) {
  const channel = fakeAdapter('channel', { requires: [{ resource: 'customers', action: 'view' }, { resource: 'intelligence', action: 'view' }], items: [channelItem('i1', '2026-09-24T14:00:00Z')] });
  const callgrid = fakeAdapter('callgrid', { workspace: 'ADMIN', requires: [{ resource: 'intelligence', action: 'view' }], items: [callItem('c1', '2026-09-24T15:00:00Z')] });
  const audit = fakeAdapter('audit', { requires: [{ resource: 'audit', action: 'view' }], items: [auditItem('a1', 'work.completed', '2026-09-24T14:30:00Z')] });
  const brain = fakeAdapter('brain-execution', { workspace: 'ADMIN', requires: [{ resource: 'intelligence', action: 'view' }], items: [brainItem('b1', '2026-09-24T13:00:00Z')] });
  // Employee-private sources, deliberately declared as if they could serve the organization lane
  // and as if the viewer held their guard: Home must still never compose them.
  const mail = fakeAdapter('mail', { requires: [{ resource: 'customers', action: 'view' }], items: [item({ domain: 'mail', recordType: 'mail', id: 'm1', category: 'COMMUNICATION', type: 'EMAIL', title: 'mail', at: '2026-09-24T15:20:00Z', requires: [{ resource: 'customers', action: 'view' }] })] });
  const telegram = fakeAdapter('telegram', { requires: [{ resource: 'customers', action: 'view' }], items: [] });
  const observations = fakeAdapter('source-observations', { requires: [{ resource: 'customers', action: 'view' }], items: [] });
  const workItems = fakeAdapter('work-os', { workspace: 'ADMIN', requires: [{ resource: 'work', action: 'view' }], items: [], lanes: ['WORK_ITEM'] });
  const all = [channel, callgrid, audit, brain, mail, telegram, observations, workItems];
  const composed = homeActivityAdapters(all.map((a) => a.adapter));
  const service = new ActivityService(NO_PRISMA, { iam: iamWith(grants), readModel: new ActivityReadModelRepository(NO_PRISMA, { adapters: composed }) });
  return { service, composed, calls: () => all.flatMap((a) => a.calls) };
}

const ADMIN_VIEWER = { organizationId: ORG, userId: 'u_owner', workspaceRole: 'ADMIN' };

// --- which adapters -----------------------------------------------------------------------------------

describe('Home composes only organization-level observable-event adapters', () => {
  it('the allowlist is exactly the four organization sources, and matches the real read model’s organization lane', () => {
    assert.deepEqual([...HOME_ACTIVITY_DOMAINS].sort(), ['audit', 'brain-execution', 'callgrid', 'channel']);
    const real = new ActivityReadModelRepository(NO_PRISMA).adaptersFor({ kind: 'ORGANIZATION' });
    const composed = homeActivityAdapters(real);
    assert.deepEqual(composed.map((a) => a.domain).sort(), [...HOME_ACTIVITY_DOMAINS].sort(), 'every organization-lane adapter the read model has today is one Home means to compose');
    for (const a of real) assert.ok((HOME_ACTIVITY_DOMAINS as readonly string[]).includes(a.domain), `${a.domain}: an organization-lane adapter Home has not decided about`);
  });

  it('a private adapter is never composed and never run, even when it claims the organization lane and the viewer holds its guard', async () => {
    const w = world();
    assert.deepEqual(w.composed.map((a) => a.domain).sort(), ['audit', 'brain-execution', 'callgrid', 'channel']);
    const result = await w.service.read(ADMIN_VIEWER, { kind: 'ORGANIZATION' }, { limit: ORG_ACTIVITY_LIMIT });
    assert.equal(result.outcome, 'OK');
    const calls = w.calls();
    for (const privateSource of ['mail', 'telegram', 'source-observations', 'work-os']) assert.equal(calls.includes(privateSource), false, `${privateSource} was run`);
    assert.deepEqual([...calls].sort(), ['audit', 'brain-execution', 'callgrid', 'channel']);
    if (result.outcome !== 'OK') return;
    assert.equal(result.value.items.some((i) => i.authority.domain === 'mail'), false);
    assert.deepEqual(result.value.items.map((i) => i.key), ['marketplace-call:c1', 'audit-log:a1', 'interaction:i1', 'brain-event:b1'], 'newest first');
  });

  it('the service still decides: without audit:view the audit adapter is not run; outside ADMIN the ADMIN sources are not run', async () => {
    const noAudit = world(new Set(['customers:view', 'intelligence:view']));
    await noAudit.service.read(ADMIN_VIEWER, { kind: 'ORGANIZATION' }, { limit: ORG_ACTIVITY_LIMIT });
    assert.equal(noAudit.calls().includes('audit'), false);
    const employee = world(new Set(['customers:view', 'intelligence:view']));
    const r = await employee.service.read({ ...ADMIN_VIEWER, workspaceRole: 'EMPLOYEE' }, { kind: 'ORGANIZATION' }, { limit: ORG_ACTIVITY_LIMIT });
    assert.deepEqual(employee.calls(), ['channel'], 'CallGrid and Brain work are ADMIN surfaces');
    assert.equal(r.outcome, 'OK');
    const nothing = world(new Set());
    assert.equal((await nothing.service.read(ADMIN_VIEWER, { kind: 'ORGANIZATION' })).outcome, 'NOT_AUTHORIZED', 'nothing readable is not an empty feed');
    assert.deepEqual(nothing.calls(), []);
  });

  it('the loader reads the ORGANIZATION subject only, as the session viewer, through the allowlist -- and names no private source', () => {
    const loader = code(read('app/app/_home/org-activity-data.ts'));
    assert.match(loader, /^import 'server-only';/m);
    assert.match(loader, /homeActivityAdapters\(new ActivityReadModelRepository\(prisma\)\.adaptersFor\(\{ kind: 'ORGANIZATION' \}\)\)/);
    assert.match(loader, /new ActivityService\(prisma, \{ readModel: new ActivityReadModelRepository\(prisma, \{ adapters: composed \}\) \}\)/);
    assert.match(loader, /\{ organizationId: session\.organizationId, userId: session\.userId, workspaceRole: resolveWorkspaceRole\(session\) \}/);
    assert.equal((loader.match(/kind: '/g) ?? []).length, 2, 'the ORGANIZATION subject, twice, and no other');
    assert.equal(/INTAKE_RECORD|WORK_ITEM|'CASE'/.test(loader), false);
    for (const privateWord of ['mail', 'Mail', 'telegram', 'Telegram', 'sourceObservation', 'source_observations', 'workItem', 'WorkItem', 'needsYou']) {
      assert.equal(loader.includes(privateWord), false, privateWord);
    }
    // Member names: the session organization's own roster, through its repository; only names the items name.
    assert.match(loader, /repositories\.iam\.listUsers\(session\.organizationId\)\.catch\(\(\) => \[\]\)/);
    assert.match(loader, /roster\.filter\(\(m\) => named\.has\(m\.id\)/);
    assert.equal(loader.includes('prisma.'), false, 'Home touches no table directly');
    // A failure is UNAVAILABLE, never an empty READ.
    assert.match(loader, /\} catch \{\s*return \{ state: 'UNAVAILABLE' \};\s*\}/);
    assert.match(loader, /if \(result\.outcome === 'NOT_AUTHORIZED'\) return \{ state: 'NOT_AUTHORIZED' \};/);
  });

  it('the direct, ungated audit read is retired: audit survives only as one adapter', () => {
    const workspace = code(read('app/app/admin/workspace-home-data.ts'));
    for (const gone of ['repos.audit', 'auditLog', 'recentActivity', 'activityCategory']) assert.equal(workspace.includes(gone), false, gone);
    const home = code(read('app/app/_home/admin-home.tsx'));
    assert.match(home, /loadOrganizationActivity\(session\)/);
    assert.match(home, /<RecentActivityPanel activity=\{activity\} time=\{time\} auditHref=\{auditHref\} \/>/);
    assert.equal(home.includes('recentActivity'), false);
    const review = code(read('app/app/_home/review-data.ts'));
    assert.match(review, /const updates = auditUpdates\(activity\)\.map/, 'the review’s work changes come from the audit adapter’s items');
    assert.equal(review.includes('recentActivity'), false);
    // The employee (module) Home is unchanged: it composes no organization feed.
    const moduleHome = code(read('app/app/_home/module-home.tsx'));
    for (const absent of ['RecentActivityPanel', 'loadOrganizationActivity', 'ActivityService']) assert.equal(moduleHome.includes(absent), false, absent);
  });
});

// --- how it reads -------------------------------------------------------------------------------------

const readFeed = (items: ActivityItemV1[], names: [string, string][] = [['u_dana', 'Dana Rivera']]): OrgActivity => ({
  state: 'READ',
  items,
  sources: HOME_ACTIVITY_DOMAINS.map((domain) => ({ domain, rowsRead: 1, refused: 0, suppressed: 0, skipped: null, limitations: [] })),
  names: new Map(names),
});

describe('Recent activity on Home: events labelled by their truth category, never a false "none"', () => {
  it('the fixtures are valid activity.v1 items', () => {
    for (const i of [callItem('c1', '2026-09-24T15:00:00Z'), auditItem('a1', 'work.completed', '2026-09-24T14:30:00Z'), channelItem('i1', '2026-09-24T14:00:00Z'), brainItem('b1', '2026-09-24T13:00:00Z')]) {
      assert.deepEqual(validateActivityItem(i), [], i.key);
    }
  });

  it('with qualifying rows the card shows them -- each with its truth category -- and never says "none"', () => {
    const feed = readFeed([callItem('c1', '2026-09-24T15:00:00Z'), auditItem('a1', 'work.completed', '2026-09-24T14:30:00Z'), channelItem('i1', '2026-09-24T14:00:00Z'), brainItem('b1', '2026-09-24T13:00:00Z')]);
    const out = html(<RecentActivityPanel activity={feed} time={time} auditHref="/crm/audit" />);
    assert.match(out, /id="recent-activity"/);
    assert.match(out, /data-home-activity="READ"/);
    assert.equal(out.includes('No organization activity recorded yet'), false);
    assert.equal(out.includes('No business activity recorded yet'), false);
    assert.match(out, /data-truth="FACT"[\s\S]*CallGrid call completed/);
    assert.match(out, /data-truth="AUDIT"[\s\S]*Work completed · Dana Rivera/);
    assert.match(out, /data-truth="COMMUNICATION"[\s\S]*Inbound phone call/);
    assert.match(out, /data-truth="STATE_CHANGE"[\s\S]*Brain analysis completed · Loop/);
    assert.match(out, /Recorded by its authority/, 'events, not intelligence');
    assert.equal(out.includes('Interpretation, not a recorded fact'), false);
    assert.match(out, /Organization events from channel facts, CallGrid calls, the audit log, Brain work/);
    assert.match(out, /href="\/crm\/audit"[^>]*>Audit log →/);
    assert.equal(html(<RecentActivityPanel activity={feed} time={time} auditHref={null} />).includes('href='), false, 'no link the rail would not offer');
  });

  it('compact: at most six rows', () => {
    const many = readFeed(Array.from({ length: 9 }, (_, i) => callItem(`c${i}`, `2026-09-24T1${i}:00:00Z`)));
    assert.equal(ACTIVITY_ON_HOME, 6);
    assert.equal((html(<RecentActivityPanel activity={many} time={time} auditHref={null} />).match(/data-truth="/g) ?? []).length, 6);
  });

  it('empty only when the read ran and returned nothing; a failed read and an unauthorized seat are never "none"', () => {
    assert.match(html(<RecentActivityPanel activity={readFeed([])} time={time} auditHref={null} />), /No organization activity recorded yet\./);
    const failed = html(<RecentActivityPanel activity={{ state: 'UNAVAILABLE' }} time={time} auditHref="/crm/audit" />);
    assert.match(failed, /Loop could not read recent activity just now/);
    assert.equal(failed.includes('No organization activity recorded'), false);
    const refused = html(<RecentActivityPanel activity={{ state: 'NOT_AUTHORIZED' }} time={time} auditHref={null} />);
    assert.match(refused, /No organization activity source is open to your role\./);
    assert.equal(refused.includes('recorded yet'), false);
  });

  it('an actor the organization cannot name is a workspace member, never an id; a row never carries a contact value', () => {
    const entries = activityEntries(readFeed([auditItem('a9', 'customer.updated', '2026-09-24T12:00:00Z', 'u_unknown')], []), time, 6);
    assert.equal(entries[0]!.story, 'Customer updated · A workspace member');
    assert.equal(entries[0]!.story.includes('u_unknown'), false);
  });

  it('the review’s work changes are the audit adapter’s business acts only', () => {
    const feed = readFeed([callItem('c1', '2026-09-24T15:00:00Z'), auditItem('a1', 'work.completed', '2026-09-24T14:30:00Z'), auditItem('a2', 'login.succeeded', '2026-09-24T14:20:00Z'), auditItem('a3', 'invitation.accepted', '2026-09-24T14:10:00Z')]);
    const updates = auditUpdates(feed);
    assert.deepEqual(updates.map((u) => [u.id, u.what, u.area, u.who]), [['a1', 'Work completed', 'Work', 'Dana Rivera'], ['a3', 'Invitation accepted', 'Team', 'Dana Rivera']]);
    assert.deepEqual(auditUpdates({ state: 'UNAVAILABLE' }), []);
    assert.deepEqual(auditUpdates(null), []);
  });
});
