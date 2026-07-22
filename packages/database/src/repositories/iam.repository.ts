// IamRepository — Sprint 7 (Identity, Authentication & Organizations).
//
// Identity & Access Management persistence: human users, roles, the
// deny-by-default permission resolver, and invitations. Built on the existing
// Sprint 2 schema (SystemRole, Role, Permission, Invitation) — nothing is
// reinvented; this repository wires the already-designed tables into queries.
//
// Permission model: every user carries a SystemRole (stored in
// user.metadata.systemRole, defaulting to EMPLOYEE). A static capability matrix
// maps each SystemRole to its resource:action grants. Explicit Permission rows
// can ADD or DENY on top of the matrix; DENY always wins (deny-by-default).
//
// Sprint 9 adds the `workflows` resource so the automation surface is governed
// by the same deny-by-default matrix as every other CRM resource.
//
// Sprint 10 adds `analytics`, `integrations`, and `intelligence` resources for
// the Loop Intelligence Foundation (Phases 2–5).


import type { PrismaClient, Prisma, User, Invitation } from '@prisma/client';
import { SystemRole } from '@prisma/client';


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
  | 'intelligence';


export type Action = 'view' | 'create' | 'update' | 'delete' | 'manage';


export const SYSTEM_ROLES: SystemRole[] = [
  SystemRole.OWNER,
  SystemRole.ADMIN,
  SystemRole.MANAGER,
  SystemRole.EMPLOYEE,
  SystemRole.READ_ONLY,
];


/** Human-facing labels matching the Sprint 7 spec role names. */
export const SYSTEM_ROLE_LABELS: Record<string, string> = {
  OWNER: 'Super Admin',
  ADMIN: 'Organization Admin',
  MANAGER: 'Manager',
  EMPLOYEE: 'Agent',
  AI_EMPLOYEE: 'AI Employee',
  READ_ONLY: 'Read Only',
};


const ALL: Action[] = ['view', 'create', 'update', 'delete', 'manage'];
const RW: Action[] = ['view', 'create', 'update'];
const RO: Action[] = ['view'];


// The capability matrix. Deny-by-default: anything not listed is denied.
// Sprint 10 adds analytics/integrations/intelligence columns.
const MATRIX: Record<string, Partial<Record<Resource, Action[]>>> = {
  OWNER: {
    customers: ALL, pipeline: ALL, inbox: ALL, workflows: ALL, users: ALL,
    organizations: ALL, aiEmployees: ALL, settings: ALL, audit: ALL,
    analytics: ALL, integrations: ALL, intelligence: ALL,
  },
  ADMIN: {
    customers: ALL, pipeline: ALL, inbox: ALL, workflows: ALL, users: ALL,
    organizations: ['view', 'update'], aiEmployees: ALL, settings: ALL, audit: ['view'],
    analytics: ALL, integrations: ALL, intelligence: ALL,
  },
  MANAGER: {
    customers: RW, pipeline: RW, inbox: RW, workflows: RW, users: ['view'],
    organizations: RO, aiEmployees: RW, settings: ['view'], audit: ['view'],
    analytics: RO, integrations: ['view'], intelligence: RO,
  },
  EMPLOYEE: {
    customers: RW, pipeline: RW, inbox: RW, workflows: RO, users: [],
    organizations: [], aiEmployees: RO, settings: [], audit: [],
    analytics: RO, integrations: [], intelligence: RO,
  },
  READ_ONLY: {
    customers: RO, pipeline: RO, inbox: RO, workflows: RO, users: [],
    organizations: [], aiEmployees: RO, settings: [], audit: [],
    analytics: RO, integrations: [], intelligence: RO,
  },
};


export function roleLabel(role: string | null | undefined): string {
  return (role && SYSTEM_ROLE_LABELS[role]) || 'Agent';
}


/** Pure matrix check (no DB). Baseline before explicit rules. */
export function matrixAllows(role: string, resource: Resource, action: Action): boolean {
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


// ---- Repository -----------------------------------------------------------

export class IamRepository {
  constructor(private readonly prisma: PrismaClient) {}


  // -- Permission resolution ------------------------------------------------

  async can(args: CanArgs): Promise<boolean> {
    const { organizationId, userId, resource, action } = args;

    const user = await this.prisma.user.findFirst({
      where: { id: userId, organizationId },
      select: { metadata: true, status: true },
    });
    if (!user || user.status !== 'ACTIVE') return false;

    const role = userSystemRole(user);

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


  // -- User management ------------------------------------------------------

  async listUsers(organizationId: string): Promise<UserListItem[]> {
    // Explicit select: only the columns this view needs. A bare findMany would
    // SELECT every schema column, so a single drifted column in a deployed DB
    // (production has no migration ledger) would 500 the whole Team page.
    const users = await this.prisma.user.findMany({
      where: { organizationId, status: { not: 'DISABLED' } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, email: true, name: true, status: true,
        metadata: true, lastLoginAt: true, createdAt: true,
      },
    });
    return users.map((u) => ({
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
    return this.prisma.user.create({
      data: {
        organizationId: data.organizationId,
        email: data.email,
        name: data.name,
        status: 'INVITED',
        metadata: { systemRole: data.systemRole ?? 'EMPLOYEE', passwordHash: data.passwordHash },
      },
    });
  }

  async updateUserRole(
    organizationId: string,
    userId: string,
    systemRole: string,
  ): Promise<void> {
    const user = await this.prisma.user.findFirst({ where: { id: userId, organizationId } });
    if (!user) return;
    const m = meta(user);
    await this.prisma.user.update({
      where: { id: userId },
      data: { metadata: { ...m, systemRole } },
    });
  }

  async activateUser(organizationId: string, userId: string): Promise<void> {
    await this.prisma.user.updateMany({
      where: { id: userId, organizationId },
      data: { status: 'ACTIVE' },
    });
  }

  async disableUser(organizationId: string, userId: string): Promise<void> {
    await this.prisma.user.updateMany({
      where: { id: userId, organizationId },
      data: { status: 'DISABLED' },
    });
  }

  async softRemoveUser(organizationId: string, userId: string): Promise<void> {
    // The metadata bag carries systemRole AND passwordHash. It must be MERGED,
    // never replaced: overwriting it stripped both, so a re-enabled user came
    // back with no password and silently defaulted to EMPLOYEE. Mirrors the
    // read-modify-write pattern used by setRole above; the findFirst keeps the
    // write scoped to the caller's organization.
    const user = await this.prisma.user.findFirst({ where: { id: userId, organizationId } });
    if (!user) return;
    const m = meta(user);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        status: 'DISABLED',
        metadata: { ...m, removedAt: new Date().toISOString() },
      },
    });
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
