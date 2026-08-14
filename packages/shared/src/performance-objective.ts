// The Performance Objective contract, v1 -- what an organization or a person is
// trying to accomplish.
//
// WHY THIS FILE EXISTS. Commercial Intelligence defines a CI Signal as a data
// point tied to a performance objective. Loop had no such concept, so the whole
// idea of "commercially relevant" had nothing to be relevant TO. This is that
// referent, declared as a contract rather than as a document, for the same
// reason `decision-contract.ts` is: `EVENT_BUS.md` describes a system that was
// never built and three other docs now cite it, so a prose contract for a shared
// concept is a drift waiting to happen.
//
// PRISMA-FREE, deliberately. Callers depend on this contract, never on
// persistence -- the rule `cognitive-context.ts` and `decision-contract.ts`
// already follow. It is also what makes the concept PROMOTABLE: Commercial
// Intelligence owns Performance Objectives provisionally (ADR-1), and if another
// domain later needs the same abstraction, the boundary that has to move is this
// file plus one repository, not a web of imports.
//
// WHAT THIS FILE IS NOT. There is no metric, no unit, no target, no baseline, no
// attainment, no progress and no achievement state. Their absence is the design.
// Loop cannot measure objective attainment today, and a field claiming otherwise
// would be a number on screen that traces to nothing -- the failure mode this
// platform has already paid for. Knowing WHAT MATTERS precedes calculating
// whether a number was hit, and the two are separate approvals.

export const PERFORMANCE_OBJECTIVE_CONTRACT_VERSION = 'performance-objective.v1';

// --- Scope --------------------------------------------------------------------

/**
 * Whose intent an objective represents.
 *
 * EXACTLY TWO MEMBERS, and this is a constraint rather than a starting point.
 * Loop has no Team model, no Division model, no Department model and no
 * reporting relationship of any kind, so a `TEAM` member would be a scope
 * pointing at an entity that does not exist, and a free-text team name would be
 * a fabricated identifier that some later query would have to pretend to
 * resolve. A third member is added when -- and only when -- Loop has a canonical
 * entity for it to reference.
 */
export const PERFORMANCE_OBJECTIVE_SCOPES = ['ORGANIZATION', 'USER'] as const;
export type PerformanceObjectiveScope = (typeof PERFORMANCE_OBJECTIVE_SCOPES)[number];

export function isPerformanceObjectiveScope(v: string): v is PerformanceObjectiveScope {
  return (PERFORMANCE_OBJECTIVE_SCOPES as readonly string[]).includes(v);
}

export const PERFORMANCE_OBJECTIVE_SCOPE_LABELS: Record<PerformanceObjectiveScope, string> = {
  ORGANIZATION: 'Organization',
  USER: 'Person',
};

// --- Status -------------------------------------------------------------------

/**
 * The smallest lifecycle that separates current intent from historical intent.
 *
 * There is no ACHIEVED, MISSED, ON_TRACK, AT_RISK or OFF_TRACK, and there must
 * not be: each is a claim about measured performance, and Loop measures nothing
 * here. An objective is either being pursued or it is history.
 */
export const PERFORMANCE_OBJECTIVE_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type PerformanceObjectiveStatus = (typeof PERFORMANCE_OBJECTIVE_STATUSES)[number];

export function isPerformanceObjectiveStatus(v: string): v is PerformanceObjectiveStatus {
  return (PERFORMANCE_OBJECTIVE_STATUSES as readonly string[]).includes(v);
}

export const PERFORMANCE_OBJECTIVE_STATUS_LABELS: Record<PerformanceObjectiveStatus, string> = {
  ACTIVE: 'Active',
  ARCHIVED: 'Archived',
};

// --- The view -----------------------------------------------------------------

/**
 * One objective, as every caller outside the persistence layer sees it.
 *
 * Dates are ISO strings, matching how every other repository view in this
 * platform crosses the boundary (`AuditView`, `AIEmployeeView`, ...), so a
 * server component can render one without importing a Prisma type.
 */
export interface PerformanceObjectiveView {
  id: string;
  title: string;
  description: string | null;
  scope: PerformanceObjectiveScope;
  /** Set if and only if `scope` is USER. */
  scopeUserId: string | null;
  /** Denormalized for display, so a list does not need a second query. */
  scopeUserName: string | null;
  status: PerformanceObjectiveStatus;
  effectiveFrom: string;
  /** NULL means open-ended intent. Distinct from ARCHIVED, which is a decision. */
  effectiveTo: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

// --- Validation ---------------------------------------------------------------

/**
 * Why a proposed objective was refused.
 *
 * A closed vocabulary rather than free-text strings, so the server action and
 * the repository cannot drift on what counts as invalid, and so a caller can
 * switch on the reason instead of matching on a message.
 */
export const PERFORMANCE_OBJECTIVE_REJECTIONS = [
  'TITLE_REQUIRED',
  'TITLE_TOO_LONG',
  'SCOPE_INVALID',
  /** scope=USER with no scopeUserId. */
  'USER_SCOPE_REQUIRES_USER',
  /** scope=ORGANIZATION with a scopeUserId supplied. */
  'ORGANIZATION_SCOPE_FORBIDS_USER',
  /** The named user is not an active member of THIS organization. */
  'USER_NOT_IN_ORGANIZATION',
  /** effectiveTo is on or before effectiveFrom. */
  'EFFECTIVE_RANGE_INVALID',
] as const;
export type PerformanceObjectiveRejection = (typeof PERFORMANCE_OBJECTIVE_REJECTIONS)[number];

export const PERFORMANCE_OBJECTIVE_REJECTION_MESSAGES: Record<
  PerformanceObjectiveRejection,
  string
> = {
  TITLE_REQUIRED: 'Give the objective a title describing what you are trying to accomplish.',
  TITLE_TOO_LONG: `Keep the title under ${200} characters. Put the detail in the description.`,
  SCOPE_INVALID: 'Choose whether this objective belongs to the organization or to a person.',
  USER_SCOPE_REQUIRES_USER: 'Choose the person this objective belongs to.',
  ORGANIZATION_SCOPE_FORBIDS_USER:
    'An organization objective does not belong to one person. Switch the scope to Person, or clear the selection.',
  USER_NOT_IN_ORGANIZATION: 'That person is not a member of your organization.',
  EFFECTIVE_RANGE_INVALID: 'The end date must fall after the start date.',
};

export const PERFORMANCE_OBJECTIVE_TITLE_MAX = 200;

/**
 * The scope/field invariants, as a pure function.
 *
 * Pure and persistence-free so the same rule runs in the repository, in a test,
 * and (if it ever helps) in a form -- one implementation rather than three that
 * agree until they do not. It deliberately CANNOT check organization membership,
 * because that needs a query; the repository owns that check and returns
 * USER_NOT_IN_ORGANIZATION. Keeping the split explicit stops this function from
 * looking like a complete authorization gate, which it is not.
 */
export function validatePerformanceObjectiveShape(input: {
  title: string;
  scope: string;
  scopeUserId?: string | null;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
}): PerformanceObjectiveRejection | null {
  const title = input.title.trim();
  if (!title) return 'TITLE_REQUIRED';
  if (title.length > PERFORMANCE_OBJECTIVE_TITLE_MAX) return 'TITLE_TOO_LONG';
  if (!isPerformanceObjectiveScope(input.scope)) return 'SCOPE_INVALID';

  const scopedUser = input.scopeUserId ?? null;
  if (input.scope === 'USER' && !scopedUser) return 'USER_SCOPE_REQUIRES_USER';
  if (input.scope === 'ORGANIZATION' && scopedUser) return 'ORGANIZATION_SCOPE_FORBIDS_USER';

  const from = input.effectiveFrom ?? null;
  const to = input.effectiveTo ?? null;
  if (from && to && to.getTime() <= from.getTime()) return 'EFFECTIVE_RANGE_INVALID';

  return null;
}
