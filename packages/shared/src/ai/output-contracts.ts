// The output-contract registry: how the gateway parses and validates an answer. PR 1 (AI runtime).
//
// ONE LOOKUP, NO BRANCH. A task declares `outputSchemaId`; the gateway finds that schema's contract
// here and runs its `parse` and `validate`. A new task with a new answer shape adds ONE entry to this
// registry -- its own parser and its own rules -- and the gateway does not change. An answer whose
// schema has no registered contract is refused before any model is called: an answer Loop could not
// check is not an answer Loop may show.
//
// TODAY'S THREE CONTRACTS ARE TODAY'S RULES, UNCHANGED. Case Explanation, Mail Reply Draft and
// Telegram Content Triage are registered against the existing `parseAiTaskOutput` and
// `validateAiTaskOutput` (task.ts) exactly as the gateway called them before this registry existed,
// so every answer is judged by the same code, byte for byte.
//
// PURE.

import { parseAiTaskOutput, validateAiTaskOutput, type AiOutputRejection, type AiSupportedEvidence, type AiTaskDefinition, type AiTaskOutput } from './task';

export interface AiOutputContract {
  readonly schemaId: string;
  /** Shape only: null when the answer is not the answer that was asked for. */
  parse(value: unknown): AiTaskOutput | null;
  /** Every rule the parsed answer breaks. Empty means Loop may show it. */
  validate(output: AiTaskOutput, task: AiTaskDefinition, suppliedRefs: ReadonlySet<string>, evidence: AiSupportedEvidence): AiOutputRejection[];
}

function existingRules(schemaId: string): AiOutputContract {
  return Object.freeze({ schemaId, parse: parseAiTaskOutput, validate: validateAiTaskOutput });
}

export const AI_OUTPUT_CONTRACTS: Readonly<Record<string, AiOutputContract>> = Object.freeze({
  'case-explanation.v2': existingRules('case-explanation.v2'),
  'mail-reply-draft.v2': existingRules('mail-reply-draft.v2'),
  'telegram-content-triage.v4': existingRules('telegram-content-triage.v4'),
});

/** The contract an answer to this schema is judged by, or null when none is registered. */
export function aiOutputContract(schemaId: string): AiOutputContract | null {
  return Object.prototype.hasOwnProperty.call(AI_OUTPUT_CONTRACTS, schemaId) ? AI_OUTPUT_CONTRACTS[schemaId]! : null;
}
