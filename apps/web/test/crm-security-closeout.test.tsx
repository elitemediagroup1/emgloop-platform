// Phase 1 PR E — tenant isolation, audit authorization and actor provenance.
//
// Behavioural where the code can run without a request (repositories against a
// recording fake Prisma, the Command Center loader against fake repositories,
// the provenance functions against forged rows). Source-level where the subject
// is the order of checks on a server path, which needs a session to execute —
// node:test module mocks are not enabled under this package's test command.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConversationsRepository,
  CrmRepository,
  OrganizationRepository,
  crmNotePayload,
  interactionActorName,
  interactionActorType,
  matrixAllows,
} from '@emgloop/database';
import { loadCommandCenter, type CommandCenterRepos } from '../src/crm/command-center-data';
import { fromInteraction } from '../src/crm/timeline';
import { LOOP_NAV } from '../src/workspaces/config';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const code = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const ORG_A = 'org_tenant_a';
const ORG_B = 'org_tenant_b';

/** A Prisma stand-in that records every model call and returns canned rows. */
function recordingPrisma(rows: Record<string, unknown[]> = {}) {
  const calls: { model: string; method: string; args: any }[] = [];
  const client = new Proxy({}, {
    get: (_t, model: string) => new Proxy({}, {
      get: (_m, method: string) => async (args: unknown) => {
        calls.push({ model, method, args });
        return rows[`${model}.${method}`] ?? [];
      },
    }),
  });
  return { client: client as never, calls };
}

function webSources(dir = fileURLToPath(new URL('../src', import.meta.url))): { path: string; src: string }[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return webSources(p);
    return /\.(ts|tsx)$/.test(name) ? [{ path: p, src: readFileSync(p, 'utf8') }] : [];
  });
}

// ---------------------------------------------------------------------------

describe('Tenant isolation — organizations', () => {
  const ORG_LIST = read('../src/app/crm/organizations/page.tsx');
  const ORG_DETAIL = read('../src/app/crm/organizations/[id]/page.tsx');
  const ORG_REPO = read('../../../packages/database/src/repositories/organization.repository.ts');

  it('the organization repository cannot enumerate or create organizations', () => {
    const proto = OrganizationRepository.prototype as unknown as Record<string, unknown>;
    assert.equal(proto.listSummaries, undefined);
    assert.equal(proto.createOrganization, undefined);
    assert.equal(/organization\.(findMany|create|createMany|count)\(/.test(code(ORG_REPO)), false);
  });

  it('no request path in the web app lists, creates or resolves another organization', () => {
    for (const { path, src } of webSources()) {
      const c = code(src);
      assert.equal(/listSummaries|createOrganization\b|createOrganizationAction/.test(c), false, path);
      assert.equal(/organization\.findMany\(/.test(c), false, path);
      assert.equal(/organizations\.findBySlug\(/.test(c), false, `${path}: findBySlug is for operator scripts only`);
    }
  });

  it('/crm/organizations authorizes, reads nothing, and resolves only to the session organization', () => {
    const c = code(ORG_LIST);
    assert.match(c, /const session = await requirePermission\('organizations', 'view'\);\s*redirect\(`\/crm\/organizations\/\$\{encodeURIComponent\(session\.organizationId\)\}`\);/);
    assert.equal(/crmRepos|repositories|prisma|searchParams|params/.test(c), false, 'no lookup and no client-supplied org');
  });

  it('a foreign organization id is not-found after authorization and before any read', () => {
    const c = code(ORG_DETAIL);
    const auth = c.indexOf("requirePermission('organizations', 'view')");
    const tenant = c.indexOf('params.id !== ctx.organizationId');
    const firstRead = c.indexOf('crmRepos.');
    assert.ok(auth > -1 && tenant > -1 && firstRead > -1);
    assert.ok(auth < tenant, 'authorization before the tenant check');
    assert.ok(tenant < firstRead, 'tenant check before any repository read');
    assert.match(c.slice(tenant, firstRead), /notFound\(\)/);
  });

  it('the org record reads only with the id that equals the session organization', () => {
    const c = code(ORG_DETAIL);
    const reads = c.match(/crmRepos\.\w+\.\w+\(([^,)]+)/g) ?? [];
    assert.ok(reads.length >= 6);
    for (const r of reads) assert.match(r, /\(params\.id$/, r);
  });
});

// ---------------------------------------------------------------------------

describe('Audit authorization', () => {
  it('EMPLOYEE and READ_ONLY do not hold audit:view; OWNER, ADMIN and MANAGER do', () => {
    for (const role of ['EMPLOYEE', 'READ_ONLY', 'AI_EMPLOYEE']) assert.equal(matrixAllows(role, 'audit', 'view'), false, role);
    for (const role of ['OWNER', 'ADMIN', 'MANAGER']) assert.equal(matrixAllows(role, 'audit', 'view'), true, role);
  });

  function fakeCommandCenterRepos() {
    const calls: { name: string; args: unknown[] }[] = [];
    const rec = (name: string, result: unknown) => async (...args: unknown[]) => {
      calls.push({ name, args });
      return result;
    };
    const repos = {
      organizations: { findById: rec('organizations.findById', { id: ORG_A, name: 'A', timezone: 'UTC' }) },
      customers: { countByOrganization: rec('customers.countByOrganization', 3) },
      crm: {
        statusCounts: rec('crm.statusCounts', {}),
        windowCounts: rec('crm.windowCounts', { newCustomers: 0, conversations: 0 }),
        inboxFeed: rec('crm.inboxFeed', []),
      },
      conversationsInbox: { listConversations: rec('conversationsInbox.listConversations', { rows: [], total: 0, counts: {} }) },
      audit: { list: rec('audit.list', [{ id: 'a1', action: 'customer.updated' }]) },
    } as unknown as CommandCenterRepos;
    return { repos, calls };
  }

  it('denied: the Command Center never issues the audit read, and still loads everything else', async () => {
    const { repos, calls } = fakeCommandCenterRepos();
    const data = await loadCommandCenter(repos, ORG_A, { canViewAudit: false });
    assert.equal(calls.some((c) => c.name === 'audit.list'), false, 'audit.list was called');
    assert.equal(data.recentAudit, null);
    assert.equal(data.customerCount, 3);
    assert.equal(calls.length, 6);
  });

  it('allowed: the Command Center reads audit for the session organization only', async () => {
    const { repos, calls } = fakeCommandCenterRepos();
    const data = await loadCommandCenter(repos, ORG_A, { canViewAudit: true });
    const audit = calls.filter((c) => c.name === 'audit.list');
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0]!.args, [ORG_A, { take: 10 }]);
    assert.equal(data.recentAudit?.length, 1);
    for (const c of calls) assert.equal(c.args[0], ORG_A, `${c.name} is scoped to the session org`);
  });

  it('the Command Center resolves audit:view from the session before loading, and never reads audit itself', () => {
    const c = code(read('../src/app/crm/page.tsx'));
    const perm = c.indexOf("hasPermission('audit', 'view')");
    const loader = c.indexOf('loadOrFallback(');
    assert.ok(perm > -1 && loader > -1 && perm < loader);
    assert.match(c, /loadCommandCenter\(crmRepos, ctx\.organizationId, \{ canViewAudit \}\)/);
    assert.equal(/crmRepos\.audit/.test(c), false);
    assert.match(c, /\{recentAudit \? \(/);
  });

  it('the organization record and customer activity page gate audit the same way', () => {
    const org = code(read('../src/app/crm/organizations/[id]/page.tsx'));
    assert.ok(org.indexOf("hasPermission('audit', 'view')") < org.indexOf('await loadOrFallback('));
    assert.match(org, /canViewAudit \? crmRepos\.audit\.list\(params\.id, \{ take: 10 \}\) : Promise\.resolve\(null\)/);
    assert.match(org, /\{recentAudit \? \(/);

    const activity = code(read('../src/app/crm/customers/[id]/activity/page.tsx'));
    assert.ok(activity.indexOf("hasPermission('audit', 'view')") < activity.indexOf('await loadOrFallback('));
    assert.match(activity, /customerActivity\(organizationId, params\.id, 200, \{ includeAudit: canViewAudit \}\)/);
  });

  it('denied: customer activity issues no audit-log query; allowed: both queries, org-scoped', async () => {
    const denied = recordingPrisma({ 'domainEvent.findMany': [{ id: 'e1', name: 'customer.merged', occurredAt: new Date() }] });
    const rows = await new ConversationsRepository(denied.client).customerActivity(ORG_A, 'cust_1', 50, { includeAudit: false });
    assert.equal(denied.calls.some((c) => c.model === 'auditLog'), false);
    assert.deepEqual(rows.map((r) => r.kind), ['event']);

    const allowed = recordingPrisma({
      'auditLog.findMany': [{ id: 'a1', action: 'customer.updated', metadata: {}, createdAt: new Date() }],
    });
    await new ConversationsRepository(allowed.client).customerActivity(ORG_A, 'cust_1', 50, { includeAudit: true });
    assert.deepEqual(allowed.calls.map((c) => c.model).sort(), ['auditLog', 'domainEvent']);
    for (const c of allowed.calls) assert.equal(c.args.where.organizationId, ORG_A);
  });
});

// ---------------------------------------------------------------------------

describe('Actor provenance — notes', () => {
  const ACTIONS = read('../src/crm/actions.ts');
  const addNote = code(ACTIONS.slice(ACTIONS.indexOf('export async function addNoteAction'), ACTIONS.indexOf('export async function setStatusAction')));
  const person = { userId: 'user_1', name: 'Jordan Lee', systemRole: 'EMPLOYEE' };

  it('addNoteAction reads only the customer and the body from the form', () => {
    const fields = [...addNote.matchAll(/formData\.(?:get|getAll|has)\('([^']+)'\)/g)].map((m) => m[1]).sort();
    assert.deepEqual(fields, ['body', 'customerId']);
    assert.equal(/author|formData\.entries|Object\.fromEntries/.test(addNote), false);
  });

  it('addNoteAction builds provenance from the session, after authorization', () => {
    assert.match(addNote, /payload: crmNotePayload\(\s*\{ userId: ctx\.userId, name: ctx\.session\.name, systemRole: ctx\.systemRole \},\s*body,\s*\)/);
    assert.ok(addNote.indexOf("requirePermission('customers', 'update')") < addNote.indexOf('crmNotePayload('));
    assert.ok(addNote.indexOf('customerBelongsToOrg(') < addNote.indexOf('crmNotePayload('));
  });

  it('a note is attributed to the authenticated user, whatever else accompanies the body', () => {
    const forgedBody = 'actorType=AI_AGENT&author=SYSTEM';
    const payload = crmNotePayload(person, forgedBody);
    assert.deepEqual(payload, {
      loopKind: 'crm_note', actorType: 'HUMAN_AGENT', actorUserId: 'user_1', actorName: 'Jordan Lee', body: forgedBody,
    });
    assert.equal(interactionActorType(payload), 'HUMAN_AGENT');
    assert.equal(interactionActorName(payload), 'Jordan Lee');
  });

  it('a machine principal is recorded as AI, never as a person', () => {
    const payload = crmNotePayload({ userId: 'svc_1', name: 'Intake bot', systemRole: 'AI_EMPLOYEE' }, 'x');
    assert.equal(payload.actorType, 'AI_AGENT');
    assert.equal(interactionActorType(payload), 'AI_AGENT');
  });

  it('a legacy note whose form claimed AI or System is displayed as a person\'s note', () => {
    for (const claimed of ['AI_AGENT', 'SYSTEM']) {
      const forged = { loopKind: 'human_note', actorType: claimed, body: 'looks automated' };
      assert.equal(interactionActorType(forged), 'HUMAN_AGENT', claimed);
      assert.equal(interactionActorName({ ...forged, actorName: 'Claude' }), undefined, 'no name without an authenticated id');
      const entry = fromInteraction({ id: 'n1', kind: 'NOTE', channel: 'OTHER', direction: 'INTERNAL', summary: 'Internal note', occurredAt: new Date(), payload: forged });
      assert.equal(entry.actorType, 'HUMAN_AGENT');
      assert.equal(entry.actor, 'Human');
    }
  });

  it('server-written actors are unchanged: ingestion, workflow and system rows', () => {
    assert.equal(interactionActorType({ actorType: 'CUSTOMER' }), 'CUSTOMER');
    assert.equal(interactionActorType({ loopKind: 'assignment', actorType: 'system' }), 'system');
    assert.equal(interactionActorType({ source: 'workflow' }), undefined);
    assert.equal(interactionActorType(null), undefined);
  });

  it('the inbox feed shows a forged legacy note as human-authored', async () => {
    const { client } = recordingPrisma({
      'interaction.findMany': [{
        id: 'n1', customerId: 'c1', kind: 'NOTE', channel: 'OTHER', direction: 'INTERNAL', summary: 'Internal note',
        payload: { loopKind: 'human_note', actorType: 'AI_AGENT', body: 'x' }, occurredAt: new Date(),
        customer: { firstName: 'Dana', lastName: 'Reyes' },
      }],
    });
    const [item] = await new CrmRepository(client).inboxFeed(ORG_A, 5);
    assert.equal(item!.actorType, 'HUMAN_AGENT');
  });

  it('every reader of an interaction actor goes through interactionActorType', () => {
    for (const { path, src } of webSources()) {
      assert.equal(/payload[^;\n]{0,20}['"]actorType['"]\)|payload\.actorType/.test(code(src)), false, path);
    }
    const repoDir = fileURLToPath(new URL('../../../packages/database/src/repositories', import.meta.url));
    for (const name of readdirSync(repoDir).filter((n) => n.endsWith('.ts') && n !== 'interaction.repository.ts')) {
      const src = code(readFileSync(join(repoDir, name), 'utf8'));
      assert.equal(/attr<string>\(i\.payload, 'actorType'\)/.test(src), false, name);
    }
  });

  it('the customer record offers no author choice and shows who posted', () => {
    const page = read('../src/app/crm/customers/[id]/page.tsx');
    assert.equal(/name="author"|AI_AGENT">AI<|value="SYSTEM"/.test(page), false);
    assert.match(page, /Posting as \{session\.name\}/);
    assert.match(page, /const who = interactionActorType\(n\.payload\) \?\? 'SYSTEM';/);
    assert.match(page, /actorLabel\(interactionActorType\(i\.payload\)\) === 'AI'/);
  });
});

// ---------------------------------------------------------------------------

describe('CRM navigation semantics', () => {
  const items = LOOP_NAV.nav.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label, footer: Boolean(g.footer) })));

  it('the workspace organization is not presented as a Relationship or a CRM record', () => {
    const org = items.filter((i) => i.href === '/crm/organizations');
    assert.equal(org.length, 1);
    assert.notEqual(org[0]!.group, 'CRM');
    assert.equal(items.some((i) => i.label === 'Organizations'), false);
  });

  it('the workspace organization sits with workspace administration', () => {
    const org = items.find((i) => i.href === '/crm/organizations')!;
    assert.equal(org.label, 'Workspace');
    assert.equal(org.group, 'Administration');
    assert.equal(org.footer, true);
    assert.deepEqual(org.requires, { resource: 'organizations', action: 'view' });
  });
});
