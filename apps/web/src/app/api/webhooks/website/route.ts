import { NextResponse } from 'next/server';
import { prisma, repositories, IngestionService } from '@emgloop/database';
import { getWebsiteProvider, mapWebsiteEventType } from '@emgloop/providers';
import type { ProviderContext } from '@emgloop/providers';
import { LIVE_ORG_SLUG, ensureLiveOrganization } from '../../../../crm/live-org';

// Website webhook — Sprint 14 (Website Intelligence — The Brain's Second Sense).
//
// The single live ingress point for EMG-owned website events. It mirrors the
// CallGrid webhook exactly — same transport-only shape, same pipeline — so the
// Brain gains a second sense without any new architecture:
// 1. Read the RAW body (needed for signature verification before JSON parse).
// 2. Resolve the live organization + its Website ingestion connection.
// 3. Verify the webhook signature via the Website adapter (no secret here).
// 4. Parse the payload (single event OR a batch) into provider-agnostic events.
// 5. Hand them to the IngestionService, which runs the full Loop pipeline
//    (IntegrationEvent -> Customer -> Interaction -> Signal -> DomainEvent ->
//    Workflow -> enrichment -> Next Best Action) with idempotency + retry.
//
// No website-specific business logic lives here — the adapter + service own it.
// The adapter is resolved through the provider registry (Provider Layer), not
// constructed directly.

export const dynamic = 'force-dynamic';

// Resolve the Website adapter via the provider registry (registers on first use).
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
  // Promote/heal the live org (also runs the one-time schema-compat check).
  await ensureLiveOrganization();

  // Resolve the live organization (ServicesInMyCity + the other InMyCity sites
  // all report into the same production org for this sprint).
  const org = await prisma.organization.findUnique({
    where: { slug: LIVE_ORG_SLUG },
    select: { id: true },
  });
  if (!org) {
    return NextResponse.json({ ok: false, error: 'organization-not-found' }, { status: 404 });
  }

  // Find (or lazily provision) the Website ingestion connection so the admin
  // panel and the retry queue have a row to attach events to.
  let connection = (await repositories.integrations.listConnections(org.id)).find(
    (c) => c.provider === 'website' && c.category === 'ingestion',
  );
  if (!connection) {
    connection = await repositories.integrations.createConnection({
      organizationId: org.id,
      category: 'ingestion',
      provider: 'website',
      displayName: 'EMG Websites',
      config: { allowUnsigned: true },
    });
  }

  // Build the provider context. Secrets come from env (never persisted in code).
  // allowUnsigned lets reviewers exercise the live pipeline without a real secret.
  const ctx: ProviderContext = {
    organizationId: org.id,
    credentials: {
      webhookSecret: process.env.WEBSITE_WEBHOOK_SECRET ?? '',
    },
    config: {
      allowUnsigned:
        (connection.config?.['allowUnsigned'] === true) ||
        !process.env.WEBSITE_WEBHOOK_SECRET,
    },
  };

  // Parse JSON (after capturing the raw body for verification).
  let payload: Record<string, unknown>;
  try {
    payload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid-json' }, { status: 400 });
  }

  // 3. Verify authenticity.
  const verification = await provider.verifyWebhook(ctx, headerMap(req), rawBody);
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

  // Mark the connection as connected on first successful delivery.
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
    results: results.map((r) => ({
      externalId: r.externalId,
      status: r.status,
      interactionId: r.interactionId,
      customerId: r.customerId,
      nextBestActions: r.nextBestActions,
    })),
  });
}

// GET is a lightweight liveness probe for the webhook URL (useful for the admin
// "Webhook Status" check). It never processes events.
export function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: 'website-webhook',
    method: 'POST',
    capabilities: provider.capabilities(),
  });
}
