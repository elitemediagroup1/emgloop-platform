// PerformanceObjectiveRepository — Commercial Intelligence Stage 1.
//
// Persistence for human-authored intent: what an organization or a person is
// trying to accomplish. The only Commercial Intelligence concept that exists.
//
// TENANCY IS ENFORCED HERE, NOT AT THE CALL SITE. Every method takes
// `organizationId` as its FIRST REQUIRED ARGUMENT and resolves the row WITHIN
// that organization before touching it, failing closed to `null`. This is the
// Sprint 29A pattern (see AIEmployeeRepository), adopted from line one rather
// than retrofitted: the lesson that produced it is that a caller-guarded write
// and an unguarded one look identical at the call site, so review cannot sustain
// the difference. A cross-organization id is NOT-FOUND, never forbidden — the
// existence of another tenant's row is not something this API will confirm.
//
// NO AUDIT ROW FOR A WRITE THAT DID NOT HAPPEN. Every mutation returns `null`
// when the scoped resolve misses, and callers record audit only on a non-null
// result. That ordering is the invariant, and the tests assert it.
//
// SCOPE INVARIANTS ARE ENFORCED AT THE DATA LAYER. A USER-scoped objective must
// name a user, and that user must be an active member of the SAME organization;
// an ORGANIZATION-scoped objective must not name one. Validating this in the
// form only would leave the rule one un-guarded caller away from being untrue.
//
// WHAT THIS REPOSITORY DOES NOT DO. It does not rank, score, measure, infer,
// recommend or conclude anything, and it reads no other domain. `MANAGER` never
// appears in this file: it is an authorization level resolved by IamRepository,
// and it establishes no relationship between users. There is no query here that
// takes a user and returns "the people they manage", because Loop has no such
// relationship to query.

import type { PrismaClient, PerformanceObjective, Prisma } from '@prisma/client';
import {
  validatePerformanceObjectiveShape,
  type PerformanceObjectiveRejection,
  type PerformanceObjectiveScope,
  type PerformanceObjectiveStatus,
  type PerformanceObjectiveView,
} from '@emgloop/shared';

/** A write either produced a row, or was refused for a stated reason. */
export type PerformanceObjectiveResult =
  | { ok: true; objective: PerformanceObjectiveView }
  | { ok: false; reason: PerformanceObjectiveRejection };

export interface CreatePerformanceObjectiveInput {
  title: string;
  description?: string | null;
  scope: PerformanceObjectiveScope;
  scopeUserId?: string | null;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
  createdByUserId?: string | null;
}

export interface UpdatePerformanceObjectiveInput {
  title?: string;
  description?: string | null;
  scope?: PerformanceObjectiveScope;
  scopeUserId?: string | null;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
}

export interface ListPerformanceObjectivesOptions {
  status?: PerformanceObjectiveStatus;
  scope?: PerformanceObjectiveScope;
  /** Objectives belonging to one person. Never widened by role. */
  scopeUserId?: string;
  take?: number;
}

type ObjectiveRow = PerformanceObjective & { scopeUser?: { name: string | null; email: string } | null };

function toView(row: ObjectiveRow): PerformanceObjectiveView {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    scope: row.scope as PerformanceObjectiveScope,
    scopeUserId: row.scopeUserId,
    scopeUserName: row.scopeUser ? (row.scopeUser.name ?? row.scopeUser.email) : null,
    status: row.status as PerformanceObjectiveStatus,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo ? row.effectiveTo.toISOString() : null,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Explicit select (drift-safe, the same reason IamRepository.listUsers gives): a
// bare include SELECTs every column, so one drifted column in the deployed
// database — production has no migration ledger — would 500 the whole page.
const SCOPE_USER_SELECT = { select: { name: true, email: true } } as const;

export class PerformanceObjectiveRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Is this user an active member of THIS organization?
   *
   * The membership rule is `User.organizationId` — the platform's one and only
   * membership fact (`User.organizationId` is scalar; there is no membership
   * table and no org switcher). Soft-removed users carry `metadata.removedAt`
   * and are excluded, matching IamRepository.listUsers, so a departed teammate
   * cannot be assigned a new objective.
   *
   * This is a MEMBERSHIP check and nothing more. It says the user is in the
   * organization; it says nothing about who may act on their behalf.
   */
  private async isActiveMember(organizationId: string, userId: string): Promise<boolean> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, organizationId, status: { in: ['ACTIVE', 'DISABLED'] } },
      select: { id: true, metadata: true },
    });
    if (!user) return false;
    const meta = (user.metadata ?? {}) as Record<string, unknown>;
    return !meta['removedAt'];
  }

  /** Shape rules first (pure), then the one rule that needs a query. */
  private async reject(
    organizationId: string,
    candidate: {
      title: string;
      scope: string;
      scopeUserId?: string | null;
      effectiveFrom?: Date | null;
      effectiveTo?: Date | null;
    },
  ): Promise<PerformanceObjectiveRejection | null> {
    const shape = validatePerformanceObjectiveShape(candidate);
    if (shape) return shape;
    if (candidate.scope === 'USER' && candidate.scopeUserId) {
      if (!(await this.isActiveMember(organizationId, candidate.scopeUserId))) {
        // Deliberately the same answer for "user in another tenant" and "user
        // does not exist". Distinguishing them would confirm that an id belongs
        // to somebody, somewhere.
        return 'USER_NOT_IN_ORGANIZATION';
      }
    }
    return null;
  }

  async create(
    organizationId: string,
    input: CreatePerformanceObjectiveInput,
  ): Promise<PerformanceObjectiveResult> {
    const title = input.title.trim();
    const scopeUserId = input.scope === 'USER' ? (input.scopeUserId ?? null) : null;
    const effectiveFrom = input.effectiveFrom ?? new Date();
    const effectiveTo = input.effectiveTo ?? null;

    const reason = await this.reject(organizationId, {
      title,
      scope: input.scope,
      // Pass what the CALLER supplied, not the normalized value, so supplying a
      // user on an ORGANIZATION-scoped objective is refused rather than silently
      // dropped. A write that quietly discards part of its input is how somebody
      // later concludes the field does not work.
      scopeUserId: input.scopeUserId ?? null,
      effectiveFrom,
      effectiveTo,
    });
    if (reason) return { ok: false, reason };

    const row = await this.prisma.performanceObjective.create({
      data: {
        organizationId,
        title,
        description: input.description?.trim() || null,
        scope: input.scope,
        scopeUserId,
        effectiveFrom,
        effectiveTo,
        createdByUserId: input.createdByUserId ?? null,
      },
      include: { scopeUser: SCOPE_USER_SELECT },
    });
    return { ok: true, objective: toView(row as ObjectiveRow) };
  }

  /** One objective, resolved within the organization. Cross-org is null. */
  async get(organizationId: string, id: string): Promise<PerformanceObjectiveView | null> {
    const row = await this.prisma.performanceObjective.findFirst({
      where: { id, organizationId },
      include: { scopeUser: SCOPE_USER_SELECT },
    });
    return row ? toView(row as ObjectiveRow) : null;
  }

  /**
   * Objectives for one organization.
   *
   * The `where` is built from the session organization plus explicit filters
   * only. There is no branch anywhere in this method that widens the result set
   * based on the caller's role, and there must not be: role decides WHETHER you
   * may read objectives (RBAC, at the guard), never WHICH tenant's you see.
   */
  async list(
    organizationId: string,
    opts: ListPerformanceObjectivesOptions = {},
  ): Promise<PerformanceObjectiveView[]> {
    const where: Prisma.PerformanceObjectiveWhereInput = { organizationId };
    if (opts.status) where.status = opts.status;
    if (opts.scope) where.scope = opts.scope;
    if (opts.scopeUserId) where.scopeUserId = opts.scopeUserId;

    const rows = await this.prisma.performanceObjective.findMany({
      where,
      // Active before archived, then newest first: the list answers "what are we
      // pursuing" before "what did we pursue".
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: Math.min(500, Math.max(1, opts.take ?? 200)),
      include: { scopeUser: SCOPE_USER_SELECT },
    });
    return rows.map((r) => toView(r as ObjectiveRow));
  }

  /**
   * Edit an objective. Returns `null` when the id does not resolve inside the
   * organization — the caller must not audit a write that did not happen.
   */
  async update(
    organizationId: string,
    id: string,
    fields: UpdatePerformanceObjectiveInput,
  ): Promise<PerformanceObjectiveResult | null> {
    // Fail closed: resolve WITHIN the organization before validating or writing.
    const existing = await this.prisma.performanceObjective.findFirst({
      where: { id, organizationId },
    });
    if (!existing) return null;

    // Validate the row as it WOULD BE, not as the patch was written. A patch that
    // changes scope to ORGANIZATION while leaving an existing scopeUserId behind
    // is invalid, and only the merged view can see that.
    const scope = (fields.scope ?? existing.scope) as PerformanceObjectiveScope;
    const scopeUserId =
      fields.scopeUserId !== undefined ? fields.scopeUserId : existing.scopeUserId;
    const merged = {
      title: (fields.title ?? existing.title).trim(),
      scope,
      // Switching to ORGANIZATION scope CLEARS the user rather than refusing:
      // the caller said "this belongs to the whole organization", which is a
      // complete instruction, not a contradiction.
      scopeUserId: scope === 'USER' ? scopeUserId : null,
      effectiveFrom: fields.effectiveFrom ?? existing.effectiveFrom,
      effectiveTo: fields.effectiveTo !== undefined ? fields.effectiveTo : existing.effectiveTo,
    };

    const reason = await this.reject(organizationId, merged);
    if (reason) return { ok: false, reason };

    // Unchecked (scalar) form, matching `create` above. Writing `scopeUserId`
    // directly rather than through a nested connect/disconnect keeps one shape
    // for the foreign key across both write paths — and switching an objective
    // from USER to ORGANIZATION scope is a plain "set this column to null",
    // which is exactly what it means.
    const data: Prisma.PerformanceObjectiveUncheckedUpdateInput = {
      title: merged.title,
      scope: merged.scope,
      scopeUserId: merged.scopeUserId,
      effectiveFrom: merged.effectiveFrom,
      effectiveTo: merged.effectiveTo,
    };
    if (fields.description !== undefined) {
      data.description = fields.description?.trim() || null;
    }

    const row = await this.prisma.performanceObjective.update({
      where: { id: existing.id },
      data,
      include: { scopeUser: SCOPE_USER_SELECT },
    });
    return { ok: true, objective: toView(row as ObjectiveRow) };
  }

  /**
   * Archive or reactivate. The whole lifecycle, deliberately.
   *
   * ARCHIVE RATHER THAN DELETE. An objective is a record of what the
   * organization decided mattered, and that stays true after it stops being
   * pursued. Hard deletion is reserved for the tenant going away, which the
   * Organization foreign key handles.
   */
  async setStatus(
    organizationId: string,
    id: string,
    status: PerformanceObjectiveStatus,
  ): Promise<PerformanceObjectiveView | null> {
    // Fail closed: a cross-organization (or unknown) id performs no write.
    const existing = await this.prisma.performanceObjective.findFirst({
      where: { id, organizationId },
      select: { id: true },
    });
    if (!existing) return null;
    const row = await this.prisma.performanceObjective.update({
      where: { id: existing.id },
      data: { status },
      include: { scopeUser: SCOPE_USER_SELECT },
    });
    return toView(row as ObjectiveRow);
  }
}
