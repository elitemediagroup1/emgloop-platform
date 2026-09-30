import { createHash } from 'crypto';
import { NextResponse } from 'next/server';
import {
  prisma,
  repositories,
  IngestionService,
  WebPropertyRepository,
  admitWebsiteDelivery,
  type WebsiteAdmittedBatch,
} from '@emgloop/database';
import { getWebsiteProvider, mapWebsiteEventType } from '@emgloop/providers';
import type { ProviderContext } from '@emgloop/providers';
import {
  mayAllowUnsigned,
  toVerificationDiagnostic,
  hostOf,
  isProductionRuntime,
} from '../../../../crm/webhook-runtime';

// Website webhook -- the ingress for Loop's first-party website events.
//
// TENANCY COMES ONLY FROM A REGISTERED PROPERTY (2026-09-30). Each event names a property; the governed
// registry (web_properties) says which ONE organization that property belongs to and whether it may send
// telemetry now (LIVE + ingestion ENABLED only). An event whose property nobody registered is refused
// PROPERTY_UNREGISTERED; a known property that is not LIVE, PROPERTY_NOT_LIVE; a LIVE one with ingestion
// disabled, INGESTION_DISABLED. There is no default organization, no hardcoded live organization, and
// nothing in the request -- the browser's `organization` field, an Origin, a property it claims -- chooses one.
// Admission is `admitWebsiteDelivery` (@emgloop/database); this route only authenticates the tier, calls it,
// and ingests each admitted batch into its own organization.
//
// Two authentication tiers, chosen by the request:
//
//   A. BROWSER SDK INGEST (emg-loop.js, untrusted client code). A browser cannot hold a secret, so these are
//      not signed: the PUBLIC key pk_emg_<property> must name a REGISTERED property that is LIVE with ingestion ENABLED, and in production
//      the Origin must be one of that property's registered allowed domains. Every event must be that
//      property's.
//   B. SERVER-TO-SERVER SIGNED EVENTS. HMAC-SHA256 over WEBSITE_WEBHOOK_SECRET. That secret is shared, so it
//      proves a CLASS of sender, not a tenant: each event's property is still resolved through the registry.
//
// What is stored is the minimized event (WebsiteProvider): a page path without its query string, bounded
// labels, pseudonymous ids -- never an email, a phone number, a full URL, free-text search or a campaign name.
//
// A refusal is reported as a CODE. Where the refusal is attributable to a registered property, its
// organization's website connection records a non-secret diagnostic; an unregistered property has no
// organization to attribute to, so it is logged as a code with a short hash of the claimed key and nothing is
// written.

export const dynamic = 'force-dynamic';

const provider = getWebsiteProvider();

function headerMap(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

/** Extract the browser-tier ingest key, if present (header wins over body). */
function readIngestKey(headers: Record<string, string>, payload: Record<string, unknown>): string {
  const fromHeader = headers['x-emg-ingest-key'];
  if (typeof fromHeader === 'string' && fromHeader.trim()) return fromHeader.trim();
  const fromBody = payload['ingestKey'] ?? payload['ingest_key'];
  return typeof fromBody === 'string' ? fromBody.trim() : '';
}

/** Origin/Referer host of a browser request (no scheme/port). Empty if absent. */
function originHostOf(headers: Record<string, string>): string {
  const raw = headers['origin'] || headers['referer'] || headers['referrer'] || '';
  if (!raw) return '';
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return raw.replace(/^[a-z]+:\/\//i, '').split('/')[0]?.split(':')[0]?.toLowerCase() ?? '';
  }
}

/** A refusal no organization can be charged with: a code and a short hash, never the claimed value. */
function logUnattributed(code: string, tier: string, claimed: string): void {
  const ref = claimed ? createHash('sha256').update(claimed).digest('hex').slice(0, 12) : 'none';
  console.warn(`WEBSITE_INGEST_REFUSED code=${code} tier=${tier} claimRef=${ref}`);
}

/** This organization's website ingestion connection -- created on its first admitted delivery. */
async function websiteConnectionFor(organizationId: string) {
  const existing = (await repositories.integrations.listConnections(organizationId)).find(
    (c) => c.provider === 'website' && c.category === 'ingestion',
  );
  if (existing) return existing;
  return repositories.integrations.createConnection({
    organizationId,
    category: 'ingestion',
    provider: 'website',
    displayName: 'Website events',
    config: { allowUnsigned: false },
  });
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  const headers = headerMap(req);
  const host = hostOf(req);
  const isProd = isProductionRuntime(host);
  const secretConfigured = !!process.env.WEBSITE_WEBHOOK_SECRET;

  let payload: Record<string, unknown>;
  try {
    payload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid-json' }, { status: 400 });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return NextResponse.json({ ok: false, error: 'invalid-json' }, { status: 400 });
  }

  const ingestKey = readIngestKey(headers, payload);
  const tier = ingestKey !== '' ? ('BROWSER' as const) : ('SIGNED' as const);
  const mode = tier === 'BROWSER' ? 'browser-ingest' : 'signed-server';
  let diag: { reason: string; signaturePrefix: string; timestamp?: number } = { reason: mode, signaturePrefix: '' };

  if (tier === 'SIGNED') {
    // The signed tier authenticates BEFORE anything is resolved. Unsigned traffic is accepted only off
    // production, and only where the deploy allows it (mayAllowUnsigned); production never accepts it.
    const ctx: ProviderContext = {
      organizationId: '',
      credentials: { webhookSecret: process.env.WEBSITE_WEBHOOK_SECRET ?? '' },
      config: { allowUnsigned: mayAllowUnsigned(false, host) },
    };
    const verification = await provider.verifyWebhook(ctx, headers, rawBody);
    if (!verification.valid) {
      logUnattributed('SIGNATURE_INVALID', tier, '');
      return NextResponse.json({ ok: false, error: 'verification-failed', mode, reason: verification.reason }, { status: 401 });
    }
    diag = { reason: 'signed-server', signaturePrefix: verification.signaturePrefix ?? '', timestamp: verification.timestamp };
  }

  const events = await provider.parseWebhook({ organizationId: '', credentials: {}, config: {} }, payload);
  const admission = await admitWebsiteDelivery(new WebPropertyRepository(prisma), {
    tier,
    ingestKey,
    originHost: originHostOf(headers),
    enforceDomain: isProd,
    events,
  });

  if (admission.refusal) {
    if (admission.refusedProperty) {
      const connection = await websiteConnectionFor(admission.refusedProperty.organizationId);
      await persistDiag(admission.refusedProperty.organizationId, connection.id, connection.config, {
        valid: false, reason: 'browser:' + admission.refusal, signaturePrefix: ingestKey.slice(0, 10),
      }, secretConfigured, { [admission.refusal]: events.length || 1 });
    } else {
      logUnattributed(admission.refusal, tier, ingestKey);
    }
    return NextResponse.json({ ok: false, error: 'ingest-rejected', mode, reason: admission.refusal }, { status: 401 });
  }

  const unattributed = admission.rejected.filter((r) => !r.organizationId);
  for (const r of unattributed) logUnattributed(r.code, tier, '');
  // Refusals a registered property's owner can be charged with (not LIVE, ingestion disabled, mismatch), counted
  // on THAT organization's connection. The response never carries an organization id.
  const refusalsByOrg = new Map<string, Record<string, number>>();
  for (const r of admission.rejected) {
    if (!r.organizationId) continue;
    const counts = refusalsByOrg.get(r.organizationId) ?? {};
    counts[r.code] = (counts[r.code] ?? 0) + 1;
    refusalsByOrg.set(r.organizationId, counts);
  }
  const rejected = admission.rejected.map((r) => ({ index: r.index, code: r.code }));

  const service = new IngestionService(prisma);
  const results: { externalId: string; status: string }[] = [];
  for (const batch of admission.batches) {
    results.push(...(await ingestBatch(service, batch, diag, secretConfigured, refusalsByOrg.get(batch.organizationId) ?? {})));
    refusalsByOrg.delete(batch.organizationId);
  }
  for (const [organizationId, counts] of refusalsByOrg) {
    const connection = await websiteConnectionFor(organizationId);
    await persistDiag(organizationId, connection.id, connection.config, { valid: true, ...diag }, secretConfigured, counts);
  }

  if (admission.batches.length === 0) {
    return NextResponse.json({ ok: false, error: 'ingest-rejected', mode, rejected }, { status: 422 });
  }

  return NextResponse.json({
    ok: true,
    mode,
    received: events.length,
    accepted: results.length,
    rejected,
    results: results.map((r) => ({ externalId: r.externalId, status: r.status })),
  });
}

async function ingestBatch(
  service: IngestionService,
  batch: WebsiteAdmittedBatch,
  diag: { reason: string; signaturePrefix: string; timestamp?: number },
  secretConfigured: boolean,
  refusals: Record<string, number>,
) {
  const connection = await websiteConnectionFor(batch.organizationId);
  await persistDiag(batch.organizationId, connection.id, connection.config, { valid: true, ...diag }, secretConfigured, refusals);

  const results = await service.ingest({
    observationSource: 'WEBHOOK' as const,
    organizationId: batch.organizationId,
    provider: 'website',
    providerConnectionId: connection.id,
    mapEventType: mapWebsiteEventType,
    events: batch.events,
  });

  if (results.some((r) => r.status === 'processed')) {
    await repositories.integrations.updateConnection(batch.organizationId, connection.id, {
      status: 'CONNECTED',
      connectedAt: connection.connectedAt ? undefined : new Date(),
      lastSyncedAt: new Date(),
    });
  }
  return results;
}

/**
 * Persist a non-secret verification diagnostic on the organization's website connection (advisory), and add
 * to its refusal counters -- codes and counts only.
 */
async function persistDiag(
  orgId: string,
  connectionId: string,
  currentConfig: Record<string, unknown>,
  result: { valid: boolean; reason?: string; signaturePrefix?: string; timestamp?: number },
  secretConfigured: boolean,
  refusals: Record<string, number>,
): Promise<void> {
  try {
    const diag = toVerificationDiagnostic(result, secretConfigured);
    const prior = currentConfig?.['refusalCounts'];
    const counts: Record<string, number> = prior && typeof prior === 'object' && !Array.isArray(prior) ? { ...(prior as Record<string, number>) } : {};
    for (const [code, n] of Object.entries(refusals)) counts[code] = (typeof counts[code] === 'number' ? counts[code]! : 0) + n;
    await repositories.integrations.updateConnection(orgId, connectionId, {
      config: {
        ...currentConfig,
        lastVerification: diag,
        refusalCounts: counts,
        allowUnsigned: currentConfig?.['allowUnsigned'] === true,
      },
    });
  } catch {
    // diagnostics are advisory; never block ingestion on a write failure.
  }
}

// GET is a lightweight liveness probe for the webhook URL. It never processes events and names no property
// and no organization: whether a signing secret is configured (boolean only), whether this deploy would
// accept unsigned signed-tier traffic, and whether browser domains are enforced.
export function GET(req: Request) {
  return NextResponse.json({
    ok: true,
    endpoint: 'website-webhook',
    method: 'POST',
    secretConfigured: !!process.env.WEBSITE_WEBHOOK_SECRET,
    acceptsUnsigned: mayAllowUnsigned(true, hostOf(req)),
    tenancy: 'registered-property',
    enforcesDomain: isProductionRuntime(hostOf(req)),
    capabilities: provider.capabilities(),
  });
}
