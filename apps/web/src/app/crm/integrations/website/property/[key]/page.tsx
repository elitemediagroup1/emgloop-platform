import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePermission } from '../../../../../../auth/guard';
import { LIVE_ORG_SLUG } from '../../../../../../crm/live-org';
import { EMG_WEBSITE_PROPERTIES, sdkInstallScript, propertyIdentifier } from '@emgloop/database';

// Website SDK  -  single property manager (Sprint 16).
//
// Management layer only: generates the install <script>, the public property
// identifier and the (future) ingest key reference for one EMG property. The
// browser SDK itself is NOT built here. Key rotation is surfaced as an action
// stub so the operator UX is complete ahead of the backend (Sprint 17+).

export const dynamic = 'force-dynamic';

export default async function PropertyPage({ params }: { params: { key: string } }) {
  await requirePermission('integrations', 'view');
  const property = EMG_WEBSITE_PROPERTIES.find((p) => p.key === params.key);
  if (!property) notFound();
  const script = sdkInstallScript(property, LIVE_ORG_SLUG);
  const pid = propertyIdentifier(property);

  return (
    <>
      <div className="crm-wf-head">
        <div>
          <p className="crm-sub" style={{ marginBottom: '0.25rem' }}>
            <Link href="/crm/integrations" className="crm-link">Integration OS</Link> /{' '}
            <Link href="/crm/integrations/website" className="crm-link">EMG Websites</Link> / {property.name}
          </p>
          <h1 className="crm-h1">{property.name}</h1>
          <p className="crm-sub">{property.domain}  -  Installation: Not installed</p>
        </div>
      </div>

      <div className="ios-detail-grid">
        <div>
          <div className="ios-section">
            <h2>Generate Install Code</h2>
            <p className="crm-sub" style={{ marginBottom: '0.6rem' }}>Paste this snippet into the &lt;head&gt; of {property.domain}. The referenced emg-loop.js ships in a later sprint.</p>
            <code className="ios-codeblock">{script}</code>
          </div>
          <div className="ios-section">
            <h2>Verify Installation</h2>
            <p className="crm-sub">Once the SDK is live and the property emits an event, the OS detects it on the website webhook and flips this property to Installed automatically.</p>
            <p className="crm-empty" style={{ marginTop: '0.6rem' }}>Awaiting first website event for this property.</p>
          </div>
        </div>
        <div>
          <div className="ios-section">
            <h2>Property</h2>
            <div className="ios-card-meta" style={{ gridTemplateColumns: '1fr' }}>
              <div><span className="k">Property Key</span><span className="v">{property.key}</span></div>
              <div><span className="k">Property Identifier</span><span className="v"><code>{pid}</code></span></div>
              <div><span className="k">Organization</span><span className="v">{LIVE_ORG_SLUG}</span></div>
              <div><span className="k">SDK Version</span><span className="v">not installed</span></div>
            </div>
          </div>
          <div className="ios-section">
            <h2>Ingest Key</h2>
            <p className="crm-sub" style={{ marginBottom: '0.5rem' }}>Per-property key. Status only  -  the value is shown once at creation by the backend (Sprint 17+) and never again.</p>
            <div className="ios-secret">
              <div><div className="name">{pid}_KEY</div><div className="masked">not generated</div></div>
              <span className="ios-badge not_configured"><span className="ios-dot" />Not generated</span>
            </div>
            <div className="ios-card-foot" style={{ marginTop: '0.75rem' }}>
              <button type="button" className="crm-btn-sm" disabled>Generate Key</button>
              <button type="button" className="crm-btn-sm" disabled>Rotate Key</button>
            </div>
            <p className="crm-sub" style={{ marginTop: '0.5rem', fontSize: '0.72rem' }}>Key generation activates with the SDK backend in a later sprint.</p>
          </div>
        </div>
      </div>
    </>
  );
}
