// One Loop shell, one navigation registry — PR 2 of the unified application
// structure (docs/architecture/loop-application-structure.md).
//
// Behavioural where the code runs without a request: LOOP_NAV, the visibility
// filter over the real permission matrix and role router, the sidebar and Loop
// Home rendered to markup. Source-level where the subject needs a session: the
// shell mounts and the guards every page states for itself.
//
// The central claim is checked against the PAGES, not against the registry's own
// description of them: for every role, an item is shown exactly when its
// destination page would let that role in.
//
// Since 2026-09-24 the rail folds: an item marked `folded` is drawn behind its
// group's disclosure row (shell-nav-folds.test.tsx covers the drawing). Here it is
// pinned as ' ▸' after its label, so each role's list says what is primary.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTimeView } from '@emgloop/shared';
// The context next/navigation's usePathname() reads: the client router's current path.
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { matrixAllows, type Action, type Resource } from '@emgloop/database';
import * as config from '../src/workspaces/config';
import {
  LOOP_NAV, WORKSPACES, WORKSPACE_ROLES, myWorkHref, resolveActiveNav, visibleNav,
  type NavGroup, type NavItem, type WorkspaceRole,
} from '../src/workspaces/config';
import { resolveWorkspaceRole } from '../src/workspaces/role-router';
import { runWorkspaceRoutingVerification } from '../src/workspaces/verification';
import { AreaBar, ShellCrumb, ShellNav } from '../src/workspaces/ShellNav';
import UnavailablePage from '../src/workspaces/UnavailablePage';
import { ModuleHome } from '../src/app/app/_home/module-home';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const APP = join(SRC, 'app');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
const code = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const render = (el: unknown) => renderToStaticMarkup(el as never);
/** Render as the client router would at `path`. */
const renderAt = (path: string, el: React.ReactNode) =>
  renderToStaticMarkup(<PathnameContext.Provider value={path}>{el}</PathnameContext.Provider>);
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
});

const SYSTEM_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'AI_EMPLOYEE', 'READ_ONLY', 'CREATOR', 'SOMETHING_NEW'] as const;
const items = LOOP_NAV.nav.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label, footer: Boolean(g.footer) })));
const enabled = items.filter((i) => !i.soon);
const find = (label: string, href?: string) => {
  const item = items.find((i) => i.label === label && (!href || i.href === href));
  assert.ok(item, `${label} is in LOOP_NAV`);
  return item!;
};

// ---- What a destination page actually enforces, read from the page -----------

const treeOf = (href: string): WorkspaceRole | undefined =>
  WORKSPACE_ROLES.find((r) => href === WORKSPACES[r].basePath || href.startsWith(WORKSPACES[r].basePath + '/'));

/** The page file that serves a nav href: its own page, or its tree's catch-all. */
function pageFor(href: string): string | null {
  const direct = join(APP, href, 'page.tsx');
  if (existsSync(direct)) return direct;
  const tree = treeOf(href);
  if (tree) {
    const catchAll = join(APP, WORKSPACES[tree].basePath, '[...slug]', 'page.tsx');
    if (existsSync(catchAll)) return catchAll;
  }
  return null;
}

const Q = `['"]`;
function enforcedPermission(page: string): { resource: string; action: string } | null {
  const src = code(readFileSync(page, 'utf8'));
  const m = src.match(new RegExp(`requirePermission\\(${Q}(\\w+)${Q}, ${Q}(\\w+)${Q}\\)`))
    ?? src.match(new RegExp(`requireWorkspacePermission\\(${Q}\\w+${Q}, ${Q}(\\w+)${Q}, ${Q}(\\w+)${Q}\\)`));
  return m ? { resource: m[1]!, action: m[2]! } : null;
}

function enforcedAuthority(page: string): WorkspaceRole | null {
  const src = code(readFileSync(page, 'utf8'));
  const m = src.match(new RegExp(`requireWorkspace(?:Permission)?\\(${Q}(\\w+)${Q}`));
  if (m) return m[1] as WorkspaceRole;
  if (/requireWorkActor\(\)/.test(src)) return 'ADMIN';
  if (/requireEmployeeActor\(\)/.test(src)) return 'EMPLOYEE';
  return null;
}

/** Would this role get into the page behind this item? Decided by the page alone. */
function pageAdmits(item: NavItem, systemRole: string): boolean {
  const page = pageFor(item.href)!;
  const authority = enforcedAuthority(page);
  if (authority && authority !== resolveWorkspaceRole({ systemRole })) return false;
  const perm = enforcedPermission(page);
  return perm ? matrixAllows(systemRole, perm.resource as Resource, perm.action as Action) : true;
}

const navForRole = (systemRole: string): NavGroup[] =>
  visibleNav(LOOP_NAV.nav, {
    workspace: resolveWorkspaceRole({ systemRole }),
    permitted: (item) => matrixAllows(systemRole, item.requires!.resource, item.requires!.action),
  });
// A role's rail as a list: '(soon)' for an unbuilt item (none today), ' ▸' for one behind its group's fold.
const labels = (groups: NavGroup[]) => groups.map((g) => [g.label, g.items.map((i) => i.label + (i.soon ? ' (soon)' : '') + (i.folded ? ' ▸' : ''))]);

// ---------------------------------------------------------------------------

describe('One shell, one registry', () => {
  it('LOOP_NAV is the only navigation registry; role entries carry authority, not navigation', () => {
    assert.equal('CRM_SHELL' in config, false, 'the CRM has no sidebar of its own');
    for (const role of WORKSPACE_ROLES) {
      assert.deepEqual(Object.keys(WORKSPACES[role]).sort(), ['basePath', 'home', 'role'], role);
    }
    const registries = walk(SRC).filter((f) => /:\s*ShellConfig\s*=/.test(code(readFileSync(f, 'utf8'))));
    assert.deepEqual(registries.map((f) => relative(SRC, f)), ['workspaces/config.ts']);
  });

  it('the shell takes no registry: it always renders LOOP_NAV', () => {
    const shell = code(read('workspaces/WorkspaceShell.tsx'));
    assert.match(shell, /export default async function WorkspaceShell\(\{\s*session,\s*children,\s*\}/);
    assert.equal(/shell\s*[:,}]/.test(shell.slice(shell.indexOf('export default'))), false, 'no shell prop');
    assert.match(shell, /<ShellNav groups=\{groups\} label=\{LOOP_NAV\.label\} \/>/);
    assert.match(shell, /<ShellCrumb groups=\{groups\} \/>/);
  });

  it('every signed-in surface mounts that one shell, the CRM included', () => {
    const mounts = [
      'app/crm/layout.tsx', 'app/app/page.tsx', 'app/app/crm/layout.tsx',
      ...['admin', 'employee', 'client', 'business', 'creator'].map((d) => `app/app/${d}/layout.tsx`),
    ];
    for (const m of mounts) assert.match(code(read(m)), /<WorkspaceShell session=\{session\}>/, m);
    for (const file of walk(SRC)) {
      const c = code(readFileSync(file, 'utf8'));
      assert.equal(/<WorkspaceShell\s+shell=/.test(c), false, relative(SRC, file));
    }
  });

  it('the routing invariants hold, including each item stating its route tree\'s authority', () => {
    const report = runWorkspaceRoutingVerification();
    assert.equal(report.passed, true, report.checks.filter((c) => !c.passed).map((c) => c.name).join('; '));
    for (const item of items) assert.equal(item.workspace, treeOf(item.href), item.href);
  });
});

describe('Grouping', () => {
  it('is the five operating areas (Home · CRM · Work · Intelligence · Operations), the creator seat, and Administration at the foot', () => {
    // The creator seat (C-02, amended 2026-09-22) is a group of its own, not an operating
    // area: a creator holds none of the five, and the organization never sees the seat.
    assert.deepEqual(LOOP_NAV.nav.map((g) => [g.label, g.area ?? null, Boolean(g.footer)]), [
      ['', 'HOME', false], ['CRM', 'CRM', false], ['Work', 'WORK', false], ['Intelligence', 'INTELLIGENCE', false],
      ['Operations', 'OPERATIONS', false], ['Creator', null, false], ['Administration', null, true],
    ]);
    assert.deepEqual(LOOP_NAV.nav.map((g) => g.area).filter(Boolean), [...config.OPERATING_AREAS]);
    // Home, and the person's own connections (their Google account), shown only to a
    // role that holds one.
    assert.deepEqual(LOOP_NAV.nav[0]!.items.map((i) => [i.label, i.href]), [
      ['Home', '/app'],
      ['Mail', '/app/mail'],
      ['Connections', '/app/connections'],
    ]);
    // Both personal entries state the authority their own page enforces: a person's own work
    // state, and a person's own Google connection. Neither is an administrative surface.
    assert.deepEqual(LOOP_NAV.nav[0]!.items[1]!.requires, { resource: 'employeeIntelligence', action: 'view' });
    assert.deepEqual(LOOP_NAV.nav[0]!.items[2]!.requires, { resource: 'googleWorkspace', action: 'view' });
    // Operations: live execution and health (C-03) and creator administration (C-02).
    assert.deepEqual(LOOP_NAV.nav[4]!.items.map((i) => [i.label, i.href]), [
      ['Live Operations', '/crm/live/activity'], ['Live Calls', '/crm/live/calls'], ['Websites', '/crm/live/websites'],
      ['Creators', '/app/admin/creator-hub'],
    ]);
    // Accounting is its own domain surfaced contextually (C-01): no global entry while it is not built.
    assert.equal(items.some((i) => /accounting/i.test(i.href + i.label)), false);
    assert.deepEqual(LOOP_NAV.nav.find((g) => g.label === 'Administration')!.items.map((i) => i.label), [
      'Team', 'Workspace', 'Settings', 'Objectives', 'Audit Log', 'AI Employees', 'Integration OS',
    ]);
  });

  it('the creator seat is one group in the one registry: every item in the creator tree, four of them areas of the phone bar', () => {
    const creator = LOOP_NAV.nav.find((g) => g.label === 'Creator')!;
    assert.equal(creator.area, undefined, 'not an operating area');
    assert.equal(creator.footer, undefined, 'not administration');
    assert.deepEqual(creator.items.map((i) => [i.label, i.href, i.workspace, i.requires ?? null, i.area ?? null]), [
      ['Content', '/app/creator/content', 'CREATOR', null, 'CONTENT'],
      ['Opportunities', '/app/creator/opportunities', 'CREATOR', null, 'OPPORTUNITIES'],
      ['Analytics', '/app/creator/analytics', 'CREATOR', null, null],
      ['Tasks', '/app/creator/tasks', 'CREATOR', null, 'TASKS'],
      ['Earnings', '/app/creator/earnings', 'CREATOR', null, 'EARNINGS'],
      ['Profile', '/app/creator/profile', 'CREATOR', null, null],
    ]);
    // Every item area is a creator area, and only creator items carry one.
    for (const item of items) {
      assert.equal(item.area !== undefined, item.group === 'Creator' && (config.CREATOR_AREAS as readonly string[]).includes(item.area ?? ''), `${item.label}: ${item.area}`);
    }
  });

  it('CRM leads with the redesigned People and Relationships, then the real CRM under /crm', () => {
    const crm = LOOP_NAV.nav.find((g) => g.label === 'CRM')!;
    // [label, href, soon, folded]: the first three are primary; the intake tools fold.
    assert.deepEqual(crm.items.map((i) => [i.label, i.href, Boolean(i.soon), Boolean(i.folded)]), [
      // Canonical People (established PERSON Parties, C-04) and Relationships, redesigned.
      ['People', '/app/crm/people', false, false],
      ['Relationships', '/app/crm/relationships', false, false],
      ['Command Center', '/crm', false, false],
      ['Conversations', '/crm/conversations', false, true],
      ['Intake Records', '/crm/customers', false, true],
      ['Intake Board', '/crm/pipeline', false, true],
      // Identity review is its own governed workflow, on the temporary operator screen.
      ['Identity Review', '/crm/parties', false, true],
      ['Inbox', '/crm/inbox', false, true],
      ['Search', '/crm/search', false, true],
      ['Automations', '/crm/workflows', false, true],
    ]);
    assert.deepEqual(crm.fold, { label: 'Intake tools' });
    assert.equal(find('People').href.startsWith('/crm/customers'), false, 'People are never Intake Records');
  });

  it('no item leads to the retired /app/admin/crm placeholder; every CRM item is a real page under /crm or /app/crm', () => {
    assert.equal(items.some((i) => i.href.startsWith('/app/admin/crm')), false);
    for (const item of enabled.filter((i) => i.group === 'CRM')) {
      assert.ok(item.href === '/crm' || item.href.startsWith('/crm/') || item.href.startsWith('/app/crm/'), item.href);
      assert.equal(pageFor(item.href), join(APP, item.href, 'page.tsx'), `${item.label} is a real CRM page, not a placeholder`);
    }
  });

  it('only the unbuilt modules open the honest not-built page; every other item opens its own page', () => {
    const placeholders = enabled.filter((i) => pageFor(i.href)?.includes('[...slug]')).map((i) => i.label);
    // The creator seat's six pages are being built; until each one lands, the creator
    // tree's catch-all serves its address (and enforces the tree's authority). Nothing
    // else is a placeholder: Creators (EMG Creator Operations) is built now and has its
    // own page under /app/admin/creator-hub.
    const creatorItems = LOOP_NAV.nav.find((g) => g.label === 'Creator')!.items.map((i) => i.label);
    assert.deepEqual(placeholders.filter((l) => !creatorItems.includes(l)), []);
    for (const item of enabled) assert.ok(pageFor(item.href), `${item.label} → ${item.href} has no page`);
  });

  it('unbuilt items are disabled and have no route', () => {
    // Nothing unbuilt is in the rail today (2026-09-24): Opportunities, Campaigns and Work OS
    // Workflows were Soon items and are gone; the Command Center's Upcoming list names what is
    // coming. The rule below holds vacuously and protects the next item someone marks Soon.
    assert.equal(items.filter((i) => i.soon).length, 0, 'no Soon item in LOOP_NAV');
    for (const item of items.filter((i) => i.soon)) {
      assert.equal(existsSync(join(APP, item.href, 'page.tsx')), false, `${item.label} must stay soon until a route exists`);
      assert.equal(treeOf(item.href), undefined, `${item.label} must not fall into a catch-all`);
    }
  });

  it('the intake board is never presented as the Opportunity pipeline', () => {
    assert.equal(find('Intake Board').href, '/crm/pipeline');
    assert.equal(items.some((i) => /pipeline/i.test(i.label)), false);
    // The organization has no Opportunities or Campaigns entry: neither is built, and the
    // Command Center lists both under Upcoming. The only Opportunities item is the creator
    // seat's own, and it is not the intake board.
    assert.equal(items.some((i) => i.href === '/crm/opportunities' || i.href === '/crm/campaigns'), false);
    assert.deepEqual(items.filter((i) => i.label === 'Opportunities').map((i) => [i.group, i.href]), [['Creator', '/app/creator/opportunities']]);
    assert.notEqual(find('Opportunities', '/app/creator/opportunities').href, '/crm/pipeline');
    const command = code(read('app/crm/page.tsx'));
    assert.match(command, /<UpcomingItem label="Opportunities"/);
    assert.match(command, /<UpcomingItem label="Campaigns"/);
  });

  it('CRM Automations, Work OS and Commercial Intelligence stay separate authorities', () => {
    const work = LOOP_NAV.nav.find((g) => g.label === 'Work')!;
    // [label, href, workspace, soon, folded]: My Work stays primary for both authorities (final).
    assert.deepEqual(work.items.map((i) => [i.label, i.href, i.workspace ?? null, Boolean(i.soon), Boolean(i.folded)]), [
      ['My Work', '/app/admin/work', 'ADMIN', false, false],
      ['My Work', '/app/employee/work', 'EMPLOYEE', false, false],
      ['Team Work', '/app/admin/work/team', 'ADMIN', false, true],
      ['Work Types', '/app/admin/administration/work-types', 'ADMIN', false, true],
    ]);
    assert.deepEqual(work.fold, { label: 'Team work & types' });
    // Work OS Workflows (human work execution) is not built and has no entry at all.
    assert.equal(items.some((i) => i.href === '/app/work/workflows' || (i.group === 'Work' && i.label === 'Workflows')), false);
    assert.equal(work.items.some((i) => i.href.startsWith('/crm/')), false, 'CRM automation is not Work OS');
    assert.equal(find('Automations').group, 'CRM');
    assert.equal(find('Your queue').group, 'Intelligence', "CI's attention queue is not Work OS");
    assert.equal(find('Headlines').group, 'Intelligence');
  });

  it('each item is labelled as its destination names itself where a test already pins that name', () => {
    assert.match(read('app/crm/pipeline/page.tsx'), /<h1 className="crm-h1">Intake Board<\/h1>/);
    assert.match(read('app/crm/inbox/page.tsx'), /<h1 className="crm-h1">Inbox<\/h1>/);
    assert.match(read('app/crm/intelligence/page.tsx'), /<h1 className="ds-title">Intelligence Flow<\/h1>/);
  });
});

describe('Navigation follows the authority each page enforces', () => {
  it('every gated item asks for the permission its page enforces', () => {
    // No exceptions. CallGrid Intelligence used to be one: its item asked for
    // intelligence:view while its pages enforced only ADMIN authority. Its pages now
    // enforce the same permission their item states.
    for (const item of enabled) {
      const perm = enforcedPermission(pageFor(item.href)!);
      assert.deepEqual(item.requires ?? null, perm, `${item.label} → ${item.href}`);
    }
  });

  it('every item in a role-guarded tree states that authority, and its page enforces the same one itself', () => {
    for (const item of enabled) {
      const authority = enforcedAuthority(pageFor(item.href)!);
      assert.equal(item.workspace ?? null, authority, `${item.label} → ${item.href}`);
    }
  });

  it('for every role, an item is shown exactly when its page would let that role in', () => {
    for (const role of SYSTEM_ROLES) {
      const shown = new Set(navForRole(role).flatMap((g) => g.items).map((i) => i.href));
      for (const item of enabled) {
        assert.equal(shown.has(item.href), pageAdmits(item, role), `${role}: ${item.label} → ${item.href}`);
      }
    }
  });

  it('Owner, Admin and Manager see the whole application', () => {
    const everything = labels(visibleNav(LOOP_NAV.nav, { workspace: 'ADMIN', permitted: () => true }));
    for (const role of ['OWNER', 'ADMIN', 'MANAGER']) {
      const nav = labels(navForRole(role));
      assert.deepEqual(nav, everything, role);
      assert.equal(navForRole(role).flatMap((g) => g.items).some((i) => i.href === '/app/employee/work'), false, role);
    }
  });

  it('Employees get the CRM, the intelligence they can read, their own work queue, and nothing administrative they cannot open', () => {
    const intelligence = ['Intelligence Flow ▸', 'Analytics ▸', 'Traffic ▸', 'Revenue ▸'];
    const operations = ['Live Operations ▸', 'Live Calls ▸', 'Websites ▸'];
    const crm = ['People', 'Relationships', 'Command Center', 'Conversations ▸', 'Intake Records ▸', 'Intake Board ▸', 'Identity Review ▸', 'Inbox ▸', 'Search ▸', 'Automations ▸'];
    // A PERSON employee reaches canonical identity and the commercial area; an AI
    // principal reaches NEITHER. `identityResolution` has its own grant table with no
    // READ_ONLY fallback, and `relationships` hard-denies AI_EMPLOYEE because PD-F-04
    // grants view to human workspace roles and it is not one. Those two denials are
    // the whole reason these roles are asserted separately rather than in one loop.
    assert.deepEqual(labels(navForRole('EMPLOYEE')), [
      ['', ['Home', 'Mail', 'Connections']],
      ['CRM', crm],
      ['Work', ['My Work']],
      ['Intelligence', intelligence],
      ['Operations', operations],
      ['Administration', ['AI Employees ▸']],
    ]);
    assert.deepEqual(labels(navForRole('AI_EMPLOYEE')), [
      // No Mail and no Connections: an AI Employee holds neither a Google connection nor the
      // work state derived from one, and no Permission row can give it either.
      ['', ['Home']],
      ['CRM', crm.filter((l) => !['People', 'Relationships', 'Identity Review ▸'].includes(l))],
      ['Work', ['My Work']],
      ['Intelligence', intelligence],
      ['Operations', operations],
      ['Administration', ['AI Employees ▸']],
    ]);
    for (const role of ['EMPLOYEE', 'AI_EMPLOYEE']) {
      assert.equal(myWorkHref(navForRole(role)), '/app/employee/work', role);
    }
  });

  it('Read Only is not isolated in a placeholder: it sees what its permissions allow, and no Work OS it cannot open', () => {
    const intelligence = ['Intelligence Flow ▸', 'Analytics ▸', 'Traffic ▸', 'Revenue ▸'];
    const operations = ['Live Operations ▸', 'Live Calls ▸', 'Websites ▸'];
    const expected = [
      // A read-only member still connects their OWN Google account (googleWorkspace).
      ['', ['Home', 'Mail', 'Connections']],
      // READ_ONLY holds identityResolution:view and relationships:view, and may
      // perform no act through either -- capabilities decide that, not the nav.
      ['CRM', ['People', 'Relationships', 'Command Center', 'Conversations ▸', 'Intake Records ▸', 'Intake Board ▸', 'Identity Review ▸', 'Inbox ▸', 'Search ▸', 'Automations ▸']],
      ['Intelligence', intelligence],
      ['Operations', operations],
      ['Administration', ['AI Employees ▸']],
    ];
    assert.deepEqual(labels(navForRole('READ_ONLY')), expected);
    // An unknown role falls back to READ_ONLY in the matrix -- but identityResolution
    // has no such fallback, so it does NOT see People or Identity Review. Least, never more.
    assert.deepEqual(labels(navForRole('SOMETHING_NEW')), [
      ['', ['Home']],
      ['CRM', ['Relationships', 'Command Center', 'Conversations ▸', 'Intake Records ▸', 'Intake Board ▸', 'Inbox ▸', 'Search ▸', 'Automations ▸']],
      ['Intelligence', intelligence],
      ['Operations', operations],
      ['Administration', ['AI Employees ▸']],
    ], 'an unknown role gets the least, never more');
    assert.equal(myWorkHref(navForRole('READ_ONLY')), null);
  });

  it('Headlines stays with the people its route admits: EMPLOYEE and READ_ONLY hold the read grant, not the authority', () => {
    for (const role of ['EMPLOYEE', 'READ_ONLY']) {
      assert.equal(matrixAllows(role, 'commercialIntelligence', 'view'), true);
      assert.equal(navForRole(role).flatMap((g) => g.items).some((i) => i.label === 'Headlines'), false, role);
    }
  });

  it('an explicit DENY hides exactly the items that need that permission', () => {
    const nav = visibleNav(LOOP_NAV.nav, {
      workspace: 'ADMIN',
      permitted: (item) => !(item.requires!.resource === 'customers' && item.requires!.action === 'view'),
    });
    const shown = nav.flatMap((g) => g.items).map((i) => i.label);
    // The Command Center is an intake-record surface and now enforces customers:view
    // itself (so a creator's login, which holds nothing, is refused it); a DENY on that
    // permission therefore hides it along with the other intake surfaces.
    for (const hidden of ['Command Center', 'Intake Records', 'Inbox', 'Search']) assert.equal(shown.includes(hidden), false, hidden);
    for (const kept of ['Conversations', 'Intake Board', 'Headlines']) assert.ok(shown.includes(kept), kept);
  });

  it('a group with nothing a person can open is not drawn, even if it holds Soon items', () => {
    const nav = visibleNav(LOOP_NAV.nav, { workspace: 'CLIENT', permitted: () => false });
    // With the Command Center gated on customers:view, a person who holds no permission
    // can open nothing in the CRM group: it earns neither a header nor a fold.
    assert.deepEqual(labels(nav), [['', ['Home']]]);
    // No registry item is Soon today; the rule still holds for one.
    const soon = { href: '/soon', label: 'Soon item', icon: 'flow', soon: true };
    assert.deepEqual(visibleNav([{ label: 'Later', items: [soon] }], { workspace: 'ADMIN', permitted: () => true }), []);
  });

  it('a creator sees Home and the creator seat, nothing of the organization, and has no Work OS queue', () => {
    assert.deepEqual(labels(navForRole('CREATOR')), [
      ['', ['Home']],
      ['Creator', ['Content', 'Opportunities', 'Analytics', 'Tasks', 'Earnings', 'Profile']],
    ]);
    assert.equal(myWorkHref(navForRole('CREATOR')), null, 'no My Work item, so no notifications bell');
    // The creator's five-area phone bar: Home, then the four items that are areas of their own.
    assert.deepEqual(config.areaEntries(navForRole('CREATOR')), [
      { area: 'HOME', label: 'Home', href: '/app' },
      { area: 'CONTENT', label: 'Content', href: '/app/creator/content' },
      { area: 'OPPORTUNITIES', label: 'Opportunities', href: '/app/creator/opportunities' },
      { area: 'TASKS', label: 'Tasks', href: '/app/creator/tasks' },
      { area: 'EARNINGS', label: 'Earnings', href: '/app/creator/earnings' },
    ]);
    // The bar marks the area of the page shown, through the item's own area.
    const html = renderAt('/app/creator/tasks/t_1', <AreaBar groups={navForRole('CREATOR')} />);
    assert.match(html, /<a class="loop-areabar__link is-active" aria-current="true" href="\/app\/creator\/tasks">/);
    assert.equal((html.match(/is-active/g) ?? []).length, 1);
    // Analytics and Profile are in the sidebar but are no area: on those pages nothing is current.
    const analytics = renderAt('/app/creator/analytics', <AreaBar groups={navForRole('CREATOR')} />);
    assert.equal(/is-active/.test(analytics), false);
  });

  it('the shell resolves permissions for the signed session, in one read, with the rules pages enforce', () => {
    const access = code(read('workspaces/nav-access.ts'));
    assert.match(access, /repositories\.iam\.canEach\(session\.organizationId, session\.userId, checks\)/);
    assert.match(access, /workspace: resolveWorkspaceRole\(session\),/);
    assert.equal(/searchParams|formData|headers\(/.test(access), false, 'nothing from the request decides it');
  });
});

describe('The shell is about the person, not a role-branded workspace', () => {
  it('names the signed-in person in the sidebar and at the root of the breadcrumb, never a role or workspace label', () => {
    const shell = code(read('workspaces/WorkspaceShell.tsx'));
    assert.match(shell, /<span className="loop-sb__uname">\{session\.name\}<\/span>/);
    assert.match(shell, /<Link href=\{LOOP_NAV\.home\}>\s*<b>\{session\.name\}<\/b>\s*<\/Link>/);
    assert.equal(/shell\.label|Workspace['"`]|workspaceFor\(/.test(shell), false);
  });

  it('no page or shell part announces a role workspace', () => {
    for (const file of [...walk(join(SRC, 'app', 'app')), ...walk(join(SRC, 'workspaces'))]) {
      const c = code(readFileSync(file, 'utf8'));
      assert.equal(/\+ ' Workspace'|\} Workspace|Coming to this workspace|Admin Workspace|Employee Workspace|Client Workspace/.test(c), false, relative(SRC, file));
    }
  });

  it('draws only the items it is given, with the Administration foot as its own disclosure row', () => {
    const html = renderAt('/crm/customers', <ShellNav groups={navForRole('READ_ONLY')} label="Loop" />);
    assert.match(html, /<nav class="loop-sb__scroll" aria-label="Loop">/);
    // Intake Records is behind the CRM fold, which is open because the page shown is inside it.
    assert.match(html, /<a class="loop-sb__link is-active" aria-current="page" href="\/crm\/customers">/);
    assert.equal(html.includes('/app/admin'), false, 'nothing from a tree Read Only cannot open');
    assert.equal(html.includes('>Work<'), false, 'no Work area for a role without a queue');
    // Nothing unbuilt is offered: Opportunities and Campaigns have no entry at all.
    assert.equal(/opportunities|campaigns/i.test(html), false);
    assert.match(html, /href="\/app\/crm\/relationships"/, 'Relationships is reachable');
    assert.match(html, /href="\/app\/crm\/people"/, 'People is reachable');
    // Every Administration item folds, so the foot has no heading: its disclosure row carries the label.
    assert.match(html, /<nav class="loop-sb__adminarea" aria-label="Administration"><div class="loop-sb__group"><button type="button" class="loop-sb__fold" aria-expanded="false" aria-controls="loop-fold-administration-administration">/);
  });

  it('a Soon item is still drawn as a disabled non-link, never a route', () => {
    // Nothing in LOOP_NAV is Soon today; the rendering stays so an unbuilt destination can never become a link.
    const later: NavGroup = { label: 'Later', items: [{ href: '/later', label: 'Later thing', icon: 'flow', soon: true }, { href: '/crm', label: 'Command Center', icon: 'grid' }] };
    const html = renderAt('/crm', <ShellNav groups={[later]} label="Loop" />);
    assert.match(html, /<span class="loop-sb__link is-disabled" aria-disabled="true">.*?Later thing.*?Soon<\/span><\/span>/);
    assert.equal(/href="\/later"/.test(html), false);
    assert.match(html, /<a class="loop-sb__link is-active" aria-current="page" href="\/crm">/);
  });

  it('offers the notifications link only to someone with a Work OS queue, at their own queue', () => {
    assert.equal(myWorkHref(navForRole('OWNER')), '/app/admin/work');
    assert.equal(myWorkHref(navForRole('EMPLOYEE')), '/app/employee/work');
    assert.equal(myWorkHref(navForRole('READ_ONLY')), null);
    const shell = code(read('workspaces/WorkspaceShell.tsx'));
    assert.match(shell, /\{workHref \? \(\s*<Link className="loop-iconbtn" href=\{workHref\}/);
    assert.equal(shell.includes("href=\"/app/admin/work\""), false, 'no hard-coded Admin destination');
  });

  it('breadcrumb and active item resolve on nested routes', () => {
    const active = (path: string) => resolveActiveNav(LOOP_NAV, path)?.label ?? null;
    assert.equal(active('/app'), 'Home');
    assert.equal(active('/crm'), 'Command Center');
    assert.equal(active('/crm/customers/c_1/activity'), 'Intake Records');
    assert.equal(active('/crm/live/calls'), 'Live Calls');
    assert.equal(active('/app/crm/relationships'), 'Relationships');
    assert.equal(active('/app/crm/relationships/r_1'), 'Relationships', 'and on its nested routes');
    assert.equal(active('/app/crm/people/p_1'), 'People');
    assert.equal(active('/crm/parties/p_1'), 'Identity Review');
    assert.equal(active('/crm/relationships/r_1'), 'Command Center', 'the verification screens sit under the CRM command center');
    assert.equal(active('/crm/opportunities'), 'Command Center', 'an address no item owns falls to the CRM command center');
    assert.equal(active('/app/admin/work/abc123'), 'My Work');
    assert.equal(active('/app/admin/work/team'), 'Team Work');
    assert.equal(active('/app/employee/work/abc123'), 'My Work');
    assert.equal(active('/app/admin/marketplace/buyers'), 'CallGrid Intelligence');
    assert.equal(active('/app/admin/headlines/h1'), 'Headlines');
    assert.equal(active('/app/admin/administration/work-types'), 'Work Types');
    assert.equal(active('/app/creator/content/c_1'), 'Content');
    assert.equal(active('/app/creator/earnings'), 'Earnings');
  });
});

describe('Narrow screens: the operating-area bar', () => {
  it('offers each operating area the person can open, at its first openable item, and marks the current one', () => {
    assert.deepEqual(config.areaEntries(navForRole('OWNER')), [
      { area: 'HOME', label: 'Home', href: '/app' },
      { area: 'CRM', label: 'CRM', href: '/app/crm/people' },
      { area: 'WORK', label: 'Work', href: '/app/admin/work' },
      { area: 'INTELLIGENCE', label: 'Intel', href: '/app/admin/headlines' },
      { area: 'OPERATIONS', label: 'Ops', href: '/crm/live/activity' },
    ]);
    assert.deepEqual(config.areaEntries(navForRole('READ_ONLY')).map((e) => e.area), ['HOME', 'CRM', 'INTELLIGENCE', 'OPERATIONS'], 'no Work area without a queue');
    assert.deepEqual(config.areaEntries(navForRole('AI_EMPLOYEE')).find((e) => e.area === 'CRM')?.href, '/crm', 'an area leads to what this person can open');
    const soon = { href: '/soon', label: 'Soon item', icon: 'flow', soon: true };
    assert.deepEqual(config.areaEntries([{ label: 'Work', area: 'WORK', short: 'Work', items: [soon, { href: '/real', label: 'Real', icon: 'flow' }] }]), [
      { area: 'WORK', label: 'Work', href: '/real' },
    ], 'never a Soon destination');
    assert.deepEqual(config.areaEntries([{ label: 'Work', area: 'WORK', items: [soon] }]), [], 'an area with nothing to open is not a tab');
    assert.deepEqual(config.areaEntries([{ label: 'Administration', footer: true, items: [{ href: '/x', label: 'X', icon: 'cog' }] }]), [], 'administration is not an area');
    const html = renderAt('/app/crm/people/p_1', <AreaBar groups={navForRole('OWNER')} />);
    assert.match(html, /<nav class="loop-areabar" aria-label="Operating areas">/);
    assert.match(html, /<a class="loop-areabar__link is-active" aria-current="true" href="\/app\/crm\/people">/);
    assert.equal((html.match(/is-active/g) ?? []).length, 1);
    const shell = code(read('workspaces/WorkspaceShell.tsx'));
    assert.match(shell, /<AreaBar groups=\{groups\} \/>/);
    assert.match(shell, /<input type="checkbox" id="loop-menu" className="loop-menu-toggle" \/>/);
  });
});

describe('The active item and breadcrumb follow the page actually shown', () => {
  // Regression: the shell is mounted by persistent layouts (/crm, /app/admin),
  // which Next does not re-render on client-side navigation. The active item and
  // breadcrumb were computed there on the server, so they froze on the page that
  // was hard-loaded: /crm/customers → Conversations → Intake Board → Inbox →
  // Search kept "Intake Records", and /app/admin/headlines → My Work kept "Headlines".
  // Rendering with the SAME server-resolved groups at different client paths is
  // exactly that situation.
  const owner = navForRole('OWNER');
  const activeAt = (path: string) => {
    const html = renderAt(path, <ShellNav groups={owner} label="Loop" />);
    return [...html.matchAll(/aria-current="page" href="([^"]+)"/g)].map((m) => m[1]);
  };
  const crumbAt = (path: string) => renderAt(path, <ShellCrumb groups={owner} />);

  it('the CRM chain from the audit highlights each page in turn, never the first', () => {
    const chain: [string, string, string][] = [
      ['/crm/customers', '/crm/customers', 'Intake Records'],
      ['/crm/conversations', '/crm/conversations', 'Conversations'],
      ['/crm/pipeline', '/crm/pipeline', 'Intake Board'],
      ['/crm/inbox', '/crm/inbox', 'Inbox'],
      ['/crm/search', '/crm/search', 'Search'],
    ];
    for (const [path, href, label] of chain) {
      assert.deepEqual(activeAt(path), [href], path);
      assert.equal(crumbAt(path), `<span aria-current="page">${label}</span>`, path);
    }
  });

  it('Headlines → My Work in the /app/admin tree moves the highlight and the breadcrumb', () => {
    assert.deepEqual(activeAt('/app/admin/headlines'), ['/app/admin/headlines']);
    assert.equal(crumbAt('/app/admin/headlines'), '<span aria-current="page">Headlines</span>');
    assert.deepEqual(activeAt('/app/admin/work'), ['/app/admin/work']);
    assert.equal(crumbAt('/app/admin/work'), '<span aria-current="page">My Work</span>');
  });

  it('nested and unmatched paths resolve through the same rule', () => {
    assert.deepEqual(activeAt('/crm/customers/c_1/activity'), ['/crm/customers']);
    assert.deepEqual(activeAt('/app'), ['/app']);
    assert.equal(crumbAt('/nowhere'), '<span aria-current="page">Overview</span>');
  });

  it('the path comes from the client router, never from a server value frozen in a layout', () => {
    const nav = code(read('workspaces/ShellNav.tsx'));
    assert.match(read('workspaces/ShellNav.tsx'), /^'use client';/);
    assert.match(nav, /return resolveActiveNav\(\{ nav: \[\.\.\.groups\] \}, usePathname\(\)\);/);
    assert.equal(/active\??:/.test(nav.slice(nav.indexOf('export function ShellNav'))), false, 'no active prop to freeze');
    const shell = code(read('workspaces/WorkspaceShell.tsx'));
    assert.equal(/headers\(|x-pathname|resolveActiveNav/.test(shell), false);
  });
});

describe('Loop Home', () => {
  it('Owner/Admin/Manager get the operational overview; everyone else gets the areas they can open', () => {
    const app = code(read('app/app/page.tsx'));
    assert.match(app, /role === 'ADMIN' \? \(\s*<AdminHome session=\{session\} principal=\{principal\} day=\{day\}[^>]*\/>\s*\) : \(\s*<ModuleHome\s+name=\{session\.name\}\s+groups=\{await navFor\(session\)\}/);
    assert.equal(existsSync(join(APP, 'app', '_home', 'workspace-home.tsx')), false, 'the role-branded placeholder home is gone');
  });

  it('greets the person and links only to what they can open', () => {
    const time = createTimeView({ timeZone: 'America/New_York', source: 'device' }, new Date('2026-09-24T14:00:00Z'));
    const html = render(<ModuleHome name="Charlie Reyes" groups={navForRole('EMPLOYEE')} time={time} day={null} dayFailed={false} mail={null} mailFailed={false} needsYou={[]} />);
    // The module Home is the daily briefing too (2026-09-24): it greets by the reader's clock.
    assert.match(html, /<h1 class="loop-title">Good morning, Charlie Reyes<\/h1>/);
    // Relationships and Parties are built and an employee can open both, so Home
    // links to them. It was in the absent list only while they were `soon`.
    for (const href of ['/crm', '/crm/customers', '/app/crm/people', '/app/crm/relationships', '/crm/parties', '/crm/intelligence', '/app/employee/work', '/crm/ai-employees']) {
      assert.ok(html.includes(`href="${href}"`), href);
    }
    for (const absent of ['/app/admin', '/crm/opportunities', '/app/work/workflows', 'href="/app"', 'Workspace']) {
      assert.equal(html.includes(absent), false, absent);
    }
    // Drawn with the shared primitives of the Loop design system.
    assert.match(html, /<section class="loop-panel" aria-label="CRM"><h2 class="loop-panel__title">CRM<\/h2>/);
    assert.match(html, /<div class="loop-page" aria-label="Loop Home">/);
  });
});

describe('Legacy placeholder addresses are honest', () => {
  it('/app/admin/crm no longer claims the CRM lives there', () => {
    const html = render(<UnavailablePage href="/app/admin/crm" />);
    assert.match(html, /This page is not available/);
    assert.equal(/CRM lives here|Loop OS shell|later PR/.test(html), false);
  });

  it('an unbuilt module says it is not built', () => {
    const html = render(<UnavailablePage href="/app/admin/creator-hub" />);
    assert.match(html, /<h1 class="loop-title">Creators<\/h1>/);
    assert.match(html, /Creators is not built yet/);
  });
});

describe('Every page in a role-guarded tree states its authority itself', () => {
  const HOME_REDIRECTS = new Set(['admin', 'employee', 'client', 'business', 'creator'].map((d) => join(APP, 'app', d, 'page.tsx')));

  it('as the first thing it awaits, before any read', () => {
    for (const role of WORKSPACE_ROLES) {
      const tree = join(APP, WORKSPACES[role].basePath);
      const pages = walk(tree).filter((f) => f.endsWith('/page.tsx'));
      assert.ok(pages.length > 0, role);
      for (const page of pages) {
        const rel = relative(SRC, page);
        if (HOME_REDIRECTS.has(page)) {
          // A former role home: renders nothing, sends everyone to Loop Home.
          const body = code(readFileSync(page, 'utf8'));
          assert.match(body, /redirect\(LOOP_HOME\);/, rel);
          assert.equal(/await |load|repositories|prisma/.test(body.slice(body.indexOf('export default'))), false, rel);
          continue;
        }
        const src = code(readFileSync(page, 'utf8'));
        const body = src.slice(src.indexOf('export default async function'));
        assert.ok(body.length > 0, `${rel} has an async default export`);
        const first = body.match(/await ([^;]+);/)?.[1] ?? '';
        const guards = [
          `requireWorkspace('${role}')`, `requireWorkspace("${role}")`,
          `requireWorkspacePermission('${role}'`, `requireWorkspacePermission("${role}"`,
          ...(role === 'ADMIN' ? ['requireWorkActor()'] : []),
          ...(role === 'EMPLOYEE' ? ['requireEmployeeActor()'] : []),
        ];
        assert.ok(guards.some((g) => first.startsWith(g)), `${rel}: first await is "${first}"`);
      }
    }
  });

  it('the Work OS actor helpers are that same authority', () => {
    assert.match(code(read('app/app/admin/work/work-data.ts')), /export async function requireWorkActor\(\): Promise<WorkActor> \{\s*const session = await requireWorkspace\('ADMIN'\);/);
    assert.match(code(read('app/app/employee/work/work-data.ts')), /export async function requireEmployeeActor\(\): Promise<EmployeeActor> \{\s*const session = await requireWorkspace\('EMPLOYEE'\);/);
  });

  it('the tree layouts still guard too, as defence in depth', () => {
    for (const role of WORKSPACE_ROLES) {
      const layout = code(readFileSync(join(APP, WORKSPACES[role].basePath, 'layout.tsx'), 'utf8'));
      assert.match(layout, new RegExp(`const session = await requireWorkspace\\('${role}'\\);`), role);
    }
  });
});
