import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePermission } from '../../../../../../auth/guard';
import { requireCrmContext } from '../../../../../../crm/crm-data';
import { LIVE_ORG_SLUG } from '../../../../../../crm/live-org';
import {
  loadProviderCard,
  fmtTime,
  relativeTime,
  verificationSummary,
  liveStateLabel,
  liveStateClass,
} from '../../../../../../crm/integration-os';
import {
  EMG_WEBSITE_PROPERTIES,
  sdkInstallScript,
  propertyIdentifier,
  propertyIngestKey,
  propertyAllowedDomains,
} from '@emgloop/database';

// Website SDK - single property manager (Sprint 16 + Sprint 17 ingest auth).
//
// Management layer for one EMG property. Sprint 17 makes the ingest key REAL:
// browser events authenticate with a PUBLIC per-property ingest key plus
// allowed-domain validation (NOT a browser secret - see property-ingest.ts).
// This page therefore shows the live, non-secret status: the public ingest
// key, the allowed domains, the install snippet, the last SDK event seen on
// the website connection, and the latest verification outcome. It never shows
// any secret value (the server-to-server WEBSITE_WEBHOOK_SECRET is boolean-only
// elsewhere in the OS).

export const dynamic = 'force-dynamic';

export default async function PropertyPage({ params }: { params: { key: string } }) {
  await requirePermission('integrations', 'view');
  const property = EMG_WEBSITE_PROPERTIES.find((p) => p.key === params.key);
  if (!property) notFound();

  const script = sdkInstallScript(property, LIVE_ORG_SLUG);
  const pid = propertyIdentifier(property);
  const ingestKey = propertyIngestKey(property);
  const allowedDomains = propertyAllowedDomains(property);

  // Live website-connection status (shared across properties for now). Used to
  // surface the last SDK event + verification honestly; per-property event
  // breakdown is a Sprint 18 follow-up (needs per-property ingest keys in the
  // event store, noted in the report).
  const { organizationId } = await requireCrmContext();
  const card = await loadProviderCard(organizationId, 'website');
  const status = card?.status ?? null;
  const lastEvent = status?.lastEvent ?? null;
  const installed = Boolean(lastEvent);

  return (
    <>
      <div className="crm-wf-head">
        <div>
          <p className="crm-sub" style={{ marginBottom: '0.25rem' }}>
            <Link href="/crm/integrations" className="crm-link">Integration OS</Link> /{' '}
            <Link href="/crm/integrations/website" className="crm-link">EMG Websites</Link> / {property.name}
          </p>
          <h1 className="crm-h1">{property.name}</h1>
          <p className="crm-sub">
            {property.domain} - Installation: {installed ? 'Installed' : 'Not installed'}
          </p>
        </div>
        {status ? (
          <span className={'ios-badge ' + liveStateClass(status.liveState)}>
            <span className="ios-dot" />{liveStateLabel(status.liveState)}
          </span>
        ) : null}
      </div>

      <div className="ios-detail-grid">
        <div>
          <div className="ios-section">
            <h2>Generate Install Code</h2>
            <p className="crm-sub" style={{ marginBottom: '0.6rem' }}>Paste this snippet into the &lt;head&gt; of {property.domain}. It carries the public ingest key and is served live from /sdk/emg-loop.js.</p>
            <code className="ios-codeblock">{script}</code>
          </div>
          <div className="ios-section">
            <h2>Verify Installation</h2>
            <p className="crm-sub">Once the SDK is live and the property emits an event, the OS detects it on the website webhook and flips this property to Installed automatically.</p>
            {lastEvent ? (
              <div className="ios-card-meta" style={{ gridTemplateColumns: '1fr', marginTop: '0.6rem' }}>
                <div><span className="k">Last SDK Event</span><span className="v">{lastEvent.eventType ?? 'event'}</span></div>
                <div><span className="k">Seen</span><span className="v">{fmtTime(lastEvent.receivedAt)} ({relativeTime(lastEvent.receivedAt)})</span></div>
              </div>
            ) : (
              <p className="ios-empty" style={{ marginTop: '0.6rem' }}>Awaiting first website event for this property.</p>
            )}
            <p className="crm-sub" style={{ marginTop: '0.5rem', fontSize: '0.72rem' }}>Verification: {verificationSummary(status?.lastVerification ?? null)}</p>
          </div>
        </div>
        <div>
          <div className="ios-section">
            <h2>Property</h2>
            <div className="ios-card-meta" style={{ gridTemplateColumns: '1fr' }}>
              <div><span className="k">Property Key</span><span className="v">{property.key}</span></div>
              <div><span className="k">Property Identifier</span><span className="v"><code>{pid}</code></span></div>
              <div><span className="k">Organization</span><span className="v">{LIVE_ORG_SLUG}</span></div>
              <div><span className="k">SDK Version</span><span className="v">{installed ? 'detected' : 'not installed'}</span></div>
            </div>
          </div>
          <div className="ios-section">
            <h2>Browser Ingest Key</h2>
            <p className="crm-sub" style={{ marginBottom: '0.5rem' }}>PUBLIC per-property key (ships in the browser; NOT a secret). Browser events are authenticated by this key being active for the property PLUS the request origin matching an allowed domain.</p>
            <div className="ios-secret">
              <div><div className="name">{pid}</div><div className="masked"><code>{ingestKey}</code></div></div>
              <span className="ios-badge connected"><span className="ios-dot" />Configured</span>
            </div>
            <div className="ios-card-meta" style={{ gridTemplateColumns: '1fr', marginTop: '0.75rem' }}>
              <div><span className="k">Allowed Domains</span><span className="v">{allowedDomains.join(', ')}</span></div>
            </div>
            <p className="crm-sub" style={{ marginTop: '0.5rem', fontSize: '0.72rem' }}>Server-to-server website events use the signed WEBSITE_WEBHOOK_SECRET tier instead (its value is never shown).</p>
          </div>
        </div>
      </div>
    </>
  );
}
