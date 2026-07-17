// EMG Loop — Verified Knowledge Service
// GET /api/v1/knowledge/entities/:stableId?platform=..[&property=..][&organizationId=..]
//
// Fetch a single stored entity by its stable id within a tenant scope, including
// its aliases, attributes, verification/confidence metadata and provenance
// sources. Scope is enforced at the query level: an entity outside the caller's
// platform/property/organization is reported not_found, never leaked.
//
// Loop returns the entity + full metadata verbatim and applies NO KDP delivery
// policy.

import { repositories } from '@emgloop/database';
import {
  authenticateService,
  knowledgeError,
  knowledgeOk,
  mapThrownError,
  resolveScopeFromQuery,
  resolveTraceId,
} from '../../../../../../lib/knowledge/gateway';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: { stableId: string } },
) {
  const traceId = resolveTraceId(request);

  const authError = authenticateService(request, traceId);
  if (authError) return authError;

  const stableId = (context.params?.stableId || '').trim();
  if (!stableId) {
    return knowledgeError('bad_request', 'stableId is required', traceId);
  }

  const url = new URL(request.url);
  const scopeResult = resolveScopeFromQuery(url, traceId);
  if ('error' in scopeResult) return scopeResult.error;
  const { scope } = scopeResult;

  try {
    const entity = await repositories.verifiedKnowledge.getEntity(scope, stableId);
    if (!entity) {
      return knowledgeError('not_found', 'entity not found', traceId);
    }
    return knowledgeOk({ entity }, traceId);
  } catch (err) {
    return mapThrownError(err, traceId);
  }
}

export async function POST() {
  return knowledgeError('bad_request', 'method not allowed; use GET', 'trc_method_guard');
}
