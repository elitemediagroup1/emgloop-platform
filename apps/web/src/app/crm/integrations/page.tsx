import { loadOrFallback, DbNotConfigured } from '../../../demo/db-health';
import { crmRepos, resolveCrmOrganizationId } from '../../../crm/crm-data';
import { requirePermission, hasPermission } from '../../../auth/guard';
import { createIntegrationAction, deleteIntegrationAction } from '../../../crm/integration-actions';
import { KNOWN_PROVIDERS } from '@emgloop/shared';


// Integrations — Sprint 10 (Loop Intelligence Foundation, Phase 2).


export const dynamic = 'force-dynamic';


export default async function IntegrationsPage() {
  await requirePermission('integrations', 'view');
  const canManage = await hasPermission('integrations', 'create');
  const orgId = await resolveCrmOrganizationId();

  const result = await loadOrFallback(async () => {
    if (!orgId) return null;
    const [connections, eventCounts] = await Promise.all([
      crmRepos.integrations.listConnections(orgId),
      crmRepos.integrations.countEventsByStatus(orgId),
    ]);
    return { connections, eventCounts };
  });

  if (!result.ok || !result.data) {
    return (
      <>
        <h1 className="crm-h1">Integrations</h1>
        <DbNotConfigured />
      </>
    );
  }

  const { connections, eventCounts } = result.data;
  const ingestionProviders = KNOWN_PROVIDERS['ingestion'];
  const analyticsProviders = KNOWN_PROVIDERS['analytics'];
  const totalEvents = Object.values(eventCounts).reduce((a, b) => a + b, 0);
  const processedEvents = eventCounts['PROCESSED'] ?? 0;
  const failedEvents = eventCounts['FAILED'] ?? 0;

  return (
    <>
      <div className="crm-wf-head">
        <div>
          <h1 className="crm-h1">Integrations</h1>
          <p className="crm-sub">
            Configuration only — no real API calls, no OAuth, no credentials stored.
            Connections are PENDING until a real provider adapter is registered.
          </p>
        </div>
      </div>

      {totalEvents > 0 ? (
        <div className="crm-panel" style={{ marginBottom: '1.5rem', display: 'flex', gap: '2rem', fontSize: '0.85rem' }}>
          <div>
            <span style={{ color: 'var(--crm-faint)', fontSize: '0.7rem', textTransform: 'uppercase', display: 'block', marginBottom: '0.3rem' }}>Total Events</span>
            <span style={{ fontSize: '1.5rem', fontWeight: 700 }}>{totalEvents}</span>
          </div>
          <div>
            <span style={{ color: 'var(--crm-faint)', fontSize: '0.7rem', textTransform: 'uppercase', display: 'block', marginBottom: '0.3rem' }}>Processed</span>
            <span style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--crm-accent)' }}>{processedEvents}</span>
          </div>
          <div>
            <span style={{ color: 'var(--crm-faint)', fontSize: '0.7rem', textTransform: 'uppercase', display: 'block', marginBottom: '0.3rem' }}>Failed</span>
            <span style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--crm-red, #f87171)' }}>{failedEvents}</span>
          </div>
        </div>
      ) : null}

      <div style={{ marginBottom: '1.5rem' }}>
        <h2 className="crm-h2" style={{ marginBottom: '1rem' }}>Active Connections</h2>
        {connections.length === 0 ? (
          <p className="crm-empty">No connections configured yet. Add one below.</p>
        ) : (
          <div className="crm-integrations-grid">
            {connections.map((c) => (
              <div key={c.id} className="crm-integration-card">
                <div className="crm-integration-card-header">
                  <span className="crm-integration-card-name">{c.displayName}</span>
                  <span className="crm-integration-card-category">{c.category}</span>
                </div>
                <div className={'crm-integration-status ' + c.status}>{c.status}</div>
                <div className="crm-integration-card-config">
                  Provider: <strong>{c.provider}</strong>
                </div>
                {c.connectedAt ? (
                  <div className="crm-integration-card-config">
                    Connected: {new Date(c.connectedAt).toLocaleDateString()}
                  </div>
                ) : null}
                {canManage ? (
                  <div className="crm-integration-card-actions">
                    <form action={deleteIntegrationAction}>
                      <input type="hidden" name="connectionId" value={c.id} />
                      <button type="submit" className="crm-btn-sm crm-btn-danger">Remove</button>
                    </form>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      {canManage ? (
        <div className="crm-panel" style={{ marginBottom: '1.5rem' }}>
          <h2 className="crm-h2" style={{ marginBottom: '1rem' }}>Add Connection</h2>
          <p style={{ fontSize: '0.8rem', color: 'var(--crm-muted)', marginBottom: '1rem' }}>
            Configuration only — no credentials, no API keys, no OAuth.
          </p>
          <form action={createIntegrationAction} className="crm-form" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="crm-field">
              <label className="crm-label">Category</label>
              <select name="category" className="crm-input" required defaultValue="">
                <option value="" disabled>Select category</option>
                <option value="ingestion">ingestion</option>
                <option value="analytics">analytics</option>
              </select>
            </div>
            <div className="crm-field">
              <label className="crm-label">Provider</label>
              <select name="provider" className="crm-input" required defaultValue="">
                <option value="" disabled>Select provider</option>
                {[...ingestionProviders, ...analyticsProviders]
                  .filter((v, i, a) => a.indexOf(v) === i)
                  .map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
              </select>
            </div>
            <div className="crm-field" style={{ flex: 1, minWidth: 180 }}>
              <label className="crm-label">Display Name</label>
              <input type="text" name="displayName" className="crm-input" placeholder="e.g. CallGrid Production" />
            </div>
            <button type="submit" className="crm-btn">Add Connection</button>
          </form>
        </div>
      ) : null}

      <div className="crm-integration-available">
        <div className="crm-integration-available-title">Available Ingestion Providers (planned)</div>
        <div className="crm-provider-chips">
          {ingestionProviders.map((p) => (<span key={p} className="crm-provider-chip">{p}</span>))}
        </div>
      </div>

      <div className="crm-integration-available">
        <div className="crm-integration-available-title">Available Analytics Providers (planned)</div>
        <div className="crm-provider-chips">
          {analyticsProviders.map((p) => (<span key={p} className="crm-provider-chip">{p}</span>))}
        </div>
      </div>
    </>
  );
}
