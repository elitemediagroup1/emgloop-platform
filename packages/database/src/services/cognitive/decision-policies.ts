// DecisionPolicyRegistry (PURE) — Increment 3.
//
// Declarative decision policies evaluated against a GOVERNED context (the
// @emgloop/shared IdentityContext produced by CognitiveContextService — already
// purpose-scoped, expiry-filtered, and freshness-labelled). Policies never touch
// repositories and never execute anything: each returns a candidate decision or
// null. Recording and precedence resolution happen in the subscribers.
//
// Three policies ship: commerce personalization eligibility (RECOMMEND),
// communication frequency suppression (SUPPRESS), and campaign operational
// review (CREATE_WORK, approval-required). Precedence is deterministic and
// independent of evaluation order.

import type { DecisionOutcome } from '@prisma/client';
import type { IdentityContext, ActiveStateDTO } from '@emgloop/shared';

const MIN_PERSONALIZATION_CONFIDENCE = 0.5;
const MIN_CAMPAIGN_CONFIDENCE = 0.5;

const COMMERCE_INTEREST_PREFIXES = [
  'currentProductInterest',
  'currentCategoryInterest',
  'currentAttributeInterest',
];

export interface PolicyInput {
  context: IdentityContext;
  channel: string | null;
  now: Date;
}

export interface PolicyEvaluation {
  policyId: string;
  version: string;
  decision: DecisionOutcome;
  requiresApproval: boolean;
  /** The purpose recorded on the resulting decision. */
  decisionPurpose: string;
  channel: string | null;
  confidence: number | null;
  reason: string;
  /** ActiveStateRecord ids that back this decision. */
  evidenceStateIds: string[];
}

export interface DecisionPolicy {
  policyId: string;
  version: string;
  description: string;
  /** null = applies to any identity type. */
  applicableEntityTypes: string[] | null;
  inputDomains: string[];
  inputStateKeys: string[];
  /** Purpose used to fetch the governed context (so needed rows are permitted). */
  contextPurpose: string;
  channelConstrained: boolean;
  minimumConfidence: number | null;
  decision: DecisionOutcome;
  requiresApproval: boolean;
  /** 'messaging' policies are precedence-resolved; 'work' policies record separately. */
  kind: 'messaging' | 'work';
  evaluate(input: PolicyInput): PolicyEvaluation | null;
}

function isCommerceInterest(s: ActiveStateDTO): boolean {
  return (
    s.domain === 'COMMERCE' &&
    COMMERCE_INTEREST_PREFIXES.some((p) => s.stateKey.startsWith(p))
  );
}

// --- POLICY 1 — Commerce personalization eligibility -----------------------
const commercePersonalization: DecisionPolicy = {
  policyId: 'commerce-personalization-eligibility',
  version: 'v1',
  description:
    'Recommends personalization when a fresh, permitted commerce interest exists above a confidence floor. Selects no copy and sends nothing.',
  applicableEntityTypes: null,
  inputDomains: ['COMMERCE'],
  inputStateKeys: COMMERCE_INTEREST_PREFIXES,
  contextPurpose: 'PERSONALIZATION',
  channelConstrained: true,
  minimumConfidence: MIN_PERSONALIZATION_CONFIDENCE,
  decision: 'RECOMMEND',
  requiresApproval: false,
  kind: 'messaging',
  evaluate({ context, channel }: PolicyInput): PolicyEvaluation | null {
    // The context is already governed: only PERSONALIZATION-permitted, unexpired
    // states are present, so "personalization allowed" + consent are upstream.
    const interest = context.activeState.find(
      (s) =>
        isCommerceInterest(s) &&
        s.freshness !== 'EXPIRED' &&
        (s.confidence ?? 0) >= MIN_PERSONALIZATION_CONFIDENCE,
    );
    if (!interest) return null;
    return {
      policyId: commercePersonalization.policyId,
      version: commercePersonalization.version,
      decision: 'RECOMMEND',
      requiresApproval: false,
      decisionPurpose: 'PERSONALIZATION',
      channel,
      confidence: interest.confidence ?? null,
      reason: `Eligible for personalization: ${interest.stateKey}=${JSON.stringify(interest.value)} (confidence ${interest.confidence ?? 'n/a'}).`,
      evidenceStateIds: [interest.id],
    };
  },
};

// --- POLICY 2 — Communication frequency suppression ------------------------
const communicationSuppression: DecisionPolicy = {
  policyId: 'communication-frequency-suppression',
  version: 'v1',
  description:
    'Suppresses outreach on a channel when the communication frequency limit has been reached. Takes precedence over RECOMMEND for the same channel.',
  applicableEntityTypes: null,
  inputDomains: ['COMMUNICATION'],
  inputStateKeys: ['frequencyLimitReached'],
  // The frequency state is permitted for SERVICE_DELIVERY (set by the Inc-2
  // communication evaluator); that is the purpose used to READ it. The resulting
  // suppression governs the PERSONALIZATION/MARKETING channel.
  contextPurpose: 'SERVICE_DELIVERY',
  channelConstrained: true,
  minimumConfidence: null,
  decision: 'SUPPRESS',
  requiresApproval: false,
  kind: 'messaging',
  evaluate({ context, channel }: PolicyInput): PolicyEvaluation | null {
    const freq = context.activeState.find(
      (s) =>
        s.domain === 'COMMUNICATION' &&
        s.stateKey === 'frequencyLimitReached' &&
        s.value === true,
    );
    if (!freq) return null;
    return {
      policyId: communicationSuppression.policyId,
      version: communicationSuppression.version,
      decision: 'SUPPRESS',
      requiresApproval: false,
      decisionPurpose: 'PERSONALIZATION',
      channel,
      confidence: freq.confidence ?? null,
      reason: `Suppressed: communication frequency limit reached (${freq.domain}/${freq.stateKey}=true).`,
      evidenceStateIds: [freq.id],
    };
  },
};

// --- POLICY 3 — Campaign operational review --------------------------------
const campaignOperationalReview: DecisionPolicy = {
  policyId: 'campaign-operational-review',
  version: 'v1',
  description:
    'Records an approval-required recommendation to create work when a campaign reaches HIGH operational attention with sufficient confidence and evidence. Creates no Work Item.',
  applicableEntityTypes: null,
  inputDomains: ['CAMPAIGN'],
  inputStateKeys: ['operationalAttentionLevel'],
  contextPurpose: 'OPERATIONS',
  channelConstrained: false,
  minimumConfidence: MIN_CAMPAIGN_CONFIDENCE,
  decision: 'CREATE_WORK',
  requiresApproval: true,
  kind: 'work',
  evaluate({ context }: PolicyInput): PolicyEvaluation | null {
    const att = context.activeState.find(
      (s) =>
        s.domain === 'CAMPAIGN' &&
        s.stateKey === 'operationalAttentionLevel' &&
        s.value === 'HIGH' &&
        (s.confidence ?? 0) >= MIN_CAMPAIGN_CONFIDENCE,
    );
    if (!att) return null;
    // Required evidence must be present (context must have been fetched with
    // includeEvidence). No evidence → no decision (never invent one).
    const hasEvidence = context.evidence.some((e) => e.activeStateRecordId === att.id);
    if (!hasEvidence) return null;
    return {
      policyId: campaignOperationalReview.policyId,
      version: campaignOperationalReview.version,
      decision: 'CREATE_WORK',
      requiresApproval: true,
      decisionPurpose: 'OPERATIONS',
      channel: null,
      confidence: att.confidence ?? null,
      reason: `Campaign requires operational review: operationalAttentionLevel=HIGH (confidence ${att.confidence ?? 'n/a'}).`,
      evidenceStateIds: [att.id],
    };
  },
};

const ALL: DecisionPolicy[] = [
  commercePersonalization,
  communicationSuppression,
  campaignOperationalReview,
];

export const DecisionPolicyRegistry = {
  list(): DecisionPolicy[] {
    return ALL;
  },
  get(policyId: string): DecisionPolicy | undefined {
    return ALL.find((p) => p.policyId === policyId);
  },
  /** Precedence-resolved messaging policies (SUPPRESS/QUEUE/RECOMMEND/NO_ACTION). */
  messagingPolicies(): DecisionPolicy[] {
    return ALL.filter((p) => p.kind === 'messaging');
  },
  /** Work-recommending policies, recorded independently of messaging precedence. */
  workPolicies(): DecisionPolicy[] {
    return ALL.filter((p) => p.kind === 'work');
  },
};

// --- Deterministic precedence ----------------------------------------------
// SUPPRESS > QUEUE > RECOMMEND > NO_ACTION for the same identity/purpose/channel.
// CREATE_WORK and ESCALATE are SEPARATE operational decisions, never ranked here.
const MESSAGING_PRECEDENCE: DecisionOutcome[] = ['SUPPRESS', 'QUEUE', 'RECOMMEND', 'NO_ACTION'];

export function messagingPrecedenceRank(outcome: DecisionOutcome): number {
  const idx = MESSAGING_PRECEDENCE.indexOf(outcome);
  return idx === -1 ? Number.POSITIVE_INFINITY : idx;
}

/** The single highest-precedence messaging outcome, order-independent. */
export function resolveOutcomePrecedence(outcomes: DecisionOutcome[]): DecisionOutcome | null {
  const ranked = outcomes.filter((o) => MESSAGING_PRECEDENCE.includes(o));
  if (ranked.length === 0) return null;
  return ranked.reduce((best, o) =>
    messagingPrecedenceRank(o) < messagingPrecedenceRank(best) ? o : best,
  );
}

/**
 * Pick the winning messaging evaluation deterministically. Order-independent:
 * the winner is the one whose outcome has the lowest precedence rank; ties break
 * on policyId for total determinism.
 */
export function resolveDecisionPrecedence(
  evaluations: PolicyEvaluation[],
): PolicyEvaluation | null {
  const ranked = evaluations
    .filter((e) => MESSAGING_PRECEDENCE.includes(e.decision))
    .sort((a, b) => {
      const r = messagingPrecedenceRank(a.decision) - messagingPrecedenceRank(b.decision);
      return r !== 0 ? r : a.policyId < b.policyId ? -1 : a.policyId > b.policyId ? 1 : 0;
    });
  return ranked[0] ?? null;
}
