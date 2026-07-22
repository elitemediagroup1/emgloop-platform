// workflow.ts — the pure core of the configurable sequential workflow system.
//
// This holds the logic that MUST be correct and testable without a database:
//   - step owner resolution for every assignment mode (the heart of handoff),
//   - member de-duplication by canonical identity,
//   - custom-field definitions for Work Types,
//   - workflow-template step validation.
//
// It reuses the existing Work OS tables (Blueprint = Work Type / Workflow
// Template, WorkInstance = Work Item, WorkStage = Work Step); nothing here needs a
// new model. The repository (work.repository.ts) is a thin adapter over these
// pure functions. No clock, no I/O, no RNG.

// ---- Assignment modes -------------------------------------------------------

/**
 * How a step's owner is chosen. All five are real:
 *   specific       — a named active team member (chosen at build time)
 *   responsibility — an org responsibility, resolved to whoever owns it now
 *   creator        — whoever created the Work Item (covers "Myself")
 *   previous       — whoever completed the previous step (resolved at handoff)
 *   unassigned     — nobody yet; the step lands in "Needs an Owner"
 */
export const STEP_ASSIGN_MODES = ['specific', 'responsibility', 'creator', 'previous', 'unassigned'] as const;
export type StepAssignMode = (typeof STEP_ASSIGN_MODES)[number];

export interface StepAssignment {
  mode: StepAssignMode;
  /** Required when mode==='specific'. */
  specificUserId?: string | null;
  /** Required when mode==='responsibility'. */
  responsibilityKey?: string | null;
}

export interface StepResolutionContext {
  /** The user who created the Work Item — the 'creator' mode target. */
  creatorUserId: string;
  /** The user who completed the previous step — the 'previous' mode target. */
  previousCompleterUserId?: string | null;
  /** Org-configured responsibility → userId map (there is no responsibility model;
   *  this is the org's configurable assignment, absent ⇒ responsibility is unowned). */
  responsibilityOwners?: Record<string, string> | null;
  /** The set of currently-active member ids. A resolved owner who is no longer an
   *  active member (removed/disabled) is dropped to unassigned — fail closed. */
  activeMemberIds?: ReadonlySet<string> | null;
}

/**
 * Resolve the owner of a step, or null when the step should land in "Needs an
 * Owner". Deterministic and total: every mode is handled, and a resolved user who
 * is not (or no longer) an active member is never returned — so a removed or
 * disabled person can never be handed a step.
 */
export function resolveStepOwner(assignment: StepAssignment, ctx: StepResolutionContext): string | null {
  let candidate: string | null = null;
  switch (assignment.mode) {
    case 'specific':
      candidate = assignment.specificUserId?.trim() || null;
      break;
    case 'creator':
      candidate = ctx.creatorUserId || null;
      break;
    case 'previous':
      candidate = ctx.previousCompleterUserId?.trim() || null;
      break;
    case 'responsibility': {
      const key = assignment.responsibilityKey?.trim() || '';
      candidate = (key && ctx.responsibilityOwners && ctx.responsibilityOwners[key]) || null;
      break;
    }
    case 'unassigned':
    default:
      candidate = null;
      break;
  }
  if (candidate && ctx.activeMemberIds && !ctx.activeMemberIds.has(candidate)) return null;
  return candidate;
}

// ---- Member de-duplication --------------------------------------------------

export interface MemberLike {
  id: string;
  email: string;
  name?: string | null;
  status?: string | null;
}

/**
 * Canonical active-member list for assignee selectors. Corrects the underlying
 * source rather than filtering by display name: excludes any non-ACTIVE row
 * (removed/disabled/invited never assignable), and collapses duplicates by
 * canonical identity — the user id first, then the normalized (lowercased,
 * trimmed) email — so the same person can never appear twice even if two rows
 * share an email. Two genuinely distinct accounts (different emails) remain
 * distinct, because they are different identities.
 */
export function dedupeActiveMembers<T extends MemberLike>(rows: readonly T[]): T[] {
  const seenId = new Set<string>();
  const seenEmail = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (r.status != null && r.status !== 'ACTIVE') continue;
    const email = (r.email ?? '').trim().toLowerCase();
    if (seenId.has(r.id)) continue;
    if (email && seenEmail.has(email)) continue;
    seenId.add(r.id);
    if (email) seenEmail.add(email);
    out.push(r);
  }
  return out;
}

// ---- Custom fields (Work Type-defined information fields) --------------------

export const WORK_FIELD_TYPES = [
  'short_text', 'long_text', 'number', 'currency', 'date', 'time',
  'dropdown', 'checkbox', 'email', 'phone', 'url',
] as const;
export type WorkFieldType = (typeof WORK_FIELD_TYPES)[number];

export interface WorkFieldDef {
  key: string;
  label: string;
  helper?: string;
  type: WorkFieldType;
  required: boolean;
  /** For type==='dropdown'. */
  options?: string[];
  sortOrder: number;
  active: boolean;
}

/** Normalize a raw metadata array into valid, ordered, active-first field defs. */
export function readFieldDefs(raw: unknown): WorkFieldDef[] {
  if (!Array.isArray(raw)) return [];
  const defs: WorkFieldDef[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    const key = typeof r?.key === 'string' ? r.key : '';
    const label = typeof r?.label === 'string' ? r.label : '';
    const type = typeof r?.type === 'string' && (WORK_FIELD_TYPES as readonly string[]).includes(r.type)
      ? (r.type as WorkFieldType)
      : 'short_text';
    if (!key || !label) continue;
    defs.push({
      key,
      label,
      helper: typeof r.helper === 'string' ? r.helper : undefined,
      type,
      required: Boolean(r.required),
      options: Array.isArray(r.options) ? (r.options as unknown[]).map(String) : undefined,
      sortOrder: typeof r.sortOrder === 'number' ? r.sortOrder : 0,
      active: r.active !== false,
    });
  }
  return defs.sort((a, b) => a.sortOrder - b.sortOrder);
}

// ---- Workflow step definitions + validation ---------------------------------

export const COMPLETION_NOTE_MODES = ['none', 'optional', 'required'] as const;
export type CompletionNoteMode = (typeof COMPLETION_NOTE_MODES)[number];

/** A step as defined in the builder / a saved template (pre-runtime). */
export interface WorkflowStepDef {
  name: string;
  instruction: string; // "what needs to happen" — required
  assignment: StepAssignment;
  completionConfirmation?: string | null;
  completionNote: CompletionNoteMode;
  notifyActive: boolean;
  notifyComplete: boolean;
}

export type StepDefErrors = { index: number; errors: Partial<Record<'name' | 'instruction' | 'assignee', string>> }[];

/**
 * Validate an ordered step list. Sequential-only: there must be at least one
 * step, each needs a name + instruction, and a 'specific' step needs a member,
 * a 'responsibility' step needs a responsibility. Returns per-step errors.
 */
export function validateWorkflowSteps(steps: readonly WorkflowStepDef[]): StepDefErrors {
  const out: StepDefErrors = [];
  if (steps.length === 0) return [{ index: 0, errors: { name: 'Add at least one step.' } }];
  steps.forEach((s, index) => {
    const errors: Partial<Record<'name' | 'instruction' | 'assignee', string>> = {};
    if (!s.name?.trim()) errors.name = 'Name this step.';
    if (!s.instruction?.trim()) errors.instruction = 'Say what needs to happen.';
    if (s.assignment.mode === 'specific' && !s.assignment.specificUserId?.trim()) errors.assignee = 'Pick the team member.';
    if (s.assignment.mode === 'responsibility' && !s.assignment.responsibilityKey?.trim()) errors.assignee = 'Pick a responsibility.';
    if (Object.keys(errors).length) out.push({ index, errors });
  });
  return out;
}

/** The participant set of a Work Item: creator + every resolved step owner. Used
 *  to notify everyone when the final step completes. */
export function participantsOf(creatorUserId: string, stepOwnerIds: readonly (string | null | undefined)[]): string[] {
  const set = new Set<string>();
  if (creatorUserId) set.add(creatorUserId);
  for (const id of stepOwnerIds) if (id) set.add(id);
  return [...set];
}
