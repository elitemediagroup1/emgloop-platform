// IamRepository — Sprint 7 (Identity, Authentication & Organizations).
//
// Identity & Access Management persistence: human users, roles, the
// deny-by-default permission resolver, and invitations. Built on the existing
// Sprint 2 schema (SystemRole, Role, Permission, Invitation) — nothing is
// reinvented; this repository wires the already-designed tables into queries.
//
// Permission model: a user acts in an organization under the SystemRole of their
// ACTIVE OrganizationMembership there (CRM P0.2c; see resolveMembershipAuthority --
// no membership, an inactive one, or one that disagrees with the User row is a
// denial). A static capability matrix
// maps each SystemRole to its resource:action grants. Explicit Permission rows
// can ADD or DENY on top of the matrix; DENY always wins (deny-by-default).
//
// Sprint 9 adds the `workflows` resource so the automation surface is governed
// by the same deny-by-default matrix as every other CRM resource.
//
// Sprint 10 adds `analytics`, `integrations`, and `intelligence` resources for
// the Loop Intelligence Foundation (Phases 2–5).
//
// CRM Phase Zero P0.2b: every User lifecycle write below (create, invite,
// reinstate, role change, activate, disable, remove) recomputes the user's
// OrganizationMembership in the SAME transaction (`syncMembershipFromUser`).
// Authority still resolves from the User row -- `can()` is unchanged -- until
// P0.2c moves it to membership after the backfill is verified in production.


import type { PrismaClient, Prisma, User, Invitation } from '@prisma/client';
import { SystemRole } from '@prisma/client';
import { hasRemovalMarker, membershipAuthority, syncMembershipFromUser } from './membership.repository';
import { revokeGoogleConnectionInTx, type GoogleActor, type GoogleRevocation } from './google-connection.repository';
import { disconnectSourceConnectionsInTx } from './source-connection.repository';
import { revokeContentAuthorizationsInTx } from './source-content-authorization.repository';
import { absentUntilMigrated } from '../creator/until-migrated';
import { AuditRepository } from './audit.repository';
import { WorkErasureRepository, type WorkErasure } from './work-state/work-erasure.repository';
import { IdentitySuggestionRepository } from './cognitive/identity-suggestion.repository';
import { WORK_RETENTION_POLICY_VERSION } from '@emgloop/shared';


export type Resource =
  | 'customers'
  | 'pipeline'
  | 'inbox'
  | 'workflows'
  | 'users'
  | 'organizations'
  | 'aiEmployees'
  | 'settings'
  | 'audit'
  | 'analytics'
  | 'integrations'
  | 'intelligence'
  // Commercial Intelligence Stage 1. Governs Performance Objectives — human
  // authored intent. Deliberately NOT folded into 'intelligence': that resource
  // governs READING what Loop concluded (briefings, live activity, CallGrid
  // analysis) and is granted broadly, down to READ_ONLY. Authoring what the
  // organization is trying to accomplish is a different act by different people,
  // and reusing one resource for both would have silently handed every
  // READ_ONLY user a write capability the day the first form shipped.
  | 'commercialIntelligence'
  // SEEING THE COMMERCIAL RELATIONSHIP AREA AT ALL -- the coarse gate, granted to
  // every authorized human role (PD-F-04: view is for all of them).
  //
  // IT GOVERNS `view` AND NOTHING ELSE. Creating, ending, reactivating and voiding a
  // Relationship are governed by `CRM_RELATIONSHIP_ACT_ROLES` in `@emgloop/shared`,
  // which Product approved act by act and which R1 already ships. Mapping four
  // authority levels onto this matrix's five actions would have meant `delete`
  // standing for "void" -- an act that deletes nothing -- and a second grant
  // vocabulary to keep in step with the first. A Permission row adding
  // `relationships:manage` therefore grants no act; a test says so.
  | 'relationships'
  // THE ORGANIZATION'S WORK EXECUTION AS A WHOLE: seeing and administering every
  // work item in the organization, its blueprints and its team queues -- the
  // capability the `/app/admin/work` tree carries today.
  //
  // DELIBERATELY NOT "acting on my own assigned work". An employee completing the
  // stage they were assigned does not hold this resource and never needed to: that
  // flows from ASSIGNMENT, through their own queue, and is guarded by the employee
  // tree exactly as it was. Collapsing the two would hand every employee a view of
  // all of the organization's work, which no role has today outside this tree.
  //
  // Added in the Work IAM slice so an authority that governs work can be STATED --
  // `activity.v1` requires every item to name a resource:action a server re-checks,
  // and a workspace role is not one. Route guards are unchanged; this is granted to
  // exactly the roles the ADMIN workspace already admits.
  | 'work'
  // CRM Phase Zero P0.2. Creating Party records, establishing them as canonical
  // identity, and asserting that two records are the same real-world Party.
  // Deliberately NOT `customers:update`: editing a contact and asserting canonical
  // identity are different authorities. Grants: see IDENTITY_RESOLUTION_GRANTS.
  | 'identityResolution'
  // Google Workspace connection (Private V1; google-workspace-connection.md §11). A
  // person's OWN Google connection -- never anybody else's data. Grants: see
  // GOOGLE_WORKSPACE_GRANTS, which, like identityResolution, has no READ_ONLY fallback.
  | 'googleWorkspace'
  // Daily Loop employee intelligence (DL-1; daily-loop-employee-intelligence.md §20.1). A
  // person's OWN work state, derived from their OWN Google connection -- and nobody else's,
  // for any role. Grants: see EMPLOYEE_INTELLIGENCE_GRANTS.
  //
  // THIS RESOURCE HAS NO `manage` AND NO `approve`, DELIBERATELY. There is no action here
  // that could later be read as "see somebody else's", because the authority to read
  // another employee's mail-derived work state is not one this platform grants. The
  // isolation itself is structural, not permission-based: every repository method takes
  // (organizationId, userId) and there is no org-only read path, so holding `view` grants
  // you your own rows and nothing else. Adding an action here is a product decision about
  // surveillance, not a refactor.
  | 'employeeIntelligence'
  // Sending mail from inside Loop (GM-2; daily-loop-employee-intelligence.md §6.11). A person
  // sending AS THEMSELVES, through their own connected Gmail identity, and never as anybody
  // else. Grants: see EMPLOYEE_MAIL_GRANTS.
  //
  // IT IS ITS OWN RESOURCE ON PURPOSE. Sending mail is the first act in this platform that
  // leaves the building under somebody's name, so it does not ride on `googleWorkspace:update`
  // (which is about connecting an account) or on `employeeIntelligence:update` (which is about
  // one's own work state). It has exactly one action, `send`; there is no `manage` and no
  // `approve`, because an administrator sending as an employee is not a capability this
  // platform has, and a delegated mailbox would be a reviewed architecture, not a grant.
  | 'employeeMail'
  // Background conversation source connections (Teams, Telegram; source-connection.ts). A
  // person's OWN Teams/Telegram connection -- never anybody else's, and never message content.
  // Grants: see SOURCE_CONNECTION_GRANTS, which mirrors GOOGLE_WORKSPACE_GRANTS -- view+update for
  // every human role, AI_EMPLOYEE hard-denied. Connecting an account is the same authority as
  // connecting Google; it does not ride on any other resource.
  | 'sourceConnections';


/**
 * `approve` exists for one resource: on `identityResolution` it is the ONLY action
 * that may establish a Party as canonical identity or confirm that two records are
 * the same Party. `create` makes a Party record; it never establishes one.
 */
export type Action = 'view' | 'create' | 'update' | 'delete' | 'manage' | 'approve' | 'send';


export const SYSTEM_ROLES: SystemRole[] = [
  SystemRole.OWNER,
  SystemRole.ADMIN,
  SystemRole.MANAGER,
  SystemRole.EMPLOYEE,
  SystemRole.READ_ONLY,
  // Creator Hub (2026-09-22): a managed creator's own seat. Invitable from Team so a creator's
  // login is made the same way every other login is -- never by a side path.
  SystemRole.CREATOR,
];


/** Human-facing labels matching the Sprint 7 spec role names. */
export const SYSTEM_ROLE_LABELS: Record<string, string> = {
  OWNER: 'Super Admin',
  ADMIN: 'Organization Admin',
  MANAGER: 'Manager',
  EMPLOYEE: 'Agent',
  AI_EMPLOYEE: 'AI Employee',
  READ_ONLY: 'Read Only',
  CREATOR: 'Creator',
};


const ALL: Action[] = ['view', 'create', 'update', 'delete', 'manage'];
const RW: Action[] = ['view', 'create', 'update'];
const RO: Action[] = ['view'];


// COMMERCIAL INTELLIGENCE STAGE 1 -- what `commercialIntelligence` grants, and
// the one thing it deliberately does not.
//
// OWNER / ADMIN manage Performance Objectives. EMPLOYEE and READ_ONLY may view
// them, matching how every other read-only intelligence surface is granted.
//
// MANAGER IS VIEW-ONLY HERE, AND THAT IS A DELIBERATE NARROWING. The intended
// product policy is that a MANAGER may manage objectives for the people they
// manage -- and Loop cannot express that sentence. `MANAGER` is an
// AUTHORIZATION LEVEL in a static role matrix; it is NOT an organizational fact.
// There is no Team model, no Division model and no reporting relationship in
// this schema, so "the people they manage" resolves to nothing. The only
// grant this matrix could actually issue is org-wide create/update, which would
// let any MANAGER author a personal objective naming ANY member -- authority
// over arbitrary users, arriving by implication. Deny-by-default says take the
// narrower grant and report the gap rather than approximate the wider one.
//
// Widening this needs a real platform relationship (or a product decision that
// org-wide authoring is acceptable), never an inference from the role name.

// IDENTITY RESOLUTION -- Product decision, CRM P0.2 (2026-09-13).
//
// Kept apart from MATRIX because its failure mode is different. MATRIX falls back
// to READ_ONLY grants for a role it does not list, which is how AI_EMPLOYEE reads
// every surface today. That fallback must not reach identity: AI_EMPLOYEE is
// denied every identityResolution action, and a role missing from this table is
// denied too. `manage` is granted to nobody, so it can never imply `approve`.
export const IDENTITY_RESOLUTION_GRANTS: Readonly<Record<string, readonly Action[]>> = Object.freeze({
  OWNER: ['view', 'create', 'update', 'approve'],
  ADMIN: ['view', 'create', 'update', 'approve'],
  MANAGER: ['view', 'create', 'update'],
  EMPLOYEE: ['view', 'create'],
  READ_ONLY: ['view'],
  AI_EMPLOYEE: [],
});

// GOOGLE WORKSPACE -- the connection lifecycle (google-workspace-connection.md §11.10.3).
//
// EVERY ACTION HERE IS ABOUT ONE'S OWN CONNECTION, AND NOTHING ELSE. Every human member
// connects THEIR OWN Google account during onboarding, so every human role holds `view`
// (see my connection) and `update` (connect, add or remove a capability, disconnect --
// always one's own; the organization and person come from the session).
//
// THERE IS DELIBERATELY NO `manage`. It existed here until 2026-09-17, meaning "acting on
// ANOTHER member's connection", and nothing ever called it. An unused administrative
// action sitting next to somebody's mailbox is the shape a later feature grows into:
// ending a person's access to Loop is membership administration (`users:update` /
// `users:delete`, which already revoke the Google credential in the same transaction --
// see disableMember / removeMember), and that is a different boundary from reaching into
// the Google account of somebody who still works here. If a narrow administrative act is
// ever genuinely needed, it gets its own action named for that operation, with its own
// audit surface -- never a generic one that can be widened later.
//
// AI_EMPLOYEE is denied everything, whatever a Permission row says: an AI Employee is an
// assignable identity, not a person with a Google account, and no grant may make it one.
// A role missing from this table is denied too.
/**
 * EMPLOYEE MAIL -- sending, as oneself (GM-2).
 *
 * Every human role may send their own mail, because every human member connects their own Google
 * account and answering your own correspondence is not an administrative act. The authority is
 * about WHOSE HANDS ARE ON IT: the principal comes from the signed session, the token comes from
 * that principal's own connection, and the message is built from what that person submitted.
 *
 * AI_EMPLOYEE HOLDS NOTHING HERE, and that denial is the load-bearing one in this table. An AI
 * Employee is an assignable identity, not a person with a mailbox; no Permission row may give it
 * `send`, and no model output may reach this action -- generation and transmission are separate
 * acts with a person between them (§6.11).
 *
 * A role missing from this table is denied, so nothing falls back into sending.
 */
export const EMPLOYEE_MAIL_GRANTS: Readonly<Record<string, readonly Action[]>> = Object.freeze({
  OWNER: ['send'],
  ADMIN: ['send'],
  MANAGER: ['send'],
  EMPLOYEE: ['send'],
  READ_ONLY: ['send'],
  AI_EMPLOYEE: [],
});

export const GOOGLE_WORKSPACE_GRANTS: Readonly<Record<string, readonly Action[]>> = Object.freeze({
  OWNER: ['view', 'update'],
  ADMIN: ['view', 'update'],
  MANAGER: ['view', 'update'],
  EMPLOYEE: ['view', 'update'],
  READ_ONLY: ['view', 'update'],
  AI_EMPLOYEE: [],
});

/** Roles that may never hold a Google Workspace connection, whatever a Permission row says. */
const GOOGLE_WORKSPACE_FORBIDDEN_ROLES: readonly string[] = ['AI_EMPLOYEE'];

export const SOURCE_CONNECTION_GRANTS: Readonly<Record<string, readonly Action[]>> = Object.freeze({
  OWNER: ['view', 'update'],
  ADMIN: ['view', 'update'],
  MANAGER: ['view', 'update'],
  EMPLOYEE: ['view', 'update'],
  READ_ONLY: ['view', 'update'],
  AI_EMPLOYEE: [],
});

/** Roles that may never hold a Teams/Telegram connection, whatever a Permission row says. */
const SOURCE_CONNECTION_FORBIDDEN_ROLES: readonly string[] = ['AI_EMPLOYEE'];

// DAILY LOOP EMPLOYEE INTELLIGENCE (DL-1) -- a person's OWN work state.
//
// Every human role holds `view` (my queue, my day, my brief) and `update` (correct an item,
// set my preferences), always about their own rows: the organization and the person come
// from the session, and the repositories cannot express an org-only read.
//
// THE LIST IS EXACTLY ['view', 'update'] FOR EVERY HUMAN ROLE, and a test pins it. No
// `manage`, no `approve`, no OWNER exception -- an owner reading an employee's mail-derived
// state is not a permission this platform has. AI_EMPLOYEE is denied everything: an AI
// Employee has no mailbox, no work state and no way to acquire one.
export const EMPLOYEE_INTELLIGENCE_GRANTS: Readonly<Record<string, readonly Action[]>> = Object.freeze({
  OWNER: ['view', 'update'],
  ADMIN: ['view', 'update'],
  MANAGER: ['view', 'update'],
  EMPLOYEE: ['view', 'update'],
  READ_ONLY: ['view', 'update'],
  AI_EMPLOYEE: [],
});

/** Roles that may never hold employee work state, whatever a Permission row says. */
const EMPLOYEE_INTELLIGENCE_FORBIDDEN_ROLES: readonly string[] = ['AI_EMPLOYEE'];

/**
 * Roles that may never send mail, whatever a Permission row says (GM-2).
 *
 * An AI Employee is an assignable identity, not a person with a mailbox. This denial is what
 * makes "no model output may send an email" structural rather than procedural: even an explicit
 * ALLOW row cannot give a machine principal `employeeMail:send`.
 */
const EMPLOYEE_MAIL_FORBIDDEN_ROLES: readonly string[] = ['AI_EMPLOYEE'];

/** Roles that may never hold identity-resolution authority, whatever a Permission row says. */
const IDENTITY_RESOLUTION_FORBIDDEN_ROLES: readonly string[] = ['AI_EMPLOYEE'];

/** Roles that may never see the commercial Relationship area (PD-F-04's recorded reading). */
const RELATIONSHIP_FORBIDDEN_ROLES: readonly string[] = ['AI_EMPLOYEE'];

// The capability matrix. Deny-by-default: anything not listed is denied.
// Sprint 10 adds analytics/integrations/intelligence columns.
const MATRIX: Record<string, Partial<Record<Resource, Action[]>>> = {
  OWNER: {
    customers: ALL, pipeline: ALL, inbox: ALL, workflows: ALL, users: ALL,
    organizations: ALL, aiEmployees: ALL, settings: ALL, audit: ALL,
    analytics: ALL, integrations: ALL, intelligence: ALL,
    commercialIntelligence: ALL, work: ALL, relationships: RO,
  },
  ADMIN: {
    customers: ALL, pipeline: ALL, inbox: ALL, workflows: ALL, users: ALL,
    organizations: ['view', 'update'], aiEmployees: ALL, settings: ALL, audit: ['view'],
    analytics: ALL, integrations: ALL, intelligence: ALL,
    commercialIntelligence: ALL, work: ALL, relationships: RO,
  },
  MANAGER: {
    customers: RW, pipeline: RW, inbox: RW, workflows: RW, users: ['view'],
    organizations: RO, aiEmployees: RW, settings: ['view'], audit: ['view'],
    analytics: RO, integrations: ['view'], intelligence: RO,
    // NARROWED DELIBERATELY -- see the note above the matrix.
    commercialIntelligence: RO,
    relationships: RO,
    // MANAGER resolves to the ADMIN workspace, so it opens the whole work tree
    // today. Granting less here would take away access it already has.
    work: ALL,
  },
  EMPLOYEE: {
    customers: RW, pipeline: RW, inbox: RW, workflows: RO, users: [],
    organizations: [], aiEmployees: RO, settings: [], audit: [],
    analytics: RO, integrations: [], intelligence: RO,
    commercialIntelligence: RO, relationships: RO,
  },
  READ_ONLY: {
    customers: RO, pipeline: RO, inbox: RO, workflows: RO, users: [],
    relationships: RO,
    organizations: [], aiEmployees: RO, settings: [], audit: [],
    analytics: RO, integrations: [], intelligence: RO,
    commercialIntelligence: RO,
  },
  // Creator Hub (2026-09-22). A managed creator holds NOTHING on the organization's resources:
  // no intake, no conversations, no relationships, no intelligence. Listed explicitly so the
  // READ_ONLY fallback below can never reach a creator -- that fallback is how an unlisted role
  // quietly inherits the whole read side of the CRM. The creator seat authorizes through the
  // CreatorProfile bound to the login (packages/database/src/creator), never through this table.
  CREATOR: {},
};


export function roleLabel(role: string | null | undefined): string {
  return (role && SYSTEM_ROLE_LABELS[role]) || 'Agent';
}


/** Pure matrix check (no DB). Baseline before explicit rules. */
export function matrixAllows(role: string, resource: Resource, action: Action): boolean {
  if (resource === 'identityResolution') {
    return (IDENTITY_RESOLUTION_GRANTS[role] ?? []).includes(action);
  }
  if (resource === 'googleWorkspace') {
    return (GOOGLE_WORKSPACE_GRANTS[role] ?? []).includes(action);
  }
  if (resource === 'employeeIntelligence') {
    return (EMPLOYEE_INTELLIGENCE_GRANTS[role] ?? []).includes(action);
  }
  if (resource === 'employeeMail') {
    return (EMPLOYEE_MAIL_GRANTS[role] ?? []).includes(action);
  }
  if (resource === 'sourceConnections') {
    return (SOURCE_CONNECTION_GRANTS[role] ?? []).includes(action);
  }
  // PD-F-04 grants Relationship view to every authorized HUMAN workspace role, and
  // the recorded reading denies AI_EMPLOYEE because it is not one. Without this it
  // would hold view anyway: AI_EMPLOYEE is absent from the matrix and falls back to
  // READ_ONLY, which does hold it. That fallback is a separate Product decision and
  // is NOT changed here -- this denies one resource to one role, the same device
  // `identityResolution` already uses.
  if (resource === 'relationships' && RELATIONSHIP_FORBIDDEN_ROLES.includes(role)) return false;
  const grants = MATRIX[role] ?? MATRIX.READ_ONLY ?? {};
  const allowed = grants[resource] ?? [];
  if (allowed.includes('manage')) return true;
  return allowed.includes(action);
}


function meta(u: { metadata: unknown }): Record<string, unknown> {
  return u.metadata && typeof u.metadata === 'object'
    ? (u.metadata as Record<string, unknown>)
    : {};
}


export function userSystemRole(u: { metadata: unknown }): string {
  const m = meta(u);
  return typeof m['systemRole'] === 'string' ? m['systemRole'] : 'EMPLOYEE';
}

/**
 * The role an invitation actually grants — the ONE authoritative source.
 *
 * createInvitation stores the selected role in `metadata.systemRole`; the
 * `Invitation.systemRole` COLUMN is a never-written `@default(EMPLOYEE)`, so
 * reading it silently downgrades every invitee. Metadata wins; the value is
 * validated against the real role set; we fall back to the column only if it is
 * itself a real role, and to EMPLOYEE last. Used at invite listing, acceptance,
 * and on the accept-invite page so all three agree.
 */
export function invitationSystemRole(inv: { systemRole?: string | null; metadata: unknown }): string {
  const fromMeta = meta(inv)['systemRole'];
  if (typeof fromMeta === 'string' && SYSTEM_ROLE_LABELS[fromMeta]) return fromMeta;
  if (typeof inv.systemRole === 'string' && SYSTEM_ROLE_LABELS[inv.systemRole]) return inv.systemRole;
  return 'EMPLOYEE';
}


/** A member's disable or removal: whether it happened, and the Google credential it deleted. */
export interface MemberEndResult {
  readonly changed: boolean;
  readonly googleRevocation: GoogleRevocation | null;
}

export interface CanArgs {
  organizationId: string;
  userId: string;
  resource: Resource;
  action: Action;
}


// ---- View models ----------------------------------------------------------

export interface UserListItem {
  id: string;
  email: string;
  name: string | null;
  status: string;
  systemRole: string;
  roleLabel: string;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface InvitationView {
  id: string;
  email: string;
  systemRole: string;
  status: string;
  expiresAt: string | null;
  createdAt: string;
}

/**
 * The outcome of preparing a (re)invitation. Either the one (org,email) row is
 * ready for a fresh token (`ok`, `reused` telling the caller whether a prior row
 * was reinstated), or the invite is blocked with a machine-readable reason the
 * caller turns into a user-facing message. Never throws for these expected cases.
 */
export type InviteOutcome =
  | { ok: true; userId: string; reused: boolean }
  | { ok: false; reason: 'active_member' | 'pending_exists' };


// ---- Repository -----------------------------------------------------------

export class IamRepository {
  constructor(private readonly prisma: PrismaClient) {}


  // -- Permission resolution ------------------------------------------------

  async can(args: CanArgs): Promise<boolean> {
    const { organizationId, userId, resource, action } = args;

    // Standing and role come from the membership in THIS organization. No
    // membership, an inactive one, a login from another organization, or drift
    // from the User row: denied, before any rule is read.
    const authority = await membershipAuthority(this.prisma, organizationId, userId);
    if (!authority.granted) return false;
    const role = authority.systemRole;
    // A machine never asserts identity: no Permission row can grant it.
    if (resource === 'identityResolution' && IDENTITY_RESOLUTION_FORBIDDEN_ROLES.includes(role)) return false;
    // Nor holds a Google connection.
    if (resource === 'googleWorkspace' && GOOGLE_WORKSPACE_FORBIDDEN_ROLES.includes(role)) return false;
    // Nor work state derived from one.
    if (resource === 'employeeIntelligence' && EMPLOYEE_INTELLIGENCE_FORBIDDEN_ROLES.includes(role)) return false;
    // Nor a Teams/Telegram connection.
    if (resource === 'sourceConnections' && SOURCE_CONNECTION_FORBIDDEN_ROLES.includes(role)) return false;
    // Nor sends mail as a person.
    if (resource === 'employeeMail' && EMPLOYEE_MAIL_FORBIDDEN_ROLES.includes(role)) return false;

    // Check explicit DENY rules first (deny wins)
    const denyRules = await this.prisma.permission.findMany({
      where: { organizationId, userId, resource, action, effect: 'DENY' },
    });
    if (denyRules.length > 0) return false;

    // Check role-level DENY
    const roleDenyRules = await this.prisma.permission.findMany({
      where: { organizationId, systemRole: role as SystemRole, resource, action, effect: 'DENY' },
    });
        if (roleDenyRules.length > 0) return false;
    // Check explicit ALLOW
    const allowRules = await this.prisma.permission.findMany({
      where: { organizationId, userId, resource, action, effect: 'ALLOW' },
    });
    if (allowRules.length > 0) return true;

    // Fall back to capability matrix
    return matrixAllows(role, resource, action);
  }

  /**
   * Many permission questions about one member of one organization, answered by
   * exactly the rules of can() above, in the same order: membership authority,
   * then a user DENY, then a role DENY, then a user ALLOW, then the capability
   * matrix. The membership and the Permission rows are read once, so a caller
   * asking a dozen questions (the navigation) does not issue a dozen rounds of
   * queries.
   *
   * It decides what to SHOW. Enforcement stays with can(): every page and action
   * still asks can() itself. test/iam-can-each.test.ts pins the two together.
   */
  async canEach(
    organizationId: string,
    userId: string,
    checks: readonly { resource: Resource; action: Action }[],
  ): Promise<boolean[]> {
    if (checks.length === 0) return [];
    const authority = await membershipAuthority(this.prisma, organizationId, userId);
    if (!authority.granted) return checks.map(() => false);
    const role = authority.systemRole;

    const rules = await this.prisma.permission.findMany({
      where: {
        organizationId,
        resource: { in: [...new Set(checks.map((c) => c.resource))] },
        action: { in: [...new Set(checks.map((c) => c.action))] },
        OR: [{ userId }, { systemRole: role as SystemRole }],
      },
      select: { userId: true, systemRole: true, resource: true, action: true, effect: true },
    });

    return checks.map(({ resource, action }) => {
      if (resource === 'identityResolution' && IDENTITY_RESOLUTION_FORBIDDEN_ROLES.includes(role)) return false;
      if (resource === 'googleWorkspace' && GOOGLE_WORKSPACE_FORBIDDEN_ROLES.includes(role)) return false;
      if (resource === 'employeeIntelligence' && EMPLOYEE_INTELLIGENCE_FORBIDDEN_ROLES.includes(role)) return false;
      if (resource === 'employeeMail' && EMPLOYEE_MAIL_FORBIDDEN_ROLES.includes(role)) return false;
      if (resource === 'sourceConnections' && SOURCE_CONNECTION_FORBIDDEN_ROLES.includes(role)) return false;
      const applicable = rules.filter((r) => r.resource === resource && r.action === action);
      if (applicable.some((r) => r.userId === userId && r.effect === 'DENY')) return false;
      if (applicable.some((r) => r.systemRole === role && r.effect === 'DENY')) return false;
      if (applicable.some((r) => r.userId === userId && r.effect === 'ALLOW')) return true;
      return matrixAllows(role, resource, action);
    });
  }


  // -- User management ------------------------------------------------------

  async listUsers(organizationId: string): Promise<UserListItem[]> {
    // The roster is the org's real members: ACTIVE (accepted) and DISABLED
    // (deliberately disabled — kept visible so they can be reactivated). INVITED
    // rows exist from invite-time but are NOT members yet — they are represented
    // solely by their pending invitation, so they must not double-appear here.
    // Soft-REMOVED users (metadata.removedAt) are gone from the org and filtered
    // out; a fresh invitation reinstates the SAME row (see prepareInvitation).
    // Explicit select (drift-safe): a bare findMany SELECTs every column, so one
    // drifted column in the deployed DB — production has no migration ledger —
    // would 500 the whole Team page.
    const users = await this.prisma.user.findMany({
      where: { organizationId, status: { in: ['ACTIVE', 'DISABLED'] } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, email: true, name: true, status: true,
        metadata: true, lastLoginAt: true, createdAt: true,
      },
    });
    return users.filter((u) => !meta(u)['removedAt']).map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      status: u.status,
      systemRole: userSystemRole(u),
      roleLabel: roleLabel(userSystemRole(u)),
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      createdAt: u.createdAt.toISOString(),
    }));
  }

  /**
   * Org-scoped user roster counts for the Executive Brain's Users sensor. A
   * roster is a snapshot, not a window — `total` excludes disabled users (they
   * are removed, not active), and `active` is those actually ACTIVE (an INVITED
   * user has not yet accepted). COUNTs only.
   */
  async userCounts(organizationId: string): Promise<{ total: number; active: number }> {
    const [total, active] = await Promise.all([
      this.prisma.user.count({ where: { organizationId, status: { not: 'DISABLED' } } }),
      this.prisma.user.count({ where: { organizationId, status: 'ACTIVE' } }),
    ]);
    return { total, active };
  }

  async getUser(organizationId: string, id: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { id, organizationId } });
  }

  async createUser(data: {
    organizationId: string;
    email: string;
    name?: string;
    systemRole?: string;
    passwordHash?: string;
  }): Promise<User> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          organizationId: data.organizationId,
          // Normalize on write: reads always lowercase the email, so storing a
          // mixed-case email here would let a case-variant slip past the unique
          // lookup and create a second row for the same person. Store it lowercased.
          email: data.email.toLowerCase().trim(),
          name: data.name,
          status: 'INVITED',
          metadata: { systemRole: data.systemRole ?? 'EMPLOYEE', passwordHash: data.passwordHash },
        },
      });
      await syncMembershipFromUser(tx, user);
      return user;
    });
  }

  /**
   * Prepare a (re)invitation for one email WITHOUT ever creating a second row.
   *
   * There is no membership table: User carries @@unique([organizationId, email]),
   * so the user row IS the membership and `user.create` on an email that already
   * has ANY row (active, invited, disabled, or soft-removed) throws P2002. That
   * unhandled throw is exactly what crashed the Team page and blocked re-inviting
   * a removed teammate. Resolve the one existing row within the org and decide the
   * lifecycle explicitly instead:
   *   - ACTIVE                       → blocked: already a member.
   *   - a still-valid PENDING invite → blocked: caller should Resend, not duplicate.
   *   - INVITED / DISABLED / removed → reinstate the SAME row to INVITED: refresh
   *     the role, clear the removed marker, and drop any stale password hash so the
   *     invitee must accept the fresh link before they can sign in. Stale/expired
   *     PENDING tokens are revoked so exactly one live token can exist.
   *   - no row at all                → create a fresh INVITED row.
   * Fail-closed and org-scoped throughout; the caller then issues the token/email.
   *
   * `invitedByUserId` is the acting user, established by the caller from the
   * session -- never from form input. It is recorded on the membership.
   */
  async prepareInvitation(params: {
    organizationId: string;
    email: string;
    name?: string;
    systemRole: string;
    invitedByUserId?: string | null;
  }): Promise<InviteOutcome> {
    const { organizationId, name, systemRole } = params;
    const invitedByUserId = params.invitedByUserId ?? null;
    // Normalize on write so a case-variant of an existing email can never create a
    // second row for the same person (reads always lowercase).
    const email = params.email.toLowerCase().trim();

    const existing = await this.prisma.user.findFirst({ where: { organizationId, email } });
    if (existing && existing.status === 'ACTIVE') {
      return { ok: false, reason: 'active_member' };
    }

    const livePending = await this.prisma.invitation.findFirst({
      where: { organizationId, email, status: 'PENDING', expiresAt: { gt: new Date() } },
    });
    if (livePending) {
      return { ok: false, reason: 'pending_exists' };
    }

    // Supersede any expired-but-still-PENDING tokens so exactly one live token exists.
    await this.prisma.invitation.updateMany({
      where: { organizationId, email, status: 'PENDING' },
      data: { status: 'REVOKED' },
    });

    if (!existing) {
      const created = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { organizationId, email, name, status: 'INVITED', metadata: { systemRole } },
        });
        await syncMembershipFromUser(tx, user, { invitedByUserId });
        return user;
      });
      return { ok: true, userId: created.id, reused: false };
    }

    // Reinstate the existing INVITED/DISABLED/removed row in place — the unique
    // constraint makes a duplicate impossible anyway. Merge metadata so we don't
    // wipe unrelated keys, but deliberately drop the removed marker and any stale
    // password (a re-invited user must accept afresh), and refresh the role.
    const nextMeta: Record<string, unknown> = { ...meta(existing), systemRole };
    delete nextMeta['removedAt'];
    delete nextMeta['passwordHash'];
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: existing.id },
        data: {
          status: 'INVITED',
          name: name ?? existing.name,
          metadata: nextMeta as Prisma.InputJsonValue,
        },
      });
      await syncMembershipFromUser(tx, user, { invitedByUserId });
    });
    return { ok: true, userId: existing.id, reused: true };
  }

  async updateUserRole(
    organizationId: string,
    userId: string,
    systemRole: string,
  ): Promise<void> {
    const user = await this.prisma.user.findFirst({ where: { id: userId, organizationId } });
    if (!user) return;
    const m = meta(user);
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: { metadata: { ...m, systemRole } },
      });
      await syncMembershipFromUser(tx, updated);
    });
  }

  /**
   * Make a member ACTIVE. Returns whether the write happened.
   *
   * REFUSES A REMOVED MEMBER. A row carrying the soft-removal marker was removed
   * by an administrator; activating it would restore login and authority while
   * `listUsers` keeps hiding it -- a member nobody can see or remove. That is
   * exactly how the legacy demo bootstrap resurrected removed people. Removal is
   * undone only by re-inviting (`prepareInvitation` clears the marker), never by
   * a status flip.
   */
  async activateUser(organizationId: string, userId: string): Promise<boolean> {
    return this.setStatus(organizationId, userId, 'ACTIVE');
  }

  async disableUser(organizationId: string, userId: string): Promise<boolean> {
    return (await this.disableMember(organizationId, userId)).changed;
  }

  /**
   * Disable a member, ending their Google connection IN THE SAME TRANSACTION
   * (google-workspace-connection.md §6, §11.6): the sealed token is deleted before the
   * membership change commits. `googleRevocation` is what was deleted, for the caller
   * that holds the key to revoke at Google after commit. Their Teams/Telegram connections are
   * ended the same way (sealed credential cleared, DISCONNECTED) and their content consent
   * revoked -- both since 2026-09-24; before that the Telegram session stayed live for the
   * worker -- and their private work state is deleted, all in the same transaction
   * (daily-loop-employee-intelligence.md §21.2: "Employee disabled or removed -- all work
   * rows for that user are deleted"). The Telegram-side session is not logged out by this
   * path; the record says so.
   */
  async disableMember(organizationId: string, userId: string, actor: GoogleActor = { userId: null }): Promise<MemberEndResult> {
    let googleRevocation: GoogleRevocation | null = null;
    const endSources = await sourceConnectionTablesPresent(this.prisma, organizationId, userId);
    const changed = await this.setStatus(organizationId, userId, 'DISABLED', async (tx) => {
      const now = new Date();
      googleRevocation = await revokeGoogleConnectionInTx(this.prisma, tx, organizationId, userId, {
        reason: 'MEMBER_DISABLED',
        actor,
        now,
      });
      if (endSources) await endSourceConnectionsInTx(this.prisma, tx, organizationId, userId, 'MEMBER_DISABLED', actor, now);
      await eraseWorkStateInTx(this.prisma, tx, organizationId, userId, 'MEMBER_DISABLED', actor);
    });
    return { changed, googleRevocation: changed ? googleRevocation : null };
  }

  /** Org-scoped status write plus its membership, in one transaction. No row, no write. */
  private async setStatus(
    organizationId: string,
    userId: string,
    status: 'ACTIVE' | 'DISABLED',
    alsoInTransaction?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.user.findFirst({ where: { id: userId, organizationId } });
      if (!current) return false;
      if (status === 'ACTIVE' && hasRemovalMarker(current.metadata)) return false;
      const { count } = await tx.user.updateMany({
        where: { id: userId, organizationId },
        data: { status },
      });
      if (count === 0) return false;
      const user = await tx.user.findFirst({ where: { id: userId, organizationId } });
      if (user) await syncMembershipFromUser(tx, user);
      if (alsoInTransaction) await alsoInTransaction(tx);
      return true;
    });
  }

  async softRemoveUser(organizationId: string, userId: string): Promise<void> {
    await this.removeMember(organizationId, userId);
  }

  /**
   * Remove a member (soft), ending their Google and Teams/Telegram connections, revoking their
   * content consent and deleting their private work state in the same transaction, as
   * `disableMember` does. The membership row is kept (it carries the removal marker); the work
   * state is not (§21.3, row 11).
   */
  async removeMember(organizationId: string, userId: string, actor: GoogleActor = { userId: null }): Promise<MemberEndResult> {
    // The metadata bag carries systemRole AND passwordHash. It must be MERGED,
    // never replaced: overwriting it stripped both, so a re-enabled user came
    // back with no password and silently defaulted to EMPLOYEE. Mirrors the
    // read-modify-write pattern used by setRole above; the findFirst keeps the
    // write scoped to the caller's organization.
    const user = await this.prisma.user.findFirst({ where: { id: userId, organizationId } });
    if (!user) return { changed: false, googleRevocation: null };
    const m = meta(user);
    const endSources = await sourceConnectionTablesPresent(this.prisma, organizationId, userId);
    const googleRevocation = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: {
          status: 'DISABLED',
          metadata: { ...m, removedAt: new Date().toISOString() },
        },
      });
      await syncMembershipFromUser(tx, updated);
      const now = new Date();
      const revocation = await revokeGoogleConnectionInTx(this.prisma, tx, organizationId, userId, {
        reason: 'MEMBER_REMOVED',
        actor,
        now,
      });
      if (endSources) await endSourceConnectionsInTx(this.prisma, tx, organizationId, userId, 'MEMBER_REMOVED', actor, now);
      await eraseWorkStateInTx(this.prisma, tx, organizationId, userId, 'MEMBER_REMOVED', actor);
      return revocation;
    });
    return { changed: true, googleRevocation };
  }


  // -- Invitations ----------------------------------------------------------

  async createInvitation(data: {
    organizationId: string;
    email: string;
    inviterId: string;
    systemRole?: string;
    tokenHash: string;
    expiresAt?: Date;
  }): Promise<Invitation> {
    return this.prisma.invitation.create({
      data: {
        organizationId: data.organizationId,
        email: data.email,
        invitedById: data.inviterId,        status: 'PENDING',
        tokenHash: data.tokenHash,
        expiresAt: data.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),        metadata: { systemRole: data.systemRole ?? 'EMPLOYEE' },
      },
    });
  }

  async listInvitations(organizationId: string): Promise<InvitationView[]> {
    // Explicit select (same drift-safety reason as listUsers): never SELECT the
    // whole row, so a column present in schema.prisma but absent in a deployed
    // invitations table cannot crash the Team page.
    const invites = await this.prisma.invitation.findMany({
      where: { organizationId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, email: true, status: true,
        expiresAt: true, createdAt: true, metadata: true,
      },
    });
    return invites.map((i) => ({
      id: i.id,
      email: i.email,
      systemRole: invitationSystemRole({ metadata: i.metadata }),
      status: i.status,
      expiresAt: i.expiresAt?.toISOString() ?? null,
      createdAt: i.createdAt.toISOString(),
    }));
  }

  async revokeInvitation(organizationId: string, id: string): Promise<void> {
    await this.prisma.invitation.updateMany({
      where: { id, organizationId },
      data: { status: 'REVOKED' },
    });
  }

  async findInvitationByToken(tokenHash: string): Promise<Invitation | null> {
    return this.prisma.invitation.findFirst({
      where: { tokenHash, status: 'PENDING' },
    });
  }

  async acceptInvitation(id: string): Promise<void> {
    await this.prisma.invitation.update({
      where: { id },
      data: { status: 'ACCEPTED', acceptedAt: new Date() },
    });
  }

  async updateUserProfile(params: {
    organizationId: string;
    userId: string;
    name: string;
    profile: Record<string, unknown>;
  }): Promise<User> {
    const existing = await this.prisma.user.findFirst({
      where: { id: params.userId, organizationId: params.organizationId },
    });
    if (!existing) {
      throw new Error('User not found in organization');
    }
    const currentMetadata =
      existing.metadata && typeof existing.metadata === 'object'
        ? (existing.metadata as Record<string, unknown>)
        : {};
    const nextMetadata = { ...currentMetadata, profile: params.profile };
    return this.prisma.user.update({
      where: { id: params.userId },
      data: { name: params.name, metadata: nextMetadata as Prisma.InputJsonValue },
    });
  }
}


/**
 * Whether this deployment's database holds the source-connection tables, at the shape the
 * transaction below needs. Netlify deploys `main` to production on every merge, but a migration
 * reaches production only when a human dispatches the migration workflow, so there is a window
 * in which the code knows tables the database does not have. In that window there is nothing to
 * end -- no table, no connection -- and an offboarding must still complete. Decided OUTSIDE the
 * transaction, because a failed statement aborts the whole Postgres transaction and could not be
 * caught inside it. The authorization probe names the newest column the transaction reads
 * (`historicalState`, added by the historical-backfill migration), so a migration run that
 * stopped between the table and that column reads as absent here rather than failing inside the
 * transaction. Any error other than a missing table or column (P2021 / P2022) is still thrown:
 * a database that cannot be reached fails the offboarding rather than skipping a live credential.
 */
async function sourceConnectionTablesPresent(prisma: PrismaClient, organizationId: string, userId: string): Promise<boolean> {
  const probed = await absentUntilMigrated(
    Promise.all([
      prisma.sourceConnection.count({ where: { organizationId, userId } }),
      prisma.sourceContentAuthorization.findMany({ where: { organizationId, userId }, select: { id: true, historicalState: true }, take: 1 }),
    ]),
  );
  return probed !== null;
}

/**
 * End a person's Teams/Telegram connections and revoke their content consent inside the
 * transaction that ends their membership (section 21.2). The sealed credential is cleared and
 * the row marked DISCONNECTED, so the worker's cross-tenant discovery (`dueForObservation`,
 * `dueForContent`) stops returning them and the credential opener finds nothing to open; the
 * content authorization is stamped revoked, so consent never outlives the membership. Each
 * repository writes its own audit row per provider, and none for a row that was not live. The
 * derived items are left to `eraseWorkStateInTx`, which follows in the same transaction.
 */
async function endSourceConnectionsInTx(
  prisma: PrismaClient,
  tx: Prisma.TransactionClient,
  organizationId: string,
  userId: string,
  reason: 'MEMBER_DISABLED' | 'MEMBER_REMOVED',
  actor: GoogleActor,
  now: Date,
): Promise<void> {
  const connectionActor = { userId: actor.userId, name: actor.name ?? null };
  await disconnectSourceConnectionsInTx(prisma, tx, organizationId, userId, { actor: connectionActor, now });
  await revokeContentAuthorizationsInTx(prisma, tx, organizationId, userId, { actor: connectionActor, now, reason });
}

/**
 * Delete a person's private work state inside the transaction that ends their membership,
 * and record the act -- counts only, never a row -- when anything was deleted. No audit row
 * for a delete that did not happen.
 *
 * That includes the identity match suggestions resting on their private evidence (D1): they
 * live on `intelligence_hypotheses`, not a work table, and go with the rest -- proposed,
 * confirmed and rejected alike, because each one describes their mailbox.
 */
async function eraseWorkStateInTx(
  prisma: PrismaClient,
  tx: Prisma.TransactionClient,
  organizationId: string,
  userId: string,
  reason: 'MEMBER_DISABLED' | 'MEMBER_REMOVED',
  actor: GoogleActor,
): Promise<WorkErasure> {
  const erased = await new WorkErasureRepository(tx).eraseAll({ organizationId, userId });
  const { suggestions: privateSuggestions } = await new IdentitySuggestionRepository(tx).erasePrivate({ organizationId, userId });
  const total = Object.values(erased).reduce((sum, n) => sum + n, 0) + privateSuggestions;
  if (total > 0) {
    await new AuditRepository(prisma).record(
      {
        organizationId,
        userId: actor.userId,
        actorType: actor.userId ? 'HUMAN_AGENT' : 'SYSTEM',
        actorName: actor.name ?? (actor.userId ? undefined : 'System'),
        action: WORK_STATE_ERASED_AUDIT_ACTION,
        entityType: 'work_state',
        entityId: userId,
        metadata: { subjectUserId: userId, reason, retentionPolicy: WORK_RETENTION_POLICY_VERSION, erased, privateSuggestions },
      },
      tx,
    );
  }
  return erased;
}

/** The audit action for deleting a person's work state when their membership ends. */
export const WORK_STATE_ERASED_AUDIT_ACTION = 'work_state.erased';
