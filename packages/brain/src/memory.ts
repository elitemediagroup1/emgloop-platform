// @emgloop/brain — Memory model.
//
// Sprint 12: permanent, structured memory contracts. No vector database yet —
// memory is structured and deterministic. Each memory object declares its owner,
// scope, visibility, confidence, expiration, version, audit trail, and which AI
// Employees are allowed to read it. The Trust layer enforces visibility/scope.

import type { AuditEntry, Confidence, Lifespan, Visibility } from './types';

/** The kinds of memory the platform maintains. */
export type MemoryKind =
  | 'customer'
  | 'organization'
  | 'campaign'
  | 'workflow'
  | 'creator'
  | 'ai_employee'
  | 'revenue'
  | 'institutional'
  | 'knowledge';

/** Scope at which a memory is owned/queried. */
export interface MemoryScope {
  organizationId: string;
  /** Subject the memory is about (customer id, campaign id, etc.), if applicable. */
  subjectId?: string;
  locationId?: string;
}

/** Base contract every memory object satisfies. */
export interface MemoryRecord<TBody = Record<string, unknown>> {
  kind: MemoryKind;
  /** Owner: user id, ai employee id, or 'system'. */
  owner: string;
  scope: MemoryScope;
  visibility: Visibility;
  confidence: Confidence;
  lifespan?: Lifespan;
  version: number;
  audit: AuditEntry[];
  /** AI Employee ids permitted to read this memory ('*' = any in-tenant). */
  allowedAIEmployees: string[];
  /** The structured body of the memory. */
  body: TBody;
  createdAt: Date;
  updatedAt: Date;
}

// ---- Specialized memory bodies (structured, not free-form). ----------------

export interface CustomerMemoryBody {
  preferences?: Record<string, string>;
  lastChannel?: string;
  lifecycleStage?: string;
  knownSignals?: string[];
  notes?: string[];
}

export interface OrganizationMemoryBody {
  brandVoice?: string;
  operatingHours?: Record<string, string>;
  escalationRules?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
}

export interface CampaignMemoryBody {
  source?: string;
  medium?: string;
  performanceSummary?: Record<string, number>;
}

export interface WorkflowMemoryBody {
  lastRunAt?: Date;
  successRate?: number;
  learnedSuppressions?: string[];
}

export interface CreatorMemoryBody {
  niche?: string;
  channels?: string[];
  performanceSummary?: Record<string, number>;
}

export interface AIEmployeeMemoryBody {
  persona?: string;
  skills?: string[];
  guardrails?: string[];
}

export interface RevenueMemoryBody {
  lifetimeValue?: number;
  lastRevenueAt?: Date;
  revenueSources?: string[];
}

export interface InstitutionalMemoryBody {
  policies?: string[];
  playbooks?: string[];
}

export interface KnowledgeMemoryBody {
  knowledgeIds?: string[];
  topics?: string[];
}

/** Contract for the service that reads/writes structured memory. Sprint 12 only
 *  defines the interface; a concrete deterministic implementation can follow. */
export interface MemoryStore {
  get<T = Record<string, unknown>>(
    kind: MemoryKind,
    scope: MemoryScope,
  ): Promise<MemoryRecord<T> | null>;
  upsert<T = Record<string, unknown>>(
    record: Omit<MemoryRecord<T>, 'createdAt' | 'updatedAt' | 'version'> & {
      version?: number;
    },
  ): Promise<MemoryRecord<T>>;
}
