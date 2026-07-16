// EMG Loop — Verified Knowledge Gateway helpers (kg.v1)
//
// Shared auth / tracing / scope / error-envelope helpers for the internal
// /api/v1/knowledge/* handlers. These endpoints are service-to-service only
// (never exposed to browsers): they authenticate with the same shared secret
// convention as the Loop Event Gateway (x-emg-loop-secret vs LOOP_EVENT_SECRET),
// fail closed when the secret is missing or wrong, and never log or return the
// secret. Every response carries a trace id.
//
// Loop STORES and RETURNS verified objects verbatim. It applies NO KDP delivery
// policy (admission / freshness / ranking / conflict / safety). The producer's
// KDP remains the sole delivery authority.

import { NextResponse } from 'next/server';
import {
  KNOWLEDGE_CONTRACT_VERSION,
  KNOWLEDGE_ERROR_STATUS,
  type KnowledgeErrorCode,
  type KnowledgeScope,
} from '@emgloop/shared';

export const KNOWLEDGE_SECRET_HEADER = 'x-emg-loop-secret';
export const KNOWLEDGE_TRACE_HEADER = 'x-emg-trace-id';

/** A short, non-secret trace id. Propagated from the caller when supplied. */
export function resolveTraceId(request: Request): string {
  const incoming = request.headers.get(KNOWLEDGE_TRACE_HEADER);
  if (incoming && incoming.trim().length > 0 && incoming.length <= 200) {
    return incoming.trim();
  }
  // Fall back to a fresh id. crypto.randomUUID is available in the edge/node
  // runtimes Next uses; guard just in case.
  try {
    return 'trc_' + crypto.randomUUID();
  } catch {
    return 'trc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
}

/** Typed error envelope: { ok:false, error:CODE, message, trace_id }. */
export function knowledgeError(
  code: KnowledgeErrorCode,
  message: string,
  traceId: string,
): NextResponse {
  const status = KNOWLEDGE_ERROR_STATUS[code] ?? 500;
  return NextResponse.json(
    { ok: false, error: code, message, trace_id: traceId },
    { status, headers: { [KNOWLEDGE_TRACE_HEADER]: traceId } },
  );
}

/** Success envelope helper (keeps the trace header on every response). */
export function knowledgeOk(body: Record<string, unknown>, traceId: string): NextResponse {
  return NextResponse.json(
    { ok: true, ...body, trace_id: traceId },
    { status: 200, headers: { [KNOWLEDGE_TRACE_HEADER]: traceId } },
  );
}

/**
 * Authenticate a service request. Returns null on success, or a ready-to-return
 * error response on failure. Fails CLOSED: if the Loop secret is unset we treat
 * the request as unauthorized rather than accepting it. The secret itself is
 * never echoed back or logged.
 */
export function authenticateService(request: Request, traceId: string): NextResponse | null {
  const expected = process.env.LOOP_EVENT_SECRET;
  if (!expected) {
    // Misconfiguration on the Loop side -> unauthorized, not open.
    return knowledgeError('unauthorized', 'service authentication unavailable', traceId);
  }
  const provided = request.headers.get(KNOWLEDGE_SECRET_HEADER);
  if (!provided || provided !== expected) {
    return knowledgeError('unauthorized', 'invalid or missing service credentials', traceId);
  }
  return null;
}

/**
 * Resolve the tenant scope from query params (for GET) or a supplied object
 * (for POST bodies). Enforces that a platform is always present: scope is
 * mandatory on every knowledge operation so a request can never run unscoped.
 * Returns either { scope } or { error } (never both).
 */
export function resolveScopeFromQuery(
  url: URL,
  traceId: string,
): { scope: KnowledgeScope } | { error: NextResponse } {
  const platform = (url.searchParams.get('platform') || '').trim();
  if (!platform) {
    return { error: knowledgeError('bad_request', 'platform is required', traceId) };
  }
  const property = url.searchParams.get('property');
  const organizationId = url.searchParams.get('organizationId');
  const workspaceId = url.searchParams.get('workspaceId');
  return {
    scope: {
      platform,
      property: property && property.trim() ? property.trim() : null,
      organizationId: organizationId && organizationId.trim() ? organizationId.trim() : null,
      workspaceId: workspaceId && workspaceId.trim() ? workspaceId.trim() : null,
    },
  };
}

/** Validate a scope object taken from a request body. */
export function validateScopeObject(
  value: unknown,
  traceId: string,
): { scope: KnowledgeScope } | { error: NextResponse } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: knowledgeError('bad_request', 'scope is required and must be an object', traceId) };
  }
  const s = value as Record<string, unknown>;
  const platform = typeof s.platform === 'string' ? s.platform.trim() : '';
  if (!platform) {
    return { error: knowledgeError('bad_request', 'scope.platform is required', traceId) };
  }
  return {
    scope: {
      platform,
      property: typeof s.property === 'string' && s.property.trim() ? s.property.trim() : null,
      organizationId:
        typeof s.organizationId === 'string' && s.organizationId.trim() ? s.organizationId.trim() : null,
      workspaceId:
        typeof s.workspaceId === 'string' && s.workspaceId.trim() ? s.workspaceId.trim() : null,
    },
  };
}

/**
 * Map a thrown error to a typed, NON-DISCLOSING envelope. Never leaks Prisma
 * traces, SQL, connection strings, secrets, or stack frames. Recognised domain
 * error codes are surfaced with their contract code; everything else collapses
 * to a generic 'internal'.
 */
export function mapThrownError(err: unknown, traceId: string): NextResponse {
  const code = (err as { code?: string } | null)?.code;
  if (code === 'IDEMPOTENCY_CONFLICT') {
    return knowledgeError('conflict', 'idempotency key reused with a different payload', traceId);
  }
  if (code === 'VERSION_CONFLICT') {
    return knowledgeError('conflict', 'version conflict', traceId);
  }
  if (code === 'SCHEMA_INCOMPATIBLE') {
    return knowledgeError('schema_incompatible', 'unsupported schema version', traceId);
  }
  if (code === 'TOO_LARGE') {
    return knowledgeError('too_large', 'import batch exceeds limits', traceId);
  }
  // Prisma connectivity classes -> retryable unavailable (still non-disclosing).
  if (code === 'P1001' || code === 'P1002' || code === 'P1017') {
    return knowledgeError('unavailable', 'knowledge store temporarily unavailable', traceId);
  }
  return knowledgeError('internal', 'an unexpected error occurred', traceId);
}

export { KNOWLEDGE_CONTRACT_VERSION };
