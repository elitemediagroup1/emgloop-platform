import Link from 'next/link';
import { loadOrFallback, DbNotConfigured } from '../../../../../demo/db-health';
import { crmRepos } from '../../../../../crm/crm-data';
import { requireCrmContext } from '../../../../../crm/crm-data';
import { requirePermission } from '../../../../../auth/guard';

// CallGrid admin — Sprint 11 (First Live Integration, Phase 8).
//
// CRM > Settings > Integrations > CallGrid. Operational visibility into the live
// CallGrid connection: connection + webhook status, last event, processed/failed
// counts, and the retry queue (events stuck in RECEIVED/PROCESSING/FAILED). NO
// credentials are ever shown — this is monitoring only. All data comes from the
// IntegrationEvent / ProviderConnection tables via the repository layer.

export const dynamic = 'force-dynamic';

const WEBHOOK_PATH = '/api/webhooks/callgrid';

function fmt(ts: string | null): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

export default async function CallGridAdminPage() {
  await requirePermission('integrations', 'view');

  // Promote/resolve the live org so the connection + counts exist to display.
  const { organizationId } = await requireCrmContext();

  const result = await loadOrFallback(async () => {
    const [connections, counts, recent] = await Promise.all([
      crmRepos.integrations.listConnections(organizationId),
      crmRepos.integrations.countEventsByStatus(organizationId),
      crmRepos.integrations.listRecentEvents(organizationId, { provider: 'callgrid', limit: 25 }),
    ]);
    const connection = connections.find((c) => c.provider === 'callgrid') ?? null;
    return { connection, counts, recent };
  });

  if (!result.ok || !result.data) {
    return (
      <>
        <h1 className="crm-h1">CallGrid</h1>
        <DbNotConfigured />
      </>
    );
  }

  const { connection, counts, recent } = result.data;
  const processed = counts['PROCESSED'] ?? 0;
  const failed = counts['FAILED'] ?? 0;
  const received = counts['RECEIVED'] ?? 0;
  const processing = counts['PROCESSING'] ?? 0;
  const retryQueue = recent.filter((e) => e.status === 'FAILED' || e.status === 'RECEIVED' || e.status === 'PROCESSING');
  const lastEvent = recent[0] ?? null;
  const connectionStatus = connection?.status ?? 'NOT_CONNECTED';
  const webhookStatus = connection && connection.status === 'CONNECTED' ? 'Active' : 'Awaiting first event';

  return (
    <>
      <div className="crm-wf-head">
        <div>
          <p className="crm-sub" style={{ marginBottom: '0.25rem' }}>
            <Link href="/crm/settings" className="crm-link">Settings</Link> /{' '}
            <Link href="/crm/integrations" className="crm-link">Integrations</Link> / CallGrid
          </p>
          <h1 className="crm-h1">CallGrid</h1>
          <p className="crm-sub">
            Live call-tracking ingestion. Monitoring only — no credentials are stored or shown here.
          </p>
        </div>
      </div>

      {/* Status row */}
      <div className="crm-panel" style={{ marginBottom: '1.5rem', display: 'flex', gap: '2.5rem', flexWrap: 'wrap' }}>
        <div>
          <span className="crm-kpi-label">Connection Status</span>
          <div className={'crm-integration-status ' + connectionStatus}>{connectionStatus}</div>
        </div>
        <div>
          <span className="crm-kpi-label">Webhook Status</span>
          <div style={{ fontWeight: 600 }}>{webhookStatus}</div>
        </div>
        <div>
          <span className="crm-kpi-label">Last Event</span>
          <div style={{ fontWeight: 600 }}>
            {lastEvent ? lastEvent.eventType + ' · ' + fmt(lastEvent.receivedAt) : 'None yet'}
          </div>
        </div>
      </div>

      {/* Counters */}
      <div className="crm-integrations-grid" style={{ marginBottom: '1.5rem' }}>
        <div className="crm-integration-card">
          <span className="crm-kpi-label">Events Processed</span>
          <div className="crm-kpi-value" style={{ color: 'var(--crm-accent)' }}>{processed}</div>
        </div>
        <div className="crm-integration-card">
          <span className="crm-kpi-label">Events Failed</span>
          <div className="crm-kpi-value" style={{ color: 'var(--crm-red, #f87171)' }}>{failed}</div>
        </div>
        <div className="crm-integration-card">
          <span className="crm-kpi-label">In Retry Queue</span>
          <div className="crm-kpi-value">{received + processing + failed}</div>
        </div>
      </div>

      {/* Webhook endpoint (no secret shown) */}
      <div className="crm-panel" style={{ marginBottom: '1.5rem' }}>
        <h2 className="crm-h2" style={{ marginBottom: '0.5rem' }}>Webhook Endpoint</h2>
        <p className="crm-sub" style={{ marginBottom: '0.5rem' }}>
          Point CallGrid at this URL. Requests are verified by HMAC signature; the
          shared secret lives in the server environment and is never displayed.
        </p>
        <code className="crm-code-inline">POST {WEBHOOK_PATH}</code>
      </div>

      {/* Retry queue */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h2 className="crm-h2" style={{ marginBottom: '1rem' }}>Retry Queue</h2>
        {retryQueue.length === 0 ? (
          <p className="crm-empty">Retry queue is empty — all events processed cleanly.</p>
        ) : (
          <table className="crm-table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Status</th>
                <th>Received</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {retryQueue.map((e) => (
                <tr key={e.id}>
                  <td>{e.eventType ?? '—'}</td>
                  <td><span className={'crm-integration-status ' + e.status}>{e.status}</span></td>
                  <td>{fmt(e.receivedAt)}</td>
                  <td style={{ color: 'var(--crm-red, #f87171)' }}>{e.errorMessage ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Recent events */}
      <div>
        <h2 className="crm-h2" style={{ marginBottom: '1rem' }}>Recent Events</h2>
        {recent.length === 0 ? (
          <p className="crm-empty">No CallGrid events received yet.</p>
        ) : (
          <table className="crm-table">
            <thead>
              <tr>
                <th>Event</th>
                <th>External ID</th>
                <th>Status</th>
                <th>Received</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((e) => (
                <tr key={e.id}>
                  <td>{e.eventType ?? '—'}</td>
                  <td><code className="crm-code-inline">{e.externalId ?? '—'}</code></td>
                  <td><span className={'crm-integration-status ' + e.status}>{e.status}</span></td>
                  <td>{fmt(e.receivedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
