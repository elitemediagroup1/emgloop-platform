// ProviderFactRevisionRepository -- why a canonical provider fact changed.
//
// WHAT IT STORES, AND WHAT IT REFUSES TO STORE. A row exists only when a later
// observation actually MOVED a canonical fact, or when two settled answers
// DISAGREED. KEEP_EXISTING and REMAIN_UNKNOWN are not recorded: nothing
// happened, and a row per non-event is how a table becomes a log. That is what
// keeps this bounded by changes rather than by observations -- a poller
// re-reading a 48-hour overlap every fifteen minutes produces roughly 192
// observations per call and, once the postback has settled, no revisions at all.
//
// A CONFLICT IS A ROW THAT CHANGED NOTHING. When two settled amounts disagree,
// the canonical value stays where it was and `appliedAt` is NULL. Recording it
// is the whole point: a provider correction and a defect look identical from
// here, so the disagreement is preserved for a person instead of being resolved
// by whichever observation happened to arrive second.
//
// TENANT-FIRST. `organizationId` is the first argument of every method and leads
// every index, per CLAUDE.md's multi-tenant rules.

import type { PrismaClient } from '@prisma/client';
import type { FactConvergenceDecision, ObservationSource } from '@emgloop/shared';

/** One decision worth keeping. Only UPDATE and CONFLICT reach here. */
export interface RecordFactRevisionInput {
  provider: string;
  externalId: string;
  fact: string;
  decision: Extract<FactConvergenceDecision, 'UPDATE' | 'CONFLICT'>;
  /** Rendered values. Null means the fact was unknown on that side. */
  fromValue: string | null;
  toValue: string | null;
  observationSource: ObservationSource;
  observedAt: Date;
  integrationEventId: string | null;
  /** Set only when the canonical value actually moved. */
  applied: boolean;
  reason: string;
}

export interface FactRevisionView {
  id: string;
  provider: string;
  externalId: string;
  fact: string;
  decision: string;
  fromValue: string | null;
  toValue: string | null;
  observationSource: string;
  observedAt: string;
  appliedAt: string | null;
  reason: string;
}

/** Render a canonical fact for the record. Never a guess, never a default. */
export function renderFactValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export class ProviderFactRevisionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Record one decision. Append-only: a revision is never edited or deleted. */
  async record(organizationId: string, input: RecordFactRevisionInput): Promise<{ id: string }> {
    const row = await this.prisma.providerFactRevision.create({
      data: {
        organizationId,
        provider: input.provider,
        externalId: input.externalId,
        fact: input.fact,
        decision: input.decision,
        fromValue: input.fromValue,
        toValue: input.toValue,
        observationSource: input.observationSource,
        observedAt: input.observedAt,
        integrationEventId: input.integrationEventId,
        // NULL is not "not yet applied". It is "the canonical value did not
        // move", which is the whole meaning of a recorded conflict.
        appliedAt: input.applied ? input.observedAt : null,
        reason: input.reason,
      },
      select: { id: true },
    });
    return row;
  }

  /** Everything that ever changed about one call, oldest first. */
  async forCall(
    organizationId: string,
    provider: string,
    externalId: string,
  ): Promise<FactRevisionView[]> {
    const rows = await this.prisma.providerFactRevision.findMany({
      where: { organizationId, provider, externalId },
      orderBy: { observedAt: 'asc' },
    });
    return rows.map(toView);
  }

  /** Unresolved disagreements, newest first. The read an operator makes. */
  async conflicts(organizationId: string, limit = 50): Promise<FactRevisionView[]> {
    const rows = await this.prisma.providerFactRevision.findMany({
      where: { organizationId, decision: 'CONFLICT' },
      orderBy: { observedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 500),
    });
    return rows.map(toView);
  }
}

function toView(row: {
  id: string;
  provider: string;
  externalId: string;
  fact: string;
  decision: string;
  fromValue: string | null;
  toValue: string | null;
  observationSource: string;
  observedAt: Date;
  appliedAt: Date | null;
  reason: string;
}): FactRevisionView {
  return {
    id: row.id,
    provider: row.provider,
    externalId: row.externalId,
    fact: row.fact,
    decision: row.decision,
    fromValue: row.fromValue,
    toValue: row.toValue,
    observationSource: row.observationSource,
    observedAt: row.observedAt.toISOString(),
    appliedAt: row.appliedAt ? row.appliedAt.toISOString() : null,
    reason: row.reason,
  };
}
