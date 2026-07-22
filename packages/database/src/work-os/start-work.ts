// start-work.ts — the pure decision layer behind the Start Work form.
//
// All validation, owner resolution, Eastern-time due-date interpretation and
// metadata assembly live here as ONE pure function so the server action stays a
// thin adapter and every rule is unit-tested without a database, a request, or a
// clock. The action calls buildWorkSubmission(), and on success hands the result
// straight to WorkRepository.createWorkFromBlueprint (title/description/owner +
// the assembled metadata bag on the WorkInstance).

import { easternWallTimeToUtc, BUSINESS_TIME_ZONE } from '@emgloop/shared';
import { WORK_PRIORITIES, type WorkPriority, type WorkRelationType } from './work-type-catalog';

export type AssignMode = 'auto' | 'specific' | 'unassigned';

export interface WorkRequirementInput {
  name: string;
  description?: string;
  required?: boolean;
  responsibleUserId?: string | null;
}

export interface StartWorkInput {
  workTypeId: string;
  title: string;
  outcome: string; // "what needs to be accomplished" — required
  notes?: string;
  responsibility?: string | null;
  assignMode: AssignMode;
  assigneeUserId?: string | null;
  /** The work type's configured default assignee, used when assignMode==='auto'. */
  workTypeDefaultAssigneeUserId?: string | null;
  priority: string;
  dueDate?: string; // 'YYYY-MM-DD' in Eastern, optional
  dueTime?: string; // 'HH:MM' in Eastern, optional
  relationType?: WorkRelationType;
  relationLabel?: string;
  requirements?: WorkRequirementInput[];
}

export interface WorkSubmissionMetadata {
  priority: WorkPriority;
  responsibility: string | null;
  dueAt: string | null; // UTC ISO instant
  dueTimezone: string;
  dueEastern: string | null; // the wall-clock the user entered, for honest display
  relation: { type: WorkRelationType; label: string } | null;
  requirements: { name: string; description: string | null; required: boolean; responsibleUserId: string | null }[];
  notes: string | null;
}

export interface BuiltWorkSubmission {
  title: string;
  description: string | null;
  firstOwnerUserId: string | null;
  metadata: WorkSubmissionMetadata;
}

export type WorkSubmissionErrors = Partial<
  Record<'workTypeId' | 'title' | 'outcome' | 'priority' | 'assignee' | 'dueTime', string>
>;

export type BuildResult =
  | { ok: true; value: BuiltWorkSubmission }
  | { ok: false; errors: WorkSubmissionErrors };

function isPriority(v: string): v is WorkPriority {
  return (WORK_PRIORITIES as readonly string[]).includes(v);
}

/**
 * Validate a Start Work submission and, if valid, assemble exactly what the
 * repository needs. Pure and deterministic: the only environmental input, the
 * business timezone, is a fixed constant (America/New_York); no Date.now().
 */
export function buildWorkSubmission(input: StartWorkInput): BuildResult {
  const errors: WorkSubmissionErrors = {};

  const workTypeId = input.workTypeId?.trim() ?? '';
  const title = input.title?.trim() ?? '';
  const outcome = input.outcome?.trim() ?? '';

  if (!workTypeId) errors.workTypeId = 'Choose the kind of work this is.';
  if (!title) errors.title = 'Give this work a short name.';
  if (!outcome) errors.outcome = 'Describe what needs to be accomplished.';

  const priority = isPriority(input.priority) ? input.priority : null;
  if (!priority) errors.priority = 'Choose a priority.';

  // Owner resolution — all three modes are real (owner is a userId on the stage):
  //   specific  → the chosen active member (required when this mode is picked)
  //   auto      → the work type's configured default assignee (may be none)
  //   unassigned→ no owner (surfaces in "Needs an owner")
  let firstOwnerUserId: string | null = null;
  if (input.assignMode === 'specific') {
    firstOwnerUserId = input.assigneeUserId?.trim() || null;
    if (!firstOwnerUserId) errors.assignee = 'Pick the team member responsible.';
  } else if (input.assignMode === 'auto') {
    firstOwnerUserId = input.workTypeDefaultAssigneeUserId?.trim() || null;
  } else {
    firstOwnerUserId = null;
  }

  // Due date/time interpreted in Eastern. Time without a date is meaningless.
  let dueAt: string | null = null;
  let dueEastern: string | null = null;
  const dueDate = input.dueDate?.trim() || '';
  const dueTime = input.dueTime?.trim() || '';
  if (dueDate) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate);
    if (m) {
      let hh = 17, mm = 0; // default to end-of-business 5:00 PM ET when only a date is given
      if (dueTime) {
        const tm = /^(\d{1,2}):(\d{2})$/.exec(dueTime);
        if (tm) { hh = Number(tm[1]); mm = Number(tm[2]); }
      }
      dueAt = easternWallTimeToUtc(Number(m[1]), Number(m[2]), Number(m[3]), hh, mm).toISOString();
      dueEastern = dueTime ? `${dueDate} ${dueTime}` : `${dueDate} 17:00`;
    }
  } else if (dueTime) {
    errors.dueTime = 'Add a due date for this time.';
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const requirements = (input.requirements ?? [])
    .map((r) => ({
      name: r.name?.trim() ?? '',
      description: r.description?.trim() || null,
      required: r.required ?? false,
      responsibleUserId: r.responsibleUserId?.trim() || null,
    }))
    .filter((r) => r.name.length > 0);

  const relationType = input.relationType ?? 'none';
  const relationLabel = input.relationLabel?.trim() || '';
  const relation =
    relationType !== 'none' && relationLabel
      ? { type: relationType, label: relationLabel }
      : null;

  return {
    ok: true,
    value: {
      title,
      description: outcome, // the outcome IS the work's description
      firstOwnerUserId,
      metadata: {
        priority: priority!,
        responsibility: input.responsibility?.trim() || null,
        dueAt,
        dueTimezone: BUSINESS_TIME_ZONE,
        dueEastern,
        relation,
        requirements,
        notes: input.notes?.trim() || null,
      },
    },
  };
}
