// The governed CRM Contact Point authority (PD-F-05, Product 2026-10-06).
//
// The decision record is docs/architecture/crm-contact-points.md; the grants are
// `CRM_CONTACT_POINT_ACT_ROLES` in `@emgloop/shared`, bound here rather than restated.
//
// THREE WRITES OR NONE. Every act puts the Contact Point change (row and event), its AuditLog row
// and its StateChangeOutbox row in ONE transaction. A refused act -- a duplicate, a refused Party,
// an illegal transition -- leaves nothing behind, and no audit row describes a write that did not
// happen.
//
// THE VALUE NEVER LEAVES THE RECORD. Audit metadata and outbox payloads carry ids, kind,
// classification, basis and states. They never carry the value or its hash. A reason is kept on the
// event, and only THAT a reason was given reaches the audit row. A reason that carries a contact
// value is refused by the repository.
//
// VALUES ARE REVEALED, NOT SELECTED. `listForParty` reads summaries, and asks for values only when
// the viewer holds VIEW_VALUE. READ_ONLY sees kind, classification and state; AI_EMPLOYEE sees
// nothing.
//
// MATCHING IS EXACT AND RETURNS A PARTY ID. `match` compares keyed hashes inside one organization.
// It answers with an outcome and, for MATCH only, a Party id. It never returns a value, never reads
// a name, and never creates anything.

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  CRM_CONTACT_POINT_CONTRACT_VERSION,
  crmContactPointActPermitted,
  crmContactPointRetainUntil,
  decideCrmContactPointMatch,
  normalizeCrmContactPointValue,
  type CrmContactPointAct,
  type CrmContactPointBasis,
  type CrmContactPointClassification,
  type CrmContactPointKind,
  type CrmContactPointMatch,
  type CrmContactPointPurpose,
  type CrmContactPointState,
  type CrmContactPointViewV1,
  type PartyType,
} from '@emgloop/shared';

import { AuditRepository } from '../repositories/audit.repository';
import { IamRepository } from '../repositories/iam.repository';
import { membershipAuthority } from '../repositories/membership.repository';
import { PartyReferenceRepository } from '../repositories/party-reference.repository';
import {
  CrmContactPointRepository,
  crmContactPointValueHash,
  type CrmContactPointAddInput,
  type CrmContactPointSummary,
  type CrmContactPointTimeBasis,
  type CrmContactPointWriteResult,
} from '../repositories/crm-contact-point.repository';

/** Who is acting, from the signed session (or the operator a workflow names) and nowhere else. */
export interface CrmContactPointActor {
  readonly organizationId: string;
  readonly userId: string;
  /** The display name for the audit trail. Never an email. */
  readonly actorName?: string | null;
}

export type CrmContactPointServiceResult<T> = CrmContactPointWriteResult<T> | { readonly outcome: 'NOT_AUTHORIZED' };

export type CrmContactPointMatchResult =
  | CrmContactPointMatch
  | { readonly outcome: 'INVALID'; readonly reason: string }
  | { readonly outcome: 'NOT_AUTHORIZED' };

export interface CrmContactPointServiceDeps {
  contactPoints?: CrmContactPointRepository;
  references?: Pick<PartyReferenceRepository, 'resolve' | 'requireReferenceable'>;
  audit?: Pick<AuditRepository, 'record'>;
  iam?: Pick<IamRepository, 'canEach'>;
}

const AUDIT_ACTION: Readonly<Record<string, string>> = Object.freeze({
  ADD: 'contact_point.added',
  MARK_UNDELIVERABLE: 'contact_point.marked_undeliverable',
  RETIRE: 'contact_point.retired',
  VOID: 'contact_point.voided',
});

const OUTBOX_EVENT: Readonly<Record<string, string>> = Object.freeze({
  ADD: 'ContactPointAdded',
  MARK_UNDELIVERABLE: 'ContactPointMarkedUndeliverable',
  RETIRE: 'ContactPointRetired',
  VOID: 'ContactPointVoided',
});

export class CrmContactPointService {
  private readonly contactPoints: CrmContactPointRepository;
  private readonly references: Pick<PartyReferenceRepository, 'resolve' | 'requireReferenceable'>;
  private readonly audit: Pick<AuditRepository, 'record'>;
  private readonly iam: Pick<IamRepository, 'canEach'>;

  constructor(
    private readonly prisma: PrismaClient,
    deps: CrmContactPointServiceDeps = {},
  ) {
    this.references = deps.references ?? new PartyReferenceRepository(prisma);
    this.contactPoints = deps.contactPoints ?? new CrmContactPointRepository(prisma, { references: this.references });
    this.audit = deps.audit ?? new AuditRepository(prisma);
    this.iam = deps.iam ?? new IamRepository(prisma);
  }

  // --- Reads -----------------------------------------------------------------------------

  /**
   * A Party's Contact Points as this viewer may see them. Without VIEW_SUMMARY: refused. With it
   * but without VIEW_VALUE (READ_ONLY): every value withheld. Values are read only for viewers
   * who hold VIEW_VALUE.
   */
  async listForParty(actor: CrmContactPointActor, partyId: string): Promise<{ outcome: 'OK'; value: CrmContactPointViewV1[] } | { outcome: 'NOT_AUTHORIZED' }> {
    const role = await this.role(actor);
    if (!role || !crmContactPointActPermitted({ act: 'VIEW_SUMMARY', role, actorType: 'HUMAN' })) return { outcome: 'NOT_AUTHORIZED' };
    const rows = await this.contactPoints.listForParty(actor.organizationId, partyId);
    const mayReveal = crmContactPointActPermitted({ act: 'VIEW_VALUE', role, actorType: 'HUMAN' });
    const values = mayReveal ? await this.contactPoints.revealValues(actor.organizationId, rows.map((r) => r.id)) : new Map<string, string | null>();
    return { outcome: 'OK', value: rows.map((row) => view(row, mayReveal, values.get(row.id) ?? null)) };
  }

  /**
   * Whether a value may reuse an existing Party (`crm-contact-points.md` §7). Exact keyed-hash
   * equality in this organization only; anything other than one ACTIVE, non-conflicting point on
   * one established, current Party of the required type is a review outcome.
   */
  async match(
    actor: CrmContactPointActor,
    input: { readonly kind: CrmContactPointKind; readonly value: string; readonly partyType: PartyType },
  ): Promise<CrmContactPointMatchResult> {
    if (!(await this.may(actor, 'MATCH'))) return { outcome: 'NOT_AUTHORIZED' };
    const normalized = normalizeCrmContactPointValue(input.kind, input.value);
    if (!normalized.ok) return { outcome: 'INVALID', reason: normalized.reason };
    const hash = crmContactPointValueHash(actor.organizationId, input.kind, normalized.value);
    const holders = await this.contactPoints.currentHolders(actor.organizationId, input.kind, hash);
    const distinct = [...new Set(holders.map((h) => h.partyId))];
    const resolution = distinct.length === 1 ? await this.references.resolve(actor.organizationId, distinct[0]!) : null;
    return decideCrmContactPointMatch(holders, resolution, input.partyType);
  }

  // --- Acts ------------------------------------------------------------------------------

  async add(
    actor: CrmContactPointActor,
    input: Omit<CrmContactPointAddInput, 'actorUserId' | 'occurredAt'> & { readonly occurredAt?: Date },
  ): Promise<CrmContactPointServiceResult<CrmContactPointSummary>> {
    if (!(await this.may(actor, 'ADD'))) return { outcome: 'NOT_AUTHORIZED' };
    const actorName = await this.actorName(actor);
    return this.prisma.$transaction(async (tx) => {
      const result = await this.contactPoints.add(
        actor.organizationId,
        { ...input, actorUserId: actor.userId, occurredAt: input.occurredAt ?? new Date() },
        tx,
      );
      if (result.outcome !== 'RECORDED') return result;
      await this.record(tx, actor, actorName, 'ADD', result.value, null, false);
      return result;
    });
  }

  /** A bounce or "address not found". A deliverability fact, never verification. MANAGER and above. */
  markUndeliverable(actor: CrmContactPointActor, id: string, input: { readonly reason: string; readonly occurredAt?: Date; readonly occurredAtBasis?: CrmContactPointTimeBasis }) {
    return this.transition(actor, 'MARK_UNDELIVERABLE', id, 'UNDELIVERABLE', input);
  }

  /** It was true and has stopped (the person left). MANAGER and above. */
  retire(actor: CrmContactPointActor, id: string, input: { readonly reason: string; readonly occurredAt?: Date; readonly occurredAtBasis?: CrmContactPointTimeBasis }) {
    return this.transition(actor, 'RETIRE', id, 'RETIRED', input);
  }

  /** It was never true (entered in error). OWNER / ADMIN. */
  void(actor: CrmContactPointActor, id: string, input: { readonly reason: string; readonly occurredAt?: Date; readonly occurredAtBasis?: CrmContactPointTimeBasis }) {
    return this.transition(actor, 'VOID', id, 'VOIDED', input);
  }

  // --- Internals -------------------------------------------------------------------------

  private async transition(
    actor: CrmContactPointActor,
    act: CrmContactPointAct,
    id: string,
    to: CrmContactPointState,
    input: { readonly reason: string; readonly occurredAt?: Date; readonly occurredAtBasis?: CrmContactPointTimeBasis },
  ): Promise<CrmContactPointServiceResult<CrmContactPointSummary>> {
    if (!(await this.may(actor, act))) return { outcome: 'NOT_AUTHORIZED' };
    const actorName = await this.actorName(actor);
    return this.prisma.$transaction(async (tx) => {
      const result = await this.contactPoints.transition(
        actor.organizationId,
        id,
        { to, actorUserId: actor.userId, occurredAt: input.occurredAt ?? new Date(), occurredAtBasis: input.occurredAtBasis, reason: input.reason },
        tx,
      );
      if (result.outcome !== 'RECORDED') return result;
      await this.record(tx, actor, actorName, act, result.value.after, result.value.before.state, true);
      return { outcome: 'RECORDED' as const, value: result.value.after };
    });
  }

  /**
   * The audit row and the outbox event for a recorded act. Ids, kinds and states only.
   *
   * EVERYTHING INSIDE THE TRANSACTION GOES THROUGH `tx`. The actor's name is resolved before the
   * transaction opens: a lookup on the outer client from inside it needs a second pooled
   * connection, and under concurrency every connection is held by an open transaction waiting on
   * one -- the pool starves and the transactions time out (found by the race test).
   */
  private async record(
    tx: Prisma.TransactionClient,
    actor: CrmContactPointActor,
    actorName: string | undefined,
    act: CrmContactPointAct,
    point: CrmContactPointSummary,
    fromState: string | null,
    reasonGiven: boolean,
  ): Promise<void> {
    const safe = {
      contactPointId: point.id,
      partyId: point.partyId,
      partyType: point.partyType,
      kind: point.kind,
      classification: point.classification,
      fromState,
      toState: point.state,
      sequence: point.lastSequence,
    };
    await this.audit.record(
      {
        organizationId: actor.organizationId,
        userId: actor.userId,
        actorName,
        action: AUDIT_ACTION[act] ?? `contact_point.${act.toLowerCase()}`,
        entityType: 'crm_contact_point',
        entityId: point.id,
        // THAT a reason was given, never the words: they stay on the event.
        metadata: { ...safe, basis: point.basis, reasonRecorded: reasonGiven },
      },
      tx,
    );
    await tx.stateChangeOutbox.create({
      data: {
        organizationId: actor.organizationId,
        subjectType: 'CONTACT_POINT',
        subjectId: point.id,
        eventType: OUTBOX_EVENT[act] ?? 'ContactPointChanged',
        // A Contact Point is not an identity; filling this would put a non-entity into the graph.
        identityId: null,
        domain: 'COMMUNICATION',
        stateKey: `contact_point.${point.id}`,
        changeType: fromState === null ? 'CREATED' : 'UPDATED',
        payload: safe as Prisma.InputJsonValue,
        status: 'PENDING',
      },
    });
  }

  /** The actor's role when membership is ACTIVE and the coarse Party-record gate holds; else null. */
  private async role(actor: CrmContactPointActor): Promise<string | null> {
    if (!actor.organizationId?.trim() || !actor.userId?.trim()) return null;
    const authority = await membershipAuthority(this.prisma, actor.organizationId, actor.userId);
    if (!authority.granted) return null;
    const [canView] = await this.iam.canEach(actor.organizationId, actor.userId, [{ resource: 'identityResolution', action: 'view' }]);
    if (canView !== true) return null;
    return authority.systemRole;
  }

  /**
   * THREE INDEPENDENT REFUSALS: no ACTIVE membership, no `identityResolution:view` (the gate Party
   * records use), and the approved act table -- which denies AI_EMPLOYEE before it is consulted.
   * No Permission row is consulted for an act, so none can widen one.
   */
  private async may(actor: CrmContactPointActor, act: CrmContactPointAct): Promise<boolean> {
    const role = await this.role(actor);
    return role !== null && crmContactPointActPermitted({ act, role, actorType: 'HUMAN' });
  }

  private async actorName(actor: CrmContactPointActor): Promise<string | undefined> {
    const given = typeof actor.actorName === 'string' ? actor.actorName.trim() : '';
    if (given) return given;
    const member = await this.prisma.user.findFirst({ where: { id: actor.userId, organizationId: actor.organizationId }, select: { name: true } });
    return member?.name ?? undefined;
  }
}

function view(row: CrmContactPointSummary, mayReveal: boolean, value: string | null): CrmContactPointViewV1 {
  const erased = row.valueErasedAt !== null;
  const retainUntil = crmContactPointRetainUntil({ retentionPolicy: row.retentionPolicy, lastHumanContactAt: row.lastHumanContactAt, addedAt: row.addedAt });
  return {
    contractVersion: CRM_CONTACT_POINT_CONTRACT_VERSION,
    id: row.id,
    kind: row.kind as CrmContactPointKind,
    classification: row.classification as CrmContactPointClassification,
    purpose: row.purpose as CrmContactPointPurpose,
    basis: row.basis as CrmContactPointBasis,
    state: row.state as CrmContactPointState,
    verification: 'UNVERIFIED',
    value: mayReveal && !erased ? value : null,
    valueWithheld: !mayReveal ? 'NOT_PERMITTED' : erased ? 'ERASED' : null,
    addedAt: row.addedAt.toISOString(),
    addedByUserId: row.addedByUserId,
    retainUntil: retainUntil ? retainUntil.toISOString() : null,
  };
}
