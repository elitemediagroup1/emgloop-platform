// EMG Loop — Verified Knowledge Service
// GET /api/v1/knowledge/claims/:claimId?platform=..[&property=..][&organizationId=..]
//
// Fetch a single stored claim by its stable id within a tenant scope, including
// its provenance sources and current version. Scope is enforced at the query
// level, so a claim outside the caller's platform/property/organization is
// reported as not_found rather than leaked.
//
// Loop returns the claim + full metadata verbatim and applies NO KDP delivery
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
  context: { params: { claimId: string } },
) {
  const traceId = resolveTraceId(request);

  const authError = authenticateService(request, traceId);
  if (authError) return authError;

  const claimId = (context.params?.claimId || '').trim();
  if (!claimId) {
    return knowledgeError('bad_request', 'claimId is required', traceId);
  }

  const url = new URL(request.url);
  const scopeResult = resolveScopeFromQuery(url, traceId);
  if ('error' in scopeResult) return scopeResult.error;
  const { scope } = scopeResult;

  try {
    const claim = await repositories.verifiedKnowledge.getClaim(scope, claimId);
    if (!claim) {
      return knowledgeError('not_found', 'claim not found', traceId);
    }
    return knowledgeOk({ claim }, traceId);
  } catch (err) {
    return mapThrownError(err, traceId);
  }
}

export async function POST() {
  return knowledgeError('bad_request', 'method not allowed; use GET', 'trc_method_guard');
}
