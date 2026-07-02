import { NextResponse } from 'next/server';
import {
  prisma,
  repositories,
  CallGridReconciliationService,
  type SyncRange,
} from '@emgloop/database';
import { can } from '../../../../../auth/auth';
import { LIVE_ORG_SLUG, ensureLiveOrganization } from '../../../../../crm/live-org';

// CallGrid reconciliation sync - Sprint 17 (admin-only).
//
// POST /api/integrations/callgrid/sync  { range: "today" | "24h" | "7d" }
//
// Pulls recent calls from the CallGrid REST API (source of truth) and brings
// the Loop in sync: imports calls the webhook missed and enriches calls that
// arrived without full attribution. Admin-only (integrations:manage). The API
// key is read from CALLGRID_API_KEY and never returned. Webhook ingestion and
// Bearer webhook auth are untouched by this route.

export const dynamic = 'force-dynamic';

const VALID_RANGES: SyncRange[] = ['today', '24h', '7d'];

export async function POST(req: Request) {
  const allowed = await can('integrations', 'manage');
  if (!allowed) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  let range: SyncRange = '24h';
  try {
    const body = (await req.json()) as { range?: string };
    if (body && typeof body.range === 'string' && (VALID_RANGES as string[]).includes(body.range)) {
      range = body.range as SyncRange;
    }
  } catch {
    // empty/invalid body -> default range
  }

  const apiKey = process.env.CALLGRID_API_KEY || '';
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: 'api-key-not-configured', hint: 'Set CALLGRID_API_KEY in Netlify.' },
      { status: 400 },
    );
  }

  await ensureLiveOrganization();
  const org = await prisma.organization.findUnique({
    where: { slug: LIVE_ORG_SLUG },
    select: { id: true },
  });
  if (!org) {
    return NextResponse.json({ ok: false, error: 'organization-not-found' }, { status: 404 });
  }
  let connection = (await repositories.integrations.listConnections(org.id)).find(
    (c) => c.provider === 'callgrid' && c.category === 'ingestion',
  );
  if (!connection) {
    connection = await repositories.integrations.createConnection({
      organizationId: org.id,
      category: 'ingestion',
      provider: 'callgrid',
      displayName: 'CallGrid',
      config: { allowUnsigned: false },
    });
  }

  const apiBaseUrl =
    typeof connection.config?.['apiBaseUrl'] === 'string'
      ? (connection.config['apiBaseUrl'] as string)
      : undefined;
  const service = new CallGridReconciliationService(prisma);

  try {
    const result = await service.reconcile({
    organizationId: org.id,
    apiKey,
    range,
    apiBaseUrl,
    providerConnectionId: connection.id,
  });

  const diag = {
    at: result.at,
    range: result.range,
    since: result.since,
    until: result.until,
    fetched: result.fetched,
    imported: result.imported,
    enriched: result.enriched,
    skippedDuplicate: result.skippedDuplicate,
    failed: result.failed,
    errorCount: result.errors.length,
    apiKeyConfigured: true,
  };
  try {
    await repositories.integrations.updateConnection(org.id, connection.id, {
      config: { ...connection.config, lastApiSync: diag },
      lastSyncedAt: new Date(),
    });
  } catch {
    // diagnostics are advisory; never fail the sync because of them
  }

    return NextResponse.json({ ok: true, result });
  } catch (err) {
    // Never let an exception escape as a non-JSON framework error page.
    const message = err instanceof Error ? err.message : 'sync-failed';
    return NextResponse.json(
      { ok: false, error: 'sync-failed', detail: message },
      { status: 500 },
    );
  }
}
