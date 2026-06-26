// @emgloop/brain — Knowledge Engine.
//
// Sprint 12: permanent Knowledge architecture. Knowledge Objects are structured,
// versioned, governed records (guides, policies, answers, playbooks) the Brain
// and AI Employees can draw on. No AI generation in Sprint 12 — only the
// architecture: lifecycle, ownership, confidence, expiration, and access scope.

import type { AuditEntry, Confidence, Lifespan, Visibility } from './types';

/** Lifecycle status of a knowledge object. */
export type KnowledgeStatus = 'draft' | 'approved' | 'deprecated';

/** A governed unit of knowledge. */
export interface KnowledgeObject {
  id?: string;
  title: string;
  body: string;
  status: KnowledgeStatus;
  version: number;
  /** Owner: user id or 'system'. */
  owner: string;
  confidence: Confidence;
  visibility: Visibility;
  lifespan?: Lifespan;
  /** Organizations allowed to use this knowledge ('*' = platform-wide). */
  allowedOrganizations: string[];
  /** AI Employee ids allowed to use this knowledge ('*' = any in scope). */
  allowedAIEmployees: string[];
  /** Workflow ids this knowledge relates to. */
  relatedWorkflows: string[];
  /** Free-form tags/topics for retrieval. */
  topics: string[];
  audit: AuditEntry[];
  createdAt: Date;
  updatedAt: Date;
}

/** Query for retrieving knowledge, always access-scoped. */
export interface KnowledgeQuery {
  organizationId: string;
  topics?: string[];
  status?: KnowledgeStatus;
  /** Restrict to knowledge usable by a specific AI Employee. */
  aiEmployeeId?: string;
}

/** Contract for the knowledge engine. Implementations enforce allowed
 *  organizations / AI employees and never return cross-tenant private knowledge. */
export interface KnowledgeEngine {
  get(id: string, organizationId: string): Promise<KnowledgeObject | null>;
  search(query: KnowledgeQuery): Promise<KnowledgeObject[]>;
  /** Transition lifecycle status with an audit entry (draft->approved->deprecated). */
  transition(
    id: string,
    organizationId: string,
    to: KnowledgeStatus,
    actor: string,
  ): Promise<KnowledgeObject>;
}
