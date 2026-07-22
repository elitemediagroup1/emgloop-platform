// Loop OS — Workspace configuration (Phase 2, PR #47).
//
// Phase 2 turns EMG Loop from a CRM into a Business Operating System. Every
// external platform is a Sensor; the Brain (PR #29–#46) is the operating
// system; everything a human sees is a Workspace. This file is the SINGLE,
// configuration-driven source of truth that maps a user's role to:
//
//   - the Workspace they land in,
//   - the navigation shell they see,
//   - the home route they are routed to after login, and
//   - the resource:action permission each destination requires.
//
// It is deliberately data, not code branches. Adding a future role (e.g.
// PARTNER, VENDOR) or moving a nav item is a config edit here — never a routing
// rewrite. Nothing in this file computes intelligence, touches the Brain, the
// database schema, or IAM internals; it only DESCRIBES the shell. Authorization
// remains enforced server-side by the existing guards + IAM matrix
// (packages/database) — this config never becomes the security boundary.

import type { Resource, Action } from '@emgloop/database';

// ---------------------------------------------------------------------------
// Workspace roles — a PRODUCT concept layered on top of the existing, unchanged
// SystemRole enum (OWNER/ADMIN/MANAGER/EMPLOYEE/AI_EMPLOYEE/READ_ONLY). We do
// NOT add DB enum values or change the schema; role-router.ts maps a session's
// systemRole onto one of these workspace roles.
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
// 'requires' is the resource:action the destination enforces server-side; when
// omitted, the route only requires an authenticated session in this workspace.
// 'soon' marks a shell that exists but has no functionality yet (Phase 2 ships
// shells only — no feature implementation inside the workspaces).
// ---------------------------------------------------------------------------
export interface NavItem {
  href: string;
  label: string;
  icon: string;
  requires?: { resource: Resource; action: Action };
  soon?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
  /** Renders separated at the bottom of the sidebar (e.g. Administration). */
  footer?: boolean;
}

/**
 * Sprint 29B — the contract EVERY shell surface is described by.
 *
 * A shell is "a sidebar + a header + a nav tree over a base path". A Workspace
 * is one KIND of shell (a role-scoped one), and the CRM is another (a
 * surface-scoped one). Separating ShellConfig from WorkspaceConfig lets both
 * render through the SAME WorkspaceShell without inventing a fake workspace
 * role for the CRM — the role vocabulary stays exactly as it is.
 */
export interface ShellConfig {
  /** Human label for the surface, shown as the breadcrumb root. */
  label: string;
  /** Route prefix that scopes every page in this shell. */
  basePath: string;
  /** Where the user lands when hitting the shell root. */
  home: string;
  /** The grouped navigation the shell renders. */
  nav: NavGroup[];
}

export interface WorkspaceConfig extends ShellConfig {
  role: WorkspaceRole;
}

// ---------------------------------------------------------------------------
// The five workspaces. Navigation mirrors the Phase 2 brief exactly. Each links
// to a shell page under the workspace basePath; every item is marked 'soon'
// because Phase 2 builds the operating system, not the functionality that will
// live inside it. Permission requirements reuse the EXISTING IAM resources so a
// destination that needs, say, Marketplace Intelligence is gated by the same
// deny-by-default matrix the CRM already uses (resource 'intelligence').
// ---------------------------------------------------------------------------

// Owner (ADMIN) sidebar — the global product navigation.
//
// The global sidebar represents MAJOR BUSINESS OPERATING AREAS only — one flat,
// icon+label list, no category headers, no product subpages. Each product owns
// its OWN internal navigation inside its page area (e.g. CallGrid's Overview /
// Buyers / Vendors / … subnav lives on the CallGrid pages, not here).
//
//   Dashboard · CallGrid Intelligence · CRM · Creator Hub · Work OS · Accounting
//   (Administration is separated at the bottom, permission-aware.)
//
// CRM, Creator Hub, Accounting and Administration are approved operating areas,
// so they stay in the sidebar even though they are not built/connected: their
// routes open an honest "unavailable" state (the /app/admin catch-all → ShellPage)
// rather than being hidden. Nothing here shows fabricated data.
//
// Active state is derived by the shell from the current path (longest-prefix), so
// every child route (e.g. /app/admin/marketplace/buyers) keeps its top-level
// product (CallGrid Intelligence) highlighted.
const CALLGRID_INTEL = { resource: 'intelligence', action: 'view' } as const;
const ADMIN_ONLY = { resource: 'users', action: 'view' } as const;

const ADMIN_WORKSPACE: WorkspaceConfig = {
  role: 'ADMIN',
  label: 'Admin',
  basePath: '/app/admin',
  home: '/app/admin',
  nav: [
    {
      label: '',
      items: [
        { href: '/app/admin', label: 'Dashboard', icon: 'grid' },
        { href: '/app/admin/marketplace', label: 'CallGrid Intelligence', icon: 'brain', requires: CALLGRID_INTEL },
        { href: '/app/admin/crm', label: 'CRM', icon: 'users' },
        { href: '/app/admin/creator-hub', label: 'Creator Hub', icon: 'star' },
        { href: '/app/admin/work', label: 'Work OS', icon: 'flow' },
        { href: '/app/admin/accounting', label: 'Accounting', icon: 'revenue' },
      ],
    },
    {
      label: '',
      footer: true,
      items: [
        { href: '/app/admin/administration/team', label: 'Administration', icon: 'cog', requires: ADMIN_ONLY },
      ],
    },
  ],
};

const EMPLOYEE_WORKSPACE: WorkspaceConfig = {
  role: 'EMPLOYEE',
  label: 'Employee',
  basePath: '/app/employee',
  home: '/app/employee',
  nav: [
    {
      label: 'My Work',
      items: [
        { href: '/app/employee', label: 'Dashboard', icon: 'grid' },
        { href: '/app/employee/work', label: 'Work OS', icon: 'flow' },
        { href: '/app/employee/businesses', label: 'Assigned Businesses', icon: 'building' },
        { href: '/app/employee/creators', label: 'Assigned Creators', icon: 'star' },
        { href: '/app/employee/campaigns', label: 'Assigned Campaigns', icon: 'flow' },
        { href: '/app/employee/tasks', label: 'Tasks', icon: 'columns' },
      ],
    },
    {
      label: 'Signals',
      items: [
        { href: '/app/employee/brain-alerts', label: 'Brain Alerts', icon: 'brain' },
        { href: '/app/employee/messages', label: 'Messages', icon: 'chat' },
        { href: '/app/employee/calendar', label: 'Calendar', icon: 'calendar' },
      ],
    },
  ],
};

const BUSINESS_WORKSPACE: WorkspaceConfig = {
  role: 'BUSINESS_OWNER',
  label: 'Business',
  basePath: '/app/business',
  home: '/app/business',
  nav: [
    {
      label: 'Overview',
      items: [
        { href: '/app/business', label: 'Dashboard', icon: 'grid' },
        { href: '/app/business/calls', label: 'Calls', icon: 'chat' },
        { href: '/app/business/leads', label: 'Leads', icon: 'users' },
        { href: '/app/business/revenue', label: 'Revenue', icon: 'revenue' },
      ],
    },
    {
      label: 'Intelligence',
      items: [
        { href: '/app/business/brain-insights', label: 'Brain Insights', icon: 'brain' },
        { href: '/app/business/recommendations', label: 'Recommendations', icon: 'star' },
        { href: '/app/business/reports', label: 'Reports', icon: 'chart' },
      ],
    },
    {
      label: 'Workspace',
      items: [
        { href: '/app/business/messages', label: 'Messages', icon: 'chat' },
        { href: '/app/business/settings', label: 'Settings', icon: 'cog' },
      ],
    },
  ],
};

const CREATOR_WORKSPACE: WorkspaceConfig = {
  role: 'CREATOR',
  label: 'Creator',
  basePath: '/app/creator',
  home: '/app/creator',
  nav: [
    {
      label: 'Studio',
      items: [
        { href: '/app/creator', label: 'Dashboard', icon: 'grid' },
        { href: '/app/creator/content-calendar', label: 'Content Calendar', icon: 'calendar' },
        { href: '/app/creator/upload', label: 'Upload Video', icon: 'activity' },
        { href: '/app/creator/review-queue', label: 'Content Review Queue', icon: 'columns' },
        { href: '/app/creator/ai-critiques', label: 'AI Critiques', icon: 'brain' },
      ],
    },
    {
      label: 'Business',
      items: [
        { href: '/app/creator/brand-deals', label: 'Brand Deals', icon: 'star' },
        { href: '/app/creator/contracts', label: 'Contracts', icon: 'columns' },
        { href: '/app/creator/payments', label: 'Payments', icon: 'revenue' },
        { href: '/app/creator/analytics', label: 'Analytics', icon: 'chart' },
      ],
    },
    {
      label: 'Workspace',
      items: [
        { href: '/app/creator/messages', label: 'Messages', icon: 'chat' },
        { href: '/app/creator/settings', label: 'Settings', icon: 'cog' },
      ],
    },
  ],
};

const CLIENT_WORKSPACE: WorkspaceConfig = {
  role: 'CLIENT',
  label: 'Client',
  basePath: '/app/client',
  home: '/app/client',
  nav: [
    {
      label: 'Overview',
      items: [
        { href: '/app/client', label: 'Dashboard', icon: 'grid' },
        { href: '/app/client/messages', label: 'Messages', icon: 'chat' },
        { href: '/app/client/settings', label: 'Settings', icon: 'cog' },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// The registry. Config-driven: a router/shell reads this map; it never hard-
// codes role branches. Adding a workspace is one entry here plus its shell.
// ---------------------------------------------------------------------------
export const WORKSPACES: Record<WorkspaceRole, WorkspaceConfig> = {
  ADMIN: ADMIN_WORKSPACE,
  EMPLOYEE: EMPLOYEE_WORKSPACE,
  BUSINESS_OWNER: BUSINESS_WORKSPACE,
  CREATOR: CREATOR_WORKSPACE,
  CLIENT: CLIENT_WORKSPACE,
};

/** Look up a workspace by role. */
export function workspaceFor(role: WorkspaceRole): WorkspaceConfig {
  return WORKSPACES[role];
}

// ---------------------------------------------------------------------------
// Sprint 29B — the CRM shell.
//
// This nav was previously a hardcoded NAV const inside app/crm/layout.tsx,
// which meant the platform had two navigation systems that shared no code. It
// now lives here so there is exactly ONE nav registry and ONE shell component.
//
// The items, their order, their labels, their icons and the two 'soon'
// placeholders are carried over VERBATIM from the old layout: this sprint
// unifies the MECHANISM, not the policy.
//
// Deliberately NO `requires` on any item. The CRM sidebar has never been
// permission-gated — every item renders for every signed-in member, and each
// destination enforces its own server-side gate on arrival. Adding `requires`
// here would silently remove items from people's sidebars, which is a product
// decision, not a refactor. Gate them in a later sprint, one at a time.
// ---------------------------------------------------------------------------
export const CRM_SHELL: ShellConfig = {
  label: 'CRM',
  basePath: '/crm',
  home: '/crm',
  nav: [
    {
      label: 'Intelligence',
      items: [
        { href: '/crm', label: 'Overview', icon: 'grid' },
        { href: '/crm/intelligence', label: 'Brain', icon: 'brain' },
        { href: '/crm/analytics', label: 'Analytics', icon: 'chart' },
        { href: '/crm/integrations', label: 'Integration OS', icon: 'plug' },
      ],
    },
    {
      label: 'Live Operations',
      items: [
        { href: '/crm/live/activity', label: 'Live Activity', icon: 'activity' },
        { href: '/crm/live/calls', label: 'Live Calls', icon: 'chat' },
        { href: '/crm/live/websites', label: 'Live Website Feed', icon: 'grid' },
      ],
    },
    {
      label: 'Operations',
      items: [
        { href: '/crm/customers', label: 'Customers', icon: 'users' },
        { href: '/crm/conversations', label: 'Conversations', icon: 'chat' },
        { href: '/crm/pipeline', label: 'Pipeline', icon: 'columns' },
        { href: '/crm/inbox', label: 'Calendar', icon: 'calendar' },
        { href: '/crm/ai-employees', label: 'AI Employees', icon: 'robot' },
        { href: '/crm/workflows', label: 'Workflows', icon: 'flow' },
      ],
    },
    {
      label: 'Growth',
      items: [
        { href: '/crm/revenue', label: 'Revenue', icon: 'revenue' },
        { href: '/crm/traffic', label: 'Traffic', icon: 'chart' },
        { href: '/crm/organizations', label: 'Organizations', icon: 'building' },
        { href: '#creators', label: 'Creators', icon: 'star', soon: true },
        { href: '#business-portal', label: 'Business Portal', icon: 'portal', soon: true },
      ],
    },
    {
      label: 'Workspace',
      items: [
        { href: '/app/admin/administration/team', label: 'Team', icon: 'team' },
        { href: '/crm/settings', label: 'Settings', icon: 'cog' },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Sprint 29B — public auth screens.
//
// These render standalone (no shell): the caller has no session yet. This list
// is the single source of truth and MUST stay in sync with PUBLIC_PATHS in
// apps/web/src/middleware.ts. They drifted apart once and made the entire
// invite flow unreachable (fixed in Sprint 29A); keeping the list here, next to
// the shell config, is what makes the two reviewable together.
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
 * Resolve the breadcrumb leaf for a path: the longest nav href that prefixes
 * it. Longest-match matters because a shell's home ('/crm') prefixes every one
 * of its pages. Returns null when nothing matches, so the shell can fall back.
 */
export function resolveNavLabel(shell: ShellConfig, pathname: string | null): string | null {
  if (!pathname) return null;
  let best: NavItem | null = null;
  for (const group of shell.nav) {
    for (const item of group.items) {
      if (item.href.startsWith('#')) continue;
      const isMatch = pathname === item.href || pathname.startsWith(item.href + '/');
      if (isMatch && (!best || item.href.length > best.href.length)) best = item;
    }
  }
  return best ? best.label : null;
}
