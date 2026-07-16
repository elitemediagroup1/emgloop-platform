// EMG Loop — Verified Knowledge Service
// GET /api/v1/knowledge/readiness
//
// Protected internal readiness probe. Confirms that the service can authenticate,
// that the verified-knowledge schema exists and its migration is applied, and
// that the knowledge store (Neon, via Prisma) is reachable — by running a trivial
// scoped count against a vk_* table.
//
// It returns ONLY safe operational booleans + the supported contract version. It
// never returns database URLs, credentials, SQL, or schema internals. On any
// failure it returns a non-disclosing 'unavailable' envelope.

import { repositories } from '@emgloop/database';
import {
  KNOWLEDGE_CONTRACT_VERSION,
  authenticateService,
  knowledgeError,
  knowledgeOk,
  resolveTraceId,
} from '../../../../../lib/knowledge/gateway';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const traceId = resolveTraceId(request);

  const authError = authenticateService(request, traceId);
  if (authError) return authError;

  try {
    const schemaReady = await repositories.verifiedKnowledge.schemaReady();
    return knowledgeOk(
      {
        contract_version: KNOWLEDGE_CONTRACT_VERSION,
        schema_ready: schemaReady,
      },
      traceId,
    );
  } catch {
    // Do not disclose the underlying cause (connection strings, SQL, etc.).
    return knowledgeError('unavailable', 'verified knowledge store is not ready', traceId);
  }
}

export async function POST() {
  return knowledgeError('bad_request', 'method not allowed; use GET', 'trc_method_guard');
}
