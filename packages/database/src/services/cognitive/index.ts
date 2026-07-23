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

// --- Increment 3: governed read surface, publisher, subscribers, policies -----
export { CognitiveContextService } from './context-service';
export type { GetIdentityContextInput, ExplainActiveStateInput } from './context-service';
export { StateChangePublisher } from './state-change-publisher';
export type { PublisherOptions, PublisherDeps, PublishResult } from './state-change-publisher';
export {
  DecisionPolicyRegistry,
  messagingPrecedenceRank,
  resolveOutcomePrecedence,
  resolveDecisionPrecedence,
} from './decision-policies';
export type { DecisionPolicy, PolicyInput, PolicyEvaluation } from './decision-policies';
export {
  SUBSCRIBER_HANDLERS,
  resolveSubscriber,
} from './subscribers';
export type {
  SubscriberContext,
  SubscriberDeps,
  SubscriberHandler,
  HandlerResult,
} from './subscribers';
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
