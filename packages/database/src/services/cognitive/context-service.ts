// CognitiveContextService — the governed READ surface over cognitive state.
//
// Two server-only methods, both deny-by-default and both mapping stored rows to
// the Prisma-free DTOs in @emgloop/shared (never returning Prisma models):
//
//   - getIdentityContext(): everything currently known about ONE identity, scoped
//     to a MANDATORY purpose and EXPLICITLY-requested domains (never an
//     unrestricted all-domain query). Expired / revoked / suppressed / not-
//     permitted data is omitted; stale-but-live state is returned and LABELLED;
//     raw memory payloads are never returned (a summary is).
//
//   - explainActiveState(): a fully inspectable account of WHY one state holds
//     its value, assembled ONLY from stored rows. No LLM, no invented causation —
//     evidence is "supported by", never "caused by"; missing evidence is stated.
//
// organizationId is ALWAYS the first thing read from the trusted server context
// (the argument), never from a client payload. Cross-org ids resolve to
// not-found, never a leak.

import type { PrismaClient, DataGovernancePolicy, ActiveStateRecord } from '@prisma/client';
import type {
  IdentityContext,
  ActiveStateExplanation,
  ActiveStateDTO,
  ActiveStateFreshness,
  KnowledgeDTO,
  RoleDTO,
  RelationshipDTO,
  EvidenceDTO,
  PolicyDecisionDTO,
  ExplanationEvidenceDTO,
  GovernanceOutcome,
} from '@emgloop/shared';
import { COGNITIVE_CONTEXT_CONTRACT_VERSION } from '@emgloop/shared';

import {
  createCognitiveRepositories,
  type CognitiveRepositories,
} from '../../repositories/cognitive';
import { GovernanceEvaluator } from './governance-evaluator';

const DEFAULT_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_MEMORY_WINDOW = 50;

export interface GetIdentityContextInput {
  /** TRUSTED (server-derived), never from a client payload. */
  organizationId: string;
  identityId: string;
  /** MANDATORY. Deny-by-default: no purpose → nothing governed is returned. */
  requestedPurpose: string;
  channel?: string | null;
  /** EXPLICIT. Empty is refused — no unrestricted all-domain query. */
  domains: string[];
  includeEvidence?: boolean;
  /** Consent basis available for this read; absent (NONE) denies consent-gated policies. */
  consentBasis?: string;
  now?: Date;
}

export interface ExplainActiveStateInput {
  organizationId: string;
  activeStateRecordId: string;
  requestedPurpose: string;
  channel?: string | null;
  consentBasis?: string;
  now?: Date;
}

export class CognitiveContextService {
  private readonly repos: CognitiveRepositories;
  private readonly staleThresholdMs: number;

  constructor(
    prisma: PrismaClient,
    repos?: CognitiveRepositories,
    opts: { staleThresholdMs?: number } = {},
  ) {
    this.repos = repos ?? createCognitiveRepositories(prisma);
    this.staleThresholdMs = opts.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  }

  async getIdentityContext(input: GetIdentityContextInput): Promise<IdentityContext> {
    const org = input.organizationId;
    if (!org) throw new Error('getIdentityContext: organizationId is required (server-derived, never client)');
    if (!input.requestedPurpose) {
      throw new Error('getIdentityContext: requestedPurpose is required (governed reads are deny-by-default)');
    }
    if (!input.domains || input.domains.length === 0) {
      throw new Error('getIdentityContext: domains must be explicitly requested (no unrestricted all-domain query)');
    }

    const now = input.now ?? new Date();
    const purpose = input.requestedPurpose;
    const channel = input.channel ?? null;
    const unknowns: string[] = [];

    const identity = await this.repos.identities.findById(org, input.identityId);
    if (!identity) {
      return this.emptyContext(input, now, ['identity not found in this organization']);
    }

    // Top-level governance decision (deny-by-default) for this purpose + channel.
    const policies = await this.repos.governancePolicies.findApplicable(
      org,
      { entityType: identity.entityType },
      now,
    );
    const governance = GovernanceEvaluator.evaluate({
      policies,
      requestedPurposes: [purpose as never],
      channel,
      consentBasis: input.consentBasis ?? 'NONE',
    });
    const purposeAllowed = governance.outcome !== 'DENY' && governance.allowedPurposes.includes(purpose as never);
    if (!purposeAllowed) {
      unknowns.push(`purpose ${purpose} not permitted${channel ? ` for channel ${channel}` : ''}; governed data omitted`);
    }

    const policyDecisions: PolicyDecisionDTO[] = [
      {
        requestedPurpose: purpose,
        channel,
        domain: null,
        outcome: governance.outcome as GovernanceOutcome,
        allowedPurposes: governance.allowedPurposes as string[],
        reasons: governance.reasons,
      },
    ];

    // Roles + relationships are identity structure (not purpose-gated data values).
    const roleRows = await this.repos.identityRoles.listForIdentity(org, identity.id, { activeOnly: true });
    const roles: RoleDTO[] = roleRows.map((r) => ({
      roleType: r.roleType,
      status: r.status,
      effectiveFrom: r.effectiveFrom.toISOString(),
      effectiveTo: r.effectiveTo ? r.effectiveTo.toISOString() : null,
    }));
    const relRows = await this.repos.identityRelationships.listForIdentity(org, identity.id);
    const relationships: RelationshipDTO[] = relRows
      .filter((r) => r.status === 'ACTIVE')
      .map((r) => ({
        id: r.id,
        direction: r.fromIdentityId === identity.id ? 'FROM' : 'TO',
        otherIdentityId: r.fromIdentityId === identity.id ? r.toIdentityId : r.fromIdentityId,
        relationshipType: r.relationshipType,
        status: r.status,
      }));

    // Active state — only if the purpose is permitted at all.
    const activeState: ActiveStateDTO[] = [];
    const evidence: EvidenceDTO[] = [];
    let omittedExpiredCount = 0;
    let hasStale = false;

    if (purposeAllowed) {
      const records = await this.repos.activeState.listForIdentity(org, identity.id, {
        domains: input.domains as never[],
        includeExpired: true,
        now,
      });
      for (const rec of records) {
        // Omit non-live states entirely (never silently returned as active).
        if (rec.status === 'SUPPRESSED' || rec.status === 'REVOKED') continue;
        const expiredByTime = rec.expiresAt != null && rec.expiresAt <= now;
        if (rec.status === 'EXPIRED' || expiredByTime) {
          omittedExpiredCount++;
          continue;
        }
        // Row-level purpose gate (deny-by-default): the row must permit the purpose.
        if (!rec.permittedPurposes.includes(purpose as never)) {
          unknowns.push(`state ${rec.domain}/${rec.stateKey} omitted: does not permit purpose ${purpose}`);
          continue;
        }
        const freshness = this.freshnessOf(rec, now);
        if (freshness === 'STALE') hasStale = true;
        activeState.push(this.toActiveStateDTO(rec, freshness));

        if (input.includeEvidence) {
          const evRows = await this.repos.activeState.listEvidence(org, rec.id);
          for (const e of evRows) {
            evidence.push({
              activeStateRecordId: rec.id,
              memoryEventId: e.memoryEventId,
              knowledgeAssertionId: e.knowledgeAssertionId,
              relationshipId: e.relationshipId,
              weight: e.weight,
              contribution: e.contribution,
              observedAt: e.observedAt.toISOString(),
            });
          }
        }
      }
    }

    // Relevant knowledge — ACTIVE, purpose-permitted, unexpired.
    const relevantKnowledge: KnowledgeDTO[] = [];
    if (purposeAllowed) {
      const assertions = await this.repos.knowledgeAssertions.listForSubject(org, identity.id, {
        status: 'ACTIVE',
      });
      for (const a of assertions) {
        if (a.expiresAt != null && a.expiresAt <= now) continue;
        if (!a.permittedPurposes.includes(purpose as never)) continue;
        relevantKnowledge.push({
          id: a.id,
          predicate: a.predicate,
          valueType: a.valueType,
          value: a.value,
          assertionClass: a.assertionClass,
          status: a.status,
          confidence: a.confidence,
          effectiveFrom: a.effectiveFrom.toISOString(),
          sensitivity: a.sensitivity,
          permittedPurposes: a.permittedPurposes as string[],
        });
      }
    }

    // Recent memory — SUMMARY ONLY. No raw payloads leave this method.
    const memoryRows = await this.repos.memoryEvents.recentForSubject(org, identity.id, {
      take: DEFAULT_MEMORY_WINDOW,
    });
    const byType: Record<string, number> = {};
    for (const m of memoryRows) byType[m.eventType] = (byType[m.eventType] ?? 0) + 1;
    const lastEventAt = memoryRows.length ? memoryRows[0]!.occurredAt.toISOString() : null;

    if (omittedExpiredCount > 0) {
      unknowns.push(`${omittedExpiredCount} expired/inactive state record(s) omitted`);
    }

    return {
      contractVersion: COGNITIVE_CONTEXT_CONTRACT_VERSION,
      organizationId: org,
      requestedPurpose: purpose,
      channel,
      requestedDomains: input.domains,
      identity: {
        id: identity.id,
        entityType: identity.entityType,
        displayName: identity.displayName,
        status: identity.status,
      },
      roles,
      relationships,
      activeState,
      relevantKnowledge,
      recentMemorySummary: {
        total: memoryRows.length,
        byType,
        lastEventAt,
        windowConsidered: DEFAULT_MEMORY_WINDOW,
      },
      policyDecisions,
      evidence,
      freshness: {
        asOf: now.toISOString(),
        staleThresholdMs: this.staleThresholdMs,
        hasStale,
        omittedExpiredCount,
      },
      unknowns,
    };
  }

  async explainActiveState(input: ExplainActiveStateInput): Promise<ActiveStateExplanation> {
    const org = input.organizationId;
    if (!org) throw new Error('explainActiveState: organizationId is required (server-derived, never client)');
    if (!input.requestedPurpose) throw new Error('explainActiveState: requestedPurpose is required');
    const now = input.now ?? new Date();

    const record = await this.repos.activeState.findRecordById(org, input.activeStateRecordId);
    if (!record) {
      return {
        contractVersion: COGNITIVE_CONTEXT_CONTRACT_VERSION,
        organizationId: org,
        found: false,
        identityId: null,
        domain: null,
        stateKey: null,
        currentValue: null,
        valueType: null,
        confidence: null,
        status: null,
        freshness: null,
        effectiveAt: null,
        lastEvaluatedAt: null,
        lastChangedAt: null,
        expiresAt: null,
        decayModel: null,
        ruleId: null,
        ruleVersion: null,
        scope: null,
        sensitivity: null,
        permittedPurposes: [],
        governanceResult: null,
        governanceReasons: [],
        supportingEvidence: [],
        lastChangingEvent: null,
        explanation: 'No active-state record was found in this organization for the given id.',
        unknowns: ['record not found or belongs to another organization'],
      };
    }

    const unknowns: string[] = [];

    // Governance for the requested purpose + channel.
    const identity = await this.repos.identities.findById(org, record.identityId);
    const policies = await this.repos.governancePolicies.findApplicable(
      org,
      { entityType: identity?.entityType ?? null },
      now,
    );
    const governance = GovernanceEvaluator.evaluate({
      policies,
      requestedPurposes: [input.requestedPurpose as never],
      channel: input.channel ?? null,
      consentBasis: input.consentBasis ?? 'NONE',
    });
    const rowPermits = record.permittedPurposes.includes(input.requestedPurpose as never);
    const valuePermitted =
      governance.outcome !== 'DENY' &&
      governance.allowedPurposes.includes(input.requestedPurpose as never) &&
      rowPermits;
    if (!valuePermitted) {
      unknowns.push(`value withheld: purpose ${input.requestedPurpose} is not permitted for this state`);
    }

    const evidenceRows = await this.repos.activeState.listEvidence(org, record.id);
    const supportingEvidence: ExplanationEvidenceDTO[] = evidenceRows.map((e) => ({
      kind: e.memoryEventId
        ? 'MEMORY_EVENT'
        : e.knowledgeAssertionId
          ? 'KNOWLEDGE_ASSERTION'
          : 'RELATIONSHIP',
      refId: (e.memoryEventId ?? e.knowledgeAssertionId ?? e.relationshipId ?? '') as string,
      weight: e.weight,
      contribution: e.contribution,
      observedAt: e.observedAt.toISOString(),
    }));

    const revisions = await this.repos.activeState.listRevisions(org, record.id);
    const lastChangedAt = revisions.length ? revisions[0]!.changedAt.toISOString() : null;

    let lastChangingEvent = null as ActiveStateExplanation['lastChangingEvent'];
    if (record.lastChangedByEventId) {
      const ev = await this.repos.memoryEvents.findById(org, record.lastChangedByEventId);
      if (ev) {
        lastChangingEvent = {
          memoryEventId: ev.id,
          eventType: ev.eventType,
          occurredAt: ev.occurredAt.toISOString(),
          sourceSystem: ev.sourceSystem,
          channel: ev.channel ?? null,
        };
      } else {
        unknowns.push('the last-changing event id does not resolve to a stored memory event');
      }
    } else {
      unknowns.push('no source event is on file for the last change to this state');
    }

    if (supportingEvidence.length === 0) {
      unknowns.push('no supporting evidence is recorded for this state');
    }

    const freshness = this.freshnessOf(record, now);
    const explanation = this.composeExplanation({
      record,
      freshness,
      supportingEvidence,
      lastChangingEvent,
      valuePermitted,
    });

    return {
      contractVersion: COGNITIVE_CONTEXT_CONTRACT_VERSION,
      organizationId: org,
      found: true,
      identityId: record.identityId,
      domain: record.domain,
      stateKey: record.stateKey,
      currentValue: valuePermitted ? record.value : null,
      valueType: record.valueType,
      confidence: record.confidence,
      status: record.status,
      freshness,
      effectiveAt: record.effectiveAt.toISOString(),
      lastEvaluatedAt: record.lastEvaluatedAt.toISOString(),
      lastChangedAt,
      expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
      decayModel: record.decayModel,
      ruleId: record.calculationRule,
      ruleVersion: record.ruleVersion,
      scope: record.scope,
      sensitivity: record.sensitivity,
      permittedPurposes: record.permittedPurposes as string[],
      governanceResult: governance.outcome as GovernanceOutcome,
      governanceReasons: governance.reasons,
      supportingEvidence,
      lastChangingEvent,
      explanation,
      unknowns,
    };
  }

  // --- helpers -------------------------------------------------------------

  private freshnessOf(rec: ActiveStateRecord, now: Date): ActiveStateFreshness {
    if (rec.expiresAt != null && rec.expiresAt <= now) return 'EXPIRED';
    if (rec.status === 'EXPIRED') return 'EXPIRED';
    if (rec.status === 'STALE') return 'STALE';
    if (now.getTime() - rec.lastEvaluatedAt.getTime() > this.staleThresholdMs) return 'STALE';
    return 'CURRENT';
  }

  private toActiveStateDTO(rec: ActiveStateRecord, freshness: ActiveStateFreshness): ActiveStateDTO {
    return {
      id: rec.id,
      domain: rec.domain,
      stateKey: rec.stateKey,
      valueType: rec.valueType,
      value: rec.value,
      confidence: rec.confidence,
      status: rec.status,
      freshness,
      effectiveAt: rec.effectiveAt.toISOString(),
      lastEvaluatedAt: rec.lastEvaluatedAt.toISOString(),
      expiresAt: rec.expiresAt ? rec.expiresAt.toISOString() : null,
      decayModel: rec.decayModel,
      ruleVersion: rec.ruleVersion,
      scope: rec.scope,
      sensitivity: rec.sensitivity,
      permittedPurposes: rec.permittedPurposes as string[],
    };
  }

  /**
   * Plain-language account built ONLY from stored rows. Uses "Supported by",
   * never "Caused by" — evidence here is correlation, not proven causation. When
   * evidence is absent it says so rather than inventing a reason.
   */
  private composeExplanation(args: {
    record: ActiveStateRecord;
    freshness: ActiveStateFreshness;
    supportingEvidence: ExplanationEvidenceDTO[];
    lastChangingEvent: ActiveStateExplanation['lastChangingEvent'];
    valuePermitted: boolean;
  }): string {
    const { record, freshness, supportingEvidence, lastChangingEvent, valuePermitted } = args;
    const valueStr = valuePermitted ? JSON.stringify(record.value) : '[withheld: purpose not permitted]';
    const conf = record.confidence == null ? 'unspecified' : record.confidence.toFixed(2);
    const rule = record.ruleVersion ? `rule ${record.ruleVersion}` : 'an unversioned rule';
    const parts: string[] = [];
    parts.push(
      `${record.domain}/${record.stateKey} is ${valueStr} (confidence ${conf}, status ${record.status}, freshness ${freshness}).`,
    );
    parts.push(`It was last evaluated by ${rule} at ${record.lastEvaluatedAt.toISOString()}.`);
    if (supportingEvidence.length > 0) {
      const kinds = supportingEvidence.map((e) => `${e.kind.toLowerCase()} ${e.refId}`).join(', ');
      parts.push(`Supported by ${supportingEvidence.length} evidence item(s): ${kinds}.`);
    } else {
      parts.push('No supporting evidence is recorded, so this value cannot be independently explained.');
    }
    if (lastChangingEvent) {
      parts.push(
        `The value last changed following a ${lastChangingEvent.eventType} event from ${lastChangingEvent.sourceSystem} at ${lastChangingEvent.occurredAt}.`,
      );
    } else {
      parts.push('No source event is on file for the last change.');
    }
    return parts.join(' ');
  }

  private emptyContext(input: GetIdentityContextInput, now: Date, unknowns: string[]): IdentityContext {
    return {
      contractVersion: COGNITIVE_CONTEXT_CONTRACT_VERSION,
      organizationId: input.organizationId,
      requestedPurpose: input.requestedPurpose,
      channel: input.channel ?? null,
      requestedDomains: input.domains,
      identity: null,
      roles: [],
      relationships: [],
      activeState: [],
      relevantKnowledge: [],
      recentMemorySummary: { total: 0, byType: {}, lastEventAt: null, windowConsidered: DEFAULT_MEMORY_WINDOW },
      policyDecisions: [],
      evidence: [],
      freshness: { asOf: now.toISOString(), staleThresholdMs: this.staleThresholdMs, hasStale: false, omittedExpiredCount: 0 },
      unknowns,
    };
  }
}
