// @emgloop/brain — service boundaries.
//
// Sprint 12: the permanent service boundaries of the Brain. These are lightweight
// contracts (interfaces) only — no AI implementation. Where a deterministic
// implementation already exists in another package (e.g. the Sprint 11
// SignalRegistry / NextBestActionService in @emgloop/database), this file simply
// names the boundary the platform organizes around; it does NOT replace working
// logic. Future sprints provide concrete implementations behind these interfaces.

import type { BrainEvent, BrainProcessResult, BrainPipeline } from './pipeline';
import type { IdentityResolutionService } from './identity';
import type { MemoryStore } from './memory';
import type { BrainSignalInstance } from './signals';
import type { CustomerGraph } from './graph';
import type { KnowledgeEngine } from './knowledge';
import type { RecommendationEngine, RecommendationContext, RecommendationResult } from './recommendation';
import type { RevenueIntelligence } from './revenue';
import type { TrustService } from './trust';

/** Detects higher-order signals from a brain event (deterministic in Sprint 12). */
export interface SignalRegistryService {
  detect(event: BrainEvent): Promise<BrainSignalInstance[]>;
}

/** Resolves canonical intent from an event + known signals. */
export interface IntentService {
  classify(event: BrainEvent): Promise<{ intentKeys: string[] }>;
}

/** Customer-graph facade scoped to the Brain. */
export interface CustomerGraphService {
  graph: CustomerGraph;
}

/** Organization-graph facade (org-to-org and org-internal relationships). */
export interface OrganizationGraphService {
  graph: CustomerGraph;
}

/** Knowledge facade. */
export interface KnowledgeService {
  engine: KnowledgeEngine;
}

/** Recommendation / Next Best Action facade. */
export interface RecommendationService {
  engine: RecommendationEngine;
  recommend(context: RecommendationContext): Promise<RecommendationResult>;
}

/** Next Best Action is a first-class platform service (alias of recommendation
 *  for callers that think in NBA terms). */
export type NextBestActionService = RecommendationService;

/** Revenue intelligence facade. */
export interface RevenueIntelligenceService {
  intelligence: RevenueIntelligence;
}

/** Learning service: turns outcomes into generalized, tenant-safe improvements.
 *  Sprint 12 defines the boundary only; no model training is performed. */
export interface LearningService {
  /** Record an outcome for later (deterministic) aggregation. */
  observe(outcome: {
    organizationId: string;
    subjectId?: string;
    kind: string;
    value: number;
  }): Promise<void>;
}

/** Memory facade. */
export interface MemoryService {
  store: MemoryStore;
}

/** The top-level Brain facade: the single entry point the platform calls to
 *  process an event end-to-end through the pipeline. */
export interface BrainService {
  readonly pipeline: BrainPipeline;
  readonly identity: IdentityResolutionService;
  readonly memory: MemoryService;
  readonly signals: SignalRegistryService;
  readonly intent: IntentService;
  readonly customerGraph: CustomerGraphService;
  readonly organizationGraph: OrganizationGraphService;
  readonly knowledge: KnowledgeService;
  readonly recommendation: RecommendationService;
  readonly nextBestAction: NextBestActionService;
  readonly revenue: RevenueIntelligenceService;
  readonly learning: LearningService;
  readonly trust: TrustService;
  /** Process a single normalized event through the full Brain pipeline. */
  process(event: BrainEvent): Promise<BrainProcessResult>;
}

/** Re-export the canonical Identity Resolution service boundary. */
export type { IdentityResolutionService } from './identity';
// @emgloop/brain — service boundaries.
//
// Sprint 12: the permanent service boundaries of the Brain. These are lightweight
// contracts (interfaces) only — no AI implementation. Where a deterministic
// implementation already exists in another package (e.g. the Sprint 11
// SignalRegistry / NextBestActionService in @emgloop/database), this file simply
// names the boundary the platform organizes around; it does NOT replace working
// logic. Future sprints provide concrete implementations behind these interfaces.

import type { BrainEvent, BrainProcessResult, BrainPipeline } from './pipeline';
import type { IdentityResolutionService } from './identity';
import type { MemoryStore } from './memory';
import type { BrainSignalInstance } from './signals';
import type { CustomerGraph } from './graph';
import type { KnowledgeEngine } from './knowledge';
import type { RecommendationEngine, RecommendationContext, RecommendationResult } from './recommendation';
import type { RevenueIntelligence } from './revenue';
import type { TrustService } from './trust';

/** Detects higher-order signals from a brain event (deterministic in Sprint 12). */
export interface SignalRegistryService {
  detect(event: BrainEvent): Promise<BrainSignalInstance[]>;
}

/** Resolves canonical intent from an event + known signals. */
export interface IntentService {
  classify(event: BrainEvent): Promise<{ intentKeys: string[] }>;
}

/** Customer-graph facade scoped to the Brain. */
export interface CustomerGraphService {
  graph: CustomerGraph;
}

/** Organization-graph facade (org-to-org and org-internal relationships). */
export interface OrganizationGraphService {
  graph: CustomerGraph;
}

/** Knowledge facade. */
export interface KnowledgeService {
  engine: KnowledgeEngine;
}

/** Recommendation / Next Best Action facade. */
export interface RecommendationService {
  engine: RecommendationEngine;
  recommend(context: RecommendationContext): Promise<RecommendationResult>;
}

/** Next Best Action is a first-class platform service (alias of recommendation
 *  for callers that think in NBA terms). */
export type NextBestActionService = RecommendationService;

/** Revenue intelligence facade. */
export interface RevenueIntelligenceService {
  intelligence: RevenueIntelligence;
}

/** Learning service: turns outcomes into generalized, tenant-safe improvements.
 *  Sprint 12 defines the boundary only; no model training is performed. */
export interface LearningService {
  /** Record an outcome for later (deterministic) aggregation. */
  observe(outcome: {
    organizationId: string;
    subjectId?: string;
    kind: string;
    value: number;
  }): Promise<void>;
}

/** Memory facade. */
export interface MemoryService {
  store: MemoryStore;
}

/** The top-level Brain facade: the single entry point the platform calls to
 *  process an event end-to-end through the pipeline. */
export interface BrainService {
  readonly pipeline: BrainPipeline;
  readonly identity: IdentityResolutionService;
  readonly memory: MemoryService;
  readonly signals: SignalRegistryService;
  readonly intent: IntentService;
  readonly customerGraph: CustomerGraphService;
  readonly organizationGraph: OrganizationGraphService;
  readonly knowledge: KnowledgeService;
  readonly recommendation: RecommendationService;
  readonly nextBestAction: NextBestActionService;
  readonly revenue: RevenueIntelligenceService;
  readonly learning: LearningService;
  readonly trust: TrustService;
  /** Process a single normalized event through the full Brain pipeline. */
  process(event: BrainEvent): Promise<BrainProcessResult>;
}
