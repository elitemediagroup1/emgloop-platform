import { verifyWorkerRequest, WORKER_SIGNATURE_HEADER, WORKER_TIMESTAMP_HEADER } from '@emgloop/shared';
import { readConnectionWorkerEndpoint } from '../../../../connections/connection-environment';
import { readMetaEnvironment } from '../../../../meta/meta-environment';
import { metaRepository, metaService, metaAnalyticsService } from '../../../../meta/meta-runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function POST(request: Request) {
  const body = await request.text();
  const secret = readConnectionWorkerEndpoint()?.secret;
  if (body !== '{"purpose":"creator-meta-analytics","version":1}' || !secret || !verifyWorkerRequest(secret, { body, timestamp: request.headers.get(WORKER_TIMESTAMP_HEADER), signature: request.headers.get(WORKER_SIGNATURE_HEADER), toleranceMs: 60_000 })) return json({ ok: false }, 401);
  if (!readMetaEnvironment()) return json({ ok: true, enabled: false, processed: 0 });
  try {
    const repo = metaRepository();
    await repo.purgeExpiredAttempts();
    const analysis = await repo.dueAnalysis();
    const due = (await repo.due(1))[0];
    if (analysis && (!due || Math.floor(Date.now() / 60_000) % 2 === 0)) {
      const outcome = await metaAnalyticsService().analyze(analysis);
      return json({ ok: true, processed: 1, outcome });
    }
    if (!due) return json({ ok: true, processed: 0 });
    const outcome = await metaService().sync(due);
    return json({ ok: true, processed: 1, outcome });
  } catch { return json({ ok: false, failure: 'PASS_FAILED' }, 503); }
}
