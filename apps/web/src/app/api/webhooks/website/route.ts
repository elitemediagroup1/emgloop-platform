import { NextResponse } from 'next/server';
import { prisma, repositories, IngestionService } from '@emgloop/database';
import { getWebsiteProvider, mapWebsiteEventType } from '@emgloop/providers';
import type { ProviderContext } from '@emgloop/providers';
import { LIVE_ORG_SLUG, ensureLiveOrganization } from '../../../../crm/live-org';
import { mayAllowUnsigned, toVerificationDiagnostic, hostOf } from '../../../../crm/webhook-runtime';

// Website webhook - Sprint 14 (Website Intelligence) + Sprint 17 hardening.
//
// The single live ingress point for EMG-owned website events, emitted by the
// EMG Loop browser SDK (Sprint 17). It mirrors the CallGrid webhook exactly -
// same transport-only shape, same pipeline, same security posture:
// 1. Read the RAW body (needed for signature verification before JSON parse).
// 2. Resolve the live organization + its Website ingestion connection.
// 3. Verify signature + timestamp + replay via the Website adapter (shared helper).
// 4. Parse the payload (single event OR a batch) into provider-agnostic events.
// 5. Hand them to the IngestionService, which runs the full Loop pipeline.
//
// Sprint 17 security rule: PRODUCTION NEVER ACCEPTS UNSIGNED TRAFFIC. The route
// fails closed when WEBSITE_WEBHOOK_SECRET is missing on the live deploy. Only a
// non-production preview may run allow-unsigned so reviewers can test the SDK
// path. Every delivery records a non-secret verification diagnostic.

export const dynamic = 'force-dynamic';

const provider = getWebsiteProvider();

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

  let connection = (await repositories.integrations.listConnections(org.id)).find(
    (c) => c.provider === 'website' && c.category === 'ingestion',
  );
  if (!connection) {
    connection = await repositories.integrations.createConnection({
      organizationId: org.id,
      category: 'ingestion',
      provider: 'website',
      displayName: 'EMG Websites',
      config: { allowUnsigned: false },
    });
  }

  const secretConfigured = !!process.env.WEBSITE_WEBHOOK_SECRET;
  const host = hostOf(req);
  const allowUnsigned = mayAllowUnsigned(connection.config?.['allowUnsigned'] === true, host);

  const ctx: ProviderContext = {
    organizationId: org.id,
    credentials: {
      webhookSecret: process.env.WEBSITE_WEBHOOK_SECRET ?? '',
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

  const diag = toVerificationDiagnostic(verification, secretConfigured);
  try {
    await repositories.integrations.updateConnection(org.id, connection.id, {
      config: { ...connection.config, lastVerification: diag, allowUnsigned: connection.config?.['allowUnsigned'] === true },
    });
  } catch {
    // diagnostics are advisory
  }

  if (!verification.valid) {
    return NextResponse.json(
      { ok: false, error: 'verification-failed', reason: verification.reason },
      { status: 401 },
    );
  }

  // 4. Parse into provider-agnostic events (single or batched).
  const events = await provider.parseWebhook(ctx, payload);

  // 5. Ingest through the full pipeline.
  const service = new IngestionService(prisma);
  const results = await service.ingest({
    organizationId: org.id,
    provider: 'website',
    providerConnectionId: connection.id,
    mapEventType: mapWebsiteEventType,
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
// events. Reports whether a signing secret is configured (boolean only) and
// whether the live deploy would currently accept unsigned traffic.
export function GET(req: Request) {
  return NextResponse.json({
    ok: true,
    endpoint: 'website-webhook',
    method: 'POST',
    secretConfigured: !!process.env.WEBSITE_WEBHOOK_SECRET,
    acceptsUnsigned: mayAllowUnsigned(true, hostOf(req)),
    capabilities: provider.capabilities(),
  });
}
