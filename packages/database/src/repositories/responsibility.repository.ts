// Sprint 27 — Work Intelligence Foundation (PR #121A)
// ---------------------------------------------------------------------------
// First-class organizational responsibilities and their configurable assignment
// to actors. A responsibility (CALLGRID_SETUP, CONTRACT_REVIEW, …) represents an
// organizational capability; the responsible actor can change without changing
// the responsibility. Routing resolves an owner through an explicit preference
// order and NEVER silently picks an arbitrary user.
//
// Org scoping: every method takes organizationId first; single-row resolves use
// findFirst({ where: { id, organizationId } }) and fail closed to null.
// ---------------------------------------------------------------------------

import type { PrismaClient, Responsibility, ResponsibilityAssignment } from '@prisma/client';

import { resolveRoutingPreference, type RoutingResult } from './work-intelligence.policy';

export interface CreateResponsibilityInput {
  organizationId: string;
  key: string;
  name: string;
  description?: string | null;
  category?: string | null;
}

export interface AssignResponsibilityInput {
  organizationId: string;
  responsibilityId: string;
  userId: string;
  assignmentType?: 'primary' | 'secondary';
  assignedByUserId?: string | null;
}

export class ResponsibilityRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // Idempotent create for seed data: returns the existing row if (org,key) exists.
  async ensureResponsibility(input: CreateResponsibilityInput): Promise<Responsibility> {
    const existing = await this.prisma.responsibility.findFirst({
      where: { organizationId: input.organizationId, key: input.key },
    });
    if (existing) return existing;
    return this.prisma.responsibility.create({
      data: {
        organizationId: input.organizationId,
        key: input.key,
        name: input.name,
        description: input.description ?? null,
        category: input.category ?? null,
      },
    });
  }

  async listResponsibilities(organizationId: string): Promise<Responsibility[]> {
    return this.prisma.responsibility.findMany({
      where: { organizationId },
      orderBy: { key: 'asc' },
    });
  }

  async findResponsibilityByKey(
    organizationId: string,
    key: string,
  ): Promise<Responsibility | null> {
    return this.prisma.responsibility.findFirst({ where: { organizationId, key } });
  }

  // Assign an actor to a responsibility. Idempotent for an already-active
  // (responsibility, user, type) tuple. The DB enforces one active per tuple via
  // a partial unique index; this method also checks first to avoid the throw.
  async assignResponsibility(
    input: AssignResponsibilityInput,
  ): Promise<ResponsibilityAssignment> {
    const responsibility = await this.prisma.responsibility.findFirst({
      where: { id: input.responsibilityId, organizationId: input.organizationId },
      select: { id: true },
    });
    if (!responsibility) {
      throw new Error(`Responsibility not found: ${input.responsibilityId}`);
    }
    const assignmentType = input.assignmentType ?? 'primary';
    const existing = await this.prisma.responsibilityAssignment.findFirst({
      where: {
        organizationId: input.organizationId,
        responsibilityId: input.responsibilityId,
        userId: input.userId,
        assignmentType,
        active: true,
      },
    });
    if (existing) return existing;
    return this.prisma.responsibilityAssignment.create({
      data: {
        organizationId: input.organizationId,
        responsibilityId: input.responsibilityId,
        userId: input.userId,
        assignmentType,
        assignedByUserId: input.assignedByUserId ?? null,
      },
    });
  }

  async deactivateAssignment(
    organizationId: string,
    assignmentId: string,
  ): Promise<ResponsibilityAssignment | null> {
    const existing = await this.prisma.responsibilityAssignment.findFirst({
      where: { id: assignmentId, organizationId },
    });
    if (!existing) return null;
    return this.prisma.responsibilityAssignment.update({
      where: { id: assignmentId },
      data: { active: false, unassignedAt: new Date() },
    });
  }

  async listActiveAssignments(
    organizationId: string,
    responsibilityId: string,
  ): Promise<ResponsibilityAssignment[]> {
    return this.prisma.responsibilityAssignment.findMany({
      where: { organizationId, responsibilityId, active: true },
      orderBy: [{ assignmentType: 'asc' }, { assignedAt: 'asc' }],
    });
  }

  // Resolve the responsible actor for a responsibility using the pure preference
  // order (explicit owner → active primary → active secondary → Needs Owner).
  async resolveResponsibleActor(
    organizationId: string,
    responsibilityId: string | null,
    explicitOwnerUserId?: string | null,
  ): Promise<RoutingResult> {
    if (explicitOwnerUserId) return { userId: explicitOwnerUserId, via: 'explicit' };
    if (!responsibilityId) return { userId: null, via: 'needs_owner' };
    const assignments = await this.listActiveAssignments(organizationId, responsibilityId);
    return resolveRoutingPreference({
      explicitOwnerUserId: null,
      assignments: assignments.map((a) => ({
        userId: a.userId,
        assignmentType: a.assignmentType,
        active: a.active,
      })),
    });
  }
}
