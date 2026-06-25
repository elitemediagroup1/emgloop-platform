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

import type { PrismaClient, User, Invitation } from '@prisma/client';
import { SystemRole } from '@prisma/client';

export type Resource =
  | 'customers'
  | 'pipeline'
  | 'inbox'
  | 'users'
  | 'organizations'
  | 'aiEmployees'
  | 'settings'
  | 'audit';

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
const MATRIX: Record<string, Partial<Record<Resource, Action[]>>> = {
  OWNER: {
    customers: ALL, pipeline: ALL, inbox: ALL, users: ALL,
    organizations: ALL, aiEmployees: ALL, settings: ALL, audit: ALL,
  },
  ADMIN: {
    customers: ALL, pipeline: ALL, inbox: ALL, users: ALL,
    organizations: ['view', 'update'], aiEmployees: ALL, settings: ALL, audit: ['view'],
  },
  MANAGER: {
    customers: RW, pipeline: RW, inbox: RW, users: ['view'],
    organizations: RO, aiEmployees: RW, settings: ['view'], audit: ['view'],
  },
  EMPLOYEE: {
    customers: RW, pipeline: RW, inbox: RW, users: [],
    organizations: [], aiEmployees: RO, settings: [], audit: [],
  },
  READ_ONLY: {
    customers: RO, pipeline: RO, inbox: RO, users: [],
    organizations: [], aiEmployees: RO, settings: [], audit: [],
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

export function userSystemRole(u: { metadata: unknown }): SystemRole {
  const r = meta(u).systemRole;
  if (typeof r === 'string' && (SYSTEM_ROLES as string[]).includes(r)) {
    return r as SystemRole;
  }
  return SystemRole.EMPLOYEE;
}

export interface UserView {
  id: string;
  name: string;
  email: string;
  status: string;
  systemRole: SystemRole;
  roleLabel: string;
  lastLoginAt: string | null;
  createdAt: string;
}

function toUserView(u: User): UserView {
  const role = userSystemRole(u);
  return {
    id: u.id,
    name: u.name ?? u.email,
    email: u.email,
    status: u.status,
    systemRole: role,
    roleLabel: roleLabel(role),
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
  };
}

export class IamRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // --- Permission resolution -------------------------------------------

  /** Deny-by-default resolver. Explicit Permission rows override the matrix;
      a matching DENY always wins over any ALLOW. */
  async can(args: {
    organizationId: string;
    userId: string;
    resource: Resource;
    action: Action;
  }): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: args.userId } });
    if (!user) return false;
    if (user.status === 'DISABLED') return false;
    const role = userSystemRole(user);
    let allowed = matrixAllows(role, args.resource, args.action);

    const rules = await this.prisma.permission.findMany({
      where: {
        organizationId: args.organizationId,
        resource: args.resource,
        OR: [{ userId: args.userId }, { systemRole: role }],
      },
    });
    for (const r of rules) {
      if (r.action !== args.action && r.action !== 'manage') continue;
      if (r.effect === 'DENY') return false;
      if (r.effect === 'ALLOW') allowed = true;
    }
    return allowed;
  }

  // --- Users -----------------------------------------------------------

  async listUsers(organizationId: string): Promise<UserView[]> {
    const rows = await this.prisma.user.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toUserView);
  }

  async getUser(id: string): Promise<UserView | null> {
    const u = await this.prisma.user.findUnique({ where: { id } });
    return u ? toUserView(u) : null;
  }

  async countUsers(organizationId: string): Promise<number> {
    return this.prisma.user.count({ where: { organizationId } });
  }

  /** Set a user's system role (stored in metadata, merged). */
  async setSystemRole(userId: string, role: SystemRole): Promise<User> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { metadata: true },
    });
    const current = u ? meta(u) : {};
    return this.prisma.user.update({
      where: { id: userId },
      data: { metadata: { ...current, systemRole: role } as object },
    });
  }

  setStatus(userId: string, status: 'ACTIVE' | 'DISABLED' | 'INVITED'): Promise<User> {
    return this.prisma.user.update({ where: { id: userId }, data: { status } });
  }

  /** Create (or revive) a user row in INVITED state for an org. */
  async createUser(args: {
    organizationId: string;
    email: string;
    name?: string | null;
    systemRole?: SystemRole;
  }): Promise<User> {
    const email = args.email.toLowerCase().trim();
    const role = args.systemRole ?? SystemRole.EMPLOYEE;
    return this.prisma.user.upsert({
      where: { organizationId_email: { organizationId: args.organizationId, email } },
      update: { name: args.name ?? undefined, metadata: { systemRole: role } as object },
      create: {
        organizationId: args.organizationId,
        email,
        name: args.name ?? null,
        status: 'INVITED',
        authProvider: 'PASSWORD',
        metadata: { systemRole: role } as object,
      },
    });
  }

  // --- Invitations -----------------------------------------------------

  async createInvitation(args: {
    organizationId: string;
    email: string;
    systemRole: SystemRole;
    invitedById?: string | null;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<Invitation> {
    return this.prisma.invitation.create({
      data: {
        organizationId: args.organizationId,
        email: args.email.toLowerCase().trim(),
        systemRole: args.systemRole,
        invitedById: args.invitedById ?? null,
        tokenHash: args.tokenHash,
        expiresAt: args.expiresAt,
      },
    });
  }

  listInvitations(organizationId: string): Promise<Invitation[]> {
    return this.prisma.invitation.findMany({
      where: { organizationId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revokeInvitation(id: string): Promise<void> {
    await this.prisma.invitation.update({
      where: { id },
      data: { status: 'REVOKED' },
    });
  }
}
