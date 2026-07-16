// EMG Loop — Verified Knowledge Service
// GET /api/v1/knowledge/claims?platform=..&subject=..[&predicate=..]
//
// Query stored claims for a subject (optionally narrowed by predicate) within a
// tenant scope. Scope is applied at the persistence query level, so a caller can
// never read another platform/property/organization's claims.
//
// Loop returns claims + their full metadata (verification / confidence /
// safety_critical / validity window / review_by / provenance sources / version)
// VERBATIM. It does NOT apply KDP admission / freshness / ranking / conflict /
// safety filtering: that is the producer's KDP responsibility.

import { repositories } from '@emgloop/database';
import {
  authenticateService,
  knowledgeError,
  knowledgeOk,
  mapThrownError,
  resolveScopeFromQuery,
  resolveTraceId,
} from '../../../../../lib/knowledge/gateway';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const traceId = resolveTraceId(request);

  const authError = authenticateService(request, traceId);
  if (authError) return authError;

  const url = new URL(request.url);

  const scopeResult = resolveScopeFromQuery(url, traceId);
  if ('error' in scopeResult) return scopeResult.error;
  const { scope } = scopeResult;

  const subject = (url.searchParams.get('subject') || '').trim();
  if (!subject) {
    return knowledgeError('bad_request', 'subject is required', traceId);
  }
  const predicateParam = url.searchParams.get('predicate');
  const predicate = predicateParam && predicateParam.trim() ? predicateParam.trim() : null;

  try {
    const claims = await repositories.verifiedKnowledge.queryClaims(scope, subject, predicate);
    return knowledgeOk({ claims }, traceId);
  } catch (err) {
    return mapThrownError(err, traceId);
  }
}

export async function POST() {
  return knowledgeError('bad_request', 'method not allowed; use GET', 'trc_method_guard');
}
