// Loop home navigation (ADMIN workspace) — grouped by operating area.
//
// Navigation only: every item must open a route that exists, carry the permission
// that route enforces, and keep the authority boundaries the grouping could blur.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolveActiveNav, workspaceFor } from '../src/workspaces/config';

const APP = new URL('../src/app', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const admin = workspaceFor('ADMIN');
const items = admin.nav.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label, footer: Boolean(g.footer) })));
const find = (label: string) => {
  const item = items.find((i) => i.label === label);
  assert.ok(item, `${label} is in the nav`);
  return item!;
};

function pageFor(href: string): string | null {
  const direct = new URL(`.${href}/page.tsx`, APP + '/');
  if (existsSync(direct)) return direct.pathname;
  if (href.startsWith('/app/admin/')) {
    const catchAll = new URL('./app/admin/[...slug]/page.tsx', APP + '/');
    if (existsSync(catchAll)) return catchAll.pathname;
  }
  return null;
}

describe('Loop home navigation', () => {
  it('is grouped Home · CRM · Intelligence · Work OS · Creator Hub/Accounting, with Administration at the foot', () => {
    assert.deepEqual(admin.nav.map((g) => [g.label, Boolean(g.footer)]), [
      ['', false], ['CRM', false], ['Intelligence', false], ['Work OS', false], ['', false], ['Administration', true],
    ]);
    assert.deepEqual(admin.nav[0]!.items.map((i) => [i.label, i.href]), [['Home', '/app/admin']]);
    assert.deepEqual(admin.nav[4]!.items.map((i) => i.label), ['Creator Hub', 'Accounting']);
    assert.deepEqual(admin.nav[5]!.items.map((i) => i.label), ['Team', 'Settings', 'Objectives', 'Audit']);
  });

  it('CRM lists People · Relationships · Opportunities · Campaigns · Conversations · Intake · Activity', () => {
    const crm = admin.nav.find((g) => g.label === 'CRM')!;
    assert.deepEqual(crm.items.map((i) => [i.label, i.href, Boolean(i.soon)]), [
      ['People', '/crm/customers', false],
      ['Relationships', '/crm/relationships', true],
      ['Opportunities', '/crm/opportunities', true],
      ['Campaigns', '/crm/campaigns', true],
      ['Conversations', '/crm/conversations', false],
      ['Intake', '/crm/pipeline', false],
      ['Activity', '/crm/inbox', false],
    ]);
  });

  it('Phase 2 domains are not built, so they are disabled and have no route', () => {
    for (const label of ['Relationships', 'Opportunities', 'Campaigns']) {
      const item = find(label);
      assert.equal(item.soon, true, label);
      assert.equal(pageFor(item.href), null, `${label} must stay soon until a route exists`);
    }
  });

  it('the intake board is never presented as the Opportunity pipeline', () => {
    const intake = items.find((i) => i.href === '/crm/pipeline')!;
    assert.equal(intake.label, 'Intake');
    assert.equal(items.some((i) => /pipeline/i.test(i.label)), false);
    assert.equal(find('Opportunities').href === '/crm/pipeline', false);
  });

  it('every enabled item opens a route that exists', () => {
    for (const item of items.filter((i) => !i.soon)) {
      assert.ok(pageFor(item.href), `${item.label} → ${item.href} has no page`);
    }
  });

  it('each gated item carries the permission its destination page enforces', () => {
    for (const item of items.filter((i) => !i.soon)) {
      const page = pageFor(item.href)!;
      const enforced = readFileSync(page, 'utf8').match(/requirePermission\('(\w+)', '(\w+)'\)/);
      if (!enforced) continue;
      assert.deepEqual(item.requires, { resource: enforced[1], action: enforced[2] }, `${item.label} → ${item.href}`);
    }
  });

  it('Work OS and Commercial Intelligence stay separate authorities', () => {
    const work = admin.nav.find((g) => g.label === 'Work OS')!;
    assert.deepEqual(work.items.map((i) => [i.label, i.href, Boolean(i.soon)]), [
      ['My Work', '/app/admin/work', false],
      ['Queue', '/app/admin/work/team', false],
      ['Workflows', '/app/admin/work/workflows', true],
      ['Work Types', '/app/admin/administration/work-types', false],
    ]);
    assert.equal(work.items.some((i) => i.href.startsWith('/crm/workflows')), false, 'CRM automation is not Work OS');
    assert.equal(find('Your queue').group, 'Intelligence', "CI's attention queue is not Work OS");
    assert.equal(find('Headlines').group, 'Intelligence');
  });

  it('highlights the right item on nested routes', () => {
    const active = (path: string) => resolveActiveNav(admin, path)?.label ?? null;
    assert.equal(active('/app/admin'), 'Home');
    assert.equal(active('/app/admin/work'), 'My Work');
    assert.equal(active('/app/admin/work/abc123'), 'My Work');
    assert.equal(active('/app/admin/work/team'), 'Queue');
    assert.equal(active('/app/admin/marketplace/buyers'), 'CallGrid Intelligence');
    assert.equal(active('/app/admin/headlines/h1'), 'Headlines');
    assert.equal(active('/app/admin/administration/work-types'), 'Work Types');
  });

  it('the shell renders the footer group label', () => {
    const shell = read('../src/workspaces/WorkspaceShell.tsx');
    assert.match(shell, /shell\.nav\.filter\(\(g\) => g\.footer\)\.map\(\(group, gi\) =>/);
  });
});
