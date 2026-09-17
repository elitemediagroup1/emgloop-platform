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
  /** Not built: rendered as a disabled "Soon" item, never a link. */
  soon?: boolean;
  /**
   * The role authority the destination enforces with requireWorkspace, when it
   * lives in a role-guarded route tree (/app/admin → ADMIN). Anyone else would
   * be sent back to Loop Home, so the item is shown only to that authority.
   */
  workspace?: WorkspaceRole;
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

export interface NavGroup {
  label: string;
  items: NavItem[];
  /** The operating area this group is. Absent for Administration. */
  area?: OperatingArea;
  /** The area's name in the compact mobile bar. */
  short?: string;
  /** Renders separated at the bottom of the sidebar (Administration). */
  footer?: boolean;
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
// Each item carries the authority its destination enforces: `requires` for the
// page's requirePermission, `workspace` for its route tree's requireWorkspace.
// The shell hides what a person cannot open. Never less than the page enforces;
// the one item that asks for more (CallGrid Intelligence) says so below.
//
// Boundaries the grouping must not blur:
//   - People are established PERSON Parties (/app/crm/people), never Intake
//     Records. Identity review is its own governed workflow, still served by the
//     temporary operator screen (/crm/parties) until its redesign covers it.
//   - The intake board is the legacy Customer.status board, never an
//     Opportunity pipeline. Opportunities and Campaigns stay `soon` until their
//     authorities exist.
//   - CRM Automations (automation triggers) and Work OS Workflows (human work
//     execution, not built) are different authorities under different areas.
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

export const LOOP_NAV: ShellConfig = {
  label: 'Loop',
  basePath: '/app',
  home: '/app',
  nav: [
    {
      label: '',
      area: 'HOME',
      short: 'Home',
      items: [{ href: '/app', label: 'Home', icon: 'grid' }],
    },
    {
      label: 'CRM',
      area: 'CRM',
      short: 'CRM',
      items: [
        // Canonical People first: the redesigned CRM slice.
        { href: '/app/crm/people', label: 'People', icon: 'users', requires: IDENTITY_VIEW },
        { href: '/app/crm/relationships', label: 'Relationships', icon: 'flow', requires: RELATIONSHIPS_VIEW },
        { href: '/crm', label: 'Command Center', icon: 'grid' },
        { href: '/crm/opportunities', label: 'Opportunities', icon: 'target', soon: true },
        { href: '/crm/campaigns', label: 'Campaigns', icon: 'star', soon: true },
        { href: '/crm/conversations', label: 'Conversations', icon: 'chat', requires: CONVERSATIONS_VIEW },
        { href: '/crm/customers', label: 'Intake Records', icon: 'users', requires: INTAKE_RECORDS_VIEW },
        { href: '/crm/pipeline', label: 'Intake Board', icon: 'columns', requires: INTAKE_VIEW },
        // Establishing and reviewing identity: the governed workflow on the temporary
        // operator screen, which also lists Companies until their redesign.
        { href: '/crm/parties', label: 'Identity Review', icon: 'check', requires: IDENTITY_VIEW },
        // An activity inbox, not a calendar: no calendar surface exists.
        { href: '/crm/inbox', label: 'Inbox', icon: 'activity', requires: INTAKE_RECORDS_VIEW },
        { href: '/crm/search', label: 'Search', icon: 'search', requires: INTAKE_RECORDS_VIEW },
        { href: '/crm/workflows', label: 'Automations', icon: 'flow', requires: AUTOMATIONS_VIEW },
      ],
    },
    {
      // Work OS has no RBAC resource; its authority is the role. Owner, Admin and
      // Manager run the organization's work; Employees work their own queue.
      label: 'Work',
      area: 'WORK',
      short: 'Work',
      items: [
        { href: '/app/admin/work', label: 'My Work', icon: 'check', workspace: 'ADMIN' },
        { href: '/app/employee/work', label: 'My Work', icon: 'check', workspace: 'EMPLOYEE' },
        { href: '/app/admin/work/team', label: 'Team Work', icon: 'columns', workspace: 'ADMIN' },
        { href: '/app/work/workflows', label: 'Workflows', icon: 'flow', soon: true },
        { href: '/app/admin/administration/work-types', label: 'Work Types', icon: 'flow', requires: SETTINGS_VIEW, workspace: 'ADMIN' },
      ],
    },
    {
      label: 'Intelligence',
      area: 'INTELLIGENCE',
      short: 'Intel',
      items: [
        // HEADLINES is the product noun Charlie and Lexi established. Gated on the
        // READ half of commercialIntelligence plus the route tree's authority.
        { href: '/app/admin/headlines', label: 'Headlines', icon: 'bell', requires: CI_VIEW, workspace: 'ADMIN' },
        // The same intelligence, ordered for one person: "nothing is waiting on
        // me" and "nothing needs the organization's attention" are different
        // questions, so they are different destinations.
        { href: '/app/admin/queue', label: 'Your queue', icon: 'check', requires: CI_VIEW, workspace: 'ADMIN' },
        { href: '/app/admin/brain', label: 'Executive Brain', icon: 'brain', requires: INTELLIGENCE_VIEW, workspace: 'ADMIN' },
        { href: '/crm/intelligence', label: 'Intelligence Flow', icon: 'brain', requires: INTELLIGENCE_VIEW },
        // Its pages enforce ADMIN authority only. The item also asks for the
        // intelligence read grant, as this sidebar entry always has, so an explicit
        // DENY on intelligence hides it. Every ADMIN-authority role holds the grant.
        { href: '/app/admin/marketplace', label: 'CallGrid Intelligence', icon: 'chart', requires: INTELLIGENCE_VIEW, workspace: 'ADMIN' },
        { href: '/crm/analytics', label: 'Analytics', icon: 'chart', requires: ANALYTICS_VIEW },
        { href: '/crm/traffic', label: 'Traffic', icon: 'chart', requires: ANALYTICS_VIEW },
        { href: '/crm/revenue', label: 'Revenue', icon: 'revenue', requires: ANALYTICS_VIEW },
      ],
    },
    {
      label: 'Operations',
      area: 'OPERATIONS',
      short: 'Ops',
      items: [
        { href: '/crm/live/activity', label: 'Live Operations', icon: 'activity', requires: INTELLIGENCE_VIEW },
        { href: '/crm/live/calls', label: 'Live Calls', icon: 'chat', requires: INTELLIGENCE_VIEW },
        { href: '/crm/live/websites', label: 'Websites', icon: 'grid', requires: INTELLIGENCE_VIEW },
        // Internal creator administration (C-02). Not built: it opens the honest
        // not-built page in the /app/admin tree.
        { href: '/app/admin/creator-hub', label: 'Creators', icon: 'star', workspace: 'ADMIN' },
      ],
    },
    {
      label: 'Administration',
      footer: true,
      items: [
        { href: '/app/admin/administration/team', label: 'Team', icon: 'team', requires: USERS_VIEW, workspace: 'ADMIN' },
        { href: '/crm/organizations', label: 'Workspace', icon: 'building', requires: ORGANIZATION_VIEW },
        { href: '/crm/settings', label: 'Settings', icon: 'cog', requires: SETTINGS_VIEW },
        { href: '/app/admin/administration/objectives', label: 'Objectives', icon: 'target', requires: CI_VIEW, workspace: 'ADMIN' },
        { href: '/crm/audit', label: 'Audit Log', icon: 'activity', requires: AUDIT_VIEW },
        { href: '/crm/ai-employees', label: 'AI Employees', icon: 'robot', requires: AI_EMPLOYEES_VIEW },
        { href: '/crm/integrations', label: 'Integration OS', icon: 'plug', requires: INTEGRATIONS_VIEW },
      ],
    },
  ],
};

/**
 * One entry per operating area this person can open, for the compact mobile bar:
 * the area's first openable item. An area with nothing openable is absent, never a
 * dead tab.
 */
export function areaEntries(groups: readonly NavGroup[]): { area: OperatingArea; label: string; href: string }[] {
  const out: { area: OperatingArea; label: string; href: string }[] = [];
  for (const group of groups) {
    if (!group.area) continue;
    const first = group.items.find((i) => !i.soon);
    if (first) out.push({ area: group.area, label: group.short ?? group.label, href: first.href });
  }
  return out;
}

/** The operating area that owns a nav item, through the one resolver. */
export function areaOfItem(groups: readonly NavGroup[], item: NavItem | null): OperatingArea | null {
  if (!item) return null;
  return groups.find((g) => g.items.includes(item))?.area ?? null;
}

/**
 * The navigation one person is offered: the items whose authority they hold.
 * A group is dropped when nothing in it can be opened, so no one sees a header
 * over only "Soon" items or over nothing at all.
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
