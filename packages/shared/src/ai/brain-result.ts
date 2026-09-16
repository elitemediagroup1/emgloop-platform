// What a Brain result means to Loop, and who owns it. Slice B2.
//
// Architecture: docs/architecture/brain-execution-architecture.md §5, and the
// intelligence taxonomy in loop-ai-runtime.md §6.
//
// THE JOB IS NOT THE ARTIFACT. A job's state belongs to Brain execution. The
// intelligence it produces belongs to the Loop authority that governs that kind of
// thing about that kind of subject -- a Case explanation to Commercial Intelligence, a
// proposed action to the Decision Engine's approval path -- and reaches it only
// through that authority's own gate. Activity records that something happened and
// points at the artifact. It never holds the artifact, and neither does the job.
//
// A RESULT IS NEVER TRUTH. Every result is NON_AUTHORITATIVE (an answer, an analysis)
// or PROPOSED (a finding, a recommendation, an action) and nothing else. Accepting,
// resolving or executing is the owning authority's act, on a person's or an approved
// policy's authority, recorded there. Every claim cites evidence Loop supplied, and a
// previous model output is never cited as if it were a governed fact.
//
// THESE AUTHORITIES' STORES ARE NOT BUILT. This file is the contract a commit must
// satisfy; the tables behind each path arrive with the first task that needs them.
//
// PURE.

import type { AiContentTrustLevel } from './provider';

export const BRAIN_RESULT_TYPES = ['ANSWER', 'ANALYSIS', 'FINDING', 'RECOMMENDATION', 'PROPOSED_ACTION'] as const;
export type BrainResultType = (typeof BRAIN_RESULT_TYPES)[number];

/** The only standing a result can have. Anything stronger is granted by its owner, later. */
export const BRAIN_RESULT_STANDINGS = ['NON_AUTHORITATIVE', 'PROPOSED'] as const;
export type BrainResultStanding = (typeof BRAIN_RESULT_STANDINGS)[number];

/** Loop authorities that may own a Brain result. */
export const BRAIN_RESULT_OWNERS = [
  'BRAIN_CONVERSATIONS',
  'COMMERCIAL_INTELLIGENCE',
  'RELATIONSHIPS',
  'CAMPAIGNS',
  'DECISION_ENGINE',
] as const;
export type BrainResultOwnerAuthority = (typeof BRAIN_RESULT_OWNERS)[number];

/** Things that record or run work and so must never own what the work produced. */
export const BRAIN_NEVER_OWNERS = ['ACTIVITY', 'BRAIN_EXECUTION', 'MODEL_PROVIDER'] as const;

export const BRAIN_RESULT_SUBJECT_TYPES = ['CONVERSATION', 'CASE', 'RELATIONSHIP', 'CAMPAIGN', 'DECISION'] as const;
export type BrainResultSubjectType = (typeof BRAIN_RESULT_SUBJECT_TYPES)[number];

export interface BrainResultOwner {
  readonly authority: BrainResultOwnerAuthority;
  readonly subjectType: BrainResultSubjectType;
}

export interface BrainOwnershipRule extends BrainResultOwner {
  readonly resultType: BrainResultType;
  readonly standing: BrainResultStanding;
  /** The owner's governed path a commit must go through. */
  readonly path: string;
}

/**
 * Which authority may own which result, about which subject, with which standing. A
 * pairing not listed here is refused, so adding a new kind of result is a reviewed
 * change to this table -- not a new place for output to land.
 */
export const BRAIN_OWNERSHIP_RULES: readonly BrainOwnershipRule[] = Object.freeze([
  rule('ANSWER', 'BRAIN_CONVERSATIONS', 'CONVERSATION', 'NON_AUTHORITATIVE', 'a Brain conversation turn'),
  rule('ANALYSIS', 'COMMERCIAL_INTELLIGENCE', 'CASE', 'NON_AUTHORITATIVE', 'a Case analysis held by Commercial Intelligence'),
  rule('ANALYSIS', 'RELATIONSHIPS', 'RELATIONSHIP', 'NON_AUTHORITATIVE', 'a Relationship analysis held by the Relationship authority'),
  rule('ANALYSIS', 'CAMPAIGNS', 'CAMPAIGN', 'NON_AUTHORITATIVE', 'a Campaign analysis held by the Campaign authority'),
  rule('FINDING', 'COMMERCIAL_INTELLIGENCE', 'CASE', 'PROPOSED', 'CaseFindingService, author MODEL'),
  rule('RECOMMENDATION', 'COMMERCIAL_INTELLIGENCE', 'CASE', 'PROPOSED', 'CaseRecommendationService, author MODEL'),
  rule('PROPOSED_ACTION', 'DECISION_ENGINE', 'DECISION', 'PROPOSED', 'a Decision Engine approval item'),
]);

function rule(
  resultType: BrainResultType,
  authority: BrainResultOwnerAuthority,
  subjectType: BrainResultSubjectType,
  standing: BrainResultStanding,
  path: string,
): BrainOwnershipRule {
  return Object.freeze({ resultType, authority, subjectType, standing, path });
}

export function brainOwnershipRule(resultType: string, owner: { authority: string; subjectType: string }): BrainOwnershipRule | null {
  return (
    BRAIN_OWNERSHIP_RULES.find(
      (r) => r.resultType === resultType && r.authority === owner.authority && r.subjectType === owner.subjectType,
    ) ?? null
  );
}

/** A pointer to an artifact its owner holds. Never the artifact. */
export interface BrainResultRef {
  readonly owner: BrainResultOwner;
  readonly subjectId: string;
  readonly artifactId: string;
}

/**
 * A reference a model's own earlier output carries when it is fed back as context. It
 * may be cited, but only as what it is -- never as a governed fact.
 */
export const BRAIN_MODEL_OUTPUT_REF_PREFIX = 'brain-result:';

export interface BrainResultProvenance {
  readonly jobId: string;
  readonly taskId: string;
  readonly taskVersion: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly capabilityRoute: string;
  readonly specializationPolicyVersion: string;
  readonly routingPolicyVersion: string;
  /** Ledger call keys of every provider call that shaped the result. At least one. */
  readonly invocationIds: readonly string[];
  /** What each serving provider reported, in call order. */
  readonly servedModels: readonly string[];
  /** The model the result stands in for, when a fallback served. */
  readonly fellBackFrom: string | null;
  /** A hash of the ordered source refs. Never the content. */
  readonly contextManifestHash: string;
}

export interface BrainResultClaim {
  readonly statement: string;
  readonly citations: readonly string[];
}

/** The shape every result has before its owner accepts it. `payload` is the task's own schema. */
export interface BrainResultEnvelope<TPayload = unknown> {
  readonly resultType: BrainResultType;
  readonly schemaId: string;
  readonly organizationId: string;
  readonly subject: { readonly type: BrainResultSubjectType; readonly id: string };
  readonly owner: BrainResultOwner;
  readonly standing: BrainResultStanding;
  readonly claims: readonly BrainResultClaim[];
  /** Every ref the claims cite, sorted and de-duplicated. The evidence outlives the result. */
  readonly evidenceRefs: readonly string[];
  readonly limitations: readonly string[];
  readonly provenance: BrainResultProvenance;
  readonly payload: TPayload;
}

/** What Loop supplied, and how far it can be trusted. */
export interface BrainSuppliedEvidence {
  readonly ref: string;
  readonly trust: AiContentTrustLevel;
}

/** What the job itself says the result must be. Read from Loop's job record. */
export interface BrainCommitExpectation {
  readonly jobId: string;
  readonly organizationId: string;
  readonly resultType: BrainResultType;
  readonly owner: BrainResultOwner;
  readonly subject: { readonly type: BrainResultSubjectType; readonly id: string };
}

export const BRAIN_COMMIT_REFUSALS = [
  'ORGANIZATION_MISMATCH',
  'JOB_MISMATCH',
  'RESULT_TYPE_MISMATCH',
  'SUBJECT_MISMATCH',
  'OWNER_MISMATCH',
  'OWNER_NOT_PERMITTED',
  'STANDING_NOT_PERMITTED',
  'UNCITED_CLAIM',
  'CITATION_NOT_SUPPLIED',
  'EVIDENCE_REFS_INCONSISTENT',
  'EVIDENCE_MISSING',
  'MODEL_OUTPUT_CITED_AS_FACT',
  'PROVENANCE_INCOMPLETE',
] as const;
export type BrainCommitRefusal = (typeof BRAIN_COMMIT_REFUSALS)[number];

/**
 * Every reason a result may not be handed to its owner. Empty means the owner's gate
 * may now consider it -- which is still the owner's decision, not this function's.
 */
export function brainCommitRefusals(
  envelope: BrainResultEnvelope,
  expected: BrainCommitExpectation,
  supplied: readonly BrainSuppliedEvidence[],
): BrainCommitRefusal[] {
  const out: BrainCommitRefusal[] = [];
  if (envelope.organizationId !== expected.organizationId) out.push('ORGANIZATION_MISMATCH');
  if (envelope.provenance.jobId !== expected.jobId) out.push('JOB_MISMATCH');
  if (envelope.resultType !== expected.resultType) out.push('RESULT_TYPE_MISMATCH');
  if (envelope.subject.type !== expected.subject.type || envelope.subject.id !== expected.subject.id) out.push('SUBJECT_MISMATCH');
  if (envelope.owner.authority !== expected.owner.authority || envelope.owner.subjectType !== expected.owner.subjectType) {
    out.push('OWNER_MISMATCH');
  }

  const governing = brainOwnershipRule(envelope.resultType, envelope.owner);
  if (!governing || (BRAIN_NEVER_OWNERS as readonly string[]).includes(envelope.owner.authority)) out.push('OWNER_NOT_PERMITTED');
  else if (governing.subjectType !== envelope.subject.type) out.push('OWNER_NOT_PERMITTED');
  if (!governing || envelope.standing !== governing.standing) out.push('STANDING_NOT_PERMITTED');

  const trustOf = new Map(supplied.map((s) => [s.ref, s.trust]));
  const cited = new Set<string>();
  for (const claim of envelope.claims) {
    if (claim.citations.length === 0) out.push('UNCITED_CLAIM');
    for (const ref of claim.citations) {
      cited.add(ref);
      const trust = trustOf.get(ref);
      if (trust === undefined) out.push('CITATION_NOT_SUPPLIED');
      else if (ref.startsWith(BRAIN_MODEL_OUTPUT_REF_PREFIX) && trust === 'GOVERNED_FACT') out.push('MODEL_OUTPUT_CITED_AS_FACT');
    }
  }
  const declared = [...new Set(envelope.evidenceRefs)].sort();
  const actual = [...cited].sort();
  if (declared.length !== actual.length || declared.some((ref, i) => ref !== actual[i])) out.push('EVIDENCE_REFS_INCONSISTENT');
  if (envelope.resultType !== 'ANSWER' && actual.length === 0) out.push('EVIDENCE_MISSING');

  const p = envelope.provenance;
  const blank = (v: string) => typeof v !== 'string' || v.trim() === '';
  if (
    p.invocationIds.length === 0 ||
    [p.taskId, p.taskVersion, p.templateId, p.templateVersion, p.capabilityRoute, p.specializationPolicyVersion, p.routingPolicyVersion, p.contextManifestHash].some(blank)
  ) {
    out.push('PROVENANCE_INCOMPLETE');
  }
  return [...new Set(out)];
}

/** The cited refs of a set of claims, in the order an envelope stores them. */
export function brainEvidenceRefsOf(claims: readonly BrainResultClaim[]): string[] {
  return [...new Set(claims.flatMap((c) => c.citations))].sort();
}

// --- What Activity is told ------------------------------------------------------------

export const BRAIN_JOB_EVENT_NAMES = [
  'brain.job.accepted',
  'brain.job.promoted',
  'brain.job.waiting_for_user',
  'brain.job.succeeded',
  'brain.job.failed',
  'brain.job.cancelled',
] as const;
export type BrainJobEventName = (typeof BRAIN_JOB_EVENT_NAMES)[number];

export type BrainEventActor =
  | { readonly kind: 'HUMAN'; readonly userId: string }
  | { readonly kind: 'SYSTEM' }
  | { readonly kind: 'POLICY'; readonly policy: string };

/**
 * What a job tells the rest of Loop when its state changes: that it happened, to which
 * job, caused by whom, and where the results now live. Deliberately no summary, no
 * claim and no model text -- an event that carried the artifact would become a second
 * copy of it with no owner's gate in front of it.
 */
export interface BrainJobEvent {
  readonly name: BrainJobEventName;
  readonly organizationId: string;
  readonly jobId: string;
  readonly taskId: string;
  readonly resultType: BrainResultType;
  readonly occurredAt: string;
  readonly actor: BrainEventActor;
  readonly resultRefs: readonly BrainResultRef[];
  readonly reason: string | null;
}

export const BRAIN_JOB_EVENT_FIELDS: readonly (keyof BrainJobEvent)[] = Object.freeze([
  'name',
  'organizationId',
  'jobId',
  'taskId',
  'resultType',
  'occurredAt',
  'actor',
  'resultRefs',
  'reason',
]);

export const BRAIN_EVENT_REFUSALS = ['UNKNOWN_EVENT', 'EVENT_CARRIES_CONTENT', 'EVENT_CLAIMS_OWNERSHIP', 'REFS_ON_UNSUCCESSFUL_EVENT'] as const;
export type BrainEventRefusal = (typeof BRAIN_EVENT_REFUSALS)[number];

/** Whether an event is fit to publish: a pointer, never a payload and never an owner. */
export function brainJobEventRefusals(event: Record<string, unknown>): BrainEventRefusal[] {
  const out: BrainEventRefusal[] = [];
  if (!(BRAIN_JOB_EVENT_NAMES as readonly unknown[]).includes(event.name)) out.push('UNKNOWN_EVENT');
  if (Object.keys(event).some((k) => !(BRAIN_JOB_EVENT_FIELDS as readonly string[]).includes(k))) out.push('EVENT_CARRIES_CONTENT');
  const refs = Array.isArray(event.resultRefs) ? (event.resultRefs as unknown[]) : [];
  for (const ref of refs) {
    const owner = (ref as { owner?: { authority?: unknown } } | null)?.owner?.authority;
    if (typeof owner !== 'string' || !(BRAIN_RESULT_OWNERS as readonly string[]).includes(owner)) out.push('EVENT_CLAIMS_OWNERSHIP');
    const keys = ref && typeof ref === 'object' ? Object.keys(ref) : [];
    if (keys.some((k) => !['owner', 'subjectId', 'artifactId'].includes(k))) out.push('EVENT_CARRIES_CONTENT');
  }
  if (refs.length > 0 && event.name !== 'brain.job.succeeded') out.push('REFS_ON_UNSUCCESSFUL_EVENT');
  return [...new Set(out)];
}
