// Persistence for the CRM outreach authority (CRM slice 6): context facts and the human-set
// conversation state. Organization-scoped at the data layer: every method takes `organizationId`
// first, resolves rows WITHIN it, and fails closed to null / empty.
//
// No method here authorizes. The governed service (`crm-outreach.service.ts`) and the backfill
// (`crm-context-backfill.service.ts`) do, and own the audit and outbox rows.

import type { Prisma, PrismaClient } from '@prisma/client';
import type { CrmContextFactBasis, CrmContextFactKind, CrmHumanConversationState, CrmTimePrecision } from '@emgloop/shared';

type Db = PrismaClient | Prisma.TransactionClient;

export interface CrmContextFactRecord {
  readonly id: string;
  readonly partyId: string;
  readonly partyType: string;
  readonly kind: CrmContextFactKind;
  readonly text: string | null;
  readonly redactions: number;
  readonly relatedPartyId: string | null;
  readonly occurredAt: Date | null;
  readonly occurredAtPrecision: CrmTimePrecision;
  readonly basis: CrmContextFactBasis;
  readonly sourceRef: string | null;
  readonly importRunId: string | null;
  readonly importLine: number | null;
  readonly recordedByUserId: string | null;
  readonly recordedAt: Date;
  readonly retractedAt: Date | null;
}

export interface CrmContextFactInput {
  readonly partyId: string;
  readonly partyType: string;
  readonly kind: CrmContextFactKind;
  readonly text: string | null;
  readonly redactions?: number;
  readonly relatedPartyId?: string | null;
  readonly occurredAt: Date | null;
  readonly occurredAtPrecision: CrmTimePrecision;
  readonly basis: CrmContextFactBasis;
  readonly sourceRef?: string | null;
  readonly importRunId?: string | null;
  readonly importLine?: number | null;
  readonly dedupeKey: string;
  readonly recordedByUserId: string | null;
  readonly recordedAt?: Date;
}

export interface CrmOutreachStateRecord {
  readonly partyId: string;
  readonly state: CrmHumanConversationState | null;
  readonly stateSetAt: Date | null;
  readonly stateSetByUserId: string | null;
  readonly nextAction: string | null;
  readonly nextActionDueAt: Date | null;
  readonly nextActionSetAt: Date | null;
  readonly nextActionSetByUserId: string | null;
  readonly lastSequence: number;
}

export interface CrmOutreachEventRecord {
  readonly id: string;
  readonly partyId: string;
  readonly sequence: number;
  readonly type: 'STATE_SET' | 'STATE_CLEARED' | 'NEXT_ACTION_SET' | 'NEXT_ACTION_CLEARED';
  readonly state: CrmHumanConversationState | null;
  readonly nextAction: string | null;
  readonly nextActionDueAt: Date | null;
  readonly actorUserId: string;
  readonly occurredAt: Date;
}

const FACT_SELECT = {
  id: true, partyId: true, partyType: true, kind: true, text: true, redactions: true, relatedPartyId: true,
  occurredAt: true, occurredAtPrecision: true, basis: true, sourceRef: true, importRunId: true, importLine: true,
  recordedByUserId: true, recordedAt: true, retractedAt: true,
} as const;

const STATE_SELECT = {
  partyId: true, state: true, stateSetAt: true, stateSetByUserId: true, nextAction: true, nextActionDueAt: true,
  nextActionSetAt: true, nextActionSetByUserId: true, lastSequence: true,
} as const;

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

export class CrmOutreachRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // --- Context facts -------------------------------------------------------------------------

  /**
   * Record a fact once. The dedupe key is checked FIRST, on the caller's transaction, so an
   * already-recorded fact is UNCHANGED without a failed insert -- a failed insert would abort the
   * caller's Postgres transaction (the slice 5 finding). A concurrent writer that wins the race
   * still surfaces as UNCHANGED through the unique key, outside a caller transaction.
   */
  async recordFact(organizationId: string, input: CrmContextFactInput, db: Db = this.prisma): Promise<{ outcome: 'RECORDED' | 'UNCHANGED'; fact: CrmContextFactRecord } | { outcome: 'NOT_FOUND' }> {
    if (!organizationId?.trim() || !input.partyId?.trim() || !input.dedupeKey?.trim()) return { outcome: 'NOT_FOUND' };
    const existing = await db.crmSubjectContextFact.findFirst({ where: { organizationId, dedupeKey: input.dedupeKey }, select: FACT_SELECT });
    if (existing) return { outcome: 'UNCHANGED', fact: existing as CrmContextFactRecord };
    try {
      const fact = await db.crmSubjectContextFact.create({
        data: {
          organizationId,
          partyId: input.partyId,
          partyType: input.partyType,
          kind: input.kind,
          text: input.text,
          redactions: input.redactions ?? 0,
          relatedPartyId: input.relatedPartyId ?? null,
          occurredAt: input.occurredAtPrecision === 'UNKNOWN' ? null : input.occurredAt,
          occurredAtPrecision: input.occurredAtPrecision,
          basis: input.basis,
          sourceRef: input.sourceRef ?? null,
          importRunId: input.importRunId ?? null,
          importLine: input.importLine ?? null,
          dedupeKey: input.dedupeKey,
          recordedByUserId: input.recordedByUserId,
          ...(input.recordedAt ? { recordedAt: input.recordedAt } : {}),
        },
        select: FACT_SELECT,
      });
      return { outcome: 'RECORDED', fact: fact as CrmContextFactRecord };
    } catch (err) {
      if (!isUniqueViolation(err) || db !== this.prisma) throw err;
      const raced = await this.prisma.crmSubjectContextFact.findFirst({ where: { organizationId, dedupeKey: input.dedupeKey }, select: FACT_SELECT });
      if (!raced) throw err;
      return { outcome: 'UNCHANGED', fact: raced as CrmContextFactRecord };
    }
  }

  /** Whether facts with these dedupe keys already exist (for a dry run). */
  async existingDedupeKeys(organizationId: string, keys: readonly string[]): Promise<Set<string>> {
    if (!organizationId?.trim() || keys.length === 0) return new Set();
    const out = new Set<string>();
    for (let i = 0; i < keys.length; i += 1000) {
      const rows = await this.prisma.crmSubjectContextFact.findMany({
        where: { organizationId, dedupeKey: { in: keys.slice(i, i + 1000) } },
        select: { dedupeKey: true },
      });
      for (const r of rows) out.add(r.dedupeKey);
    }
    return out;
  }

  /** One Party's facts, current and retracted, newest recorded first. */
  async factsForParty(organizationId: string, partyId: string): Promise<CrmContextFactRecord[]> {
    if (!organizationId?.trim() || !partyId?.trim()) return [];
    const rows = await this.prisma.crmSubjectContextFact.findMany({
      where: { organizationId, partyId },
      select: FACT_SELECT,
      orderBy: [{ recordedAt: 'desc' }, { id: 'asc' }],
    });
    return rows as CrmContextFactRecord[];
  }

  /** The organization's CURRENT (unretracted) facts of some kinds, for the directory. One query. */
  async currentFacts(organizationId: string, kinds: readonly CrmContextFactKind[], partyIds?: readonly string[]): Promise<CrmContextFactRecord[]> {
    if (!organizationId?.trim() || kinds.length === 0) return [];
    const rows = await this.prisma.crmSubjectContextFact.findMany({
      where: { organizationId, kind: { in: [...kinds] }, retractedAt: null, ...(partyIds ? { partyId: { in: [...partyIds] } } : {}) },
      select: FACT_SELECT,
      orderBy: [{ recordedAt: 'desc' }, { id: 'asc' }],
    });
    return rows as CrmContextFactRecord[];
  }

  async findFact(organizationId: string, id: string, db: Db = this.prisma): Promise<CrmContextFactRecord | null> {
    if (!organizationId?.trim() || !id?.trim()) return null;
    const row = await db.crmSubjectContextFact.findFirst({ where: { organizationId, id }, select: FACT_SELECT });
    return (row as CrmContextFactRecord | null) ?? null;
  }

  /** Mark a current fact retracted. Null when it is not in this organization or already retracted. */
  async retractFact(organizationId: string, id: string, actorUserId: string, at: Date, db: Db): Promise<CrmContextFactRecord | null> {
    if (!organizationId?.trim() || !id?.trim()) return null;
    const done = await db.crmSubjectContextFact.updateMany({
      where: { organizationId, id, retractedAt: null },
      data: { retractedAt: at, retractedByUserId: actorUserId },
    });
    if (done.count !== 1) return null;
    return this.findFact(organizationId, id, db);
  }

  /**
   * The login addresses of this organization's members: what "internal" means for discovery. Used
   * only to EXCLUDE addresses from a viewer's private queue; never shown, never stored elsewhere.
   */
  async memberAddresses(organizationId: string): Promise<string[]> {
    if (!organizationId?.trim()) return [];
    const rows = await this.prisma.organizationMembership.findMany({ where: { organizationId }, select: { user: { select: { email: true } } } });
    return rows.map((r) => r.user.email?.trim().toLowerCase()).filter((a): a is string => typeof a === 'string' && a.includes('@'));
  }

  /** Display names of this organization's members, by id (for "set by"). */
  async memberNames(organizationId: string, ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((i) => typeof i === 'string' && i.length > 0))];
    if (!organizationId?.trim() || unique.length === 0) return new Map();
    const rows = await this.prisma.user.findMany({ where: { organizationId, id: { in: unique } }, select: { id: true, name: true } });
    return new Map(rows.flatMap((r) => (r.name?.trim() ? [[r.id, r.name.trim()] as const] : [])));
  }

  // --- Human-set outreach state --------------------------------------------------------------

  async state(organizationId: string, partyId: string, db: Db = this.prisma): Promise<CrmOutreachStateRecord | null> {
    if (!organizationId?.trim() || !partyId?.trim()) return null;
    const row = await db.crmOutreachState.findFirst({ where: { organizationId, partyId }, select: STATE_SELECT });
    return (row as CrmOutreachStateRecord | null) ?? null;
  }

  /** Every Party's human-set state in the organization. One query. */
  async states(organizationId: string): Promise<CrmOutreachStateRecord[]> {
    if (!organizationId?.trim()) return [];
    const rows = await this.prisma.crmOutreachState.findMany({ where: { organizationId }, select: STATE_SELECT });
    return rows as CrmOutreachStateRecord[];
  }

  async events(organizationId: string, partyId: string): Promise<CrmOutreachEventRecord[]> {
    if (!organizationId?.trim() || !partyId?.trim()) return [];
    const rows = await this.prisma.crmOutreachEvent.findMany({
      where: { organizationId, partyId },
      orderBy: [{ sequence: 'asc' }],
      select: { id: true, partyId: true, sequence: true, type: true, state: true, nextAction: true, nextActionDueAt: true, actorUserId: true, occurredAt: true },
    });
    return rows as CrmOutreachEventRecord[];
  }

  /**
   * Append one event and project it, in the caller's transaction. The sequence is the projection's
   * `lastSequence + 1` under the (organization, party, sequence) unique key, so two concurrent acts
   * cannot both take the same position: the loser's transaction fails and is retried by the caller.
   */
  async appendEvent(
    organizationId: string,
    partyId: string,
    event: { readonly type: CrmOutreachEventRecord['type']; readonly state?: CrmHumanConversationState | null; readonly nextAction?: string | null; readonly nextActionDueAt?: Date | null; readonly actorUserId: string; readonly occurredAt: Date },
    tx: Prisma.TransactionClient,
  ): Promise<{ before: CrmOutreachStateRecord | null; after: CrmOutreachStateRecord; sequence: number }> {
    const before = await this.state(organizationId, partyId, tx);
    const sequence = (before?.lastSequence ?? 0) + 1;
    await tx.crmOutreachEvent.create({
      data: {
        organizationId,
        partyId,
        sequence,
        type: event.type,
        state: event.state ?? null,
        nextAction: event.nextAction ?? null,
        nextActionDueAt: event.nextActionDueAt ?? null,
        actorUserId: event.actorUserId,
        occurredAt: event.occurredAt,
      },
    });
    const projected: Omit<CrmOutreachStateRecord, 'partyId' | 'lastSequence'> = {
      state: before?.state ?? null,
      stateSetAt: before?.stateSetAt ?? null,
      stateSetByUserId: before?.stateSetByUserId ?? null,
      nextAction: before?.nextAction ?? null,
      nextActionDueAt: before?.nextActionDueAt ?? null,
      nextActionSetAt: before?.nextActionSetAt ?? null,
      nextActionSetByUserId: before?.nextActionSetByUserId ?? null,
      ...(event.type === 'STATE_SET' ? { state: event.state ?? null, stateSetAt: event.occurredAt, stateSetByUserId: event.actorUserId } : {}),
      ...(event.type === 'STATE_CLEARED' ? { state: null, stateSetAt: event.occurredAt, stateSetByUserId: event.actorUserId } : {}),
      ...(event.type === 'NEXT_ACTION_SET'
        ? { nextAction: event.nextAction ?? null, nextActionDueAt: event.nextActionDueAt ?? null, nextActionSetAt: event.occurredAt, nextActionSetByUserId: event.actorUserId }
        : {}),
      ...(event.type === 'NEXT_ACTION_CLEARED' ? { nextAction: null, nextActionDueAt: null, nextActionSetAt: event.occurredAt, nextActionSetByUserId: event.actorUserId } : {}),
    };
    const after = before
      ? await tx.crmOutreachState.update({ where: { organizationId_partyId: { organizationId, partyId } }, data: { ...projected, lastSequence: sequence }, select: STATE_SELECT })
      : await tx.crmOutreachState.create({ data: { organizationId, partyId, ...projected, lastSequence: sequence }, select: STATE_SELECT });
    return { before, after: after as CrmOutreachStateRecord, sequence };
  }
}
