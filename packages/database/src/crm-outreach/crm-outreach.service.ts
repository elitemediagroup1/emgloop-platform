// The governed CRM outreach authority (CRM slice 6): human interpretation and recorded context.
//
// Decision record: docs/architecture/crm-people-command-center.md. Grants: `CRM_OUTREACH_ACT_ROLES`.
//
// THREE WRITES OR NONE. Every act puts its change (event + projection, or fact), its AuditLog row
// and its StateChangeOutbox row in ONE transaction; a refused act leaves nothing behind.
//
// NO TEXT LEAVES THE RECORD. Audit metadata and outbox payloads carry ids, kinds, states and
// booleans ("a next action was set", "a due date was set") -- never a next action's words, a
// note's text, a title, or anything typed. Typed text carrying a contact value is refused outright.
//
// THE PARTY IS RESOLVED FIRST. Every act resolves its Party through the Party Reference contract
// in this organization (established, current, not archived, a PERSON or COMPANY as the act needs);
// anything else is NOT_FOUND -- another tenant's Party is indistinguishable from none.

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  CRM_NEXT_ACTION_MAX,
  CRM_NOTE_MAX,
  CRM_TITLE_MAX,
  isCrmHumanConversationState,
  validateCrmOutreachText,
  type CrmContextFactKind,
  type CrmHumanConversationState,
  type CrmOutreachAct,
  type CrmOutreachTextViolation,
} from '@emgloop/shared';
import { randomUUID } from 'node:crypto';

import { AuditRepository } from '../repositories/audit.repository';
import { IamRepository } from '../repositories/iam.repository';
import { PartyReferenceRepository } from '../repositories/party-reference.repository';
import { crmOutreachPermits, crmOutreachRole, type CrmOutreachActor } from './crm-outreach-access';
import { CrmOutreachRepository, type CrmContextFactRecord, type CrmOutreachStateRecord } from './crm-outreach.repository';

export type CrmOutreachActResult<T> =
  | { readonly outcome: 'RECORDED'; readonly value: T }
  | { readonly outcome: 'NOT_AUTHORIZED' | 'NOT_FOUND' | 'UNCHANGED' }
  | { readonly outcome: 'INVALID'; readonly violation: CrmOutreachTextViolation | 'NOT_A_HUMAN_STATE' | 'DUE_DATE_INVALID' };

export interface CrmOutreachServiceDeps {
  repository?: CrmOutreachRepository;
  references?: Pick<PartyReferenceRepository, 'requireReferenceable'>;
  audit?: Pick<AuditRepository, 'record'>;
  iam?: Pick<IamRepository, 'canEach'>;
  clock?: () => Date;
}

/** Far enough to be a mistake, near enough for any real plan. */
const DUE_DATE_MIN = Date.UTC(2000, 0, 1);
const DUE_DATE_MAX = Date.UTC(2100, 0, 1);

export class CrmOutreachService {
  private readonly repository: CrmOutreachRepository;
  private readonly references: Pick<PartyReferenceRepository, 'requireReferenceable'>;
  private readonly audit: Pick<AuditRepository, 'record'>;
  private readonly iam: Pick<IamRepository, 'canEach'>;
  private readonly clock: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    deps: CrmOutreachServiceDeps = {},
  ) {
    this.repository = deps.repository ?? new CrmOutreachRepository(prisma);
    this.references = deps.references ?? new PartyReferenceRepository(prisma);
    this.audit = deps.audit ?? new AuditRepository(prisma);
    this.iam = deps.iam ?? new IamRepository(prisma);
    this.clock = deps.clock ?? (() => new Date());
  }

  /** The viewer's role when they may VIEW the outreach authority; else null. */
  async viewerRole(actor: CrmOutreachActor): Promise<string | null> {
    const role = await crmOutreachRole(this.prisma, this.iam, actor);
    return role !== null && (await this.may(actor, 'VIEW')) ? role : null;
  }

  async may(actor: CrmOutreachActor, act: CrmOutreachAct): Promise<boolean> {
    return crmOutreachPermits(this.prisma, this.iam, actor, act);
  }

  // --- Human interpretation ------------------------------------------------------------------

  /** Set a person's conversation state, or clear it (null) so the derived state shows again. */
  async setState(actor: CrmOutreachActor, partyId: string, state: CrmHumanConversationState | null): Promise<CrmOutreachActResult<CrmOutreachStateRecord>> {
    if (state !== null && !isCrmHumanConversationState(state)) return { outcome: 'INVALID', violation: 'NOT_A_HUMAN_STATE' };
    if (!(await this.may(actor, 'SET_STATE'))) return { outcome: 'NOT_AUTHORIZED' };
    return this.prisma.$transaction(async (tx) => {
      const party = await this.party(actor.organizationId, partyId, tx);
      if (!party) return { outcome: 'NOT_FOUND' as const };
      const current = await this.repository.state(actor.organizationId, party.partyId, tx);
      if ((current?.state ?? null) === state) return { outcome: 'UNCHANGED' as const };
      const at = this.clock();
      const r = await this.repository.appendEvent(actor.organizationId, party.partyId, { type: state ? 'STATE_SET' : 'STATE_CLEARED', state, actorUserId: actor.userId, occurredAt: at }, tx);
      await this.record(tx, actor, 'crm_outreach.state_set', party.partyId, party.partyType, 'OutreachStateChanged', {
        sequence: r.sequence,
        fromState: r.before?.state ?? null,
        toState: r.after.state,
      });
      return { outcome: 'RECORDED' as const, value: r.after };
    });
  }

  /** Set a person's next action (and, optionally, its due date), or clear it (null). */
  async setNextAction(actor: CrmOutreachActor, partyId: string, next: { readonly text: string; readonly dueAt: Date | null } | null): Promise<CrmOutreachActResult<CrmOutreachStateRecord>> {
    let text: string | null = null;
    if (next) {
      const v = validateCrmOutreachText(next.text, CRM_NEXT_ACTION_MAX);
      if (!v.ok) return { outcome: 'INVALID', violation: v.violation };
      text = v.value;
      if (next.dueAt && (Number.isNaN(next.dueAt.getTime()) || next.dueAt.getTime() < DUE_DATE_MIN || next.dueAt.getTime() > DUE_DATE_MAX)) {
        return { outcome: 'INVALID', violation: 'DUE_DATE_INVALID' };
      }
    }
    if (!(await this.may(actor, 'SET_NEXT_ACTION'))) return { outcome: 'NOT_AUTHORIZED' };
    return this.prisma.$transaction(async (tx) => {
      const party = await this.party(actor.organizationId, partyId, tx);
      if (!party) return { outcome: 'NOT_FOUND' as const };
      const current = await this.repository.state(actor.organizationId, party.partyId, tx);
      const dueAt = next?.dueAt ?? null;
      if ((current?.nextAction ?? null) === text && (current?.nextActionDueAt?.getTime() ?? null) === (dueAt?.getTime() ?? null)) return { outcome: 'UNCHANGED' as const };
      if (!next && !current?.nextAction) return { outcome: 'UNCHANGED' as const };
      const at = this.clock();
      const r = await this.repository.appendEvent(
        actor.organizationId,
        party.partyId,
        next ? { type: 'NEXT_ACTION_SET', nextAction: text, nextActionDueAt: dueAt, actorUserId: actor.userId, occurredAt: at } : { type: 'NEXT_ACTION_CLEARED', actorUserId: actor.userId, occurredAt: at },
        tx,
      );
      await this.record(tx, actor, 'crm_outreach.next_action_set', party.partyId, party.partyType, 'OutreachNextActionChanged', {
        sequence: r.sequence,
        // THAT a next action and a due date are set, never the words.
        nextActionSet: text !== null,
        dueDateSet: dueAt !== null,
      });
      return { outcome: 'RECORDED' as const, value: r.after };
    });
  }

  // --- Recorded context ------------------------------------------------------------------------

  /** Record an operator's note on a Party. Refused when it carries a contact value. */
  async recordNote(actor: CrmOutreachActor, partyId: string, text: string): Promise<CrmOutreachActResult<CrmContextFactRecord>> {
    return this.recordOperatorFact(actor, partyId, 'NOTE', text, CRM_NOTE_MAX);
  }

  /** Record a person's title as an operator states it. */
  async recordTitle(actor: CrmOutreachActor, partyId: string, text: string): Promise<CrmOutreachActResult<CrmContextFactRecord>> {
    return this.recordOperatorFact(actor, partyId, 'TITLE', text, CRM_TITLE_MAX, 'PERSON');
  }

  /** Retract a recorded fact. It stays in the history, marked retracted. OWNER / ADMIN. */
  async retractFact(actor: CrmOutreachActor, factId: string): Promise<CrmOutreachActResult<CrmContextFactRecord>> {
    if (!(await this.may(actor, 'RETRACT_FACT'))) return { outcome: 'NOT_AUTHORIZED' };
    return this.prisma.$transaction(async (tx) => {
      const fact = await this.repository.retractFact(actor.organizationId, factId, actor.userId, this.clock(), tx);
      if (!fact) return { outcome: 'NOT_FOUND' as const };
      await this.record(tx, actor, 'crm_context.fact_retracted', fact.partyId, fact.partyType, 'ContextFactRetracted', { factId: fact.id, kind: fact.kind, basis: fact.basis });
      return { outcome: 'RECORDED' as const, value: fact };
    });
  }

  /**
   * Record an ORIGIN fact on a Party a person just created (e.g. from Gmail discovery), in the
   * caller's transaction. Not an act of its own: the caller already holds the authority that created
   * the Party, and this only says how it came to be.
   */
  async recordOriginIn(tx: Prisma.TransactionClient, actor: CrmOutreachActor, partyId: string, partyType: string, text: string, at: Date): Promise<CrmContextFactRecord> {
    const r = await this.repository.recordFact(
      actor.organizationId,
      { partyId, partyType, kind: 'ORIGIN', text, occurredAt: at, occurredAtPrecision: 'INSTANT', basis: 'OPERATOR_RECORDED', dedupeKey: `origin:${partyId}`, recordedByUserId: actor.userId, recordedAt: at },
      tx,
    );
    if (r.outcome === 'NOT_FOUND') throw new Error('origin fact refused');
    if (r.outcome === 'RECORDED') {
      await this.record(tx, actor, 'crm_context.fact_recorded', partyId, partyType, 'ContextFactRecorded', { factId: r.fact.id, kind: 'ORIGIN', basis: 'OPERATOR_RECORDED' });
    }
    return r.fact;
  }

  // --- Internals -------------------------------------------------------------------------------

  private async recordOperatorFact(
    actor: CrmOutreachActor,
    partyId: string,
    kind: CrmContextFactKind,
    raw: string,
    max: number,
    requiredType?: 'PERSON' | 'COMPANY',
  ): Promise<CrmOutreachActResult<CrmContextFactRecord>> {
    const v = validateCrmOutreachText(raw, max);
    if (!v.ok) return { outcome: 'INVALID', violation: v.violation };
    if (!(await this.may(actor, 'RECORD_NOTE'))) return { outcome: 'NOT_AUTHORIZED' };
    return this.prisma.$transaction(async (tx) => {
      const party = await this.party(actor.organizationId, partyId, tx);
      if (!party || (requiredType && party.partyType !== requiredType)) return { outcome: 'NOT_FOUND' as const };
      const at = this.clock();
      const r = await this.repository.recordFact(
        actor.organizationId,
        {
          partyId: party.partyId,
          partyType: party.partyType,
          kind,
          text: v.value,
          occurredAt: at,
          occurredAtPrecision: 'INSTANT',
          basis: 'OPERATOR_RECORDED',
          // Every operator act is its own fact.
          dedupeKey: `operator:${randomUUID()}`,
          recordedByUserId: actor.userId,
          recordedAt: at,
        },
        tx,
      );
      if (r.outcome !== 'RECORDED') return { outcome: 'NOT_FOUND' as const };
      await this.record(tx, actor, 'crm_context.fact_recorded', party.partyId, party.partyType, 'ContextFactRecorded', { factId: r.fact.id, kind, basis: 'OPERATOR_RECORDED' });
      return { outcome: 'RECORDED' as const, value: r.fact };
    });
  }

  private async party(organizationId: string, partyId: string, tx: Prisma.TransactionClient): Promise<{ partyId: string; partyType: string } | null> {
    if (!partyId?.trim()) return null;
    const r = await this.references.requireReferenceable(organizationId, partyId, tx);
    if (!r.ok) return null;
    // Acts land on the canonical Party, never on a superseded id.
    return { partyId: r.reference.partyId, partyType: r.partyType };
  }

  /** The audit row and the outbox event. Ids, kinds, states and booleans only. */
  private async record(
    tx: Prisma.TransactionClient,
    actor: CrmOutreachActor,
    action: string,
    partyId: string,
    partyType: string,
    eventType: string,
    safe: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    const payload = { partyId, partyType, ...safe };
    await this.audit.record({ organizationId: actor.organizationId, userId: actor.userId, action, entityType: 'crm_party_outreach', entityId: partyId, metadata: payload }, tx);
    await tx.stateChangeOutbox.create({
      data: {
        organizationId: actor.organizationId,
        subjectType: 'CRM_OUTREACH',
        subjectId: partyId,
        eventType,
        identityId: null,
        domain: 'COMMUNICATION',
        stateKey: `party_outreach.${partyId}`,
        changeType: 'UPDATED',
        payload: payload as Prisma.InputJsonValue,
        status: 'PENDING',
      },
    });
  }
}
