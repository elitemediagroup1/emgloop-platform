// Loop OS — navigation registry and role authority.
//
// EMG Loop is one application (docs/architecture/loop-application-structure.md).
// This file holds the ONE navigation registry every signed-in page renders,
// LOOP_NAV, and the role authority table the route guards use. It is data, not
// code branches: moving a nav item is an edit here, never a new shell.
//
// Nothing here is the security boundary. Each item DESCRIBES the authority its
// destination enforces, so nobody is shown a link that refuses them; every page
// still enforces that authority itself, server-side, on arrival.

import type { Resource, Action } from '@emgloop/database';
import { pickActiveHref } from '@emgloop/shared';

// ---------------------------------------------------------------------------
// Role authority. A PRODUCT concept over the unchanged SystemRole enum
// (OWNER/ADMIN/MANAGER/EMPLOYEE/AI_EMPLOYEE/READ_ONLY); role-router.ts maps a
// session onto one of these. It is authority, not a separate application: it
// decides which role-guarded route trees (/app/admin, /app/employee, ...) a
// person may open, and every role shares the same shell and the same LOOP_NAV.
// ---------------------------------------------------------------------------
export const WORKSPACE_ROLES = [
  'ADMIN',
  'EMPLOYEE',
  'BUSINESS_OWNER',
  'CREATOR',
  'CLIENT',
] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

// ---------------------------------------------------------------------------
// Navigation model. 'icon' names map to the existing SidebarIcon set; unknown
// names degrade gracefully to the default glyph, so new items never crash.
// ---------------------------------------------------------------------------
export interface NavItem {
  href: string;
  label: string;
  icon: string;
  /** The resource:action a person must hold to be offered the item: the one its destination enforces. */
  requires?: { resource: Resource; action: Action };
  /**
   * Not built: rendered as a disabled "Soon" item, never a link. Nothing in the
   * registry carries it today (2026-09-24: what is unbuilt is listed by the Command
   * Center under Upcoming, not offered in the rail); the mechanism stays so an
   * unbuilt destination can never be offered as a link.
   */
  soon?: boolean;
  /**
   * Secondary in the rail (2026-09-24): drawn inside its group's fold, a disclosure
   * row the person opens, rather than as a primary link under the group heading.
   * Navigation only: a folded item is the same item, resolves the same active state
   * and breadcrumb, and enforces the same authority. The fold opens itself while the
   * page shown is inside it.
   */
  folded?: true;
  /**
   * The role authority the destination enforces with requireWorkspace, when it
   * lives in a role-guarded route tree (/app/admin → ADMIN). Anyone else would
   * be sent back to Loop Home, so the item is shown only to that authority.
   */
  workspace?: WorkspaceRole;
  /**
   * This item is its own entry in the compact mobile bar, rather than part of its
   * group's area. The creator's five-area phone bar is Home · Content · Opportunities ·
   * Tasks · Earnings (design pass 2026-09-22, approved): four of the creator group's
   * items carry an area of their own, and the group itself has none.
   */
  area?: ShellArea;
}

/** Whether a nav item is offered: its permission, if any, and its role authority, if any. */
export function navItemVisible(
  item: Pick<NavItem, 'requires' | 'workspace'>,
  ctx: { permitted: boolean; workspace: WorkspaceRole },
): boolean {
  if (item.requires && !ctx.permitted) return false;
  if (item.workspace && item.workspace !== ctx.workspace) return false;
  return true;
}

/** The five operating areas (handoff 2026-09-16, p. 3). Administration is not one of them. */
export const OPERATING_AREAS = ['HOME', 'CRM', 'WORK', 'INTELLIGENCE', 'OPERATIONS'] as const;
export type OperatingArea = (typeof OPERATING_AREAS)[number];

/**
 * The creator seat's own areas (Creator Hub design pass, 2026-09-22, approved). They are
 * not operating areas: a creator never sees the organization's five, and the organization
 * never sees these. Together with HOME they make the creator's five-area phone bar.
 */
export const CREATOR_AREAS = ['CONTENT', 'OPPORTUNITIES', 'TASKS', 'EARNINGS'] as const;
/** Every area the compact mobile bar can hold: an operating area or a creator area. */
export type ShellArea = OperatingArea | (typeof CREATOR_AREAS)[number];

export interface NavGroup {
  label: string;
  items: NavItem[];
  /** The operating area this group is. Absent for Administration. */
  area?: OperatingArea;
  /** The area's name in the compact mobile bar. */
  short?: string;
  /** Renders separated at the bottom of the sidebar (Administration). */
  footer?: boolean;
  /**
   * The disclosure row over this group's `folded` items. Its label; absent, the
   * group's own label names the fold. A group whose every item is folded draws no
   * heading: the disclosure row carries the group label and the whole group folds.
   */
  fold?: { label: string };
}

/** A navigation tree the shell renders. LOOP_NAV is the only one. */
export interface ShellConfig {
  /** Names the navigation landmark. */
  label: string;
  /** Route prefix of the application. */
  basePath: string;
  /** Where the breadcrumb root leads: Loop Home. */
  home: string;
  /** The grouped navigation. */
  nav: NavGroup[];
}

// ---------------------------------------------------------------------------
// Role authority table. `basePath` is the route tree requireWorkspace(role)
// guards; `home` is where a person is sent when they open a tree their role
// does not hold. Every home is Loop Home: one application, one home.
// ---------------------------------------------------------------------------
export interface WorkspaceConfig {
  role: WorkspaceRole;
  basePath: string;
  home: string;
}

export const WORKSPACES: Record<WorkspaceRole, WorkspaceConfig> = {
  ADMIN: { role: 'ADMIN', basePath: '/app/admin', home: '/app' },
  EMPLOYEE: { role: 'EMPLOYEE', basePath: '/app/employee', home: '/app' },
  BUSINESS_OWNER: { role: 'BUSINESS_OWNER', basePath: '/app/business', home: '/app' },
  CREATOR: { role: 'CREATOR', basePath: '/app/creator', home: '/app' },
  CLIENT: { role: 'CLIENT', basePath: '/app/client', home: '/app' },
};

/** Look up a role's authority entry. */
export function workspaceFor(role: WorkspaceRole): WorkspaceConfig {
  return WORKSPACES[role];
}

// ---------------------------------------------------------------------------
// LOOP_NAV — the one navigation registry.
//
// Grouped as the five operating areas of Charlie and Lexi's handoff (2026-09-16)
// and Product C-01 to C-03: Home, CRM, Work, Intelligence and Operations, with
// Administration (system and workspace settings, not an operating area) at the
// foot. Engineering places routes (Matt, 2026-09-17); this registry is still
// NAVIGATION ONLY. Every item opens a route that already exists, wherever it lives
// today (/app/crm, /crm or /app/admin); no route moved.
//
// Primary and folded (2026-09-24, approved). The rail leads with what a person
// opens every day and folds the rest behind one disclosure row per group:
//   - Home: Home, Mail, Chats, Calendar, Connections — all primary. Chats and Calendar
//     are domain pages (2026-09-24): read-only compositions of the viewer's own Telegram
//     obligations and activity, and of their own calendar. Connections is configuration
//     only, the place a source is connected or managed; the domains link to it for that.
//   - CRM: People, Relationships and the Command Center are primary; the intake
//     tools fold behind "Intake tools".
//   - Work: My Work is primary (final: it stays in the primary rail for ADMIN and
//     EMPLOYEE alike); Team Work and Work Types fold behind "Team work & types".
//   - Intelligence, Operations and Administration fold entirely; the group label
//     is the disclosure row. Headlines stays registered (it is a real page and the
//     breadcrumb resolves through this registry) and Loop Home links to it directly.
//   - The creator seat does not fold.
// Nothing unbuilt is in the rail: Opportunities, Campaigns and Work OS Workflows
// were `soon` items here and are gone. The Command Center lists what is coming
// under Upcoming, which is the truthful place for it. `soon` stays supported so an
// unbuilt destination can never be offered as a link.
//
// Each item carries the authority its destination enforces: `requires` for the
// page's requirePermission, `workspace` for its route tree's requireWorkspace.
// The shell hides what a person cannot open. Never less than the page enforces.
//
// Boundaries the grouping must not blur:
//   - People are established PERSON Parties (/app/crm/people), never Intake
//     Records. Identity review is its own governed workflow, still served by the
//     temporary operator screen (/crm/parties) until its redesign covers it.
//   - The intake board is the legacy Customer.status board, never an
//     Opportunity pipeline. Opportunities and Campaigns are not built and have no
//     entry until their authorities exist.
//   - CRM Automations (automation triggers) and Work OS Workflows (human work
//     execution, not built, no entry) are different authorities under different
//     areas.
//   - "Your queue" is Commercial Intelligence's per-person attention queue, not
//     Work OS work.
//   - The deterministic Executive Brain is not the governed Brain, and is named
//     for what it is.
//   - Operations holds live execution and health (C-03) and creator
//     administration (C-02). CallGrid's analytical surface stays in Intelligence.
//   - Accounting is its own domain, surfaced contextually (C-01); it is not built,
//     so it has no global entry. Its honest not-built route still exists.
//   - The signed-in tenant's own Workspace Organization is administration, not
//     a commercial Relationship.
// ---------------------------------------------------------------------------
// Canonical identity (identityResolution:view) and the commercial Relationship area
// (relationships:view). Nav visibility is not authorization: each destination calls
// requirePermission itself, and the read services check again before reading.
const IDENTITY_VIEW = { resource: 'identityResolution', action: 'view' } as const;
const RELATIONSHIPS_VIEW = { resource: 'relationships', action: 'view' } as const;
const INTAKE_RECORDS_VIEW = { resource: 'customers', action: 'view' } as const;
const CONVERSATIONS_VIEW = { resource: 'inbox', action: 'view' } as const;
const INTAKE_VIEW = { resource: 'pipeline', action: 'view' } as const;
const AUTOMATIONS_VIEW = { resource: 'workflows', action: 'view' } as const;
const ANALYTICS_VIEW = { resource: 'analytics', action: 'view' } as const;
const INTELLIGENCE_VIEW = { resource: 'intelligence', action: 'view' } as const;
// Commercial Intelligence has its own resource, not 'intelligence' — see the
// note in iam.repository.ts about why reading conclusions and authoring intent
// are governed separately.
const CI_VIEW = { resource: 'commercialIntelligence', action: 'view' } as const;
const USERS_VIEW = { resource: 'users', action: 'view' } as const;
const ORGANIZATION_VIEW = { resource: 'organizations', action: 'view' } as const;
const SETTINGS_VIEW = { resource: 'settings', action: 'view' } as const;
const AUDIT_VIEW = { resource: 'audit', action: 'view' } as const;
const AI_EMPLOYEES_VIEW = { resource: 'aiEmployees', action: 'view' } as const;
const INTEGRATIONS_VIEW = { resource: 'integrations', action: 'view' } as const;
// A person's OWN Google Workspace connection (google-workspace-connection.md §11). Every
// human role holds it; an AI Employee does not.
const GOOGLE_WORKSPACE_VIEW = { resource: 'googleWorkspace', action: 'view' } as const;
// A person's OWN work state, derived from their OWN Google connection (DL-1 §20.1). Holding it
// grants your own rows and nobody else's, for any role -- the isolation is structural.
const EMPLOYEE_INTELLIGENCE_VIEW = { resource: 'employeeIntelligence', action: 'view' } as const;

export const LOOP_NAV: ShellConfig = {
  label: 'Loop',
  basePath: '/app',
  home: '/app',
  nav: [
    {
      label: '',
      area: 'HOME',
      short: 'Home',
      items: [
        { href: '/app', label: 'Home', icon: 'grid' },
        // Personal, not administration: each opens the signed-in person's OWN mailbox, chats,
        // day or connected accounts, and no role widens any of them.
        // The employee's own mail, inside Loop (GM-2).
        { href: '/app/mail', label: 'Mail', icon: 'mail', requires: EMPLOYEE_INTELLIGENCE_VIEW },
        // The employee's own chats (2026-09-24): what their own Telegram triage flagged and content-free
        // activity. Gated as the Connections page gates the Telegram tile, so exactly the people who
        // can see their Telegram connection see Chats.
        { href: '/app/chats', label: 'Chats', icon: 'chat', requires: GOOGLE_WORKSPACE_VIEW },
        // The employee's own day (2026-09-24), over the same read as Home and Mail, under Mail's gate.
        { href: '/app/calendar', label: 'Calendar', icon: 'calendar', requires: EMPLOYEE_INTELLIGENCE_VIEW },
        // Configuration only: where a source is connected and managed, never a domain surface.
        { href: '/app/connections', label: 'Connections', icon: 'plug', requires: GOOGLE_WORKSPACE_VIEW },
      ],
    },
    {
      label: 'CRM',
      area: 'CRM',
      short: 'CRM',
      fold: { label: 'Intake tools' },
      items: [
        // Canonical People first: the redesigned CRM slice.
        { href: '/app/crm/people', label: 'People', icon: 'users', requires: IDENTITY_VIEW },
        { href: '/app/crm/relationships', label: 'Relationships', icon: 'flow', requires: RELATIONSHIPS_VIEW },
        // The operator's landing page reads intake records first; it enforces
        // customers:view itself, so a login that holds nothing (a creator) is not offered it.
        { href: '/crm', label: 'Command Center', icon: 'grid', requires: INTAKE_RECORDS_VIEW },
        // The intake tools, folded: the legacy operator surfaces under /crm.
        { href: '/crm/conversations', label: 'Conversations', icon: 'chat', requires: CONVERSATIONS_VIEW, folded: true },
        { href: '/crm/customers', label: 'Intake Records', icon: 'users', requires: INTAKE_RECORDS_VIEW, folded: true },
        { href: '/crm/pipeline', label: 'Intake Board', icon: 'columns', requires: INTAKE_VIEW, folded: true },
        // Establishing and reviewing identity: the governed workflow on the temporary
        // operator screen, which also lists Companies until their redesign.
        { href: '/crm/parties', label: 'Identity Review', icon: 'check', requires: IDENTITY_VIEW, folded: true },
        // An activity inbox, not a calendar: the person's own day is Calendar, under Home.
        { href: '/crm/inbox', label: 'Inbox', icon: 'activity', requires: INTAKE_RECORDS_VIEW, folded: true },
        { href: '/crm/search', label: 'Search', icon: 'search', requires: INTAKE_RECORDS_VIEW, folded: true },
        { href: '/crm/workflows', label: 'Automations', icon: 'flow', requires: AUTOMATIONS_VIEW, folded: true },
      ],
    },
    {
      // Work OS has no RBAC resource; its authority is the role. Owner, Admin and
      // Manager run the organization's work; Employees work their own queue.
      label: 'Work',
      area: 'WORK',
      short: 'Work',
      fold: { label: 'Team work & types' },
      items: [
        { href: '/app/admin/work', label: 'My Work', icon: 'check', workspace: 'ADMIN' },
        { href: '/app/employee/work', label: 'My Work', icon: 'check', workspace: 'EMPLOYEE' },
        { href: '/app/admin/work/team', label: 'Team Work', icon: 'columns', workspace: 'ADMIN', folded: true },
        { href: '/app/admin/administration/work-types', label: 'Work Types', icon: 'flow', requires: SETTINGS_VIEW, workspace: 'ADMIN', folded: true },
      ],
    },
    {
      // Every item folds: the group label is the disclosure row.
      label: 'Intelligence',
      area: 'INTELLIGENCE',
      short: 'Intel',
      items: [
        // HEADLINES is the product noun Charlie and Lexi established. Gated on the
        // READ half of commercialIntelligence plus the route tree's authority.
        { href: '/app/admin/headlines', label: 'Headlines', icon: 'bell', requires: CI_VIEW, workspace: 'ADMIN', folded: true },
        // The same intelligence, ordered for one person: "nothing is waiting on
        // me" and "nothing needs the organization's attention" are different
        // questions, so they are different destinations.
        { href: '/app/admin/queue', label: 'Your queue', icon: 'check', requires: CI_VIEW, workspace: 'ADMIN', folded: true },
        { href: '/app/admin/brain', label: 'Executive Brain', icon: 'brain', requires: INTELLIGENCE_VIEW, workspace: 'ADMIN', folded: true },
        // Read-only execution status (AI ledger aggregates, provider policies, digest metadata). Its
        // page enforces the Executive Brain's gate: ADMIN authority and intelligence:view.
        { href: '/app/admin/intelligence-status', label: 'Intelligence status', icon: 'activity', requires: INTELLIGENCE_VIEW, workspace: 'ADMIN', folded: true },
        { href: '/crm/intelligence', label: 'Intelligence Flow', icon: 'brain', requires: INTELLIGENCE_VIEW, folded: true },
        // Its pages enforce ADMIN authority and the intelligence read grant, the same
        // as the item states, so an explicit DENY on intelligence hides it.
        { href: '/app/admin/marketplace', label: 'CallGrid Intelligence', icon: 'chart', requires: INTELLIGENCE_VIEW, workspace: 'ADMIN', folded: true },
        { href: '/crm/analytics', label: 'Analytics', icon: 'chart', requires: ANALYTICS_VIEW, folded: true },
        { href: '/crm/traffic', label: 'Traffic', icon: 'chart', requires: ANALYTICS_VIEW, folded: true },
        { href: '/crm/revenue', label: 'Revenue', icon: 'revenue', requires: ANALYTICS_VIEW, folded: true },
      ],
    },
    {
      // Every item folds: the group label is the disclosure row.
      label: 'Operations',
      area: 'OPERATIONS',
      short: 'Ops',
      items: [
        { href: '/crm/live/activity', label: 'Live Operations', icon: 'activity', requires: INTELLIGENCE_VIEW, folded: true },
        { href: '/crm/live/calls', label: 'Live Calls', icon: 'chat', requires: INTELLIGENCE_VIEW, folded: true },
        { href: '/crm/live/websites', label: 'Websites', icon: 'grid', requires: INTELLIGENCE_VIEW, folded: true },
        // Internal creator administration (C-02, Creator Hub 2026-09-22): the roster of
        // managed creators, each creator's operating view, and the edit-request queue.
        // Productions themselves are Work OS work and open under WORK, not here.
        { href: '/app/admin/creator-hub', label: 'Creators', icon: 'star', workspace: 'ADMIN', folded: true },
      ],
    },
    {
      // The creator seat (C-02, amended 2026-09-22 for exactly one participant type: a
      // managed creator's own login, SystemRole CREATOR). Not an operating area: the
      // group has no `area`, and a creator holds no organization permission, so none of
      // the five areas above is drawn for them. Its pages live in the /app/creator tree
      // and enforce requireWorkspace('CREATOR') themselves; what a creator may then read
      // or change is authorized by the creator profile bound to the login, never by the
      // organization's permission matrix. The four items with an `area` make, with Home,
      // the creator's five-area phone bar. Nothing here folds.
      label: 'Creator',
      items: [
        { href: '/app/creator/content', label: 'Content', icon: 'grid', workspace: 'CREATOR', area: 'CONTENT' },
        { href: '/app/creator/opportunities', label: 'Opportunities', icon: 'target', workspace: 'CREATOR', area: 'OPPORTUNITIES' },
        { href: '/app/creator/analytics', label: 'Analytics', icon: 'chart', workspace: 'CREATOR' },
        { href: '/app/creator/tasks', label: 'Tasks', icon: 'check', workspace: 'CREATOR', area: 'TASKS' },
        { href: '/app/creator/earnings', label: 'Earnings', icon: 'revenue', workspace: 'CREATOR', area: 'EARNINGS' },
        { href: '/app/creator/profile', label: 'Profile', icon: 'users', workspace: 'CREATOR' },
      ],
    },
    {
      // Every item folds: the disclosure row, pinned at the foot, is "Administration".
      label: 'Administration',
      footer: true,
      items: [
        { href: '/app/admin/administration/team', label: 'Team', icon: 'team', requires: USERS_VIEW, workspace: 'ADMIN', folded: true },
        { href: '/crm/organizations', label: 'Workspace', icon: 'building', requires: ORGANIZATION_VIEW, folded: true },
        { href: '/crm/settings', label: 'Settings', icon: 'cog', requires: SETTINGS_VIEW, folded: true },
        { href: '/app/admin/administration/objectives', label: 'Objectives', icon: 'target', requires: CI_VIEW, workspace: 'ADMIN', folded: true },
        { href: '/crm/audit', label: 'Audit Log', icon: 'activity', requires: AUDIT_VIEW, folded: true },
        { href: '/crm/ai-employees', label: 'AI Employees', icon: 'robot', requires: AI_EMPLOYEES_VIEW, folded: true },
        { href: '/crm/integrations', label: 'Integration OS', icon: 'plug', requires: INTEGRATIONS_VIEW, folded: true },
      ],
    },
  ],
};

/**
 * One entry per area this person can open, for the compact mobile bar. A group that
 * is an operating area contributes one entry, its first openable item; then each
 * openable item that is an area of its own (the creator seat) contributes itself.
 * Encounter order, one entry per area, and an area with nothing openable is absent,
 * never a dead tab. Administration is neither, and contributes nothing.
 */
export function areaEntries(groups: readonly NavGroup[]): { area: ShellArea; label: string; href: string }[] {
  const out: { area: ShellArea; label: string; href: string }[] = [];
  const seen = new Set<ShellArea>();
  const add = (area: ShellArea, label: string, href: string) => {
    if (seen.has(area)) return;
    seen.add(area);
    out.push({ area, label, href });
  };
  for (const group of groups) {
    if (group.area) {
      const first = group.items.find((i) => !i.soon);
      if (first) add(group.area, group.short ?? group.label, first.href);
    }
    if (group.footer) continue;
    for (const item of group.items) {
      if (item.area && !item.soon) add(item.area, item.label, item.href);
    }
  }
  return out;
}

/** The area that owns a nav item, through the one resolver: its own, else its group's. */
export function areaOfItem(groups: readonly NavGroup[], item: NavItem | null): ShellArea | null {
  if (!item) return null;
  if (item.area) return item.area;
  return groups.find((g) => g.items.includes(item))?.area ?? null;
}

/**
 * The navigation one person is offered: the items whose authority they hold.
 * A group is dropped when nothing in it can be opened, so no one sees a header
 * (or a fold) over only "Soon" items or over nothing at all. Folding is drawn by
 * the shell from `folded`/`fold`, which pass through unchanged.
 */
export function visibleNav(
  nav: readonly NavGroup[],
  access: { permitted: (item: NavItem) => boolean; workspace: WorkspaceRole },
): NavGroup[] {
  return nav
    .map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        navItemVisible(item, {
          permitted: item.requires ? access.permitted(item) : true,
          workspace: access.workspace,
        }),
      ),
    }))
    .filter((group) => group.items.some((item) => !item.soon));
}

/** Where this person's work notifications live, if they have a Work OS queue. */
export function myWorkHref(groups: readonly NavGroup[]): string | null {
  const item = groups.flatMap((g) => g.items).find((i) => i.label === 'My Work' && !i.soon);
  return item?.href ?? null;
}

// ---------------------------------------------------------------------------
// Public auth screens.
//
// These render standalone (no shell): the caller has no session yet. This list
// is the single source of truth and MUST stay in sync with PUBLIC_PATHS in
// apps/web/src/middleware.ts. They drifted apart once and made the entire
// invite flow unreachable (fixed in Sprint 29A); keeping the list here, next to
// the navigation, is what makes the two reviewable together.
// ---------------------------------------------------------------------------
export const STANDALONE_PREFIXES: readonly string[] = [
  '/crm/login',
  '/crm/forgot-password',
  '/crm/reset-password',
  '/crm/accept-invite',
  '/crm/unauthorized',
];

/** True when a path is a public auth screen that renders without the shell. */
export function isStandalonePath(pathname: string | null): boolean {
  if (!pathname) return false;
  return STANDALONE_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + '/'),
  );
}

/**
 * THE centralized route-to-item resolver.
 *
 * Returns the nav item that owns `pathname` — the item whose href is the
 * LONGEST prefix of the path. Longest-match is what keeps an item selected
 * across its child routes: /crm/customers/c_1 resolves to Intake Records, never to
 * Command Center (/crm), because that href is the longer prefix.
 *
 * Both the sidebar active state AND the breadcrumb derive from this ONE function
 * — no page implements its own active-state logic.
 */
export function resolveActiveNav(shell: Pick<ShellConfig, 'nav'>, pathname: string | null): NavItem | null {
  const items = shell.nav.flatMap((g) => g.items).filter((i) => !i.soon);
  const activeHref = pickActiveHref(items.map((i) => i.href), pathname);
  return activeHref ? items.find((i) => i.href === activeHref) ?? null : null;
}

/** The active item's label (breadcrumb leaf), via the one resolver. */
export function resolveNavLabel(shell: Pick<ShellConfig, 'nav'>, pathname: string | null): string | null {
  return resolveActiveNav(shell, pathname)?.label ?? null;
}
