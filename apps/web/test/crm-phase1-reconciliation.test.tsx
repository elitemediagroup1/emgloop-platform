// Phase 1 reconciliation — the audit's remaining findings, pinned.
//
// Behavioural where the code runs without a request: search against fake
// repositories, repository ordering against a recording Prisma, timeline
// primitives rendered to HTML, nav visibility as a pure function. Source-level
// where the subject is a server page that needs a session to render.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AuditRepository,
  ConversationsRepository,
  CrmRepository,
  matrixAllows,
} from '@emgloop/database';
import {
  AuditEventRow, EmptyTimeline, Timeline, TimelineItem,
  fromAuditView, fromDerivedSignal, fromInboxItem, fromInteraction,
} from '../src/crm/timeline';
import { SEARCH_LIMITS, kindLabel, runSearch, type SearchRepos } from '../src/crm/search-data';
import { LOOP_NAV, navItemVisible } from '../src/workspaces/config';
import { resolveWorkspaceRole } from '../src/workspaces/role-router';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const code = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const render = (el: unknown) => renderToStaticMarkup(el as never);

const ORG = 'org_session';
const CUSTOMER = code(read('../src/app/crm/customers/[id]/page.tsx'));
const COMMAND = code(read('../src/app/crm/page.tsx'));

/** A Prisma stand-in that records every call's arguments and returns canned rows. */
function recordingPrisma(rows: Record<string, unknown> = {}) {
  const calls: { model: string; method: string; args: any }[] = [];
  const client: any = new Proxy({}, {
    get: (_t, model: string) => {
      if (model === '$transaction') return (ops: Promise<unknown>[]) => Promise.all(ops);
      return new Proxy({}, {
        get: (_m, method: string) => async (args: unknown) => {
          calls.push({ model, method, args });
          const v = rows[`${model}.${method}`];
          return typeof v === 'function' ? (v as (a: unknown) => unknown)(args) : v ?? (method === 'count' ? 0 : method.startsWith('findFirst') || method === 'findUnique' ? null : []);
        },
      });
    },
  });
  return { client: client as never, calls };
}

/**
 * Remove every branch rendered only when `guard` is true: `guard ? ( … )`,
 * including `x && guard ? ( … )` and `: guard ? ( … )`. A negated `!guard ? (`
 * is NOT a permission branch and is left in place, so an inverted gate fails.
 */
function stripGuarded(src: string, guard: string): string {
  const pattern = new RegExp(`(?<![!\\w])${guard}\\s*\\?\\s*\\(`);
  let out = src;
  for (;;) {
    const m = pattern.exec(out);
    if (!m) return out;
    const at = m.index;
    let depth = 0;
    let i = at + m[0].length - 1;
    for (; i < out.length; i++) {
      if (out[i] === '(') depth++;
      else if (out[i] === ')' && --depth === 0) break;
    }
    out = out.slice(0, at) + out.slice(i + 1);
  }
}

// ---------------------------------------------------------------------------

describe('Derived signals are labelled as derived, never as recorded facts', () => {
  const signal = { id: 'sig_1', key: 'next_best_action', label: 'Call back within 1 hour', type: 'CUSTOM', source: 'next-best-action-service', observedAt: new Date('2026-07-01T12:00:00Z'), confidence: 0.87 };

  it('the adapter marks the source derived and names the producing service', () => {
    const entry = fromDerivedSignal(signal);
    assert.equal(entry.source, 'derived-signal');
    assert.equal(entry.actor, 'next-best-action-service');
    const html = render(<Timeline><TimelineItem entry={entry} /></Timeline>);
    assert.match(html, /tl-badge tl-badge--derived/);
    assert.match(html, /Derived Signal/);
    assert.equal(/Domain Event|0\.87|87%|confidence/i.test(html), false, 'no event label and no confidence');
  });

  it('a signal with no recorded producer says so', () => {
    assert.equal(fromDerivedSignal({ ...signal, source: null }).actor, 'Unrecorded producer');
  });

  it('the customer record renders signals only through the derived adapter', () => {
    const tab = CUSTOMER.slice(CUSTOMER.indexOf("activeTab === 'Signals'"), CUSTOMER.indexOf("activeTab === 'AI Activity'"));
    assert.match(tab, /<h2>Derived signals<\/h2>/);
    assert.match(tab, /entry=\{fromDerivedSignal\(s\)\}/);
    assert.equal(/source: 'event'/.test(tab), false);
    assert.match(tab, /not recorded facts/);
    assert.match(CUSTOMER, /<span className="k">Derived signals<\/span>/);
  });
});

describe('AI Activity contains only what an AI actor did', () => {
  it('appointments are not AI activity by kind', () => {
    const filter = CUSTOMER.slice(CUSTOMER.indexOf('const aiActivity'), CUSTOMER.indexOf('const tabHref'));
    assert.equal(/APPOINTMENT/.test(filter), false);
    assert.match(filter, /actorLabel\(interactionActorType\(i\.payload\)\) === 'AI'/);
  });

  it('a customer-requested appointment keeps its real actor', () => {
    const entry = fromInteraction({ id: 'ix', kind: 'APPOINTMENT', channel: 'WEB_CHAT', direction: 'INBOUND', summary: 'Appointment request', occurredAt: new Date(), payload: { actorType: 'CUSTOMER' } });
    assert.equal(entry.actorType, 'CUSTOMER');
  });
});

describe('Navigation', () => {
  const items = LOOP_NAV.nav.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label })));

  it('no item claims a Calendar that does not exist; the inbox is named as the page names itself', () => {
    assert.equal(items.some((i) => i.label === 'Calendar'), false);
    const inbox = items.find((i) => i.href === '/crm/inbox');
    assert.equal(inbox?.label, 'Inbox');
    assert.match(read('../src/app/crm/inbox/page.tsx'), /<h1 className="crm-h1">Inbox<\/h1>/);
  });

  it('Headlines links to Commercial Intelligence\'s governed route, under Intelligence', () => {
    const headlines = items.find((i) => i.label === 'Headlines');
    assert.ok(headlines);
    assert.equal(headlines!.href, '/app/admin/headlines');
    assert.equal(headlines!.group, 'Intelligence');
    assert.deepEqual(headlines!.requires, { resource: 'commercialIntelligence', action: 'view' });
    assert.equal(headlines!.workspace, 'ADMIN');
  });

  it('those two gates are exactly the ones the destination enforces, in the page itself', () => {
    const page = code(read('../src/app/app/admin/headlines/page.tsx'));
    assert.match(page, /requireWorkspace\('ADMIN'\)/);
    assert.match(page, /requirePermission\('commercialIntelligence', 'view'\)/);
    assert.match(code(read('../src/app/app/admin/layout.tsx')), /requireWorkspace\('ADMIN'\)/);
  });

  it('a user whose workspace the destination would redirect is not shown the item', () => {
    const headlines = items.find((i) => i.label === 'Headlines')!;
    assert.equal(navItemVisible(headlines, { permitted: true, workspace: 'ADMIN' }), true);
    assert.equal(navItemVisible(headlines, { permitted: false, workspace: 'ADMIN' }), false);
    assert.equal(navItemVisible(headlines, { permitted: true, workspace: 'EMPLOYEE' }), false);
    assert.equal(navItemVisible(headlines, { permitted: true, workspace: 'CLIENT' }), false);
    const people = items.find((i) => i.href === '/crm/customers')!;
    assert.equal(navItemVisible(people, { permitted: true, workspace: 'EMPLOYEE' }), true, 'ungated CRM items are unaffected');
  });

  it('EMPLOYEE and READ_ONLY hold the read grant but not the workspace — which is why both gates exist', () => {
    for (const role of ['EMPLOYEE', 'READ_ONLY']) {
      assert.equal(matrixAllows(role, 'commercialIntelligence', 'view'), true, role);
      assert.notEqual(resolveWorkspaceRole({ systemRole: role }), 'ADMIN', role);
    }
    for (const role of ['OWNER', 'ADMIN', 'MANAGER']) assert.equal(resolveWorkspaceRole({ systemRole: role }), 'ADMIN', role);
  });

  it('the shell applies the role gate and the permission gate for every item', () => {
    const shell = code(read('../src/workspaces/WorkspaceShell.tsx'));
    assert.match(shell, /const groups = await navFor\(session\);/);
    const access = code(read('../src/workspaces/nav-access.ts'));
    assert.match(access, /workspace: resolveWorkspaceRole\(session\),/);
    assert.match(access, /repositories\.iam\.canEach\(session\.organizationId, session\.userId, checks\)/);
    const config = code(read('../src/workspaces/config.ts'));
    assert.match(config, /navItemVisible\(item, \{\s*permitted: item\.requires \? access\.permitted\(item\) : true,\s*workspace: access\.workspace,\s*\}\)/);
  });
});

describe('Needs Attention composes Commercial Intelligence, and only for people who can open it', () => {
  it('uses one rule for visibility: the ADMIN workspace and commercialIntelligence:view', () => {
    const access = code(read('../src/crm/headlines-access.ts'));
    assert.match(access, /resolveWorkspaceRole\(session\) !== 'ADMIN'\) return false;/);
    assert.match(access, /hasPermission\('commercialIntelligence', 'view'\)/);
  });

  it('decides before reading, and reads only through CI\'s own loader', () => {
    const decide = COMMAND.indexOf('canOpenHeadlines(ctx.session)');
    const load = COMMAND.indexOf('loadAttention(ctx.organizationId)');
    assert.ok(decide > -1 && load > decide);
    assert.match(COMMAND, /showHeadlines \? loadAttention\(ctx\.organizationId\) : Promise\.resolve\(null\)/);
    assert.match(COMMAND, /from '\.\.\/app\/admin\/headlines\/headlines-data'/);
    assert.equal(/headlines\.(list|get|record|count)\(|prisma|HeadlineRepository/.test(COMMAND), false, 'no CRM-owned headline read');
  });

  it('renders CI\'s governed state, a named failure, and links to the existing Headlines routes', () => {
    const start = COMMAND.indexOf('{attention ? (');
    const end = COMMAND.indexOf('className="ds-grid cols-3"', start);
    assert.ok(start > -1 && end > start, 'the card precedes the main grid');
    const card = COMMAND.slice(start, end);
    assert.match(card, /<AttentionBanner attention=\{attention\.value\.attention\} \/>/);
    assert.match(card, /<ReadError what=\{attention\.what\}/);
    const hrefs = [...card.matchAll(/href=(?:"([^"]+)"|\{`([^`]+)`\})/g)].map((m) => m[1] ?? m[2]);
    assert.ok(hrefs.length >= 2);
    for (const h of hrefs) assert.match(h!, /^\/app\/admin\/headlines(\/\$\{encodeURIComponent\(h\.id\)\})?$/, h);
    assert.equal(/headlines\.length === 0|No headlines/.test(card), false, 'the governed banner, not an array length, says what an empty list means');
  });
});

describe('The customer record offers only the controls a user may use', () => {
  const ACTIONS = read('../src/crm/actions.ts');
  const permissionOf = (name: string) =>
    ACTIONS.slice(ACTIONS.indexOf(`export async function ${name}`)).match(/requirePermission\('(\w+)', '(\w+)'\)/)!.slice(1).join(':');

  it('each gate matches the permission its action enforces', () => {
    assert.equal(permissionOf('setStatusAction'), 'pipeline:update');
    for (const a of ['setAssignmentAction', 'addTagAction', 'removeTagAction', 'addNoteAction', 'updateCustomerFieldsAction']) {
      assert.equal(permissionOf(a), 'customers:update', a);
    }
    assert.match(CUSTOMER, /hasPermission\('customers', 'update'\)/);
    assert.match(CUSTOMER, /hasPermission\('pipeline', 'update'\)/);
  });

  it('no form or edit entry point exists outside its permission branch', () => {
    const ungated = stripGuarded(stripGuarded(CUSTOMER, 'canUpdateCustomer'), 'canMoveIntake');
    assert.equal(/action=\{/.test(ungated), false, 'a form renders without its permission');
    assert.equal(/tabHref\('Edit'\)/.test(ungated), false, 'the edit link renders without customers:update');
    const statusBranch = CUSTOMER.slice(CUSTOMER.indexOf('{canMoveIntake ? ('));
    assert.ok(statusBranch.indexOf('action={setStatusAction}') > -1);
  });

  it('the Edit section is not offered, or reachable by URL, without customers:update', () => {
    assert.match(CUSTOMER, /const visibleTabs = TABS\.filter\(\(t\) => t !== 'Edit' \|\| canUpdateCustomer\);/);
    assert.match(CUSTOMER, /\(visibleTabs as readonly string\[\]\)\.includes\(requestedTab\)/);
    assert.match(CUSTOMER, /tabs=\{visibleTabs\.map/);
    assert.match(CUSTOMER, /activeTab === 'Edit' && canUpdateCustomer/);
  });

  it('a read-only user still sees the values the controls would change', () => {
    assert.match(CUSTOMER, /<span className="k">Current<\/span><span className="v">\{ws\.status\}<\/span>/);
    assert.match(CUSTOMER, /\{ws\.assignedHumanName \|\| 'Unassigned'\}/);
  });
});

describe('The customer record is framed as a legacy intake record in a workspace', () => {
  it('names the record type, the workspace from the session, and what its status is not', () => {
    assert.match(CUSTOMER, /<p className="ds-eyebrow crm-record-type">Person \/ Intake Record<\/p>/);
    assert.match(CUSTOMER, /crmRepos\.organizations\.findById\(organizationId\)/);
    assert.match(CUSTOMER, /Legacy customer intake record/);
    assert.match(CUSTOMER, /not an Opportunity stage/);
  });

  it('links to its activity page, naming audit only for those who may see it', () => {
    assert.match(CUSTOMER, /href=\{`\/crm\/customers\/\$\{cid\}\/activity`\}/);
    assert.match(CUSTOMER, /\{canViewAudit \? 'Activity & audit' : 'Activity'\}/);
  });
});

describe('Timeline ordering is deterministic', () => {
  it('the inbox feed and audit list break timestamp ties on id', async () => {
    const inbox = recordingPrisma();
    await new CrmRepository(inbox.client).inboxFeed(ORG, 10);
    assert.deepEqual(inbox.calls[0]!.args.orderBy, [{ occurredAt: 'desc' }, { id: 'desc' }]);
    assert.equal(inbox.calls[0]!.args.where.organizationId, ORG);

    const audit = recordingPrisma();
    await new AuditRepository(audit.client).list(ORG, { take: 5 });
    assert.deepEqual(audit.calls[0]!.args.orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('a customer record reads every timeline within the organization, tie-broken on id', async () => {
    const { client, calls } = recordingPrisma({
      'customer.findFirst': { id: 'c1', organizationId: ORG, firstName: 'A', lastName: 'B', attributes: {} },
    });
    await new CrmRepository(client).getWorkspace(ORG, 'c1');
    for (const model of ['interaction', 'booking', 'signal', 'conversation']) {
      const call = calls.find((c) => c.model === model)!;
      assert.equal(call.args.where.organizationId, ORG, model);
      assert.deepEqual(call.args.orderBy.at(-1), { id: 'desc' }, model);
    }
    const conv = calls.find((c) => c.model === 'conversation')!;
    assert.deepEqual(conv.args.include.messages.orderBy.at(-1), { id: 'asc' });
  });

  it('customer activity with equal timestamps comes out in the same order whatever order it was read in', async () => {
    const at = new Date('2026-07-01T00:00:00Z');
    const audits = [{ id: 'a2', action: 'x', metadata: {}, createdAt: at }, { id: 'a9', action: 'y', metadata: {}, createdAt: at }];
    const events = [{ id: 'e5', name: 'z', occurredAt: at }];
    const run = async (a: unknown[], e: unknown[]) => {
      const { client } = recordingPrisma({ 'auditLog.findMany': a, 'domainEvent.findMany': e });
      return (await new ConversationsRepository(client).customerActivity(ORG, 'c1', 10, { includeAudit: true })).map((r) => r.id);
    };
    const forward = await run(audits, events);
    const reversed = await run([...audits].reverse(), [...events].reverse());
    assert.deepEqual(forward, reversed);
    assert.deepEqual(forward, ['e5', 'a9', 'a2']);
  });
});

describe('Timeline primitives', () => {
  it('mixed sources render together, each stating its own provenance', () => {
    const html = render(
      <Timeline>
        <TimelineItem entry={fromInboxItem({ id: 'i', customerName: 'Dana', kind: 'SMS', channel: 'SMS', direction: 'inbound', summary: 'Hi', actorType: 'CUSTOMER', occurredAt: '2026-07-01T00:00:03Z' })} />
        <AuditEventRow entry={fromAuditView({ id: 'a', action: 'customer.updated', actorType: 'HUMAN', actorName: 'Jordan', entityType: 'customer', entityId: 'c', createdAt: '2026-07-01T00:00:02Z' })} />
        <TimelineItem entry={fromDerivedSignal({ id: 's', key: 'lead.received', label: null, type: 'CUSTOM', source: 'signal-registry', observedAt: '2026-07-01T00:00:01Z' })} />
      </Timeline>,
    );
    const order = ['Interaction', 'Audit', 'Derived Signal'].map((l) => html.indexOf(`tl-provenance">${l}<`));
    assert.ok(order.every((i) => i > -1), 'every provenance label present');
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'rendered in the order given — primitives never reorder');
  });

  it('a missing actor is stated rather than left blank', () => {
    const html = render(<Timeline><AuditEventRow entry={fromAuditView({ id: 'a', action: 'x', actorType: '', actorName: '', entityType: null, entityId: null, createdAt: '2026-07-01T00:00:00Z' })} /></Timeline>);
    assert.match(html, /tl-actor__name">Unknown actor</);
  });

  it('audit metadata never reaches the rendered row', () => {
    const view = { id: 'a', action: 'user.invited', actorType: 'HUMAN', actorName: 'Jordan', entityType: 'user', entityId: 'u', createdAt: '2026-07-01T00:00:00Z', metadata: { email: 'secret@tenant.test', token: 'tok_live_123' } };
    const entry = fromAuditView(view);
    assert.equal('metadata' in entry, false);
    const html = render(<Timeline><AuditEventRow entry={entry} /></Timeline>);
    assert.equal(/secret@tenant\.test|tok_live_123/.test(html), false);
  });

  it('an empty timeline says so', () => {
    assert.match(render(<EmptyTimeline message="No derived signals for this record." />), /No derived signals for this record\./);
  });
});

describe('Governed search', () => {
  function fakeRepos(opts: { people?: number; conversations?: number; orgName?: string } = {}) {
    const calls: { name: string; args: unknown[] }[] = [];
    const rec = (name: string, result: unknown) => async (...args: unknown[]) => {
      calls.push({ name, args });
      return result;
    };
    const person = (i: number) => ({ id: `c${i}`, name: `Person ${i}`, company: '', email: null, phone: null, status: 'New' });
    const convo = (i: number) => ({ id: `v${i}`, subject: `Subject ${i}`, customerName: 'x', channel: 'SMS', assigneeName: null, status: 'OPEN' });
    const repos = {
      crm: { listCustomers: rec('listCustomers', { rows: Array.from({ length: opts.people ?? 0 }, (_, i) => person(i)), total: opts.people ?? 0 }) },
      conversationsInbox: { listConversations: rec('listConversations', { rows: Array.from({ length: opts.conversations ?? 0 }, (_, i) => convo(i)) }) },
      organizations: { findById: rec('findById', { id: ORG, name: opts.orgName ?? 'ServicesInMyCity', industry: null, timezone: 'UTC', status: 'ACTIVE' }) },
    } as unknown as SearchRepos;
    return { repos, calls };
  }
  const all = { canViewConversations: true, canViewOrganizations: true };

  it('an empty or blank query reads nothing', async () => {
    for (const q of ['', '   ']) {
      const { repos, calls } = fakeRepos({ people: 3 });
      assert.deepEqual(await runSearch(repos, ORG, q, all), []);
      assert.equal(calls.length, 0);
    }
  });

  it('every read is scoped to the session organization, and no other organization can appear', async () => {
    const { repos, calls } = fakeRepos({ people: 1, conversations: 1, orgName: 'ServicesInMyCity' });
    const results = await runSearch(repos, ORG, 'services', all);
    for (const c of calls) assert.equal(c.args[0], ORG, c.name);
    const orgs = results.filter((r) => r.kind === 'organization');
    assert.deepEqual(orgs.map((r) => r.id), [ORG]);
  });

  it('the workspace appears only when its name matches', async () => {
    const { repos } = fakeRepos({ orgName: 'ServicesInMyCity' });
    assert.equal((await runSearch(repos, ORG, 'zzz', all)).some((r) => r.kind === 'organization'), false);
  });

  it('a source the user may not see is never queried', async () => {
    const { repos, calls } = fakeRepos({ people: 1, conversations: 5 });
    const results = await runSearch(repos, ORG, 'a', { canViewConversations: false, canViewOrganizations: false });
    assert.deepEqual(calls.map((c) => c.name), ['listCustomers']);
    assert.equal(results.some((r) => r.kind !== 'person'), false);
  });

  it('no results is an empty list, not a fabricated one', async () => {
    const { repos } = fakeRepos({ people: 0, conversations: 0, orgName: 'Acme' });
    assert.deepEqual(await runSearch(repos, ORG, 'nothing-matches', all), []);
  });

  it('results are bounded even if a repository returns more', async () => {
    const { repos, calls } = fakeRepos({ people: 50, conversations: 50 });
    const results = await runSearch(repos, ORG, 'a', all);
    assert.equal(results.filter((r) => r.kind === 'person').length, SEARCH_LIMITS.people);
    assert.equal(results.filter((r) => r.kind === 'conversation').length, SEARCH_LIMITS.conversations);
    assert.equal((calls[0]!.args[1] as { pageSize: number }).pageSize, SEARCH_LIMITS.people);
  });

  it('every result carries an honest type and an existing destination; nothing else is invented', async () => {
    const { repos } = fakeRepos({ people: 2, conversations: 2, orgName: 'Alpha' });
    const results = await runSearch(repos, ORG, 'a', all);
    const routes = { person: /^\/crm\/customers\/[\w-]+$/, conversation: /^\/crm\/conversations\/[\w-]+$/, organization: /^\/crm\/organizations\/[\w-]+$/ };
    for (const r of results) {
      assert.ok(r.kind in routes, r.kind);
      assert.match(r.href, routes[r.kind]);
    }
    assert.deepEqual(['person', 'conversation', 'organization'].map((k) => kindLabel(k as never)), ['Person / Intake Record', 'Conversation', 'Workspace Organization']);
  });

  it('dangerous and special strings reach the repositories verbatim, as bound values, and are length-capped', async () => {
    const hostile = `  %_\\'; DROP TABLE customers;-- <script>alert(1)</script> ${'x'.repeat(400)}  `;
    const { repos, calls } = fakeRepos({ people: 0, conversations: 0 });
    await runSearch(repos, ORG, hostile, all);
    const sent = (calls[0]!.args[1] as { search: string }).search;
    assert.equal(sent, hostile.trim().slice(0, SEARCH_LIMITS.queryLength));
    assert.equal((calls[1]!.args[1] as { search: string }).search, sent);
  });

  it('the customer repository binds the text as a contains filter inside the organization — no raw SQL', async () => {
    const { client, calls } = recordingPrisma();
    await new CrmRepository(client).listCustomers(ORG, { search: `%'; DROP TABLE x;--`, pageSize: 500 });
    const find = calls.find((c) => c.model === 'customer' && c.method === 'findMany')!;
    assert.deepEqual(find.args.where.AND[0], { organizationId: ORG });
    assert.equal(find.args.where.AND[1].OR[0].firstName.contains, `%'; DROP TABLE x;--`);
    assert.equal(find.args.take, 100, 'page size is clamped');
    const repo = readFileSync(new URL('../../../packages/database/src/repositories/crm.repository.ts', import.meta.url), 'utf8');
    assert.equal(/\$queryRaw|\$executeRaw/.test(repo), false);
  });
});
