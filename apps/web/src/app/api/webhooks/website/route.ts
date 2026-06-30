import { NextResponse } from 'next/server';
import { prisma, repositories, IngestionService } from '@emgloop/database';
import {
  EMG_WEBSITE_PROPERTIES,
  propertyIngestKey,
  propertyAllowedDomains,
} from '@emgloop/database';
import { getWebsiteProvider, mapWebsiteEventType, verifyPropertyIngest } from '@emgloop/providers';
import type { ProviderContext, PropertyIngestIdentity } from '@emgloop/providers';
import { LIVE_ORG_SLUG, ensureLiveOrganization } from '../../../../crm/live-org';
import {
  mayAllowUnsigned,
  toVerificationDiagnostic,
  hostOf,
  isProductionRuntime,
} from '../../../../crm/webhook-runtime';

// Website webhook - Sprint 14 (Website Intelligence) + Sprint 17 hardening.
//
// The single live ingress point for EMG-owned website events. Sprint 17 gives
// it TWO clearly-separated authentication tiers, because the two senders have
// very different trust properties:
//
//   A. BROWSER SDK INGEST (the emg-loop.js tracker in untrusted client code).
//      Browsers cannot hold a secret, so we do NOT pretend these are HMAC
//      signed. Instead the request must carry a known/active PUBLIC per-property
//      ingest key (pk_emg_<property>) AND, in production, come from an allowed
//      domain for that property (Origin/Referer). See verifyPropertyIngest.
//
//   B. SERVER-TO-SERVER SIGNED EVENTS (trusted backends sending website data).
//      These keep the strong HMAC-SHA256 path over WEBSITE_WEBHOOK_SECRET via
//      the Website adapter (signature + timestamp + replay protection).
//
// Which tier applies is chosen by the request itself: an ingest key (header
// x-emg-ingest-key or body.ingestKey) selects the browser tier; otherwise the
// signed server-to-server tier is required. Both fail closed in production -
// the browser tier enforces allowed-domain + known key; the signed tier
// rejects when WEBSITE_WEBHOOK_SECRET is missing. Every delivery records a
// non-secret verification diagnostic (mode + outcome, never the key/secret).

export const dynamic = 'force-dynamic';

const provider = getWebsiteProvider();

// Public, non-secret identities the browser tier authenticates against. Built
// from the catalog so adding a property needs no route change.
const PROPERTY_IDENTITIES: PropertyIngestIdentity[] = EMG_WEBSITE_PROPERTIES.map((prop) => ({
  key: prop.key,
  ingestKey: propertyIngestKey(prop),
  allowedDomains: propertyAllowedDomains(prop),
}));

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

  // ---- Choose the authentication tier from the request itself -------------
  const ingestKey = readIngestKey(headers, payload);
  const isBrowserTier = ingestKey !== '';

  let verified = false;
  let mode: 'browser-ingest' | 'signed-server' = isBrowserTier ? 'browser-ingest' : 'signed-server';
  let diagPrefix = '';
  let diagReason: string | undefined;
  let diagTimestamp: number | undefined;

  if (isBrowserTier) {
    // A. BROWSER SDK INGEST - public key + allowed-domain. No HMAC (browser).
    const claimedProperty =
      typeof payload['property'] === 'string' ? (payload['property'] as string) : undefined;
    const originHost = originHostOf(headers);
    const ingest = verifyPropertyIngest(
      { ingestKey, property: claimedProperty, originHost, enforceDomain: isProd },
      PROPERTY_IDENTITIES,
    );
    verified = ingest.valid;
    diagPrefix = ingest.keyPrefix ?? '';
    diagReason = ingest.valid
      ? 'browser-ingest' + (ingest.domainMatched ? '-domain-ok' : '-no-domain')
      : 'browser:' + (ingest.reason ?? 'rejected');

    if (!verified) {
      await persistDiag(org.id, connection.id, connection.config, {
        valid: false, reason: diagReason, signaturePrefix: diagPrefix,
      }, secretConfigured);
      return NextResponse.json(
        { ok: false, error: 'ingest-rejected', mode, reason: ingest.reason },
        { status: 401 },
      );
    }
  } else {
    // B. SERVER-TO-SERVER SIGNED EVENTS - strong HMAC over WEBSITE_WEBHOOK_SECRET.
    const allowUnsigned = mayAllowUnsigned(
      connection.config?.['allowUnsigned'] === true,
      host,
    );
    const ctx: ProviderContext = {
      organizationId: org.id,
      credentials: { webhookSecret: process.env.WEBSITE_WEBHOOK_SECRET ?? '' },
      config: { allowUnsigned },
    };
    const verification = await provider.verifyWebhook(ctx, headers, rawBody);
    verified = verification.valid;
    diagPrefix = verification.signaturePrefix ?? '';
    diagReason = verification.valid ? 'signed-server' : (verification.reason ?? 'rejected');
    diagTimestamp = verification.timestamp;

    if (!verified) {
      await persistDiag(org.id, connection.id, connection.config, {
        valid: false, reason: diagReason, signaturePrefix: diagPrefix, timestamp: diagTimestamp,
      }, secretConfigured);
      return NextResponse.json(
        { ok: false, error: 'verification-failed', mode, reason: verification.reason },
        { status: 401 },
      );
    }
  }

  // Record the successful verification diagnostic (non-secret).
  await persistDiag(org.id, connection.id, connection.config, {
    valid: true, reason: diagReason, signaturePrefix: diagPrefix, timestamp: diagTimestamp,
  }, secretConfigured);

  // ---- Parse + ingest through the full pipeline (shared by both tiers) ----
  const parseCtx: ProviderContext = {
    organizationId: org.id,
    credentials: {},
    config: {},
  };
  const events = await provider.parseWebhook(parseCtx, payload);

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
    mode,
    received: events.length,
    verified,
    results: results.map((r) => ({
      externalId: r.externalId,
      status: r.status,
      interactionId: r.interactionId,
      customerId: r.customerId,
      nextBestActions: r.nextBestActions,
    })),
  });
}

/** Persist a non-secret verification diagnostic on the connection (advisory). */
async function persistDiag(
  orgId: string,
  connectionId: string,
  currentConfig: Record<string, unknown>,
  result: { valid: boolean; reason?: string; signaturePrefix?: string; timestamp?: number },
  secretConfigured: boolean,
): Promise<void> {
  try {
    const diag = toVerificationDiagnostic(result, secretConfigured);
    await repositories.integrations.updateConnection(orgId, connectionId, {
      config: {
        ...currentConfig,
        lastVerification: diag,
        allowUnsigned: currentConfig?.['allowUnsigned'] === true,
      },
    });
  } catch {
    // diagnostics are advisory; never block ingestion on a write failure.
  }
}

// GET is a lightweight liveness probe for the webhook URL. It never processes
// events. Reports whether a signing secret is configured (boolean only), the
// number of known browser-ingest properties, and whether the signed tier would
// currently accept unsigned traffic on this deploy.
export function GET(req: Request) {
  return NextResponse.json({
    ok: true,
    endpoint: 'website-webhook',
    method: 'POST',
    secretConfigured: !!process.env.WEBSITE_WEBHOOK_SECRET,
    acceptsUnsigned: mayAllowUnsigned(true, hostOf(req)),
    browserIngestProperties: PROPERTY_IDENTITIES.length,
    enforcesDomain: isProductionRuntime(hostOf(req)),
    capabilities: provider.capabilities(),
  });
}
