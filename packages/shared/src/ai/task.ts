// What Loop asks for, and what it will accept as an answer. Slice AI S0.
//
// Architecture: docs/architecture/loop-ai-runtime.md §6 and §16, approved as PD-F-08.
// A caller invokes a TASK BY NAME. It never chooses a model, never writes a prompt,
// and never sees a provider -- so a task is the only place the question is defined,
// and the only place the answer's shape is agreed.
//
// EVERY MATERIAL CLAIM CITES SUPPLIED EVIDENCE. The first task, Case Explanation,
// exists to explain a Case using facts Loop already holds. An explanation that
// asserts something no supplied block supports is not a better explanation, it is a
// fabrication with good grammar -- so `validateAiTaskOutput` REJECTS it whole. There
// is no partial display of an invalid answer, because a reader cannot tell which
// half was the invented one.
//
// NO WRITES, EVER, AT LAUNCH. A task declares its consequence, and every task here
// is READ_ONLY. Nothing in this contract can propose a domain write, and the
// governance gate refuses a tool that writes.
//
// PURE. No clock, no I/O.

import type { AiSensitivityClass } from './context';
import type { AiCapabilityProfile } from './runtime';

export const AI_TASK_CONSEQUENCES = ['READ_ONLY', 'PROPOSES_FOR_APPROVAL'] as const;
export type AiTaskConsequence = (typeof AI_TASK_CONSEQUENCES)[number];

export interface AiTaskDefinition {
  readonly taskId: string;
  readonly version: string;
  readonly profile: AiCapabilityProfile;
  /** The highest sensitivity class this task's context may carry. */
  readonly sensitivityCeiling: AiSensitivityClass;
  readonly consequence: AiTaskConsequence;
  /** The permissions the invoking user must hold, re-checked server-side. */
  readonly requires: readonly { readonly resource: string; readonly action: 'view' }[];
  /** Structured output only: a task whose answer cannot be checked is not a task. */
  readonly outputSchemaId: string;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  /** Tools the broker may publish to it. Empty at launch, and no tool may write. */
  readonly tools: readonly string[];
}

/**
 * CASE EXPLANATION -- the first slice (§16). It explains a Commercial Intelligence
 * Case from the observations, findings and evidence the reader can already see.
 *
 * OPERATIONAL data only. A Case carries no contact values, which is exactly why it
 * was chosen to go first: the hardest privacy question can wait for a task that
 * actually needs the answer.
 */
export const AI_TASK_CASE_EXPLANATION: AiTaskDefinition = Object.freeze({
  taskId: 'case.explanation',
  version: '1.0.0',
  profile: 'EXPLANATION',
  sensitivityCeiling: 'OPERATIONAL',
  consequence: 'READ_ONLY',
  requires: Object.freeze([{ resource: 'commercialIntelligence', action: 'view' } as const]),
  outputSchemaId: 'case-explanation.v1',
  maxOutputTokens: 1200,
  timeoutMs: 30_000,
  tools: Object.freeze([]),
});

export const AI_TASKS: readonly AiTaskDefinition[] = Object.freeze([AI_TASK_CASE_EXPLANATION]);

export function aiTask(taskId: string): AiTaskDefinition | null {
  return AI_TASKS.find((t) => t.taskId === taskId) ?? null;
}

// --- The answer Loop will accept ---------------------------------------------------

/** One statement, and the evidence it stands on. A claim with no citation is not a claim. */
export interface AiClaim {
  readonly statement: string;
  /** Source refs from the context package. Never a URL, never a memory, never nothing. */
  readonly citations: readonly string[];
  /** A figure the statement asserts, which Loop checks against the supplied facts. */
  readonly figures: readonly { readonly label: string; readonly value: number }[];
}

export interface AiTaskOutputV1 {
  readonly schemaId: string;
  readonly summary: string;
  readonly claims: readonly AiClaim[];
  /** What the model could not tell from what it was given. Honesty has a field. */
  readonly limitations: readonly string[];
}

export const AI_OUTPUT_REJECTIONS = [
  'WRONG_SCHEMA',
  'EMPTY_ANSWER',
  'UNCITED_CLAIM',
  'CITATION_NOT_SUPPLIED',
  'FIGURE_NOT_SUPPORTED',
  'NUMERIC_CONFIDENCE_PRESENT',
  'RECOMMENDS_AN_ACTION',
] as const;
export type AiOutputRejection = (typeof AI_OUTPUT_REJECTIONS)[number];

/** A model that scores its own certainty is guessing twice. C-05 applies to AI too. */
const CONFIDENCE_LIKE = /\b(\d{1,3})\s?%\s?(confiden|certain|sure|likel)|confidence(\s+score)?\s*[:=]\s*\d/i;
/** An explanation task may not tell somebody to do something; that is a governed act. */
const RECOMMENDATION_LIKE = /\b(you should|we recommend|i recommend|recommend(ed|ation)? (that|to)|next step[s]? (is|are) to)\b/i;

/**
 * Every rule an answer breaks. Empty means Loop may show it.
 *
 * `supportedFigures` are the numbers the context actually contained. A figure that
 * is not among them is not "approximately right" -- it is a number the model
 * produced, and showing it beside real ones would make all of them look equal.
 */
export function validateAiTaskOutput(
  output: AiTaskOutputV1,
  task: AiTaskDefinition,
  suppliedRefs: ReadonlySet<string>,
  supportedFigures: ReadonlySet<number>,
): AiOutputRejection[] {
  const out: AiOutputRejection[] = [];
  if (output.schemaId !== task.outputSchemaId) out.push('WRONG_SCHEMA');
  if (!output.summary?.trim() || output.claims.length === 0) out.push('EMPTY_ANSWER');

  for (const claim of output.claims) {
    if (claim.citations.length === 0) out.push('UNCITED_CLAIM');
    for (const citation of claim.citations) if (!suppliedRefs.has(citation)) out.push('CITATION_NOT_SUPPLIED');
    for (const figure of claim.figures) if (!supportedFigures.has(figure.value)) out.push('FIGURE_NOT_SUPPORTED');
  }

  const prose = [output.summary, ...output.claims.map((c) => c.statement), ...output.limitations].join('\n');
  if (CONFIDENCE_LIKE.test(prose)) out.push('NUMERIC_CONFIDENCE_PRESENT');
  if (task.consequence === 'READ_ONLY' && RECOMMENDATION_LIKE.test(prose)) out.push('RECOMMENDS_AN_ACTION');
  return [...new Set(out)];
}
