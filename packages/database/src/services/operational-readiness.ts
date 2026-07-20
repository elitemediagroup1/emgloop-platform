// Sprint 27B — Operational Readiness Engine (PR #121B)
// ---------------------------------------------------------------------------
// A PROVIDER-NEUTRAL engine that decides whether a real-world business process
// has satisfied every required prerequisite and is therefore eligible to move to
// its next operational stage. It sits between Decision and Work in the platform
// flow:
//
//   Information → Evidence → Reasoning → Decision → OPERATIONAL READINESS →
//   Suggested Handoff → Human Confirmation → Work Execution → Verification → Memory
//
// It is NOT part of Work OS. Work is created FROM readiness; readiness is NEVER
// created from work. Concretely that means this module NEVER reads a WorkInstance
// and NEVER writes one. Readiness is a DERIVED conclusion over supplied evidence,
// never a stored or user-entered state — there is no `ready` column anywhere.
//
// Discipline (why this file is pure):
//  - No I/O, no Prisma, no clock except an injected `now`, no RNG. The kernel is
//    deterministic so the verification suite can pin the decisions about MEANING:
//    required vs not-required, expired/revoked evidence, waiting vs incomplete vs
//    blocked, version-specific approvals, and responsibility routing.
//  - Buyer/Vendor knowledge lives ONLY in adapters (operational-readiness.adapters
//    .ts). The kernel here knows nothing about buyers or vendors; an adapter
//    supplies the requirement set and maps its own evidence to per-requirement
//    outcomes. New readiness types plug in by registering an adapter — the kernel
//    does not change.
//  - Requirement-satisfaction SEMANTICS are NOT re-implemented here. They are the
//    same rules the Sprint 27 foundation already derives readiness from
//    (work-intelligence.policy.ts): unknown never satisfies, non-required is
//    excluded (≠ missing), expired/revoked/rejected evidence never counts, and
//    asset approvals are version-specific. This engine adds the state / disposition
//    / responsibility layer ON TOP of those rules; it does not fork them.
// ---------------------------------------------------------------------------

import {
  requirementSatisfiedByStatus,
  isCurrentVersionApproved,
  type RequirementCategory,
  type WorkRequirementStatus,
  type ResponsibilityKey,
  type WaitingOnType,
  type ApprovalScope,
  type AssetLike,
  type AssetVersionLike,
  type ApprovalLike,
  type AttributionType,
} from '../repositories/work-intelligence.policy';

// ===========================================================================
// Contract vocabularies
// ===========================================================================

// The DERIVED conclusion about a process. The engine distinguishes these five —
// "Not Ready" is never a single undifferentiated bucket:
//   ready              every required prerequisite satisfied → eligible to advance
//   incomplete         required prerequisites remain and an INTERNAL responsibility
//                      can act to satisfy them → executable work exists
//   waiting            the only unsatisfied prerequisites depend on an EXTERNAL
//                      party (buyer / vendor / documents) → attention, not work
//   blocked            an active hard blocker prevents progress
//   attention_required not ready, and the remaining gap is neither internally
//                      actionable nor a clean external wait (e.g. orphaned or
//                      lapsed evidence needing a human decision)
export const READINESS_STATES = [
  'ready',
  'incomplete',
  'waiting',
  'blocked',
  'attention_required',
] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

// What Loop should DO about the conclusion. The engine only ever SUGGESTS; it
// never creates work. Human confirmation sits between a suggestion and any work.
export const READINESS_DISPOSITIONS = ['no_action', 'attention', 'suggested_handoff'] as const;
export type ReadinessDisposition = (typeof READINESS_DISPOSITIONS)[number];

// The derived outcome for a SINGLE requirement.
//   satisfied     evidence satisfies it
//   missing       required, unsatisfied, internally actionable (incl. plain unknown)
//   waiting       required, unsatisfied, satisfaction depends on an external party
//   blocked       an active hard blocker is attached to this requirement
//   expired       satisfying evidence has expired (revokes readiness)
//   revoked       satisfying evidence has been revoked (revokes readiness)
//   not_required  applicability=false — informational, NEVER fails readiness
export const REQUIREMENT_FACETS = [
  'satisfied',
  'missing',
  'waiting',
  'blocked',
  'expired',
  'revoked',
  'not_required',
] as const;
export type RequirementFacet = (typeof REQUIREMENT_FACETS)[number];

// Confidence in the conclusion, categorical for display + a 0..1 score for tests.
export const READINESS_CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type ReadinessConfidenceLevel = (typeof READINESS_CONFIDENCE_LEVELS)[number];

// ===========================================================================
// Evidence & requirement shapes
// ===========================================================================

// An honest pointer to where a piece of evidence lives. Not a polymorphic FK —
// mirrors WorkLink's "named by type + ref, validated elsewhere" convention.
export interface EvidenceRef {
  kind: string; // e.g. contract | specification | asset_version | url | document | note
  label: string;
  refId?: string | null; // internal id when the target is a Loop row
  externalRef?: string | null; // url / external identifier otherwise
}

// A hard blocker asserted against the process. A blocker WITHOUT a requirementKey
// blocks the whole process; one WITH a key blocks only that requirement.
export interface ReadinessBlocker {
  requirementKey?: string | null;
  reason: string;
  waitingParty?: WaitingOnType | null;
}

// The subject a readiness evaluation is ABOUT. Soft attribution only — canonical
// buyer/vendor entities deliberately do not exist yet (see WORK_INTELLIGENCE
// truth #4). The engine never creates one.
export interface ReadinessSubject {
  attributionType: AttributionType;
  label: string;
  externalId?: string | null;
}

// A requirement AFTER an adapter has evaluated it against evidence. This is the
// adapter → kernel interface. Adapters own evidence shape + mapping; the kernel
// owns aggregation and never sees raw provider evidence.
export interface EvaluatedRequirement {
  key: string;
  label: string;
  category: RequirementCategory;
  required: boolean; // applicability RESULT (Required=false never fails readiness)
  facet: RequirementFacet;
  responsibility: ResponsibilityKey | null; // internal owner who can satisfy it
  waitingParty: WaitingOnType | null; // external party when the facet is 'waiting'
  reason: string; // why this facet — always points at evidence or its absence
  evidenceRefs: EvidenceRef[];
}

// ===========================================================================
// classifyFacet — the ONE place requirement satisfaction becomes a facet.
// ---------------------------------------------------------------------------
// Adapters MUST route every requirement through here so satisfaction semantics
// stay identical to the Sprint 27 foundation (work-intelligence.policy.ts). The
// kernel then aggregates facets; it never classifies.
// ===========================================================================
export interface FacetInput {
  required: boolean;
  category: RequirementCategory;
  status: WorkRequirementStatus;
  expiresAt?: Date | null;
  // For category 'asset_approval' only: whether the linked asset's CURRENT version
  // is approved at every required scope. Absent ⇒ not satisfied (unknown).
  approvalSatisfied?: boolean;
  // An active hard blocker specifically attached to this requirement.
  hardBlocked?: boolean;
  // When unsatisfied, the EXTERNAL party satisfaction depends on. Setting this
  // turns a 'missing' into a 'waiting' (attention, not executable work). Internal
  // waiting-on values (internal_user/internal_responsibility) are treated as
  // internally actionable and do NOT downgrade to waiting.
  waitingParty?: WaitingOnType | null;
}

function isExternalWaitingParty(party: WaitingOnType | null | undefined): boolean {
  return (
    party != null &&
    party !== 'internal_user' &&
    party !== 'internal_responsibility' &&
    party !== 'unknown'
  );
}

export function classifyFacet(input: FacetInput, now: Date): RequirementFacet {
  // Non-required is excluded from readiness entirely — it is NOT missing.
  if (input.required !== true) return 'not_required';
  if (input.hardBlocked === true) return 'blocked';

  // Revoked / expired evidence revokes readiness (checked before satisfaction so a
  // formerly-satisfying status that has lapsed cannot slip through).
  if (input.status === 'revoked') return 'revoked';
  if (input.status === 'expired' || (input.expiresAt != null && input.expiresAt <= now)) {
    return 'expired';
  }

  const satisfied =
    input.category === 'asset_approval'
      ? input.approvalSatisfied === true
      : requirementSatisfiedByStatus({
          key: '',
          category: input.category,
          required: true,
          status: input.status,
        });
  if (satisfied) return 'satisfied';

  // Unsatisfied. An external dependency is a WAIT (attention); anything else is
  // internally actionable MISSING work. Unknown never satisfies → missing/waiting.
  return isExternalWaitingParty(input.waitingParty) ? 'waiting' : 'missing';
}

// Convenience for adapters with an asset_approval requirement: resolve the
// current-version approval fact across every required scope, reusing the policy's
// version-specific truth (a new version inherits nothing; only the latest live
// decision counts). Returns undefined when no asset is supplied (⇒ unknown).
export function currentVersionApprovedAtScopes(
  asset: AssetLike | null | undefined,
  versions: readonly AssetVersionLike[],
  approvals: readonly ApprovalLike[],
  scopes: readonly ApprovalScope[],
): boolean | undefined {
  if (!asset) return undefined;
  return scopes.every((scope) => isCurrentVersionApproved(asset, versions, approvals, scope));
}

// ===========================================================================
// Adapter interface & registry
// ===========================================================================

// An adapter supplies the requirement set for ONE operational process and maps
// its own (strongly-typed) evidence to EvaluatedRequirements. It also names the
// responsibility that owns the DOWNSTREAM action once the process is ready
// (advanceResponsibility) — used to suggest the next handoff.
export interface ReadinessAdapter<TEvidence> {
  processType: string;
  title: string;
  advanceResponsibility: ResponsibilityKey | null;
  evaluate(evidence: TEvidence, now: Date): EvaluatedRequirement[];
}

const REGISTRY = new Map<string, ReadinessAdapter<unknown>>();

export function registerReadinessAdapter<T>(adapter: ReadinessAdapter<T>): void {
  REGISTRY.set(adapter.processType, adapter as ReadinessAdapter<unknown>);
}

export function getReadinessAdapter(processType: string): ReadinessAdapter<unknown> | null {
  return REGISTRY.get(processType) ?? null;
}

export function registeredReadinessProcessTypes(): string[] {
  return [...REGISTRY.keys()].sort();
}

// ===========================================================================
// The readiness conclusion (the reusable contract)
// ===========================================================================
export interface ReadinessResult {
  processType: string;
  subject: ReadinessSubject;
  state: ReadinessState;
  disposition: ReadinessDisposition;
  completionPct: number; // 0..100 over APPLICABLE (required) requirements
  // The next responsibility that should ACT to move readiness forward. A KEY, not
  // a user — Loop resolves the person separately. Null when no internal action is
  // the next step (waiting / blocked / already advanced).
  nextResponsibilityKey: ResponsibilityKey | null;
  requiredCount: number;
  satisfiedCount: number;
  satisfied: EvaluatedRequirement[];
  unsatisfied: EvaluatedRequirement[]; // missing + waiting + expired + revoked
  blocked: EvaluatedRequirement[];
  notApplicable: EvaluatedRequirement[]; // not_required — informational only
  warnings: string[];
  informationalNotes: string[];
  reason: string; // WHY — always references the deciding evidence/gaps
  supportingEvidence: EvidenceRef[];
  confidence: number; // 0..1
  confidenceLevel: ReadinessConfidenceLevel;
  derivedAt: Date;
}

function pct(numerator: number, denominator: number): number {
  if (denominator === 0) return 100;
  return Math.round((numerator / denominator) * 100);
}

function confidenceLevel(score: number): ReadinessConfidenceLevel {
  if (score >= 0.85) return 'high';
  if (score >= 0.5) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// aggregate — turn per-requirement facets into the readiness conclusion. This is
// the whole of the kernel's "reasoning": everything provider-specific already
// happened in the adapter. Deterministic given `evaluated` + `now`.
// ---------------------------------------------------------------------------
export function aggregate(
  processType: string,
  subject: ReadinessSubject,
  evaluated: readonly EvaluatedRequirement[],
  adapter: Pick<ReadinessAdapter<unknown>, 'advanceResponsibility'>,
  globalBlockers: readonly ReadinessBlocker[],
  now: Date,
): ReadinessResult {
  const notApplicable = evaluated.filter((r) => r.facet === 'not_required');
  const applicable = evaluated.filter((r) => r.facet !== 'not_required');

  const satisfied = applicable.filter((r) => r.facet === 'satisfied');
  const blocked = applicable.filter((r) => r.facet === 'blocked');
  const waiting = applicable.filter((r) => r.facet === 'waiting');
  const lapsed = applicable.filter((r) => r.facet === 'expired' || r.facet === 'revoked');
  const missing = applicable.filter((r) => r.facet === 'missing');
  const unsatisfied = applicable.filter((r) => r.facet !== 'satisfied');

  // A process-wide blocker (no requirementKey) forces the whole thing blocked.
  const hasGlobalBlocker = globalBlockers.some((b) => b.requirementKey == null);

  // "Internally actionable" = a gap an internal responsibility can close now:
  // plain missing work OR lapsed evidence someone must renew. Both have an owner.
  const internallyActionable = [...missing, ...lapsed].filter((r) => r.responsibility != null);
  // A gap with neither an owner nor an external party is an orphan → attention.
  const orphaned = [...missing, ...lapsed].filter(
    (r) => r.responsibility == null && !isExternal(r.waitingParty),
  );

  let state: ReadinessState;
  if (hasGlobalBlocker || blocked.length > 0) {
    state = 'blocked';
  } else if (unsatisfied.length === 0) {
    state = 'ready';
  } else if (internallyActionable.length > 0) {
    state = 'incomplete';
  } else if (waiting.length > 0 && orphaned.length === 0) {
    state = 'waiting';
  } else {
    state = 'attention_required';
  }

  // Next responsibility to act. For a ready process it is the DOWNSTREAM owner
  // (advance). For incomplete work it is the owner of the first actionable gap,
  // in the adapter's declared requirement order (deterministic — never guessed).
  let nextResponsibilityKey: ResponsibilityKey | null = null;
  if (state === 'ready') {
    nextResponsibilityKey = adapter.advanceResponsibility;
  } else if (state === 'incomplete') {
    nextResponsibilityKey = internallyActionable[0]?.responsibility ?? null;
  }

  // Disposition: ready or incomplete → a suggested handoff to the next
  // responsibility; blocked / waiting / attention → attention. A ready process
  // with no downstream owner has nothing to hand off → no_action.
  let disposition: ReadinessDisposition;
  if (state === 'ready') {
    disposition = nextResponsibilityKey ? 'suggested_handoff' : 'no_action';
  } else if (state === 'incomplete') {
    disposition = nextResponsibilityKey ? 'suggested_handoff' : 'attention';
  } else {
    disposition = 'attention';
  }

  const warnings: string[] = [];
  for (const r of lapsed) {
    warnings.push(
      `${r.label} evidence ${r.facet === 'expired' ? 'has expired' : 'was revoked'} — readiness revoked (${r.reason})`,
    );
  }
  for (const r of orphaned) {
    warnings.push(`${r.label} is unsatisfied with no responsible party and no external dependency`);
  }
  for (const b of globalBlockers.filter((b) => b.requirementKey == null)) {
    warnings.push(`Process blocked: ${b.reason}`);
  }

  const informationalNotes = notApplicable.map((r) => `${r.label} not required — ${r.reason}`);
  for (const r of waiting) {
    informationalNotes.push(`Waiting on ${r.waitingParty ?? 'external party'}: ${r.label}`);
  }

  const supportingEvidence = evaluated.flatMap((r) => r.evidenceRefs);

  // Confidence: fraction of applicable requirements whose evidence is KNOWN (a
  // facet other than plain 'missing'-from-unknown counts as known). Concretely we
  // treat 'missing' as the only low-information facet; satisfied/waiting/blocked/
  // expired/revoked are all backed by an observation. A ready conclusion has zero
  // missing by construction ⇒ full confidence.
  const known = applicable.filter((r) => r.facet !== 'missing').length;
  const confidence = applicable.length === 0 ? 1 : known / applicable.length;

  return {
    processType,
    subject,
    state,
    disposition,
    completionPct: pct(satisfied.length, applicable.length),
    nextResponsibilityKey,
    requiredCount: applicable.length,
    satisfiedCount: satisfied.length,
    satisfied,
    unsatisfied,
    blocked,
    notApplicable,
    warnings,
    informationalNotes,
    reason: composeReason(state, subject, {
      satisfied,
      applicable,
      missing,
      waiting,
      lapsed,
      blocked,
      globalBlockers,
    }),
    supportingEvidence,
    confidence,
    confidenceLevel: confidenceLevel(confidence),
    derivedAt: now,
  };
}

function isExternal(party: WaitingOnType | null): boolean {
  return isExternalWaitingParty(party);
}

function labels(reqs: readonly EvaluatedRequirement[]): string {
  return reqs.map((r) => r.label).join(', ');
}

function composeReason(
  state: ReadinessState,
  subject: ReadinessSubject,
  ctx: {
    satisfied: EvaluatedRequirement[];
    applicable: EvaluatedRequirement[];
    missing: EvaluatedRequirement[];
    waiting: EvaluatedRequirement[];
    lapsed: EvaluatedRequirement[];
    blocked: EvaluatedRequirement[];
    globalBlockers: readonly ReadinessBlocker[];
  },
): string {
  const s = `${ctx.satisfied.length} of ${ctx.applicable.length} required prerequisites satisfied`;
  switch (state) {
    case 'ready':
      return `${subject.label}: all ${ctx.applicable.length} required prerequisites satisfied — eligible to advance.`;
    case 'blocked': {
      const g = ctx.globalBlockers.find((b) => b.requirementKey == null);
      const detail = g ? g.reason : labels(ctx.blocked) || 'active blocker';
      return `${subject.label}: blocked (${detail}). ${s}.`;
    }
    case 'incomplete': {
      const gaps = [...ctx.missing, ...ctx.lapsed];
      return `${subject.label}: ${s}. Missing: ${labels(gaps)}.`;
    }
    case 'waiting':
      return `${subject.label}: ${s}. Waiting on external parties: ${labels(ctx.waiting)}.`;
    default:
      return `${subject.label}: ${s}. Needs attention: ${labels([...ctx.missing, ...ctx.lapsed, ...ctx.waiting])}.`;
  }
}

// ===========================================================================
// evaluateReadiness — the public kernel entry point (registry-dispatched).
// ===========================================================================
export interface ReadinessRequest<TEvidence = unknown> {
  processType: string;
  subject: ReadinessSubject;
  evidence: TEvidence;
  blockers?: ReadinessBlocker[];
  now?: Date;
}

// Evaluate a request through its registered adapter. Provider-neutral: the kernel
// selects the adapter, lets it produce facets from its own evidence, applies any
// per-requirement hard blockers, and aggregates. Throws only for an unknown
// process type (fail loud — a missing adapter is a wiring bug, not a tenant input).
export function evaluateReadiness<T>(request: ReadinessRequest<T>): ReadinessResult {
  const adapter = getReadinessAdapter(request.processType);
  if (!adapter) {
    throw new Error(`No readiness adapter registered for process type: ${request.processType}`);
  }
  const now = request.now ?? new Date();
  const blockers = request.blockers ?? [];
  const blockedKeys = new Set(
    blockers.filter((b) => b.requirementKey != null).map((b) => b.requirementKey as string),
  );

  const evaluated = adapter.evaluate(request.evidence, now).map((r): EvaluatedRequirement => {
    // A per-requirement hard blocker overrides the adapter's facet (unless the
    // requirement is not applicable — a blocker cannot resurrect a non-requirement).
    if (r.facet !== 'not_required' && blockedKeys.has(r.key)) {
      const b = blockers.find((x) => x.requirementKey === r.key)!;
      return { ...r, facet: 'blocked', reason: `blocked: ${b.reason}` };
    }
    return r;
  });

  return aggregate(request.processType, request.subject, evaluated, adapter, blockers, now);
}
