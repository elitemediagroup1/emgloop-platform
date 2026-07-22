// start-work.ts — the pure decision layer behind the Start Work form.
//
// Rebuilt for the configurable sequential workflow engine: a Work Item is now a
// Work Type + ordered Work Steps (each step owns its own assignment), NOT a
// single global owner + a flat requirements list. This one pure function does
// all of it — universal-field + custom-field + step validation, and Eastern-time
// target interpretation — so the server action stays a thin adapter and every
// rule is unit-tested without a database, a request, or a clock. On success it
// hands the assembled pieces straight to WorkRepository.createWorkItem.

import { easternWallTimeToUtc, BUSINESS_TIME_ZONE } from '@emgloop/shared';
import { WORK_PRIORITIES, type WorkPriority } from './work-type-catalog';
import {
  validateWorkflowSteps,
  type WorkFieldDef,
  type WorkflowStepDef,
  type StepDefErrors,
} from './workflow';

export interface WorkItemSubmissionInput {
  title: string;
  outcome: string; // "what needs to be accomplished" — required
  details?: string; // "important details" — optional
  priority: string;
  /** 'YYYY-MM-DD' in Eastern, optional. */
  targetDate?: string;
  /** 'HH:MM' in Eastern, only meaningful when useTime is on. */
  targetTime?: string;
  /** Whether the user opted to add a specific time to the target date. */
  useTime?: boolean;
  /** The selected Work Type's configured custom field definitions (may be empty). */
  fields?: WorkFieldDef[];
  /** Raw values the user entered for those custom fields, keyed by field key. */
  fieldValues?: Record<string, unknown>;
  /** The ordered step list from the builder / a chosen template. */
  steps: WorkflowStepDef[];
}

export interface WorkItemErrors {
  title?: string;
  outcome?: string;
  priority?: string;
  targetTime?: string;
  /** Per custom-field-key validation messages. */
  fields?: Record<string, string>;
  /** Per-step builder errors (index + field). */
  steps?: StepDefErrors;
}

export interface BuiltWorkItem {
  title: string;
  outcome: string;
  details: string | null;
  priority: WorkPriority;
  /** UTC ISO instant for the target, or null when no date was given. */
  targetAtUtc: string | null;
  /** The Eastern wall-clock the user entered, for honest display. */
  targetEastern: string | null;
  dueTimezone: string;
  customFieldValues: Record<string, unknown>;
  steps: WorkflowStepDef[];
}

export type WorkItemBuildResult =
  | { ok: true; value: BuiltWorkItem }
  | { ok: false; errors: WorkItemErrors };

function isPriority(v: string): v is WorkPriority {
  return (WORK_PRIORITIES as readonly string[]).includes(v);
}

/** Coerce and required-check custom field values against their definitions.
 *  Returns the cleaned values plus any per-key errors. Only ACTIVE fields count. */
function validateFields(
  fields: readonly WorkFieldDef[],
  values: Record<string, unknown>,
): { clean: Record<string, unknown>; errors: Record<string, string> } {
  const clean: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    if (!f.active) continue;
    const raw = values[f.key];
    const asString = typeof raw === 'string' ? raw.trim() : raw;
    const empty =
      asString === undefined ||
      asString === null ||
      (typeof asString === 'string' && asString.length === 0) ||
      (f.type === 'checkbox' && (asString === false || asString === 'false'));
    if (empty) {
      if (f.required) errors[f.key] = `${f.label} is required.`;
      continue;
    }
    clean[f.key] = asString;
  }
  return { clean, errors };
}

/**
 * Validate a Start Work submission and, if valid, assemble exactly what
 * WorkRepository.createWorkItem needs. Pure and deterministic: the only
 * environmental input, the business timezone, is a fixed constant
 * (America/New_York); no Date.now(), no I/O.
 */
export function buildWorkItemSubmission(input: WorkItemSubmissionInput): WorkItemBuildResult {
  const errors: WorkItemErrors = {};

  const title = input.title?.trim() ?? '';
  const outcome = input.outcome?.trim() ?? '';
  const details = input.details?.trim() || null;

  if (!title) errors.title = 'Give this work a short name.';
  if (!outcome) errors.outcome = 'Describe what needs to be accomplished.';

  const priority = isPriority(input.priority) ? input.priority : null;
  if (!priority) errors.priority = 'Choose a priority.';

  // Custom fields defined by the selected Work Type (may be none).
  const { clean: customFieldValues, errors: fieldErrors } = validateFields(
    input.fields ?? [],
    input.fieldValues ?? {},
  );
  if (Object.keys(fieldErrors).length > 0) errors.fields = fieldErrors;

  // Target date/time interpreted in Eastern. Time without a date is meaningless.
  let targetAtUtc: string | null = null;
  let targetEastern: string | null = null;
  const targetDate = input.targetDate?.trim() || '';
  const wantsTime = Boolean(input.useTime);
  const targetTime = wantsTime ? input.targetTime?.trim() || '' : '';
  if (targetDate) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(targetDate);
    if (m) {
      let hh = 17;
      let mm = 0; // default to end-of-business 5:00 PM ET when only a date is given
      if (targetTime) {
        const tm = /^(\d{1,2}):(\d{2})$/.exec(targetTime);
        if (tm) {
          hh = Number(tm[1]);
          mm = Number(tm[2]);
        }
      }
      targetAtUtc = easternWallTimeToUtc(Number(m[1]), Number(m[2]), Number(m[3]), hh, mm).toISOString();
      targetEastern = targetTime ? `${targetDate} ${targetTime}` : `${targetDate} 17:00`;
    }
  } else if (targetTime) {
    errors.targetTime = 'Add a target date for this time.';
  }

  // Steps — sequential, at least one, each named + with an instruction + a
  // resolvable assignee for 'specific'/'responsibility'. Delegated to the engine.
  const stepErrors = validateWorkflowSteps(input.steps);
  if (stepErrors.length > 0) errors.steps = stepErrors;

  const hasError =
    errors.title ||
    errors.outcome ||
    errors.priority ||
    errors.targetTime ||
    errors.fields ||
    errors.steps;
  if (hasError) return { ok: false, errors };

  return {
    ok: true,
    value: {
      title,
      outcome,
      details,
      priority: priority!,
      targetAtUtc,
      targetEastern,
      dueTimezone: BUSINESS_TIME_ZONE,
      customFieldValues,
      steps: input.steps,
    },
  };
}
