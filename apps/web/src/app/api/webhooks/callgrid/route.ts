import { NextResponse } from 'next/server';
import { prisma, repositories, IngestionService } from '@emgloop/database';
import { getCallGridProvider, mapCallgridEventType } from '@emgloop/providers';
import type { ProviderContext } from '@emgloop/providers';
import { LIVE_ORG_SLUG, ensureLiveOrganization } from '../../../../crm/live-org';
import { mayAllowUnsigned, toVerificationDiagnostic, hostOf } from '../../../../crm/webhook-runtime';

// CallGrid webhook - Sprint 11 (First Live Integration) + Sprint 17 hardening.
//
// The single live ingress point for CallGrid call-tracking events. The flow is:
// 1. Read the RAW body (needed for signature verification before JSON parse).
// 2. Resolve the ServicesInMyCity organization + its CallGrid connection.
// 3. Verify signature + timestamp + replay via the CallGrid adapter (shared helper).
// 4. Parse the payload into provider-agnostic InboundEvents.
// 5. Hand them to the IngestionService, which runs the full Loop pipeline
//    (IntegrationEvent -> Customer -> Interaction -> Signal -> DomainEvent ->
//    Workflow -> enrichment -> Next Best Action) with idempotency + retry.
//
// Sprint 17 security rule: PRODUCTION NEVER ACCEPTS UNSIGNED TRAFFIC. The route
// fails closed when the signing secret is missing on the live deploy. Only a
// non-production preview may run allow-unsigned so reviewers can test. Every
// delivery records a non-secret verification diagnostic on the connection so the
// Integration OS can show Last Verification / Last Signature / Last Error.

export const dynamic = 'force-dynamic';

const provider = getCallGridProvider();

function headerMap(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  await ensureLiveOrganization();

  const org = await prisma.organization.findUnique({
    where: { slug: LIVE_ORG_SLUG },
    select: { id: true },
  });
  if (!org) {
    return NextResponse.json({ ok: false, error: 'organization-not-found' }, { status: 404 });
  }

  // Find (or lazily provision) the CallGrid ingestion connection so the admin
  // panel and the retry queue have a row to attach events + diagnostics to.
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

  const secretConfigured = !!process.env.CALLGRID_WEBHOOK_SECRET;
  // allowUnsigned is honoured ONLY off production; the live site fails closed.
  const host = hostOf(req);
  const allowUnsigned = mayAllowUnsigned(connection.config?.['allowUnsigned'] === true, host);

  const ctx: ProviderContext = {
    organizationId: org.id,
    credentials: {
      webhookSecret: process.env.CALLGRID_WEBHOOK_SECRET ?? '',
    },
    config: { allowUnsigned },
  };

  let payload: Record<string, unknown>;
  try {
    payload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid-json' }, { status: 400 });
  }

  // 3. Verify authenticity (signature + timestamp + replay).
  const verification = await provider.verifyWebhook(ctx, headerMap(req), rawBody);

  // Persist a non-secret verification diagnostic on the connection (best-effort).
  const diag = toVerificationDiagnostic(verification, secretConfigured);
  try {
    await repositories.integrations.updateConnection(org.id, connection.id, {
      config: { ...connection.config, lastVerification: diag, allowUnsigned: connection.config?.['allowUnsigned'] === true },
    });
  } catch {
    // diagnostics are advisory; never fail ingestion because of them
  }

  if (!verification.valid) {
    return NextResponse.json(
      { ok: false, error: 'verification-failed', reason: verification.reason },
      { status: 401 },
    );
  }

  // 4. Parse into provider-agnostic events.
  const events = await provider.parseWebhook(ctx, payload);

  // 5. Ingest through the full pipeline.
  const service = new IngestionService(prisma);
  const results = await service.ingest({
    organizationId: org.id,
    provider: 'callgrid',
    providerConnectionId: connection.id,
    mapEventType: mapCallgridEventType,
    events,
  });

  if (results.some((r) => r.status === 'processed')) {
    await repositories.integrations.updateConnection(org.id, connection.id, {
      status: 'CONNECTED',
      connectedAt: connection.connectedAt ? undefined : new Date(),
      lastSyncedAt: new Date(),
    });
  }

  return NextResponse.json({
    ok: true,
    received: events.length,
    verified: verification.valid,
    results: results.map((r) => ({
      externalId: r.externalId,
      status: r.status,
      interactionId: r.interactionId,
      customerId: r.customerId,
      nextBestActions: r.nextBestActions,
    })),
  });
}

// GET is a lightweight liveness probe for the webhook URL. It never processes
// events. It also reports whether a signing secret is configured (boolean only)
// and whether the live deploy would currently accept unsigned traffic.
export function GET(req: Request) {
  return NextResponse.json({
    ok: true,
    endpoint: 'callgrid-webhook',
    method: 'POST',
    secretConfigured: !!process.env.CALLGRID_WEBHOOK_SECRET,
    acceptsUnsigned: mayAllowUnsigned(true, hostOf(req)),
    capabilities: provider.capabilities(),
  });
}
