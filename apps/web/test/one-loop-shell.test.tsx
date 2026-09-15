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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
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
import { ShellCrumb, ShellNav } from '../src/workspaces/ShellNav';
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

const SYSTEM_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'AI_EMPLOYEE', 'READ_ONLY', 'SOMETHING_NEW'] as const;
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
const labels = (groups: NavGroup[]) => groups.map((g) => [g.label, g.items.map((i) => i.label + (i.soon ? ' (soon)' : ''))]);

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
      'app/crm/layout.tsx', 'app/app/page.tsx',
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
  it('is Home · CRM · Intelligence · Work OS · Creator Hub/Accounting, with Administration at the foot', () => {
    assert.deepEqual(LOOP_NAV.nav.map((g) => [g.label, Boolean(g.footer)]), [
      ['', false], ['CRM', false], ['Intelligence', false], ['Work OS', false], ['', false], ['Administration', true],
    ]);
    assert.deepEqual(LOOP_NAV.nav[0]!.items.map((i) => [i.label, i.href]), [['Home', '/app']]);
    assert.deepEqual(LOOP_NAV.nav[4]!.items.map((i) => i.label), ['Creator Hub', 'Accounting']);
    assert.deepEqual(LOOP_NAV.nav[5]!.items.map((i) => i.label), [
      'Team', 'Workspace', 'Settings', 'Objectives', 'Audit Log', 'AI Employees', 'Integration OS',
    ]);
  });

  it('CRM opens the real CRM under /crm, starting at its Command Center', () => {
    const crm = LOOP_NAV.nav.find((g) => g.label === 'CRM')!;
    assert.deepEqual(crm.items.map((i) => [i.label, i.href, Boolean(i.soon)]), [
      ['Command Center', '/crm', false],
      ['Intake Records', '/crm/customers', false],
      ['Relationships', '/crm/relationships', true],
      ['Opportunities', '/crm/opportunities', true],
      ['Campaigns', '/crm/campaigns', true],
      ['Conversations', '/crm/conversations', false],
      ['Intake Board', '/crm/pipeline', false],
      ['Inbox', '/crm/inbox', false],
      ['Search', '/crm/search', false],
      ['Automations', '/crm/workflows', false],
    ]);
  });

  it('no item leads to the retired /app/admin/crm placeholder, or to any CRM copy outside /crm', () => {
    assert.equal(items.some((i) => i.href.startsWith('/app/admin/crm')), false);
    for (const item of enabled.filter((i) => i.group === 'CRM')) {
      assert.ok(item.href === '/crm' || item.href.startsWith('/crm/'), item.href);
      assert.equal(pageFor(item.href), join(APP, item.href, 'page.tsx'), `${item.label} is a real CRM page, not a placeholder`);
    }
  });

  it('only the unbuilt modules open the honest not-built page; every other item opens its own page', () => {
    const placeholders = enabled.filter((i) => pageFor(i.href)?.includes('[...slug]')).map((i) => i.label);
    assert.deepEqual(placeholders, ['Creator Hub', 'Accounting']);
    for (const item of enabled) assert.ok(pageFor(item.href), `${item.label} → ${item.href} has no page`);
  });

  it('unbuilt items are disabled and have no route', () => {
    for (const item of items.filter((i) => i.soon)) {
      assert.equal(existsSync(join(APP, item.href, 'page.tsx')), false, `${item.label} must stay soon until a route exists`);
      assert.equal(treeOf(item.href), undefined, `${item.label} must not fall into a catch-all`);
    }
  });

  it('the intake board is never presented as the Opportunity pipeline', () => {
    assert.equal(find('Intake Board').href, '/crm/pipeline');
    assert.equal(items.some((i) => /pipeline/i.test(i.label)), false);
    assert.notEqual(find('Opportunities').href, '/crm/pipeline');
  });

  it('CRM Automations, Work OS and Commercial Intelligence stay separate authorities', () => {
    const work = LOOP_NAV.nav.find((g) => g.label === 'Work OS')!;
    assert.deepEqual(work.items.map((i) => [i.label, i.href, i.workspace ?? null, Boolean(i.soon)]), [
      ['My Work', '/app/admin/work', 'ADMIN', false],
      ['My Work', '/app/employee/work', 'EMPLOYEE', false],
      ['Team Work', '/app/admin/work/team', 'ADMIN', false],
      ['Workflows', '/app/work/workflows', null, true],
      ['Work Types', '/app/admin/administration/work-types', 'ADMIN', false],
    ]);
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
    // CallGrid Intelligence's pages enforce ADMIN authority only; its item also
    // asks for intelligence:view, as that sidebar entry always has (config.ts).
    const ASKS_FOR_MORE = new Set(['/app/admin/marketplace']);
    for (const item of enabled) {
      const perm = enforcedPermission(pageFor(item.href)!);
      if (ASKS_FOR_MORE.has(item.href)) {
        assert.equal(perm, null);
        assert.deepEqual(item.requires, { resource: 'intelligence', action: 'view' });
        continue;
      }
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
    for (const role of ['EMPLOYEE', 'AI_EMPLOYEE']) {
      assert.deepEqual(labels(navForRole(role)), [
        ['', ['Home']],
        ['CRM', ['Command Center', 'Intake Records', 'Relationships (soon)', 'Opportunities (soon)', 'Campaigns (soon)', 'Conversations', 'Intake Board', 'Inbox', 'Search', 'Automations']],
        ['Intelligence', ['Intelligence Flow', 'Analytics', 'Traffic', 'Revenue', 'Live Operations', 'Live Calls', 'Websites']],
        ['Work OS', ['My Work', 'Workflows (soon)']],
        ['Administration', ['AI Employees']],
      ], role);
      assert.equal(myWorkHref(navForRole(role)), '/app/employee/work', role);
    }
  });

  it('Read Only is not isolated in a placeholder: it sees what its permissions allow, and no Work OS it cannot open', () => {
    const expected = [
      ['', ['Home']],
      ['CRM', ['Command Center', 'Intake Records', 'Relationships (soon)', 'Opportunities (soon)', 'Campaigns (soon)', 'Conversations', 'Intake Board', 'Inbox', 'Search', 'Automations']],
      ['Intelligence', ['Intelligence Flow', 'Analytics', 'Traffic', 'Revenue', 'Live Operations', 'Live Calls', 'Websites']],
      ['Administration', ['AI Employees']],
    ];
    assert.deepEqual(labels(navForRole('READ_ONLY')), expected);
    assert.deepEqual(labels(navForRole('SOMETHING_NEW')), expected, 'an unknown role gets the least, never more');
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
    for (const hidden of ['Intake Records', 'Inbox', 'Search']) assert.equal(shown.includes(hidden), false, hidden);
    for (const kept of ['Command Center', 'Conversations', 'Intake Board', 'Headlines']) assert.ok(shown.includes(kept), kept);
  });

  it('a group with nothing a person can open is not drawn, even if it holds Soon items', () => {
    const nav = visibleNav(LOOP_NAV.nav, { workspace: 'CLIENT', permitted: () => false });
    assert.deepEqual(labels(nav), [['', ['Home']], ['CRM', ['Command Center', 'Relationships (soon)', 'Opportunities (soon)', 'Campaigns (soon)']]]);
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

  it('draws only the items it is given, with Soon as a non-link and the Administration foot labelled', () => {
    const html = renderAt('/crm/customers', <ShellNav groups={navForRole('READ_ONLY')} label="Loop" />);
    assert.match(html, /<nav class="loop-sb__scroll" aria-label="Loop">/);
    assert.match(html, /<a class="loop-sb__link is-active" aria-current="page" href="\/crm\/customers">/);
    assert.equal(html.includes('/app/admin'), false, 'nothing from a tree Read Only cannot open');
    assert.equal(html.includes('Work OS'), false);
    assert.match(html, /<span class="loop-sb__link is-disabled" aria-disabled="true">.*?Relationships.*?Soon<\/span><\/span>/);
    assert.equal(/href="\/crm\/relationships"/.test(html), false);
    assert.match(html, /<nav class="loop-sb__adminarea" aria-label="Administration"><div class="loop-sb__group"><div class="loop-sb__grouplabel">Administration<\/div>/);
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
    assert.equal(active('/crm/relationships'), 'Command Center', 'a Soon item is never active');
    assert.equal(active('/app/admin/work/abc123'), 'My Work');
    assert.equal(active('/app/admin/work/team'), 'Team Work');
    assert.equal(active('/app/employee/work/abc123'), 'My Work');
    assert.equal(active('/app/admin/marketplace/buyers'), 'CallGrid Intelligence');
    assert.equal(active('/app/admin/headlines/h1'), 'Headlines');
    assert.equal(active('/app/admin/administration/work-types'), 'Work Types');
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
    assert.match(app, /\{role === 'ADMIN' \? <AdminHome \/> : <ModuleHome name=\{session\.name\} groups=\{await navFor\(session\)\} \/>\}/);
    assert.equal(existsSync(join(APP, 'app', '_home', 'workspace-home.tsx')), false, 'the role-branded placeholder home is gone');
  });

  it('greets the person and links only to what they can open', () => {
    const html = render(<ModuleHome name="Charlie Reyes" groups={navForRole('EMPLOYEE')} />);
    assert.match(html, /<h1 class="loop-title">Welcome, Charlie Reyes<\/h1>/);
    for (const href of ['/crm', '/crm/customers', '/crm/intelligence', '/app/employee/work', '/crm/ai-employees']) {
      assert.ok(html.includes(`href="${href}"`), href);
    }
    for (const absent of ['/app/admin', '/crm/relationships', '/app/work/workflows', 'href="/app"', 'Workspace']) {
      assert.equal(html.includes(absent), false, absent);
    }
    assert.match(html, /<section class="loop-card" aria-label="CRM">/);
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
    assert.match(html, /<h1 class="loop-title">Creator Hub<\/h1>/);
    assert.match(html, /Creator Hub is not built yet/);
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
