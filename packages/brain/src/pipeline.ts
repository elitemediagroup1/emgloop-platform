// @emgloop/brain — the Brain pipeline.
//
// Sprint 12: formalize the single path EVERY event flows through. This file
// defines the ordered pipeline stages and the contract each stage implements,
// so that future providers/integrations plug into the same architecture instead
// of building isolated logic.
//
// Provider -> Adapter -> Normalization -> Integration Event -> Event Store ->
// Brain -> Identity Resolution -> Memory Update -> Signal Detection -> Intent ->
// Customer Graph -> Recommendation -> Next Best Action -> Workflow -> CRM ->
// Analytics -> Portals.
//
// NOTE: Sprint 11 already implements the left half of this pipeline concretely
// (Provider/Adapter/Normalization/Integration Event in @emgloop/providers and
// @emgloop/database). The Brain stages below are the permanent contracts the
// remaining stages will satisfy. No behavior is changed here.

import type { NormalizedEvent } from '@emgloop/shared';
import type { Metadata, TenantScope } from './types';

/** The canonical, ordered list of pipeline stages. */
export const BRAIN_PIPELINE_STAGES = [
  'provider',
  'adapter',
  'normalization',
  'integration_event',
  'event_store',
  'brain',
  'identity_resolution',
  'memory_update',
  'signal_detection',
  'intent',
  'customer_graph',
  'recommendation',
  'next_best_action',
  'workflow',
  'crm',
  'analytics',
  'portals',
] as const;
export type BrainPipelineStage = (typeof BRAIN_PIPELINE_STAGES)[number];

/** The unit of work flowing through the Brain after normalization. */
export interface BrainEvent extends TenantScope {
  /** The normalized event produced upstream (Sprint 11 pipeline). */
  normalized: NormalizedEvent;
  /** Resolved identity, populated by the identity_resolution stage. */
  identityId?: string;
  /** Stage outputs accumulate here as the event flows through the Brain. */
  context: Metadata;
}

/** Result emitted by the Brain after a single event is fully processed. */
export interface BrainProcessResult extends TenantScope {
  identityId?: string;
  signalIds: string[];
  intentKeys: string[];
  recommendationIds: string[];
  nextBestActionKinds: string[];
  /** Stages that ran, in order, for traceability. */
  stagesExecuted: BrainPipelineStage[];
  wasIdempotent: boolean;
}

/** Contract every pipeline stage implements. Stages are pure transforms over a
 *  BrainEvent; they enrich .context and never reach across tenants. */
export interface BrainPipelineStageHandler {
  readonly stage: BrainPipelineStage;
  /** Process the event for this stage, returning the (possibly enriched) event.
   *  Implementations must be deterministic and tenant-safe in Sprint 12. */
  handle(event: BrainEvent): Promise<BrainEvent>;
}

/** Ordered pipeline executor contract. A concrete implementation runs the
 *  registered stage handlers in BRAIN_PIPELINE_STAGES order. */
export interface BrainPipeline {
  register(handler: BrainPipelineStageHandler): void;
  run(event: BrainEvent): Promise<BrainProcessResult>;
}
