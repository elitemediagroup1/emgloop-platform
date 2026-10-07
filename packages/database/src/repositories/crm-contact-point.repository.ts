// CRM Contact Points, persisted (PD-F-05, Product 2026-10-06; docs/architecture/crm-contact-points.md).
//
// Persistence only. The governed service (`crm-contact-point.service.ts`) adds authorization, the
// audit row and the outbox event in the same transaction. This file is therefore not a security
// boundary, and says so.
//
// EVERY PARTY GOES THROUGH THE PARTY REFERENCE CONTRACT, HERE. A Contact Point attaches only to an
// established, non-superseded, non-archived Party of this organization. A superseded id is refused
// with its canonical id, never swapped. The Party authority -- not the caller -- supplies the
// Party type the classification is checked against.
//
// THE VALUE IS NEVER SELECTED BY DEFAULT. Every read here uses `SUMMARY_SELECT`, which omits it. The
// one exception is `revealValues`, which the service calls only after the VIEW_VALUE grant. A
// source fence (test) holds that line.
//
// NOT IDENTITY. Nothing here writes identity_evidence, an attribution, a tier or a Party, and the
// value is hashed under a Contact Point namespace so it never compares with an evidence hash.
//
// HISTORY IS APPEND-ONLY. Every write appends an event in the same transaction; the row's state is
// the projection of that log, guarded by `lastSequence` so two concurrent acts cannot both apply.

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  CRM_CONTACT_POINT_DEFAULT_RETENTION_POLICY,
  CRM_CONTACT_POINT_REASON_REQUIRED,
  crmContactPointCurrentKey,
  crmContactPointHashNamespace,
  crmContactPointIsCurrent,
  crmContactPointReasonCarriesContactValue,
  crmContactPointTransition,
  normalizeCrmContactPointValue,
  partyReferenceForWrite,
  validateCrmContactPointAdd,
  type CrmContactPointBasis,
  type CrmContactPointClassification,
  type CrmContactPointKind,
  type CrmContactPointState,
  type PartyType,
  type PartyWriteRefusal,
} from '@emgloop/shared';

import { hashIdentifier, identifierKeyFingerprint } from './cognitive/hashing';
import { PartyReferenceRepository } from './party-reference.repository';

/** The time bases an event may claim (Loop Time Authority), as the Relationship log uses. */
export const CRM_CONTACT_POINT_TIME_BASES = ['PROVIDER_REPORTED', 'LOOP_CLOCK', 'OPERATOR_STATED', 'REPORTING_WINDOW', 'UNKNOWN'] as const;
export type CrmContactPointTimeBasis = (typeof CRM_CONTACT_POINT_TIME_BASES)[number];

/** Everything a reader may see without the VIEW_VALUE grant. No value; no hash. */
const SUMMARY_SELECT = {
  id: true,
  organizationId: true,
  partyId: true,
  partyType: true,
  kind: true,
  classification: true,
  purpose: true,
  state: true,
  lastSequence: true,
  basis: true,
  sourceRef: true,
  retentionPolicy: true,
  lastHumanContactAt: true,
  valueErasedAt: true,
  addedByUserId: true,
  addedAt: true,
  undeliverableAt: true,
  retiredAt: true,
  voidedAt: true,
} as const satisfies Prisma.CrmContactPointSelect;

export type CrmContactPointSummary = Prisma.CrmContactPointGetPayload<{ select: typeof SUMMARY_SELECT }>;

export interface CrmContactPointAddInput {
  readonly partyId: string;
  readonly kind: string;
  readonly classification: string;
  readonly value: string;
  readonly basis: string;
  readonly sourceRef?: string | null;
  readonly purpose?: string;
  /** A real, recorded human contact time when the source has one. Never defaulted. */
  readonly lastHumanContactAt?: Date | null;
  readonly actorUserId: string;
  readonly occurredAt: Date;
  readonly occurredAtBasis?: CrmContactPointTimeBasis;
}

export interface CrmContactPointTransitionInput {
  readonly to: CrmContactPointState;
  readonly actorUserId: string;
  readonly occurredAt: Date;
  readonly occurredAtBasis?: CrmContactPointTimeBasis;
  readonly reason: string;
}

export type CrmContactPointWriteResult<T> =
  | { readonly outcome: 'RECORDED'; readonly value: T }
  | { readonly outcome: 'INVALID'; readonly violations: readonly string[] }
  | { readonly outcome: 'PARTY_REFUSED'; readonly refusal: PartyWriteRefusal; readonly canonicalPartyId?: string }
  | { readonly outcome: 'DUPLICATE' }
  | { readonly outcome: 'NOT_FOUND' }
  | { readonly outcome: 'ILLEGAL_TRANSITION'; readonly from: CrmContactPointState }
  | { readonly outcome: 'REASON_REQUIRED' }
  | { readonly outcome: 'REASON_CARRIES_CONTACT_VALUE' }
  | { readonly outcome: 'RETRY' };

export interface CrmContactPointRepositoryDeps {
  references?: Pick<PartyReferenceRepository, 'requireReferenceable'>;
}

export type CrmContactPointTx = Prisma.TransactionClient;

const STATE_STAMP: Readonly<Record<string, 'undeliverableAt' | 'retiredAt' | 'voidedAt'>> = Object.freeze({
  UNDELIVERABLE: 'undeliverableAt',
  RETIRED: 'retiredAt',
  VOIDED: 'voidedAt',
});

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

/** The keyed, organization-salted hash of an already-normalized value, under the Contact Point namespace. */
export function crmContactPointValueHash(organizationId: string, kind: CrmContactPointKind, normalized: string): string {
  return hashIdentifier(organizationId, crmContactPointHashNamespace(kind), normalized);
}

export class CrmContactPointRepository {
  private readonly references: Pick<PartyReferenceRepository, 'requireReferenceable'>;

  constructor(
    private readonly prisma: PrismaClient,
    deps: CrmContactPointRepositoryDeps = {},
  ) {
    this.references = deps.references ?? new PartyReferenceRepository(prisma);
  }

  // --- Reads (never the value) ---------------------------------------------------------

  async findById(organizationId: string, id: string, db: CrmContactPointTx | PrismaClient = this.prisma): Promise<CrmContactPointSummary | null> {
    if (!organizationId?.trim() || !id?.trim()) return null;
    return db.crmContactPoint.findFirst({ where: { id, organizationId }, select: SUMMARY_SELECT });
  }

  /** A Party's Contact Points, current first, then history, newest first within each. */
  async listForParty(organizationId: string, partyId: string): Promise<CrmContactPointSummary[]> {
    if (!organizationId?.trim() || !partyId?.trim()) return [];
    const rows = await this.prisma.crmContactPoint.findMany({
      where: { organizationId, partyId },
      select: SUMMARY_SELECT,
      orderBy: [{ addedAt: 'desc' }, { id: 'asc' }],
    });
    return [...rows.filter((r) => crmContactPointIsCurrent(r.state)), ...rows.filter((r) => !crmContactPointIsCurrent(r.state))];
  }

  /** Every current (ACTIVE or UNDELIVERABLE) holder of a hash in this organization and kind. */
  async currentHolders(organizationId: string, kind: CrmContactPointKind, valueHash: string): Promise<{ partyId: string; state: string }[]> {
    if (!organizationId?.trim()) return [];
    return this.prisma.crmContactPoint.findMany({
      where: { organizationId, kind, valueHash, state: { in: ['ACTIVE', 'UNDELIVERABLE'] } },
      select: { partyId: true, state: true },
    });
  }

  /**
   * THE ONLY READ OF A RAW VALUE. The governed service calls it after the VIEW_VALUE grant, for
   * ids it already read in this organization. An erased value comes back null.
   */
  async revealValues(organizationId: string, ids: readonly string[]): Promise<Map<string, string | null>> {
    if (!organizationId?.trim() || ids.length === 0) return new Map();
    const rows = await this.prisma.crmContactPoint.findMany({
      where: { organizationId, id: { in: [...ids] } },
      select: { id: true, value: true },
    });
    return new Map(rows.map((r) => [r.id, r.value]));
  }

  // --- Writes ----------------------------------------------------------------------------

  /** Record a Contact Point for an established Party, with its first event, in the caller's transaction. */
  async add(organizationId: string, input: CrmContactPointAddInput, tx: CrmContactPointTx): Promise<CrmContactPointWriteResult<CrmContactPointSummary>> {
    if (!organizationId?.trim()) return { outcome: 'NOT_FOUND' };
    // Checked on the caller's transaction, so a Party created earlier in the same unit is seen.
    const required = await this.references.requireReferenceable(organizationId, input.partyId, tx);
    if (!required.ok) {
      const refusal = partyReferenceForWrite(required.resolution);
      return refusal.ok
        ? { outcome: 'PARTY_REFUSED', refusal: 'NOT_FOUND' }
        : { outcome: 'PARTY_REFUSED', refusal: refusal.refusal, ...(refusal.canonicalPartyId ? { canonicalPartyId: refusal.canonicalPartyId } : {}) };
    }
    const partyType: PartyType = required.partyType;
    const sourceRef = input.sourceRef ?? null;
    const purpose = input.purpose ?? 'BUSINESS_CONTACT';
    const violations: string[] = [
      ...validateCrmContactPointAdd({ kind: input.kind, classification: input.classification, partyType, purpose, basis: input.basis, sourceRef }),
    ];
    const normalized = normalizeCrmContactPointValue(input.kind, input.value);
    if (!normalized.ok) violations.push(normalized.reason);
    const basisOk = (CRM_CONTACT_POINT_TIME_BASES as readonly string[]).includes(input.occurredAtBasis ?? 'LOOP_CLOCK');
    if (!basisOk) violations.push('UNKNOWN_TIME_BASIS');
    if (input.lastHumanContactAt && input.lastHumanContactAt.getTime() > input.occurredAt.getTime()) violations.push('HUMAN_CONTACT_AFTER_ACT');
    if (violations.length > 0 || !normalized.ok) return { outcome: 'INVALID', violations: [...new Set(violations)] };

    const kind = input.kind as CrmContactPointKind;
    const valueHash = crmContactPointValueHash(organizationId, kind, normalized.value);
    const currentKey = crmContactPointCurrentKey(required.reference.partyId, kind, valueHash);
    // Already current on this Party: answered by a read, not by a failed insert. A failed statement
    // aborts the whole Postgres transaction, which would poison a caller's unit (the importer). The
    // unique key below still settles a concurrent race; then the caller's unit rolls back whole.
    if (await tx.crmContactPoint.findFirst({ where: { organizationId, currentKey }, select: { id: true } })) return { outcome: 'DUPLICATE' };
    try {
      const row = await tx.crmContactPoint.create({
        data: {
          organizationId,
          partyId: required.reference.partyId,
          partyType,
          kind,
          classification: input.classification as CrmContactPointClassification,
          purpose,
          value: normalized.value,
          valueHash,
          hashKeyFingerprint: identifierKeyFingerprint(),
          state: 'ACTIVE',
          lastSequence: 1,
          currentKey,
          basis: input.basis as CrmContactPointBasis,
          sourceRef,
          retentionPolicy: CRM_CONTACT_POINT_DEFAULT_RETENTION_POLICY,
          lastHumanContactAt: input.lastHumanContactAt ?? null,
          addedByUserId: input.actorUserId,
          addedAt: input.occurredAt,
        },
        select: SUMMARY_SELECT,
      });
      await tx.crmContactPointEvent.create({
        data: {
          organizationId,
          contactPointId: row.id,
          sequence: 1,
          type: 'CONTACT_POINT_ADDED',
          occurredAt: input.occurredAt,
          occurredAtBasis: input.occurredAtBasis ?? 'LOOP_CLOCK',
          actorType: 'HUMAN',
          actorUserId: input.actorUserId,
          reason: null,
          fromState: null,
          toState: 'ACTIVE',
        },
      });
      return { outcome: 'RECORDED', value: row };
    } catch (err) {
      if (isUniqueViolation(err)) return { outcome: 'DUPLICATE' };
      throw err;
    }
  }

  /** Mark undeliverable, retire or void, appending the event, in the caller's transaction. */
  async transition(
    organizationId: string,
    id: string,
    input: CrmContactPointTransitionInput,
    tx: CrmContactPointTx,
  ): Promise<CrmContactPointWriteResult<{ before: CrmContactPointSummary; after: CrmContactPointSummary }>> {
    const before = await this.findById(organizationId, id, tx);
    if (!before) return { outcome: 'NOT_FOUND' };
    const from = before.state as CrmContactPointState;
    const type = crmContactPointTransition(from, input.to);
    if (!type) return { outcome: 'ILLEGAL_TRANSITION', from };
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if ((CRM_CONTACT_POINT_REASON_REQUIRED as readonly string[]).includes(type) && reason === '') return { outcome: 'REASON_REQUIRED' };
    if (crmContactPointReasonCarriesContactValue(reason)) return { outcome: 'REASON_CARRIES_CONTACT_VALUE' };
    if (!(CRM_CONTACT_POINT_TIME_BASES as readonly string[]).includes(input.occurredAtBasis ?? 'LOOP_CLOCK')) {
      return { outcome: 'INVALID', violations: ['UNKNOWN_TIME_BASIS'] };
    }

    const sequence = before.lastSequence + 1;
    const stamp = STATE_STAMP[input.to];
    // Guarded on the sequence read above: a concurrent act moves it, this matches nothing, RETRY.
    const updated = await tx.crmContactPoint.updateMany({
      where: { id: before.id, organizationId, lastSequence: before.lastSequence, state: before.state },
      data: {
        state: input.to,
        lastSequence: sequence,
        ...(crmContactPointIsCurrent(input.to) ? {} : { currentKey: null }),
        ...(stamp ? { [stamp]: input.occurredAt } : {}),
      },
    });
    if (updated.count !== 1) return { outcome: 'RETRY' };
    try {
      await tx.crmContactPointEvent.create({
        data: {
          organizationId,
          contactPointId: before.id,
          sequence,
          type,
          occurredAt: input.occurredAt,
          occurredAtBasis: input.occurredAtBasis ?? 'LOOP_CLOCK',
          actorType: 'HUMAN',
          actorUserId: input.actorUserId,
          reason,
          fromState: from,
          toState: input.to,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) return { outcome: 'RETRY' };
      throw err;
    }
    const after = await this.findById(organizationId, before.id, tx);
    if (!after) return { outcome: 'NOT_FOUND' };
    return { outcome: 'RECORDED', value: { before, after } };
  }
}
