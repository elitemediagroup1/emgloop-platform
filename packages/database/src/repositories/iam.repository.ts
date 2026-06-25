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


import type { PrismaClient, User, Invitation } from '@prisma/client';
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
      where: { organizationId, systemRole: role as Parameters<typeof this.prisma.permission.findMany>[0]['where'] extends { systemRole?: infer R } ? R : never, resource, action, effect: 'DENY' },
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
    const users = await this.prisma.user.findMany({
      where: { organizationId, status: { not: 'DISABLED' } },
      orderBy: { createdAt: 'desc' },
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
    await this.prisma.user.updateMany({
      where: { id: userId, organizationId },
      data: { status: 'DISABLED', metadata: { removedAt: new Date().toISOString() } },
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
        inviterId: data.inviterId,
        status: 'PENDING',
        tokenHash: data.tokenHash,
        expiresAt: data.expiresAt,
        metadata: { systemRole: data.systemRole ?? 'EMPLOYEE' },
      },
    });
  }

  async listInvitations(organizationId: string): Promise<InvitationView[]> {
    const invites = await this.prisma.invitation.findMany({
      where: { organizationId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    return invites.map((i) => ({
      id: i.id,
      email: i.email,
      systemRole: ((i.metadata as Record<string, unknown>)?.['systemRole'] as string) ?? 'EMPLOYEE',
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
}
