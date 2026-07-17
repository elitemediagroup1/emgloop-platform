// @emgloop/shared — Verified Knowledge contract (kg.v1)
//
// Cross-cutting transport types + validation for the Verified Knowledge domain.
// This is the DISTINCT verified knowledge graph (entities / claims / relationships /
// sources / provenance / lifecycle) that PetsInMyCity produces and consumes. It is
// deliberately separate from any embedding / RAG document store: those are AI
// retrieval documents, this is a verified fact graph.
//
// These are TRANSPORT types (the public service contract). They intentionally do
// NOT import Prisma types — the persistence layer maps to/from these. The shapes
// mirror docs/implementation/LOOP_KNOWLEDGE_CONTRACT.md in the PetsInMyCity repo
// (contract fixture copied into this repo at
// packages/shared/src/knowledge-contract.fixture.ts, source: petsinmycity
// feature/durable-knowledge-storage).
//
// Loop STORES and RETURNS these objects verbatim. Loop is NOT the delivery
// authority: PetsInMyCity's Knowledge Delivery Platform (KDP) alone decides
// admissibility / freshness / ranking / conflict / safety. Loop must not filter or
// rank for delivery in this phase.

export const KNOWLEDGE_CONTRACT_VERSION = 'kg.v1' as const;
export type KnowledgeContractVersion = typeof KNOWLEDGE_CONTRACT_VERSION;

// --- Tenancy / scope (carried on every request) ---------------------------
// Mirrors the loop_events attribution model: a producer `platform` slug plus an
// optional Loop tenant `organizationId`. Every stored row and every query is
// isolated by (platform, property) and, when supplied, organizationId. Knowledge
// is NEVER returned across the wrong platform/property/organization.
export interface KnowledgeScope {
  platform: string;            // producer slug, e.g. "petsinmycity"
  property?: string | null;    // product/property id; defaults to platform
  organizationId?: string | null; // Loop tenant id (once provisioned)
  workspaceId?: string | null;    // optional finer scope
}

// --- Verification / confidence vocab --------------------------------------
// Stored verbatim as supplied by the producer. Loop validates the enum shape but
// does NOT re-derive or drop these values.
export const KNOWLEDGE_VERIFICATIONS = ['verified', 'unverified', 'disputed', 'retired'] as const;
export type KnowledgeVerification = (typeof KNOWLEDGE_VERIFICATIONS)[number];

export const KNOWLEDGE_CONFIDENCES = ['high', 'medium', 'low'] as const;
export type KnowledgeConfidence = (typeof KNOWLEDGE_CONFIDENCES)[number];

// --- Object transport shapes (response side) ------------------------------
export interface KnowledgeSourceObject {
  id: string;
  tier: number | null;
  kind: string | null;
  url: string | null;
  accessed: string | null;   // ISO date (string) as supplied
  quote: string | null;
  captured_by: string | null;
}

export interface KnowledgeClaimObject {
  id: string;
  subject: string;
  predicate: string;
  value: unknown;            // stored JSON value (NOT stringified)
  confidence: KnowledgeConfidence | string | null;
  verification: KnowledgeVerification | string | null;
  safety_critical: boolean;
  valid_from: string | null;
  valid_until: string | null;
  expires: string | null;
  review_by: string | null;
  note: string | null;
  version: number;
  sources: KnowledgeSourceObject[];
}

export interface KnowledgeEntityObject {
  id: string;
  type: string;
  name: string | null;
  aliases: string[];
  status: string | null;
  confidence: KnowledgeConfidence | string | null;
  verification: KnowledgeVerification | string | null;
  safety_critical: boolean;
  attributes: Record<string, unknown>;
  sources: KnowledgeSourceObject[];
}

export interface KnowledgeRelationshipObject {
  edge: string;
  from: string;
  to: string;
  confidence: KnowledgeConfidence | string | null;
}

// --- Import batch (request side) ------------------------------------------
export interface KnowledgeImportBatch {
  contract_version: KnowledgeContractVersion | string;
  sources?: KnowledgeSourceObject[];
  entities?: Array<Omit<KnowledgeEntityObject, 'sources'>>;
  claims?: Array<Omit<KnowledgeClaimObject, 'sources' | 'version'> & { version?: number }>;
  relationships?: KnowledgeRelationshipObject[];
  entity_sources?: Array<{ entityId: string; sourceId: string }>;
  claim_sources?: Array<{ claimId: string; sourceId: string }>;
}

export interface KnowledgeImportRequest {
  scope: KnowledgeScope;
  idempotency_key: string;
  batch: KnowledgeImportBatch;
}

export interface KnowledgeImportResultCounts {
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
}

// --- Response envelopes ----------------------------------------------------
export interface KnowledgeErrorResponse {
  ok: false;
  error: KnowledgeErrorCode;
  message: string;
  trace_id?: string;
}

export interface KnowledgeQueryResponse {
  ok: true;
  claims: KnowledgeClaimObject[];
  trace_id?: string;
}

export interface KnowledgeClaimResponse {
  ok: true;
  claim: KnowledgeClaimObject;
  trace_id?: string;
}

export interface KnowledgeEntityResponse {
  ok: true;
  entity: KnowledgeEntityObject;
  trace_id?: string;
}

export interface KnowledgeStatsResponse {
  ok: true;
  counts: { entities: number; claims: number; relationships: number; sources: number };
  trace_id?: string;
}

export interface KnowledgeReadinessResponse {
  ok: true;
  contract_version: KnowledgeContractVersion;
  schema_ready: boolean;
  trace_id?: string;
}

export interface KnowledgeImportResponse {
  ok: true;
  idempotency_key: string;
  result: KnowledgeImportResultCounts;
  duplicate: boolean;
  trace_id?: string;
}

// --- Typed error codes (match LOOP_KNOWLEDGE_CONTRACT.md table) ------------
export const KNOWLEDGE_ERROR_CODES = [
  'bad_request',        // 400 -> validation
  'unauthorized',       // 401 -> auth
  'forbidden',          // 403 -> forbidden
  'not_found',          // 404 -> not_found
  'conflict',           // 409 -> conflict (idempotency-key/payload or version conflict)
  'gone',               // 410 -> gone
  'too_large',          // 413 -> too_large
  'schema_incompatible',// 422 -> schema_incompatible
  'rate_limited',       // 429 -> rate_limited (retryable)
  'unavailable',        // 503 -> unavailable (retryable)
  'internal',           // 5xx -> loop_error (retryable)
] as const;
export type KnowledgeErrorCode = (typeof KNOWLEDGE_ERROR_CODES)[number];

export const KNOWLEDGE_ERROR_STATUS: Record<KnowledgeErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  gone: 410,
  too_large: 413,
  schema_incompatible: 422,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
};

// --- Batch limits (documented + enforced; return 413 too_large beyond) -----
// The event gateway caps a single event payload at 64 KB; an import batch is
// larger. These are the initial documented limits; PetsInMyCity chunks if needed.
export const KNOWLEDGE_BATCH_LIMITS = {
  maxBodyBytes: 4 * 1024 * 1024, // 4 MB total request body
  maxEntities: 5000,
  maxClaims: 20000,
  maxRelationships: 20000,
  maxSources: 10000,
  maxEntitySources: 40000,
  maxClaimSources: 40000,
} as const;
