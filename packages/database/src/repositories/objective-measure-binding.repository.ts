// ObjectiveMeasureBindingRepository -- Commercial Intelligence Stage 3 v1.
//
// Persistence for what a Performance Objective means in measurable terms: one
// metric, a human-confirmed population of provider external ids, and a direction.
//
// IMMUTABLE AFTER CONFIRMATION, AND THE API IS THE ENFORCEMENT. There is no
// `update` method and there cannot be one. Changing what an objective measures is
// `confirm()` again, which writes a NEW version and supersedes the old -- because
// a binding that can be edited retroactively rewrites the meaning of every
// Headline ever produced under it, which is the same reasoning that made Stage 2
// reject a projection over editable objective text. `supersede` writes exactly two
// columns and is the only post-confirmation write in this file.
//
// TENANCY IS ENFORCED HERE, NOT AT THE CALL SITE, following
// PerformanceObjectiveRepository and CommercialSignalRepository directly. Every
// method takes `organizationId` as its FIRST REQUIRED ARGUMENT, resolves the
// objective WITHIN the organization before writing anything, and fails closed to
// null. A cross-organization id is NOT-FOUND, never forbidden.
//
// THE POPULATION IS WHAT A HUMAN TICKED. This repository never derives a
// population, never parses a label, never reads a Commercial Signal and never
// consults TERM_MATCH. It stores a selection and hands it back.
//
// WHAT THIS REPOSITORY DOES NOT DO. It does not measure, score, rank, prioritize,
// notify, escalate, create work or create decisions. It has no notion of a target,
// a baseline or attainment, and no column here could hold one.

import type { PrismaClient, ObjectiveMeasureBinding, Prisma } from '@prisma/client';
import {
  BINDING_DIMENSIONS,
  isBindingDimension,
  isMeasureDirection,
  isMeasureMetric,
  validateBindingShape,
  type BindingDimension,
  type BindingMember,
  type BindingRejection,
  type ObjectiveMeasureBindingView,
} from '@emgloop/shared';

/** externalId -> label as it read at confirmation. Display only, never identity. */
type LabelMap = Record<string, string>;

function labelMapOf(value: Prisma.JsonValue | null): LabelMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: LabelMap = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** The four id arrays, back into one ordered member list. */
function membersOfRow(row: ObjectiveMeasureBinding): BindingMember[] {
  const labels = labelMapOf(row.memberLabels);
  const byDimension: Record<BindingDimension, string[]> = {
    CAMPAIGN: row.campaignExternalIds,
    SOURCE: row.sourceExternalIds,
    BUYER: row.buyerExternalIds,
    VENDOR: row.vendorExternalIds,
  };
  const out: BindingMember[] = [];
  for (const dimension of BINDING_DIMENSIONS) {
    for (const externalId of byDimension[dimension]) {
      out.push({
        dimension,
        externalId,
        labelAtConfirmation: labels[`${dimension}:${externalId}`] ?? null,
      });
    }
  }
  return out;
}

function toView(
  row: ObjectiveMeasureBinding,
  confirmedByName: string | null,
): ObjectiveMeasureBindingView {
  return {
    id: row.id,
    performanceObjectiveId: row.performanceObjectiveId,
    version: row.version,
    // Validated on the way OUT as well as in. The columns are strings so a sixth
    // metric needs no migration; that flexibility is only safe if a value written
    // by an older build cannot reach a caller as an unrecognised vocabulary
    // member. An unknown value fails closed to the safest reading.
    metric: isMeasureMetric(row.metric) ? row.metric : 'CALL_VOLUME',
    direction: isMeasureDirection(row.direction) ? row.direction : 'HIGHER_IS_BETTER',
    members: membersOfRow(row),
    callerStates: row.callerStates,
    confirmedByUserId: row.confirmedByUserId,
    confirmedByName,
    confirmedAt: row.confirmedAt.toISOString(),
    supersededAt: row.supersededAt?.toISOString() ?? null,
    supersededByBindingId: row.supersededByBindingId,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface ConfirmBindingInput {
  performanceObjectiveId: string;
  metric: string;
  direction: string;
  members: ReadonlyArray<{ dimension: string; externalId: string; label?: string | null }>;
  /** OPTIONAL ADDITIONAL restriction. Empty means no restriction at all. */
  callerStates?: readonly string[];
  confirmedByUserId: string | null;
}

export type ConfirmBindingResult =
  | { ok: true; binding: ObjectiveMeasureBindingView; supersededBindingId: string | null }
  | { ok: false; reason: BindingRejection };

export class ObjectiveMeasureBindingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Confirm a binding, superseding whatever was active before.
   *
   * Returns `null` when the objective does not resolve inside this organization
   * -- unknown id and another tenant's id get the same answer, and neither writes
   * anything. The caller must not audit a write that did not happen.
   *
   * The supersede-and-create pair runs in ONE transaction. A half-applied change
   * would leave either two active bindings (so a measurement run would not know
   * which definition to use) or none (so an objective would silently stop being
   * measurable), and both are worse than the write failing.
   */
  async confirm(
    organizationId: string,
    input: ConfirmBindingInput,
  ): Promise<ConfirmBindingResult | null> {
    // FAIL CLOSED FIRST. The objective is what makes this a binding at all, so it
    // is resolved WITHIN the organization before anything is validated or written.
    const objective = await this.prisma.performanceObjective.findFirst({
      where: { id: input.performanceObjectiveId, organizationId },
      select: { id: true },
    });
    if (!objective) return null;

    const rejection = validateBindingShape(input);
    if (rejection) return { ok: false, reason: rejection };

    const members = input.members.map((m) => ({
      dimension: m.dimension as BindingDimension,
      externalId: m.externalId.trim(),
      label: m.label?.trim() || null,
    }));

    const labels: LabelMap = {};
    for (const m of members) {
      if (m.label) labels[`${m.dimension}:${m.externalId}`] = m.label;
    }

    const idsFor = (d: BindingDimension): string[] =>
      members.filter((m) => m.dimension === d).map((m) => m.externalId).sort();

    const callerStates = [...new Set((input.callerStates ?? []).map((s) => s.trim().toUpperCase()))].sort();

    const created = await this.prisma.$transaction(async (tx) => {
      const active = await tx.objectiveMeasureBinding.findFirst({
        where: { organizationId, performanceObjectiveId: objective.id, supersededAt: null },
        select: { id: true },
      });
      const highest = await tx.objectiveMeasureBinding.findFirst({
        where: { performanceObjectiveId: objective.id },
        orderBy: { version: 'desc' },
        select: { version: true },
      });

      const row = await tx.objectiveMeasureBinding.create({
        data: {
          organizationId,
          performanceObjectiveId: objective.id,
          version: (highest?.version ?? 0) + 1,
          metric: input.metric,
          direction: input.direction,
          campaignExternalIds: idsFor('CAMPAIGN'),
          sourceExternalIds: idsFor('SOURCE'),
          buyerExternalIds: idsFor('BUYER'),
          vendorExternalIds: idsFor('VENDOR'),
          callerStates,
          memberLabels: labels,
          confirmedByUserId: input.confirmedByUserId,
        },
      });

      if (active) {
        // Two columns, written once. The superseded row's definition -- its
        // metric, population, direction and confirmer -- is never touched, so
        // every Headline produced under it stays interpretable.
        await tx.objectiveMeasureBinding.update({
          where: { id: active.id },
          data: { supersededAt: new Date(), supersededByBindingId: row.id },
        });
      }

      return { row, supersededBindingId: active?.id ?? null };
    });

    return {
      ok: true,
      binding: toView(created.row, await this.nameOf(organizationId, created.row.confirmedByUserId)),
      supersededBindingId: created.supersededBindingId,
    };
  }

  /**
   * The binding a measurement run should use for this objective, or null.
   *
   * Null is the honest answer for an objective nobody has bound: NOT MEASURABLE
   * YET. It is never filled with a default, never inferred from the objective's
   * text, and never derived from Commercial Signals.
   */
  async activeFor(
    organizationId: string,
    performanceObjectiveId: string,
  ): Promise<ObjectiveMeasureBindingView | null> {
    const row = await this.prisma.objectiveMeasureBinding.findFirst({
      where: { organizationId, performanceObjectiveId, supersededAt: null },
      orderBy: { version: 'desc' },
    });
    if (!row) return null;
    return toView(row, await this.nameOf(organizationId, row.confirmedByUserId));
  }

  /** Every active binding in the organization, for a run that sweeps objectives. */
  async listActive(organizationId: string, take = 200): Promise<ObjectiveMeasureBindingView[]> {
    const rows = await this.prisma.objectiveMeasureBinding.findMany({
      where: { organizationId, supersededAt: null },
      orderBy: [{ performanceObjectiveId: 'asc' }, { version: 'desc' }],
      take: Math.min(500, Math.max(1, take)),
    });
    const names = await this.namesFor(organizationId, rows);
    return rows.map((r) => toView(r, r.confirmedByUserId ? (names.get(r.confirmedByUserId) ?? null) : null));
  }

  /** One binding by id, resolved within the organization. Cross-org is null. */
  async get(organizationId: string, id: string): Promise<ObjectiveMeasureBindingView | null> {
    const row = await this.prisma.objectiveMeasureBinding.findFirst({ where: { id, organizationId } });
    if (!row) return null;
    return toView(row, await this.nameOf(organizationId, row.confirmedByUserId));
  }

  /**
   * The full version history for one objective, newest first.
   *
   * Superseded versions are returned, never hidden: they are how a reader
   * interprets a Headline produced months ago under a definition that has since
   * changed.
   */
  async history(
    organizationId: string,
    performanceObjectiveId: string,
    take = 20,
  ): Promise<ObjectiveMeasureBindingView[]> {
    const rows = await this.prisma.objectiveMeasureBinding.findMany({
      where: { organizationId, performanceObjectiveId },
      orderBy: { version: 'desc' },
      take: Math.min(100, Math.max(1, take)),
    });
    const names = await this.namesFor(organizationId, rows);
    return rows.map((r) => toView(r, r.confirmedByUserId ? (names.get(r.confirmedByUserId) ?? null) : null));
  }

  /**
   * Retire a binding without replacing it.
   *
   * Leaves the objective NOT MEASURABLE YET, which is a legitimate state and not
   * an error. Returns null when the binding does not resolve inside this
   * organization, or when it was already superseded -- superseding twice would
   * rewrite the first supersession's timestamp, and a supersede-only column that
   * can be re-written is not supersede-only.
   */
  async retire(organizationId: string, id: string): Promise<ObjectiveMeasureBindingView | null> {
    const row = await this.prisma.objectiveMeasureBinding.findFirst({
      where: { id, organizationId, supersededAt: null },
      select: { id: true },
    });
    if (!row) return null;
    const updated = await this.prisma.objectiveMeasureBinding.update({
      where: { id: row.id },
      data: { supersededAt: new Date() },
    });
    return toView(updated, await this.nameOf(organizationId, updated.confirmedByUserId));
  }

  /** Display name of a confirmer, resolved inside the organization. */
  private async nameOf(organizationId: string, userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const user = await this.prisma.user.findFirst({
      where: { id: userId, organizationId },
      select: { name: true, email: true },
    });
    if (!user) return null;
    return user.name ?? user.email;
  }

  private async namesFor(
    organizationId: string,
    rows: readonly ObjectiveMeasureBinding[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((r) => r.confirmedByUserId).filter((v): v is string => Boolean(v)))];
    if (ids.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { organizationId, id: { in: ids } },
      select: { id: true, name: true, email: true },
    });
    return new Map(users.map((u) => [u.id, u.name ?? u.email]));
  }
}

/** Re-exported so a caller can validate a dimension without importing shared twice. */
export { isBindingDimension };
