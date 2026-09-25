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
// A RESULT IS NEVER TRUTH. Every result is NON_AUTHORITATIVE (an answer, an analysis,
// a draft) or PROPOSED (a finding, a recommendation, an action) and nothing else, and
// which one is fixed by its type (`BRAIN_RESULT_TYPE_STANDING`), not by whoever owns it.
// Accepting, resolving or executing is the owning authority's act, on a person's or an
// approved policy's authority, recorded there. Every claim cites evidence Loop
// supplied, and a previous model output is never cited as if it were a governed fact.
//
// A DRAFT IS NOT A SEND (Matt and Charlie, 2026-09-16). A DRAFT is content Brain wrote
// for a person to review and use -- an email, a follow-up, a rewrite. A PROPOSED_ACTION
// asks Loop to DO something -- send that email -- and only the Decision Engine's
// approval path may hold one. Committing a draft informs; it never authorizes,
// schedules or performs the act it was written for. Sending is a separate act: a person
// sending through Communications under their own permission, or a separate
// PROPOSED_ACTION, approved on its own, that cites the draft as untrusted input. This is
// what lets Brain draft through any provider without gaining authority to send.
//
// THESE AUTHORITIES' STORES ARE NOT BUILT. This file is the contract a commit must
// satisfy; the tables behind each path arrive with the first task that needs them.
//
// PURE.

import type { AiContentTrustLevel } from './provider';

export const BRAIN_RESULT_TYPES = ['ANSWER', 'ANALYSIS', 'FINDING', 'RECOMMENDATION', 'DRAFT', 'PROPOSED_ACTION', 'TRIAGE'] as const;
export type BrainResultType = (typeof BRAIN_RESULT_TYPES)[number];

/** The only standing a result can have. Anything stronger is granted by its owner, later. */
export const BRAIN_RESULT_STANDINGS = ['NON_AUTHORITATIVE', 'PROPOSED'] as const;
export type BrainResultStanding = (typeof BRAIN_RESULT_STANDINGS)[number];

/**
 * The standing each result type has, whoever owns it. An ownership rule takes its
 * standing from here, so no rule can make a draft a proposal.
 */
export const BRAIN_RESULT_TYPE_STANDING: Readonly<Record<BrainResultType, BrainResultStanding>> = Object.freeze({
  ANSWER: 'NON_AUTHORITATIVE',
  ANALYSIS: 'NON_AUTHORITATIVE',
  FINDING: 'PROPOSED',
  RECOMMENDATION: 'PROPOSED',
  DRAFT: 'NON_AUTHORITATIVE',
  PROPOSED_ACTION: 'PROPOSED',
  // A TRIAGE verdict informs one person about one of their own messages; it proposes nothing.
  TRIAGE: 'NON_AUTHORITATIVE',
});

/** Loop authorities that may own a Brain result. */
export const BRAIN_RESULT_OWNERS = [
  'BRAIN_CONVERSATIONS',
  'COMMERCIAL_INTELLIGENCE',
  'RELATIONSHIPS',
  'CAMPAIGNS',
  // The CRM's customer conversations (IAM resource `inbox`): the authority that holds
  // communication and the only one whose people may send it.
  'COMMUNICATIONS',
  'DECISION_ENGINE',
  // One employee's own work context (Daily Loop; daily-loop-employee-intelligence.md §20.1).
  // It is its own authority because it is the only one whose results are PRIVATE TO ONE PERSON:
  // an OWNER does not hold them, an ADMIN does not hold them, and nothing here may be published
  // into an organization-level surface. It owns what Loop concludes or proposes about that
  // person's own mail and calendar, and nothing about anybody else's.
  'EMPLOYEE_INTELLIGENCE',
  // Loop Intelligence (2026-09-26): the organization's own domain readings and the business situations
  // connected across domains. Its results are never one person's: a PRINCIPAL reading is always
  // EMPLOYEE_INTELLIGENCE's, whatever domain it is about.
  'LOOP_INTELLIGENCE',
] as const;
export type BrainResultOwnerAuthority = (typeof BRAIN_RESULT_OWNERS)[number];

/** Things that record or run work and so must never own what the work produced. */
export const BRAIN_NEVER_OWNERS = ['ACTIVITY', 'BRAIN_EXECUTION', 'MODEL_PROVIDER'] as const;

/** The one result type that asks Loop to act, and the one authority whose approval path may hold it. */
export const BRAIN_ACTION_RESULT_TYPE = 'PROPOSED_ACTION' satisfies BrainResultType;
export const BRAIN_ACTION_AUTHORITY = 'DECISION_ENGINE' satisfies BrainResultOwnerAuthority;

/**
 * What a result is about. CONVERSATION is a Brain conversation; CUSTOMER_CONVERSATION is a
 * CRM conversation with a customer (`conversations`), where a reply would be sent.
 */
export const BRAIN_RESULT_SUBJECT_TYPES = [
  'CONVERSATION',
  'CASE',
  'RELATIONSHIP',
  'CAMPAIGN',
  'CUSTOMER_CONVERSATION',
  'DECISION',
  // One conversation in one employee's own mailbox. Deliberately not CUSTOMER_CONVERSATION: that
  // is the CRM's shared record of the business talking to a customer, and this is somebody's
  // private correspondence, which never becomes the other by being drafted against.
  'EMPLOYEE_MAIL_THREAD',
  // One conversation in one employee's own background source (e.g. Telegram). Deliberately not
  // EMPLOYEE_MAIL_THREAD (that is mail) and not CUSTOMER_CONVERSATION (that is the CRM's shared
  // record): this is somebody's private messaging, employee-private and never promoted.
  'EMPLOYEE_CONVERSATION',
  // Loop Intelligence (2026-09-26). A person's own domain reading (Mail, Calendar ...), the
  // organization's domain reading (CallGrid, Intake ...), a connected business situation, the check of
  // a situation's claims by an independent provider, and a person's own Briefing.
  'EMPLOYEE_DOMAIN',
  'ORGANIZATION_DOMAIN',
  'SITUATION',
  'SITUATION_CLAIMS',
  'EMPLOYEE_BRIEFING',
] as const;
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
  rule('ANSWER', 'BRAIN_CONVERSATIONS', 'CONVERSATION', 'a Brain conversation turn'),
  rule('ANALYSIS', 'COMMERCIAL_INTELLIGENCE', 'CASE', 'a Case analysis held by Commercial Intelligence'),
  rule('ANALYSIS', 'RELATIONSHIPS', 'RELATIONSHIP', 'a Relationship analysis held by the Relationship authority'),
  rule('ANALYSIS', 'CAMPAIGNS', 'CAMPAIGN', 'a Campaign analysis held by the Campaign authority'),
  rule('FINDING', 'COMMERCIAL_INTELLIGENCE', 'CASE', 'CaseFindingService, author MODEL'),
  rule('RECOMMENDATION', 'COMMERCIAL_INTELLIGENCE', 'CASE', 'CaseRecommendationService, author MODEL'),
  // Held as a draft on the conversation it would be sent in. Sending is not part of
  // this path. Drafts about other subjects (a Relationship's outreach, a Campaign's
  // copy) are each a reviewed addition here when their first task is defined.
  rule('DRAFT', 'COMMUNICATIONS', 'CUSTOMER_CONVERSATION', 'a draft held by Communications, sent only by a separate act'),
  // GM-3, and the reviewed addition the line above anticipated. A reply Loop proposes is held as
  // a draft on the employee's own thread, by the authority that is that employee -- and sending
  // it is a separate act, performed by them, under an authority (`employeeMail:send`) that no
  // machine principal can hold.
  rule('DRAFT', 'EMPLOYEE_INTELLIGENCE', 'EMPLOYEE_MAIL_THREAD', 'a reply drafted for the employee whose mail it is, sent only by that employee'),
  rule('PROPOSED_ACTION', 'DECISION_ENGINE', 'DECISION', 'a Decision Engine approval item'),
  // Content-triage slice. A conservative actionability verdict on one message in the employee's own
  // conversation, held privately to that employee -- never published into an organization surface,
  // and sent nowhere (the task publishes no tool and its result acts on nothing).
  rule('TRIAGE', 'EMPLOYEE_INTELLIGENCE', 'EMPLOYEE_CONVERSATION', 'a triage verdict held privately for the employee whose conversation it is'),
  // Loop Intelligence (2026-09-26). Each lands in exactly one governed store and proposes nothing.
  rule('TRIAGE', 'EMPLOYEE_INTELLIGENCE', 'EMPLOYEE_MAIL_THREAD', 'a mail thread reading held privately as the employee\'s own MAIL digest'),
  rule('ANALYSIS', 'EMPLOYEE_INTELLIGENCE', 'EMPLOYEE_DOMAIN', 'a person\'s own domain reading, stored as their PRINCIPAL digest'),
  rule('ANALYSIS', 'LOOP_INTELLIGENCE', 'ORGANIZATION_DOMAIN', 'an organization domain reading over Loop records, stored as an ORGANIZATION digest'),
  rule('ANALYSIS', 'LOOP_INTELLIGENCE', 'SITUATION', 'a connected situation, stored as a Case with the evidence it cites'),
  rule('ANALYSIS', 'LOOP_INTELLIGENCE', 'SITUATION_CLAIMS', 'an independent check of a situation\'s claims, recorded on that Case'),
  rule('ANALYSIS', 'EMPLOYEE_INTELLIGENCE', 'EMPLOYEE_BRIEFING', 'a person\'s own Briefing, stored in their work_briefs'),
]);

function rule(
  resultType: BrainResultType,
  authority: BrainResultOwnerAuthority,
  subjectType: BrainResultSubjectType,
  path: string,
): BrainOwnershipRule {
  return Object.freeze({ resultType, authority, subjectType, standing: BRAIN_RESULT_TYPE_STANDING[resultType], path });
}

export const BRAIN_OWNERSHIP_TABLE_VIOLATIONS = [
  'UNKNOWN_RESULT_TYPE',
  'STANDING_NOT_OF_TYPE',
  'NEVER_OWNER',
  'ACTION_OUTSIDE_APPROVAL_PATH',
  'APPROVAL_PATH_HOLDS_NON_ACTION',
  'AMBIGUOUS_OWNER',
] as const;
export type BrainOwnershipTableViolation = (typeof BRAIN_OWNERSHIP_TABLE_VIOLATIONS)[number];

/**
 * Everything wrong with an ownership table. The shipped table has none, and a test
 * holds it there. The action path is closed both ways: only the approval path holds
 * a proposed action, and it holds nothing else -- so a draft can never land where an
 * approval would execute it. One result type about one kind of subject has one owner.
 */
export function brainOwnershipTableViolations(rules: readonly BrainOwnershipRule[]): BrainOwnershipTableViolation[] {
  const out: BrainOwnershipTableViolation[] = [];
  const seen = new Map<string, string>();
  for (const r of rules) {
    if (!(BRAIN_RESULT_TYPES as readonly string[]).includes(r.resultType)) {
      out.push('UNKNOWN_RESULT_TYPE');
      continue;
    }
    if (r.standing !== BRAIN_RESULT_TYPE_STANDING[r.resultType]) out.push('STANDING_NOT_OF_TYPE');
    if ((BRAIN_NEVER_OWNERS as readonly string[]).includes(r.authority)) out.push('NEVER_OWNER');
    if (r.resultType === BRAIN_ACTION_RESULT_TYPE && r.authority !== BRAIN_ACTION_AUTHORITY) out.push('ACTION_OUTSIDE_APPROVAL_PATH');
    if (r.authority === BRAIN_ACTION_AUTHORITY && r.resultType !== BRAIN_ACTION_RESULT_TYPE) out.push('APPROVAL_PATH_HOLDS_NON_ACTION');
    const key = `${r.resultType}|${r.subjectType}`;
    const holder = seen.get(key);
    if (holder !== undefined && holder !== r.authority) out.push('AMBIGUOUS_OWNER');
    seen.set(key, r.authority);
  }
  return [...new Set(out)];
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

/** What the job itself says the result must be. Read from Loop's job record (`brainCommitExpectation`). */
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
