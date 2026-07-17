// EMG Loop — Verified Knowledge Service
// POST /api/v1/knowledge/import
//
// Batch-import verified knowledge (entities / claims / relationships / sources /
// provenance) into the durable, tenant-isolated verified knowledge graph.
//
// - Service-to-service only (x-emg-loop-secret). Fails closed.
// - Idempotent on (scope, idempotency_key): identical retries return the prior
//   outcome; the same key with a different payload is a 409 conflict.
// - Applied atomically in a single Prisma transaction; append-only versioning.
// - Loop stores objects verbatim and applies NO KDP delivery policy.
//
// Loop does NOT decide admissibility / freshness / ranking / conflict / safety;
// PetsInMyCity's KDP remains the delivery authority.

import { repositories } from '@emgloop/database';
import {
  KNOWLEDGE_BATCH_LIMITS,
  KNOWLEDGE_CONTRACT_VERSION,
  type KnowledgeImportBatch,
} from '@emgloop/shared';
import {
  authenticateService,
  knowledgeError,
  knowledgeOk,
  mapThrownError,
  resolveTraceId,
  validateScopeObject,
} from '../../../../../lib/knowledge/gateway';

export const dynamic = 'force-dynamic';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function countOf(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

export async function POST(request: Request) {
  const traceId = resolveTraceId(request);

  // --- Auth (fail closed) --------------------------------------------------
  const authError = authenticateService(request, traceId);
  if (authError) return authError;

  // --- Content type --------------------------------------------------------
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return knowledgeError('bad_request', 'content-type must be application/json', traceId);
  }

  // --- Body size cap (reject oversized bodies before parsing where possible) -
  const declaredLength = Number(request.headers.get('content-length') || '0');
  if (declaredLength && declaredLength > KNOWLEDGE_BATCH_LIMITS.maxBodyBytes) {
    return knowledgeError('too_large', 'request body exceeds maximum size', traceId);
  }

  // --- Parse ---------------------------------------------------------------
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return knowledgeError('bad_request', 'invalid JSON body', traceId);
  }
  if (!isPlainObject(raw)) {
    return knowledgeError('bad_request', 'request body must be a JSON object', traceId);
  }

  const { scope: scopeRaw, idempotency_key: idempotencyKey, batch: batchRaw } = raw as Record<string, unknown>;

  // --- Scope (mandatory, isolates every write) -----------------------------
  const scopeResult = validateScopeObject(scopeRaw, traceId);
  if ('error' in scopeResult) return scopeResult.error;
  const { scope } = scopeResult;

  // --- Idempotency key -----------------------------------------------------
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
    return knowledgeError('bad_request', 'idempotency_key is required', traceId);
  }

  // --- Batch shape ---------------------------------------------------------
  if (!isPlainObject(batchRaw)) {
    return knowledgeError('bad_request', 'batch is required and must be an object', traceId);
  }
  const batch = batchRaw as unknown as KnowledgeImportBatch;

  // Schema/contract version: forward-compatible on the same major (kg.*).
  const version = typeof batch.contract_version === 'string' ? batch.contract_version : '';
  if (!version) {
    return knowledgeError('bad_request', 'batch.contract_version is required', traceId);
  }
  if (!version.startsWith('kg.')) {
    return knowledgeError('schema_incompatible', 'unsupported contract version', traceId);
  }

  // --- Per-collection batch limits (typed too_large beyond) -----------------
  if (
    countOf(batch.entities) > KNOWLEDGE_BATCH_LIMITS.maxEntities ||
    countOf(batch.claims) > KNOWLEDGE_BATCH_LIMITS.maxClaims ||
    countOf(batch.relationships) > KNOWLEDGE_BATCH_LIMITS.maxRelationships ||
    countOf(batch.sources) > KNOWLEDGE_BATCH_LIMITS.maxSources ||
    countOf(batch.entity_sources) > KNOWLEDGE_BATCH_LIMITS.maxEntitySources ||
    countOf(batch.claim_sources) > KNOWLEDGE_BATCH_LIMITS.maxClaimSources
  ) {
    return knowledgeError('too_large', 'import batch exceeds per-collection limits', traceId);
  }

  // --- Apply (atomic, idempotent, append-only versioned) --------------------
  try {
    const outcome = await repositories.verifiedKnowledge.importBatch(
      scope,
      idempotencyKey.trim(),
      batch,
      traceId,
    );
    return knowledgeOk(
      {
        idempotency_key: idempotencyKey.trim(),
        contract_version: version || KNOWLEDGE_CONTRACT_VERSION,
        result: outcome.result,
        duplicate: outcome.duplicate,
      },
      traceId,
    );
  } catch (err) {
    return mapThrownError(err, traceId);
  }
}

// This endpoint is POST only.
export async function GET() {
  return knowledgeError('bad_request', 'method not allowed; use POST', 'trc_method_guard');
}
