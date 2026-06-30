import Link from 'next/link';
import { notFound } from 'next/navigation';
import { loadOrFallback, DbNotConfigured } from '../../../../demo/db-health';
import { ensureLiveOrganization } from '../../../../crm/live-org';
import { requirePermission } from '../../../../auth/guard';
import {
  loadProviderCard,
  webhookUrlFor,
  connectionLabel,
  healthLabel,
  liveStateLabel,
  liveStateClass,
  verificationSummary,
  fmtTime,
  relativeTime,
} from '../../../../crm/integration-os';
import { sdkInstallScript, propertyIdentifier, EMG_WEBSITE_PROPERTIES } from '@emgloop/database';
import { LIVE_ORG_SLUG } from '../../../../crm/live-org';

// Integration OS  -  provider detail / connection wizard (Sprint 16).
//
// Generated entirely from the catalog spec + live status. Renders: connection
// wizard, health center, secret-status checklist (masked), required-config
// checklist, live event monitor, retry queue and diagnostics  -  for ANY
// provider. Website-class providers additionally render the SDK manager.

export const dynamic = 'force-dynamic';

function Mark({ ok, optional }: { ok: boolean; optional?: boolean }) {
  if (optional) return <span className="mark opt"> - </span>;
  return ok ? <span className="mark ok"> - </span> : <span className="mark no">!</span>;
}

export default async function ProviderDetailPage({
  params,
}: {
  params: { provider: string };
}) {
  await requirePermission('integrations', 'view');
  const { organizationId } = await ensureLiveOrganization();

  const result = await loadOrFallback(async () => {
    return loadProviderCard(organizationId, params.provider);
  });

  if (!result.ok) {
    return (<><h1 className="crm-h1">Integration OS</h1><DbNotConfigured /></>);
  }
  const card = result.data;
  if (!card) notFound();
  const { spec, status } = card;
  const webhookUrl = webhookUrlFor(spec);
  const isWebsite = spec.manages === 'website_properties';

  return (
    <>
      <div className="crm-wf-head">
        <div>
          <p className="crm-sub" style={{ marginBottom: '0.25rem' }}>
            <Link href="/crm/integrations" className="crm-link">Integration OS</Link> / {spec.displayName}
          </p>
          <h1 className="crm-h1">{spec.displayName}</h1>
          <p className="crm-sub">{spec.blurb}</p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <span className={'ios-badge ' + liveStateClass(status.liveState)}><span className="ios-dot" />{liveStateLabel(status.liveState)}</span>
          <span className={'ios-badge ' + status.connection}><span className="ios-dot" />{connectionLabel(status.connection)}</span>
        </div>
      </div>

      {/* Health Center row */}
      <div className="ios-card-meta" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: '1.5rem' }}>
        <div><span className="k">Health</span><span className="v">{healthLabel(status.health)}</span></div>
        <div><span className="k">Webhook</span><span className="v">{spec.webhookPath ? (status.webhookActive ? 'Active' : 'Awaiting events') : 'n/a'}</span></div>
        <div><span className="k">Authentication</span><span className="v">{status.authVerified ? 'Verified' : 'Pending'}</span></div>
        <div><span className="k">Last Event</span><span className="v">{relativeTime(status.lastEvent ? status.lastEvent.receivedAt : null)}</span></div>
        <div><span className="k">Events Today</span><span className="v">{status.eventsToday}</span></div>
        <div><span className="k">Processed</span><span className="v">{status.eventsProcessed}</span></div>
        <div><span className="k">Failed</span><span className="v">{status.eventsFailed}</span></div>
        <div><span className="k">Retry Queue</span><span className="v">{status.retryQueueDepth}</span></div>
      </div>

      <div className="ios-detail-grid">
        <div>
          {/* Connection Wizard */}
          <div className="ios-section">
            <h2>Connection Wizard</h2>
            <ol className="ios-steps">
              {spec.setupSteps.map((step, i) => (
                <li key={i} className="ios-step">
                  <div className="st">{step.title}</div>
                  <div className="sd">{step.detail}</div>
                  {step.generates === 'webhook_url' && webhookUrl ? (
                    <div className="sgen"><code className="ios-codeblock">POST {webhookUrl}</code></div>
                  ) : null}
                  {step.generates === 'required_events' && spec.recommendedEvents ? (
                    <div className="sgen">{spec.recommendedEvents.map((e) => (<span key={e} className="ios-eventtag">{e}</span>))}</div>
                  ) : null}
                  {step.generates === 'signing_secret_ref' ? (
                    <div className="sgen">{spec.secrets.map((s) => (<div key={s.envVar} className="sd">Set <code>{s.envVar}</code> in the server environment.</div>))}</div>
                  ) : null}
                  {step.generates === 'verification' ? (
                    <div className="sgen sd">{status.authVerified ? 'Verified  -  first live event received.' : 'Not verified yet  -  the OS marks this complete on the first live event.'}</div>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>

          {/* SDK Manager  -  website-class providers only */}
          {isWebsite ? (
            <div className="ios-section">
              <h2>SDK Manager</h2>
              <p className="crm-sub" style={{ marginBottom: '0.85rem' }}>
                Per-property install code and ingest identifiers. The browser SDK
                (emg-loop.js) is now served at /sdk/emg-loop.js - paste the snippet into each property to begin sending events.
              </p>
              {EMG_WEBSITE_PROPERTIES.map((prop) => (
                <div key={prop.key} style={{ marginBottom: '1rem' }}>
                  <div className="st" style={{ fontWeight: 600 }}>{prop.name} <span className="crm-sub"> -  {prop.domain}</span></div>
                  <div className="sd">Property id: <code>{propertyIdentifier(prop)}</code>  -  Installation: Not installed</div>
                  <code className="ios-codeblock">{sdkInstallScript(prop, LIVE_ORG_SLUG)}</code>
                  <div className="ios-card-foot">
                    <Link className="crm-btn-sm" href={'/crm/integrations/website/property/' + prop.key}>Manage Property</Link>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {/* Live Event Monitor + Diagnostics */}
          <div className="ios-section">
            <h2>Live Event Monitor</h2>
            {status.recentEvents.length === 0 ? (
              <p className="crm-empty">No events received yet. Live deliveries appear here in real time.</p>
            ) : (
              <table className="crm-table">
                <thead><tr><th>Event</th><th>External ID</th><th>Status</th><th>Received</th></tr></thead>
                <tbody>
                  {status.recentEvents.map((e) => (
                    <tr key={e.id}>
                      <td>{e.eventType ?? ' - '}</td>
                      <td><code className="crm-code-inline">{e.externalId ?? ' - '}</code></td>
                      <td><span className={'crm-integration-status ' + e.status}>{e.status}</span></td>
                      <td>{fmtTime(e.receivedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Retry Queue */}
          <div className="ios-section">
            <h2>Retry Queue</h2>
            {status.retryQueue.length === 0 ? (
              <p className="crm-empty">Retry queue is empty  -  all events processed cleanly.</p>
            ) : (
              <table className="crm-table">
                <thead><tr><th>Event</th><th>Status</th><th>Received</th><th>Error</th></tr></thead>
                <tbody>
                  {status.retryQueue.map((e) => (
                    <tr key={e.id}>
                      <td>{e.eventType ?? ' - '}</td>
                      <td><span className={'crm-integration-status ' + e.status}>{e.status}</span></td>
                      <td>{fmtTime(e.receivedAt)}</td>
                      <td style={{ color: '#f87171' }}>{e.errorMessage ?? ' - '}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div>
          {/* Required Configuration Checklist */}
          <div className="ios-section">
            <h2>Required Configuration</h2>
            <div className="ios-check">
              <Mark ok={Boolean(spec.webhookPath)} optional={!spec.webhookPath} />
              <span>Webhook endpoint {spec.webhookPath ? 'available' : 'not applicable'}</span>
            </div>
            {spec.secrets.map((s) => {
              const conf = status.secrets.find((x) => x.envVar === s.envVar);
              return (
                <div key={s.envVar} className="ios-check">
                  <Mark ok={Boolean(conf && conf.configured)} optional={!s.required} />
                  <span><code>{s.envVar}</code> {conf && conf.configured ? 'configured' : (s.required ? 'missing (required)' : 'optional')}</span>
                </div>
              );
            })}
            <div className="ios-check">
              <Mark ok={status.authVerified} />
              <span>First live event received &amp; verified</span>
            </div>
            <div className="ios-check">
              <Mark ok={status.connection === 'connected'} />
              <span>Connection active</span>
            </div>
          </div>

          {/* Secret Status  -  never reveals values */}
          <div className="ios-section">
            <h2>Secret Status</h2>
            <p className="crm-sub" style={{ marginBottom: '0.5rem' }}>Status only  -  values are never displayed.</p>
            {status.secrets.length === 0 ? (
              <p className="crm-empty">No secrets required for this provider.</p>
            ) : status.secrets.map((s) => (
              <div key={s.envVar} className="ios-secret">
                <div>
                  <div className="name">{s.envVar}</div>
                  <div className="masked">{s.configured ? ' - ' : 'not set'}</div>
                </div>
                <span className={'ios-badge ' + (s.configured ? 'connected' : (s.required ? 'error' : 'not_configured'))}>
                  <span className="ios-dot" />{s.configured ? 'Configured' : (s.required ? 'Missing' : 'Optional')}
                </span>
              </div>
            ))}
          </div>

          {/* Provider info / sync status */}
          <div className="ios-section">
            <h2>Diagnostics</h2>
            <div className="ios-card-meta" style={{ gridTemplateColumns: '1fr' }}>
              <div><span className="k">Readiness</span><span className="v">{spec.readiness.replace('_', ' ')}</span></div>
              <div><span className="k">Authentication</span><span className="v">{spec.authentication}</span></div>
              <div><span className="k">Delivery</span><span className="v">{spec.delivery.join(', ')}</span></div>
              <div><span className="k">Polling / Backfill</span><span className="v">{spec.pollingSupported ? 'Yes' : 'No'}</span></div>
              <div><span className="k">Idempotency</span><span className="v">{spec.idempotency ? 'Yes' : 'No'}</span></div>
              <div><span className="k">Retry</span><span className="v">{spec.retrySupported ? 'Yes' : 'No'}</span></div>
              <div><span className="k">Connected</span><span className="v">{fmtTime(status.connectedAt)}</span></div>
              <div><span className="k">Last Sync</span><span className="v">{fmtTime(status.lastSyncedAt)}</span></div>
              <div><span className="k">Last Verification</span><span className="v">{verificationSummary(status.lastVerification)}</span></div>
              <div><span className="k">Last Signature</span><span className="v">{status.lastVerification && status.lastVerification.signaturePrefix ? status.lastVerification.signaturePrefix : ' - '}</span></div>
              <div><span className="k">Secret Configured</span><span className="v">{status.allRequiredSecretsConfigured ? 'Yes' : 'No'}</span></div>
            </div>
            {spec.notes ? (<p className="crm-sub" style={{ marginTop: '0.75rem' }}>{spec.notes}</p>) : null}
          </div>
        </div>
      </div>
    </>
  );
}
