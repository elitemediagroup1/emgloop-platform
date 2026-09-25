// The output-contract registry: how the gateway parses and validates an answer. PR 1 (AI runtime).
//
// ONE LOOKUP, NO BRANCH. A task declares `outputSchemaId`; the gateway finds that schema's contract
// here and runs its `parse` and `validate`. A new task with a new answer shape adds ONE entry to this
// registry -- its own parser and its own rules -- and the gateway does not change. An answer whose
// schema has no registered contract is refused before any model is called: an answer Loop could not
// check is not an answer Loop may show.
//
// THE PRE-REGISTRY CONTRACTS ARE THE PRE-REGISTRY RULES, UNCHANGED. Case Explanation and Mail Reply Draft
// are registered against the existing `parseAiTaskOutput` and `validateAiTaskOutput` (task.ts) exactly as
// the gateway called them before this registry existed. Telegram triage v4 was too, until Chats v5
// (Phase B) replaced its schema with v5, which has its own contract; a retired schema has no contract.
//
// PURE.

import { DOMAIN_READING_SCHEMA_ID, parseDomainReadingOutput, validateDomainReadingOutput } from './domain-reading';
import { MAIL_CONTENT_TRIAGE_SCHEMA_ID, TELEGRAM_TRIAGE_V5_SCHEMA_ID, parseConversationTriageOutput, parseTriageV5Output, validateTriageV5Output } from './telegram-triage-v5';
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
  // PR 2 (Loop Intelligence fabric, 2026-09-26): the ONE generic domain reading. Its own parser and
  // rules (`domain-reading.ts`); the gateway does not change.
  [DOMAIN_READING_SCHEMA_ID]: Object.freeze({ schemaId: DOMAIN_READING_SCHEMA_ID, parse: parseDomainReadingOutput, validate: validateDomainReadingOutput }),
  // Chats v5 (Loop Intelligence Phase B): owedBy, typed signals, grounded parties. Its own rules.
  [TELEGRAM_TRIAGE_V5_SCHEMA_ID]: Object.freeze({ schemaId: TELEGRAM_TRIAGE_V5_SCHEMA_ID, parse: parseTriageV5Output, validate: validateTriageV5Output }),
  // Mail content triage (Phase D): the SAME conversation-triage rules, its own schema id.
  [MAIL_CONTENT_TRIAGE_SCHEMA_ID]: Object.freeze({
    schemaId: MAIL_CONTENT_TRIAGE_SCHEMA_ID,
    parse: (value: unknown) => parseConversationTriageOutput(value, MAIL_CONTENT_TRIAGE_SCHEMA_ID),
    validate: validateTriageV5Output,
  }),
});

/** The contract an answer to this schema is judged by, or null when none is registered. */
export function aiOutputContract(schemaId: string): AiOutputContract | null {
  return Object.prototype.hasOwnProperty.call(AI_OUTPUT_CONTRACTS, schemaId) ? AI_OUTPUT_CONTRACTS[schemaId]! : null;
}
