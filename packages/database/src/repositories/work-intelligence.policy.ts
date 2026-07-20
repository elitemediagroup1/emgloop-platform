// Sprint 27 — Work Intelligence Foundation (PR #121A)
// ---------------------------------------------------------------------------
// PURE policy for the Work OS instance-lifecycle. No I/O, no Prisma, no clock
// except an injected `now`, no RNG. Every "decision about MEANING" the sprint
// depends on lives here so it can be pinned deterministically by tests:
//
//   * the status transition graph and its guards,
//   * requirement satisfaction and DERIVED readiness (unknown ≠ satisfied,
//     non-required ≠ missing, expired/revoked evidence revokes readiness),
//   * version-specific approval truth (only the current version counts,
//     internal ≠ buyer, a new version inherits nothing),
//   * responsibility routing preference (never silently pick an arbitrary user),
//   * deterministic dedupe keys.
//
// Readiness is NEVER stored as an editable boolean; it is always derived here.
//
// This module is imported transitively by client bundles (via the database
// barrel), so it MUST stay free of Node built-ins — hence the pure-JS hash below
// instead of node:crypto.
// ---------------------------------------------------------------------------

// ---- Work source (provenance) ---------------------------------------------
export const WORK_SOURCES = ['manual', 'brain', 'rule'] as const;
export type WorkSource = (typeof WORK_SOURCES)[number];

// ---- Instance lifecycle ----------------------------------------------------
export const WORK_STATUSES = [
  'draft',
  'open',
  'in_progress',
  'blocked',
  'waiting',
  'completed',
  'verified',
  'reopened',
  'cancelled',
  'archived',
] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

// 'active' is the PR #75 blueprint-runtime legacy value. It remains valid on the
// column but is NOT part of the Sprint 27 instance-lifecycle graph; the new
// lifecycle methods refuse to drive an instance whose status is not a WorkStatus.
export const LEGACY_WORK_STATUSES = ['active'] as const;

export type WorkStatusCategory = 'open' | 'active' | 'paused' | 'terminal';
export const WORK_STATUS_CATEGORY: Record<WorkStatus, WorkStatusCategory> = {
  draft: 'open',
  open: 'open',
  in_progress: 'active',
  reopened: 'active',
  blocked: 'paused',
  waiting: 'paused',
  completed: 'terminal',
  verified: 'terminal',
  cancelled: 'terminal',
  archived: 'terminal',
};

// The allowed transition graph (see the Phase B WORK LIFECYCLE section).
export const ALLOWED_TRANSITIONS: Record<WorkStatus, readonly WorkStatus[]> = {
  draft: ['open', 'cancelled'],
  open: ['in_progress', 'blocked', 'waiting', 'cancelled', 'archived'],
  in_progress: ['blocked', 'waiting', 'completed', 'cancelled'],
  blocked: ['in_progress', 'waiting', 'cancelled'],
  waiting: ['in_progress', 'blocked', 'cancelled'],
  completed: ['verified', 'reopened', 'archived'],
  verified: ['reopened', 'archived'],
  reopened: ['in_progress', 'cancelled'],
  cancelled: ['reopened', 'archived'],
  archived: [],
};

// cancelled → reopened is only reachable through an explicit privileged action.
export const PRIVILEGED_TRANSITIONS: ReadonlyArray<[WorkStatus, WorkStatus]> = [
  ['cancelled', 'reopened'],
];

export function isWorkStatus(value: string): value is WorkStatus {
  return (WORK_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: WorkStatus, to: WorkStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export function isPrivilegedTransition(from: WorkStatus, to: WorkStatus): boolean {
  return PRIVILEGED_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

// A transition to 'blocked' is only meaningful with an active blocker record.
export function requiresActiveBlocker(to: WorkStatus): boolean {
  return to === 'blocked';
}

// A transition to 'waiting' is only meaningful with waiting-on information.
export function requiresWaitingInfo(to: WorkStatus): boolean {
  return to === 'waiting';
}

// ---- Work types ------------------------------------------------------------
export const SETUP_WORK_TYPES = ['buyer_setup', 'vendor_setup'] as const;

// Setup work requires an INDEPENDENT verifier (verifier ≠ completer). Preserved
// as a predicate so future responsibility-based verifier rules can extend it.
export function requiresIndependentVerifier(workType: string | null | undefined): boolean {
  return workType != null && (SETUP_WORK_TYPES as readonly string[]).includes(workType);
}

// ---- Requirements & readiness ---------------------------------------------
export const WORK_REQUIREMENT_STATUSES = [
  'not_required',
  'unknown',
  'missing',
  'requested',
  'received',
  'under_review',
  'redlining',
  'partial',
  'complete',
  'signed',
  'approved',
  'rejected',
  'expired',
  'revoked',
] as const;
export type WorkRequirementStatus = (typeof WORK_REQUIREMENT_STATUSES)[number];

export const REQUIREMENT_CATEGORIES = [
  'contract',
  'specification',
  'asset_approval',
  'info',
  'other',
] as const;
export type RequirementCategory = (typeof REQUIREMENT_CATEGORIES)[number];

// Which statuses count as "satisfied", by category — STATUS-ONLY. Note that
// asset_approval is intentionally NOT satisfiable by status alone: asset approval
// truth comes from current-version approval records, never from a hand-set status.
const SATISFYING_STATUS: Record<RequirementCategory, ReadonlySet<WorkRequirementStatus>> = {
  contract: new Set(['signed', 'approved']),
  specification: new Set(['complete', 'approved']),
  asset_approval: new Set(), // must be resolved via approval facts
  info: new Set(['complete', 'received', 'approved']),
  other: new Set(['complete', 'approved']),
};

export interface RequirementLike {
  key: string;
  category?: string | null;
  required: boolean;
  status: string;
  expiresAt?: Date | null;
}

function normalizeCategory(category: string | null | undefined): RequirementCategory {
  return category != null && (REQUIREMENT_CATEGORIES as readonly string[]).includes(category)
    ? (category as RequirementCategory)
    : 'other';
}

// STATUS-ONLY satisfaction (does not consult approval facts). asset_approval
// always returns false here by design.
export function requirementSatisfiedByStatus(req: RequirementLike): boolean {
  const category = normalizeCategory(req.category);
  return SATISFYING_STATUS[category].has(req.status as WorkRequirementStatus);
}

export interface ReadinessOptions {
  now?: Date;
  // Resolver for asset_approval requirements: returns whether the linked asset's
  // CURRENT version is approved at the required scope. Absent ⇒ treated as not
  // satisfied (unknown is never satisfied).
  approvalSatisfied?: (req: RequirementLike) => boolean;
}

export interface ReadinessResult {
  ready: boolean;
  requiredCount: number;
  satisfiedCount: number;
  unsatisfied: { key: string; reason: string }[];
  evaluatedAt: Date;
}

// DERIVE requirement readiness. Non-required rows are excluded entirely.
// Expired/revoked/rejected evidence never counts. Unknown never counts.
export function deriveReadiness(
  requirements: readonly RequirementLike[],
  opts: ReadinessOptions = {},
): ReadinessResult {
  const now = opts.now ?? new Date();
  const applicable = requirements.filter((r) => r.required === true);
  const unsatisfied: { key: string; reason: string }[] = [];

  for (const req of applicable) {
    if (req.status === 'revoked') {
      unsatisfied.push({ key: req.key, reason: 'evidence revoked' });
      continue;
    }
    if (req.status === 'expired' || (req.expiresAt != null && req.expiresAt <= now)) {
      unsatisfied.push({ key: req.key, reason: 'evidence expired' });
      continue;
    }
    if (req.status === 'rejected') {
      unsatisfied.push({ key: req.key, reason: 'rejected' });
      continue;
    }
    const category = normalizeCategory(req.category);
    const satisfied =
      category === 'asset_approval'
        ? opts.approvalSatisfied?.(req) === true
        : requirementSatisfiedByStatus(req);
    if (!satisfied) {
      unsatisfied.push({ key: req.key, reason: `status '${req.status}' does not satisfy` });
    }
  }

  return {
    ready: unsatisfied.length === 0,
    requiredCount: applicable.length,
    satisfiedCount: applicable.length - unsatisfied.length,
    unsatisfied,
    evaluatedAt: now,
  };
}

// ---- Version-specific approval truth --------------------------------------
export const APPROVAL_SCOPES = ['internal', 'buyer'] as const;
export type ApprovalScope = (typeof APPROVAL_SCOPES)[number];

export const APPROVAL_DECISIONS = ['approved', 'rejected', 'revision_requested'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export interface ApprovalLike {
  workAssetVersionId: string;
  scope: string;
  decision: string;
  decidedAt: Date;
  revokedAt?: Date | null;
}

// The LATEST non-revoked decision for a (version, scope), or null if none.
// This makes an 'approved' that is later superseded by a 'revision_requested'
// no longer count — the truth is the most recent live decision.
export function latestDecision(
  approvals: readonly ApprovalLike[],
  versionId: string,
  scope: ApprovalScope,
): ApprovalDecision | null {
  const live = approvals
    .filter((a) => a.workAssetVersionId === versionId && a.scope === scope && a.revokedAt == null)
    .sort((a, b) => a.decidedAt.getTime() - b.decidedAt.getTime());
  const last = live[live.length - 1];
  return last ? (last.decision as ApprovalDecision) : null;
}

// Is a SPECIFIC version approved at a scope? Only the latest live decision counts.
export function isVersionApprovedAtScope(
  approvals: readonly ApprovalLike[],
  versionId: string,
  scope: ApprovalScope,
): boolean {
  return latestDecision(approvals, versionId, scope) === 'approved';
}

export interface AssetLike {
  id: string;
  currentVersion: number;
}
export interface AssetVersionLike {
  id: string;
  workAssetId: string;
  version: number;
}

// Is the asset's CURRENT version approved at scope? A brand-new version (with no
// approvals) is not approved; an approval on a prior version does not carry over.
export function isCurrentVersionApproved(
  asset: AssetLike,
  versions: readonly AssetVersionLike[],
  approvals: readonly ApprovalLike[],
  scope: ApprovalScope,
): boolean {
  const current = versions.find(
    (v) => v.workAssetId === asset.id && v.version === asset.currentVersion,
  );
  if (!current) return false;
  return isVersionApprovedAtScope(approvals, current.id, scope);
}

// ---- Responsibility routing -----------------------------------------------
export const RESPONSIBILITY_KEYS = [
  'CALLGRID_SETUP',
  'CONTRACT_REVIEW',
  'CONTRACT_APPROVAL',
  'SALES',
  'CREATOR_MANAGEMENT',
  'BRAND_MANAGEMENT',
  'CREATIVE_REVIEW',
  'URL_REVIEW',
  'BUYER_APPROVAL_COORDINATION',
  'CALLGRID_OPTIMIZATION',
  'ACCOUNTING',
  'OPERATIONAL_COMMUNICATIONS',
] as const;
export type ResponsibilityKey = (typeof RESPONSIBILITY_KEYS)[number];

export type RoutingVia = 'explicit' | 'primary' | 'secondary' | 'needs_owner' | 'ambiguous';

export interface AssignmentLike {
  userId: string;
  assignmentType: string; // 'primary' | 'secondary'
  active: boolean;
}

export interface RoutingResult {
  userId: string | null;
  via: RoutingVia;
}

// Resolve the responsible actor WITHOUT ever silently picking an arbitrary user.
// Preference: explicit owner → single active primary → single active secondary →
// Needs Owner. Genuine ambiguity (more than one candidate at a tier) resolves to
// Needs Owner ('ambiguous'), never to a guess.
export function resolveRoutingPreference(input: {
  explicitOwnerUserId?: string | null;
  assignments: readonly AssignmentLike[];
}): RoutingResult {
  if (input.explicitOwnerUserId) {
    return { userId: input.explicitOwnerUserId, via: 'explicit' };
  }
  const activePrimary = input.assignments.filter((a) => a.active && a.assignmentType === 'primary');
  if (activePrimary.length === 1) return { userId: activePrimary[0]!.userId, via: 'primary' };
  if (activePrimary.length > 1) return { userId: null, via: 'ambiguous' };

  const activeSecondary = input.assignments.filter(
    (a) => a.active && a.assignmentType === 'secondary',
  );
  if (activeSecondary.length === 1) return { userId: activeSecondary[0]!.userId, via: 'secondary' };
  if (activeSecondary.length > 1) return { userId: null, via: 'ambiguous' };

  return { userId: null, via: 'needs_owner' };
}

// ---- Deduplication ---------------------------------------------------------
export interface DedupeComponents {
  organizationId: string;
  workType: string;
  ruleId: string;
  subjectType: string;
  subjectRef: string;
  conditionClass: string;
}

// A deterministic key for system-proposed work. The same normalized tuple always
// yields the same key; any difference yields a different key. Normalization
// lower-cases and trims so trivial variants collapse. Uses a pure-JS FNV-1a
// (64-bit) so this module stays bundler-safe (no Node built-ins); dedupe needs
// determinism and good distribution, not cryptographic strength — the DB unique
// constraint on (organizationId, dedupeKey) is the real guard.
export function buildDedupeKey(c: DedupeComponents): string {
  const norm = (s: string) => s.trim().toLowerCase();
  const tuple = [
    norm(c.organizationId),
    norm(c.workType),
    norm(c.ruleId),
    norm(c.subjectType),
    norm(c.subjectRef),
    norm(c.conditionClass),
  ].join('');
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < tuple.length; i++) {
    hash ^= BigInt(tuple.charCodeAt(i));
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

// ---- Event & attribution vocabularies -------------------------------------
export const WORK_EVENT_TYPES = [
  'created',
  'proposed',
  'accepted',
  'assigned',
  'reassigned',
  'started',
  'requirement_changed',
  'readiness_changed',
  'blocked',
  'unblocked',
  'waiting_started',
  'waiting_ended',
  'handoff_proposed',
  'handoff_accepted',
  'handoff_rejected',
  'asset_added',
  'asset_version_added',
  'approval_recorded',
  'approval_revoked',
  'completed',
  'verified',
  'reopened',
  'cancelled',
  'archived',
  'linked',
  'comment_added',
] as const;
export type WorkEventType = (typeof WORK_EVENT_TYPES)[number];

export const WAITING_ON_TYPES = [
  'internal_user',
  'internal_responsibility',
  'buyer',
  'vendor',
  'client',
  'creator',
  'external_party',
  'system',
  'unknown',
] as const;
export type WaitingOnType = (typeof WAITING_ON_TYPES)[number];

export const ATTRIBUTION_TYPES = [
  'buyer',
  'destination',
  'vendor',
  'source',
  'campaign',
  'customer',
  'general',
] as const;
export type AttributionType = (typeof ATTRIBUTION_TYPES)[number];

export const WORK_LINK_TYPES = [
  'observation',
  'recommendation',
  'evidence',
  'customer',
  'conversation',
  'marketplace_call',
  'marketplace_report_run',
  'buyer',
  'destination',
  'vendor',
  'source',
  'campaign',
  'contract',
  'file',
  'url',
  'manual_note',
] as const;
export type WorkLinkType = (typeof WORK_LINK_TYPES)[number];
