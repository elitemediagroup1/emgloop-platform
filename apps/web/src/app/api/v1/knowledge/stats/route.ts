// EMG Loop — Verified Knowledge Service
// GET /api/v1/knowledge/stats?platform=..[&property=..][&organizationId=..]
//
// Scoped counts of stored verified knowledge (entities / claims / relationships /
// sources) for the caller's tenant. Counts are computed with the scope applied
// at the query level, so a caller never sees totals spanning another
// platform/property/organization. No knowledge content is returned here.

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

  try {
    const counts = await repositories.verifiedKnowledge.stats(scope);
    return knowledgeOk({ counts }, traceId);
  } catch (err) {
    return mapThrownError(err, traceId);
  }
}

export async function POST() {
  return knowledgeError('bad_request', 'method not allowed; use GET', 'trc_method_guard');
}
