// The navigation rail's folds (2026-09-24, approved): each group leads with its
// primary items and keeps the rest behind one disclosure row. The fold is data
// in the one registry (NavGroup.fold, NavItem.folded), drawn by ShellNav; the
// phone's area bar is untouched by it.
//
// Behavioural through the pure plan (foldPlan) and the markup rendered at a
// client path. Source-level for the browser-only part, the remembered choice,
// which no server render can exercise.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
// The context next/navigation's usePathname() reads: the client router's current path.
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { matrixAllows } from '@emgloop/database';
import { LOOP_NAV, areaEntries, resolveActiveNav, visibleNav, type NavGroup } from '../src/workspaces/config';
import { resolveWorkspaceRole } from '../src/workspaces/role-router';
import { AreaBar, ShellNav, foldPlan } from '../src/workspaces/ShellNav';

const NAV_SRC = readFileSync(new URL('../src/workspaces/ShellNav.tsx', import.meta.url), 'utf8');
const code = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
/** Render as the client router would at `path`. */
const renderAt = (path: string, el: React.ReactNode) =>
  renderToStaticMarkup(<PathnameContext.Provider value={path}>{el}</PathnameContext.Provider>);

const navForRole = (systemRole: string): NavGroup[] =>
  visibleNav(LOOP_NAV.nav, {
    workspace: resolveWorkspaceRole({ systemRole }),
    permitted: (item) => matrixAllows(systemRole, item.requires!.resource, item.requires!.action),
  });
/** Everything an ADMIN-authority person who holds every permission is offered. */
const everything = visibleNav(LOOP_NAV.nav, { workspace: 'ADMIN', permitted: () => true });
const planAt = (groups: readonly NavGroup[], path: string) =>
  foldPlan(groups, resolveActiveNav({ nav: [...groups] }, path)?.href ?? null);
/** A plan in one comparable shape: [group, heading, primary labels, fold]. */
const shape = (groups: readonly NavGroup[], path = '/nowhere') =>
  planAt(groups, path).map((p) => [
    p.group.label,
    p.heading,
    p.primary.map((i) => i.label),
    p.fold
      ? { key: p.fold.key, id: p.fold.id, label: p.fold.label, count: p.fold.count, items: p.fold.items.map((i) => i.label), activeInside: p.fold.activeInside }
      : null,
  ]);
/** The keys of the folds that are open around `path`. */
const insideAt = (groups: readonly NavGroup[], path: string) =>
  planAt(groups, path).flatMap((p) => (p.fold?.activeInside ? [p.fold.key] : []));

describe('The fold model is data in the one registry', () => {
  it('for the whole application: which folds exist, their keys, labels, counts and items', () => {
    assert.deepEqual(shape(everything), [
      // Home is all primary and unlabelled: no heading, no fold.
      ['', null, ['Home', 'Mail', 'Chats', 'Calendar', 'Connections'], null],
      // CRM keeps the redesigned surfaces and the Command Center primary; the intake tools fold.
      ['CRM', 'CRM', ['People', 'Relationships', 'Command Center'], {
        key: 'crm-intake-tools', id: 'loop-fold-crm-intake-tools', label: 'Intake tools', count: 7,
        items: ['Conversations', 'Intake Records', 'Intake Board', 'Identity Review', 'Inbox', 'Search', 'Automations'],
        activeInside: false,
      }],
      // My Work stays primary (final); the organization's work administration folds.
      ['Work', 'Work', ['My Work'], {
        key: 'work-team-work-types', id: 'loop-fold-work-team-work-types', label: 'Team work & types', count: 2,
        items: ['Team Work', 'Work Types'], activeInside: false,
      }],
      // Whole groups fold: no heading, the row carries the group label.
      ['Intelligence', null, [], {
        key: 'intelligence-intelligence', id: 'loop-fold-intelligence-intelligence', label: 'Intelligence', count: 9,
        items: ['Headlines', 'Your queue', 'Executive Brain', 'Intelligence status', 'Intelligence Flow', 'CallGrid Intelligence', 'Analytics', 'Traffic', 'Revenue'],
        activeInside: false,
      }],
      ['Operations', null, [], {
        key: 'operations-operations', id: 'loop-fold-operations-operations', label: 'Operations', count: 4,
        items: ['Live Operations', 'Live Calls', 'Websites', 'Creators'], activeInside: false,
      }],
      ['Administration', null, [], {
        key: 'administration-administration', id: 'loop-fold-administration-administration', label: 'Administration', count: 7,
        items: ['Team', 'Workspace', 'Settings', 'Objectives', 'Audit Log', 'AI Employees', 'Integration OS'], activeInside: false,
      }],
    ]);
  });

  it('for an employee: the same folds over what they can open, and no fold where nothing folds for them', () => {
    assert.deepEqual(shape(navForRole('EMPLOYEE')), [
      ['', null, ['Home', 'Mail', 'Chats', 'Calendar', 'Connections'], null],
      ['CRM', 'CRM', ['People', 'Relationships', 'Command Center'], {
        key: 'crm-intake-tools', id: 'loop-fold-crm-intake-tools', label: 'Intake tools', count: 7,
        items: ['Conversations', 'Intake Records', 'Intake Board', 'Identity Review', 'Inbox', 'Search', 'Automations'],
        activeInside: false,
      }],
      // Team Work and Work Types are ADMIN authority: an employee's Work group has nothing to fold.
      ['Work', 'Work', ['My Work'], null],
      ['Intelligence', null, [], {
        key: 'intelligence-intelligence', id: 'loop-fold-intelligence-intelligence', label: 'Intelligence', count: 4,
        items: ['Intelligence Flow', 'Analytics', 'Traffic', 'Revenue'], activeInside: false,
      }],
      ['Operations', null, [], {
        key: 'operations-operations', id: 'loop-fold-operations-operations', label: 'Operations', count: 3,
        items: ['Live Operations', 'Live Calls', 'Websites'], activeInside: false,
      }],
      ['Administration', null, [], {
        key: 'administration-administration', id: 'loop-fold-administration-administration', label: 'Administration', count: 1,
        items: ['AI Employees'], activeInside: false,
      }],
    ]);
  });

  it('the creator seat has no fold and no folded item', () => {
    const creator = LOOP_NAV.nav.find((g) => g.label === 'Creator')!;
    assert.equal(creator.fold, undefined);
    assert.equal(creator.items.some((i) => i.folded), false);
    assert.deepEqual(shape(navForRole('CREATOR')), [
      ['', null, ['Home'], null],
      ['Creator', 'Creator', ['Content', 'Opportunities', 'Analytics', 'Tasks', 'Earnings', 'Profile'], null],
    ]);
  });

  it('nothing unbuilt is in the rail: no item is Soon', () => {
    // Opportunities, Campaigns and Work OS Workflows were Soon items; the Command Center's
    // Upcoming list is where what is coming is named. The Soon mechanism itself stays.
    assert.deepEqual(LOOP_NAV.nav.flatMap((g) => g.items).filter((i) => i.soon), []);
    for (const plan of foldPlan(everything, null)) {
      if (plan.fold) assert.equal(plan.fold.count, plan.fold.items.length, plan.fold.key);
    }
  });

  it('a folded item is the same item: same group, resolved for the breadcrumb through the one resolver', () => {
    const groupOf = (label: string) => LOOP_NAV.nav.find((g) => g.items.some((i) => i.label === label))?.label;
    assert.equal(groupOf('Headlines'), 'Intelligence');
    assert.equal(groupOf('Team Work'), 'Work');
    assert.equal(groupOf('Inbox'), 'CRM');
    const active = (path: string) => resolveActiveNav(LOOP_NAV, path)?.label ?? null;
    assert.equal(active('/app/admin/headlines/h1'), 'Headlines');
    assert.equal(active('/crm/inbox'), 'Inbox');
    assert.equal(active('/app/admin/work/team'), 'Team Work');
    assert.equal(active('/crm/settings'), 'Settings');
    assert.equal(active('/crm/live/calls'), 'Live Calls');
  });

  it('the plan is pure: the same groups and path give the same plan, and a fold with nothing openable counts none', () => {
    assert.deepEqual(shape(everything, '/crm/inbox'), shape(everything, '/crm/inbox'));
    const later: NavGroup = {
      label: 'Later', fold: { label: 'Not yet' },
      items: [{ href: '/now', label: 'Now', icon: 'flow' }, { href: '/later', label: 'Later thing', icon: 'flow', soon: true, folded: true }],
    };
    assert.deepEqual(shape([later]), [['Later', 'Later', ['Now'], {
      key: 'later-not-yet', id: 'loop-fold-later-not-yet', label: 'Not yet', count: 0, items: ['Later thing'], activeInside: false,
    }]]);
  });
});

describe('A fold opens itself around the page shown', () => {
  it('exactly the fold that holds the page, through the one resolver', () => {
    assert.deepEqual(insideAt(everything, '/app/admin/headlines'), ['intelligence-intelligence']);
    assert.deepEqual(insideAt(everything, '/app/admin/headlines/h1'), ['intelligence-intelligence'], 'and on its nested routes');
    assert.deepEqual(insideAt(everything, '/crm/inbox'), ['crm-intake-tools']);
    assert.deepEqual(insideAt(everything, '/crm/customers/c_1/activity'), ['crm-intake-tools']);
    assert.deepEqual(insideAt(everything, '/app/admin/work/team'), ['work-team-work-types']);
    assert.deepEqual(insideAt(everything, '/crm/settings'), ['administration-administration']);
    assert.deepEqual(insideAt(everything, '/crm/live/calls'), ['operations-operations']);
    // A primary item opens nothing; neither does a page no item owns.
    assert.deepEqual(insideAt(everything, '/app/admin/work'), []);
    assert.deepEqual(insideAt(everything, '/app/crm/people/p_1'), []);
    assert.deepEqual(insideAt(everything, '/crm'), []);
    assert.deepEqual(insideAt(everything, '/app'), []);
    assert.deepEqual(insideAt(everything, '/nowhere'), []);
    assert.deepEqual(insideAt(navForRole('EMPLOYEE'), '/crm/intelligence'), ['intelligence-intelligence']);
  });

  it('renders the row as a disclosure button, the list hidden by attribute, and only the active fold open', () => {
    const html = renderAt('/crm/inbox', <ShellNav groups={everything} label="Loop" />);
    assert.match(html, /<nav class="loop-sb__scroll" aria-label="Loop">/);
    // Primary links under the group heading, then the row and its list.
    assert.match(html, /<div class="loop-sb__grouplabel">CRM<\/div><a class="loop-sb__link" href="\/app\/crm\/people">/);
    assert.match(html, /<button type="button" class="loop-sb__fold is-inside" aria-expanded="true" aria-controls="loop-fold-crm-intake-tools"><span class="loop-sb__chev" aria-hidden="true"><svg [^>]*aria-hidden="true">.*?<\/svg><\/span><span>Intake tools<\/span><span class="loop-sb__foldcount">7<\/span><\/button><div id="loop-fold-crm-intake-tools" class="loop-sb__foldlist"><a class="loop-sb__link" href="\/crm\/conversations">/);
    assert.match(html, /<a class="loop-sb__link is-active" aria-current="page" href="\/crm\/inbox">/);
    assert.equal((html.match(/is-active/g) ?? []).length, 1);
    // Every other fold is closed: its list carries `hidden`, its row says so.
    assert.equal((html.match(/class="loop-sb__foldlist"/g) ?? []).length, 5);
    assert.equal((html.match(/class="loop-sb__foldlist" hidden=""/g) ?? []).length, 4);
    assert.equal((html.match(/aria-expanded="false"/g) ?? []).length, 4);
    assert.equal((html.match(/aria-expanded="true"/g) ?? []).length, 1);
    assert.equal(/style="/.test(html), false, 'hidden by attribute, never by style');
    // The row shows how many items it holds.
    for (const [key, count] of [['work-team-work-types', 2], ['intelligence-intelligence', 9], ['operations-operations', 4], ['administration-administration', 7]] as const) {
      assert.match(html, new RegExp(`aria-controls="loop-fold-${key}">.*?<span class="loop-sb__foldcount">${count}</span></button><div id="loop-fold-${key}" class="loop-sb__foldlist" hidden="">`), key);
    }
    // A wholly folded group has no heading: the row carries the label.
    assert.deepEqual([...html.matchAll(/<div class="loop-sb__grouplabel">([^<]+)<\/div>/g)].map((m) => m[1]), ['CRM', 'Work']);
    assert.match(html, /<div class="loop-sb__group"><button type="button" class="loop-sb__fold" aria-expanded="false" aria-controls="loop-fold-intelligence-intelligence">.*?<span>Intelligence<\/span>/);
    // A folded item is drawn once, inside its list, never as a primary link.
    const headlines = [...html.matchAll(/href="\/app\/admin\/headlines"/g)];
    assert.equal(headlines.length, 1);
    assert.ok(headlines[0]!.index! > html.indexOf('id="loop-fold-intelligence-intelligence"'));
    // The Administration foot goes through the same code path, pinned at the bottom.
    assert.match(html, /<nav class="loop-sb__adminarea" aria-label="Administration"><div class="loop-sb__group"><button type="button" class="loop-sb__fold" aria-expanded="false" aria-controls="loop-fold-administration-administration">/);
  });

  it('on Loop Home every fold is closed; inside Intelligence and Work, those open', () => {
    const home = renderAt('/app', <ShellNav groups={everything} label="Loop" />);
    assert.equal(/aria-expanded="true"/.test(home), false);
    assert.equal((home.match(/class="loop-sb__foldlist" hidden=""/g) ?? []).length, 5);
    assert.equal(/is-inside/.test(home), false);
    const headlines = renderAt('/app/admin/headlines/h1', <ShellNav groups={everything} label="Loop" />);
    assert.match(headlines, /<button type="button" class="loop-sb__fold is-inside" aria-expanded="true" aria-controls="loop-fold-intelligence-intelligence">/);
    assert.match(headlines, /<div id="loop-fold-intelligence-intelligence" class="loop-sb__foldlist"><a class="loop-sb__link is-active" aria-current="page" href="\/app\/admin\/headlines">/);
    const team = renderAt('/app/admin/work/team', <ShellNav groups={everything} label="Loop" />);
    assert.match(team, /<button type="button" class="loop-sb__fold is-inside" aria-expanded="true" aria-controls="loop-fold-work-team-work-types">/);
    assert.match(team, /<a class="loop-sb__link" href="\/app\/admin\/work">.*?<a class="loop-sb__link is-active" aria-current="page" href="\/app\/admin\/work\/team">/);
    // The server render is a pure function of groups and path: what the client hydrates against.
    assert.equal(renderAt('/crm/inbox', <ShellNav groups={everything} label="Loop" />), renderAt('/crm/inbox', <ShellNav groups={everything} label="Loop" />));
  });

  it('a Soon item behind a fold is still a disabled non-link, and never counted', () => {
    const later: NavGroup = {
      label: 'Later', fold: { label: 'Not yet' },
      items: [{ href: '/now', label: 'Now', icon: 'flow' }, { href: '/later', label: 'Later thing', icon: 'flow', soon: true, folded: true }],
    };
    const html = renderAt('/now', <ShellNav groups={[later]} label="Loop" />);
    assert.match(html, /<span class="loop-sb__foldcount">0<\/span>/);
    assert.match(html, /<span class="loop-sb__link is-disabled" aria-disabled="true">.*?Later thing.*?Soon<\/span><\/span>/);
    assert.equal(/href="\/later"/.test(html), false);
  });
});

describe('The remembered choice is a browser convenience the shell never trusts', () => {
  const src = code(NAV_SRC);

  it('stays a client leaf that imports nothing from the database', () => {
    assert.match(NAV_SRC, /^'use client';/);
    assert.equal(/@emgloop\/database/.test(src), false);
    assert.match(src, /return resolveActiveNav\(\{ nav: \[\.\.\.groups\] \}, usePathname\(\)\);/, 'the path still comes from the client router');
  });

  it('reads and writes exactly one localStorage key, loop.nav.folds, and only inside try/catch', () => {
    assert.equal((NAV_SRC.match(/'loop\.nav\.folds'/g) ?? []).length, 1, 'one key, declared once');
    assert.match(src, /const FOLD_STORE = 'loop\.nav\.folds';/);
    const calls = [...src.matchAll(/localStorage\.(\w+)\(([^,)]*)/g)];
    assert.deepEqual(calls.map((m) => [m[1], m[2]!.trim()]), [['getItem', 'FOLD_STORE'], ['setItem', 'FOLD_STORE']]);
    const total = (src.match(/localStorage/g) ?? []).length;
    const guarded = [...src.matchAll(/try \{([\s\S]*?)\} catch/g)].reduce((n, m) => n + (m[1]!.match(/localStorage/g) ?? []).length, 0);
    assert.equal(total, 2);
    assert.equal(guarded, total, 'every touch of storage is inside a try block');
    assert.equal(/sessionStorage|document\.cookie|indexedDB/.test(src), false);
  });

  it('applies the remembered choice after mount, so the first client render matches the server', () => {
    assert.match(src, /useState<FoldChoices>\(\{\}\)/, 'nothing remembered before mount');
    assert.match(src, /useEffect\(\(\) => \{\s*setChoices\(readFoldChoices\(\)\);\s*\}, \[\]\);/);
    // open = remembered (default closed) OR inside-and-not-closed-here.
    assert.match(src, /\(choices\[fold\.key\] \?\? false\) \|\| \(fold\.activeInside && !closedHere\.includes\(fold\.key\)\)/);
    // The list hides by attribute; nothing here toggles display in a style.
    assert.match(src, /hidden=\{!open\}/);
    assert.equal(/style=\{|display:/.test(src), false);
    assert.match(src, /<button\s+type="button"\s+className=\{'loop-sb__fold'/);
    assert.match(src, /aria-expanded=\{open\}\s+aria-controls=\{fold\.id\}/);
  });
});

describe('The phone area bar is unchanged', () => {
  it('offers the same entries, at the same first item, as before the rail folded', () => {
    // Pinned from the registry as it stood before 2026-09-24.
    const org = [
      { area: 'HOME', label: 'Home', href: '/app' },
      { area: 'CRM', label: 'CRM', href: '/app/crm/people' },
      { area: 'WORK', label: 'Work', href: '/app/admin/work' },
      { area: 'INTELLIGENCE', label: 'Intel', href: '/app/admin/headlines' },
      { area: 'OPERATIONS', label: 'Ops', href: '/crm/live/activity' },
    ];
    for (const role of ['OWNER', 'ADMIN', 'MANAGER']) assert.deepEqual(areaEntries(navForRole(role)), org, role);
    assert.deepEqual(areaEntries(navForRole('EMPLOYEE')), [
      { area: 'HOME', label: 'Home', href: '/app' },
      { area: 'CRM', label: 'CRM', href: '/app/crm/people' },
      { area: 'WORK', label: 'Work', href: '/app/employee/work' },
      { area: 'INTELLIGENCE', label: 'Intel', href: '/crm/intelligence' },
      { area: 'OPERATIONS', label: 'Ops', href: '/crm/live/activity' },
    ]);
    assert.deepEqual(areaEntries(navForRole('AI_EMPLOYEE')), [
      { area: 'HOME', label: 'Home', href: '/app' },
      { area: 'CRM', label: 'CRM', href: '/crm' },
      { area: 'WORK', label: 'Work', href: '/app/employee/work' },
      { area: 'INTELLIGENCE', label: 'Intel', href: '/crm/intelligence' },
      { area: 'OPERATIONS', label: 'Ops', href: '/crm/live/activity' },
    ]);
    assert.deepEqual(areaEntries(navForRole('READ_ONLY')), [
      { area: 'HOME', label: 'Home', href: '/app' },
      { area: 'CRM', label: 'CRM', href: '/app/crm/people' },
      { area: 'INTELLIGENCE', label: 'Intel', href: '/crm/intelligence' },
      { area: 'OPERATIONS', label: 'Ops', href: '/crm/live/activity' },
    ]);
    assert.deepEqual(areaEntries(navForRole('CREATOR')), [
      { area: 'HOME', label: 'Home', href: '/app' },
      { area: 'CONTENT', label: 'Content', href: '/app/creator/content' },
      { area: 'OPPORTUNITIES', label: 'Opportunities', href: '/app/creator/opportunities' },
      { area: 'TASKS', label: 'Tasks', href: '/app/creator/tasks' },
      { area: 'EARNINGS', label: 'Earnings', href: '/app/creator/earnings' },
    ]);
  });

  it('marks the area of a folded page through the same resolver, and knows nothing of folds', () => {
    const html = renderAt('/crm/inbox', <AreaBar groups={everything} />);
    assert.match(html, /<a class="loop-areabar__link is-active" aria-current="true" href="\/app\/crm\/people">/);
    assert.equal((html.match(/is-active/g) ?? []).length, 1);
    const bar = code(NAV_SRC).slice(code(NAV_SRC).indexOf('export function AreaBar'));
    assert.equal(/fold/i.test(bar), false);
  });
});
