// The steps a job runs, per execution mode. Slice B6.
//
// DARK PLAN, REVISION 1. Every job runs the same four-part plan, whatever its task:
//
//   context.load    LOAD_CONTEXT       ask Loop for the minimized, authorized context; keep
//                                      only its shape (counts, a manifest hash, whether a
//                                      result could be committed)
//   dark.probe      SYNTHETIC          stands where a model call will stand; calls no provider
//   dark.clarify    REQUEST_USER_INPUT only when the task may wait and the job's input asks
//                                      (`darkAskQuestion: true`); a structured CONFIRM question
//   commit.result   COMMIT_RESULT      the governed commit boundary. Access is re-decided here.
//                                      Revision 1 never commits: the job ends FAILED
//                                      COMMIT_REFUSED, naming why (no owner gate, or dark mode).
//
// EXECUTION COMPLETION IS NOT A GOVERNED COMMIT. When the first three steps have
// checkpoints, execution is complete. A job SUCCEEDS only when an owning authority
// accepts a result (RESULT_COMMITTED), which revision 1 never attempts.

import type { AiTaskDefinition, BrainQuestion, BrainStepKind } from '@emgloop/shared';

import type { BrainTaskInputView } from './types';

export const BRAIN_DARK_PLAN_VERSION = 'dark-plan.r1';

export interface BrainPlanStep {
  readonly key: string;
  readonly kind: BrainStepKind;
  /** The longest this step may take, for the deadline check before it starts. */
  readonly maxDurationMs: number;
}

export const DARK_CLARIFY_QUESTION: BrainQuestion = Object.freeze({
  kind: 'CONFIRM',
  prompt: 'Dark verification: may this run continue to the commit boundary?',
});

export function brainTaskMayWait(task: AiTaskDefinition): boolean {
  return task.execution.classes.includes('DURABLE') && (task.execution.durable?.maxUserWaitMs ?? null) !== null;
}

export function darkPlan(task: AiTaskDefinition, input: BrainTaskInputView): readonly BrainPlanStep[] {
  const steps: BrainPlanStep[] = [
    { key: 'context.load', kind: 'LOAD_CONTEXT', maxDurationMs: 15_000 },
    { key: 'dark.probe', kind: 'SYNTHETIC', maxDurationMs: 1_000 },
  ];
  if (brainTaskMayWait(task) && input.darkAskQuestion === true) steps.push({ key: 'dark.clarify', kind: 'REQUEST_USER_INPUT', maxDurationMs: 5_000 });
  steps.push({ key: 'commit.result', kind: 'COMMIT_RESULT', maxDurationMs: 15_000 });
  return steps;
}
