// Loop Cognitive Architecture — services sub-barrel (Increment 2).
//
// The event-to-memory-to-state pipeline built ON the Increment 1 repositories.
// The processor is the only I/O component; the evaluators are pure.

export { CognitiveEventProcessor } from './cognitive-event-processor';
export type { ProcessorLogger } from './cognitive-event-processor';
export { normalizeEvent } from './normalization';
export { GovernanceEvaluator } from './governance-evaluator';
export type { GovernanceContext } from './governance-evaluator';
export { KnowledgeEvaluatorRegistry } from './knowledge-evaluators';
export { ActiveStateEvaluatorRegistry } from './active-state-evaluators';
export { resolveIdentity } from './identity-resolution';
export type { ResolutionResult } from './identity-resolution';
export { LoopEventConsumer, adaptLoopEvent } from './loop-event-consumer';
export type { LoopEventConsumerOptions, DrainResult } from './loop-event-consumer';
export type {
  ProcessEventInput,
  ProcessResult,
  ProcessStatus,
  IdentityDescriptor,
  EvidenceHint,
  NormalizedEvent,
  EvaluatorEvent,
  ProposedAssertion,
  ProposedStateChange,
  KnowledgeEvaluator,
  ActiveStateEvaluator,
  StateEvaluatorInput,
  GovernanceDecision,
  GovernanceOutcome,
} from './types';
