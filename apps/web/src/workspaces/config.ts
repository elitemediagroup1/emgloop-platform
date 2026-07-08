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
}

export interface WorkspaceConfig {
  role: WorkspaceRole;
  /** Human label for the workspace, shown in the shell header. */
  label: string;
  /** Route prefix that scopes every page in this workspace. */
  basePath: string;
  /** Where the user lands after login / when hitting the workspace root. */
  home: string;
  /** The grouped navigation the shell renders for this role. */
  nav: NavGroup[];
}

// ---------------------------------------------------------------------------
// The five workspaces. Navigation mirrors the Phase 2 brief exactly. Each links
// to a shell page under the workspace basePath; every item is marked 'soon'
// because Phase 2 builds the operating system, not the functionality that will
// live inside it. Permission requirements reuse the EXISTING IAM resources so a
// destination that needs, say, Marketplace Intelligence is gated by the same
// deny-by-default matrix the CRM already uses (resource 'intelligence').
// ---------------------------------------------------------------------------

const ADMIN_WORKSPACE: WorkspaceConfig = {
  role: 'ADMIN',
  label: 'Admin',
  basePath: '/app/admin',
  home: '/app/admin',
  nav: [
      {
        label: 'OPERATING SYSTEM',
        items: [
        { href: '/app/admin', label: 'Dashboard', icon: 'grid' },
        { href: '/app/admin/brain', label: 'Brain', icon: 'brain' },
        { href: '/app/admin/marketplace-intelligence', label: 'Marketplace', icon: 'chart', requires: { resource: 'intelligence', action: 'view' } },
        { href: '/app/admin/operations', label: 'Operations', icon: 'activity' },
        { href: '/app/admin/work', label: 'My Work', icon: 'flow' },
        ],
      },
      {
        label: 'WORKSPACES',
        items: [
        { href: '/app/admin/businesses', label: 'Businesses', icon: 'building' },
        { href: '/app/admin/creators', label: 'Creators', icon: 'star' },
        { href: '/crm', label: 'CRM', icon: 'users' },
        { href: '/app/admin/employees', label: 'Employees', icon: 'team' },
        ],
      },
      {
        label: 'SYSTEM',
        items: [
        { href: '/app/admin/experiments', label: 'Experiments', icon: 'flow' },
        { href: '/app/admin/knowledge', label: 'Knowledge', icon: 'columns' },
        { href: '/app/admin/integrations', label: 'Integrations', icon: 'plug', requires: { resource: 'integrations', action: 'view' } },
        { href: '/app/admin/settings', label: 'Settings', icon: 'cog', requires: { resource: 'settings', action: 'view' } },
        { href: '/app/admin/system-health', label: 'System Health', icon: 'activity' },
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
