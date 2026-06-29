import Link from 'next/link';
import { requirePermission } from '../../../../auth/guard';
import { allSecretRefs, listProviders } from '@emgloop/brain';
import { IntegrationOsService } from '@emgloop/database';

// Secret Status — Sprint 16 (admin-only, status only).
//
// Consolidated view of every server environment variable referenced by the
// integration catalog. Reports CONFIGURED / MISSING (boolean) only — values
// are NEVER read or displayed. There is no secret-storage backend here; this
// reflects process.env presence so operators know what still needs setting in
// Netlify. Rotation is surfaced as guidance (done in the hosting dashboard).

export const dynamic = 'force-dynamic';

export default async function SecretStatusPage() {
  await requirePermission('integrations', 'manage');
  const refs = allSecretRefs();
  const providers = listProviders();

  const rows = refs.map((ref) => {
    const configured = IntegrationOsService.isSecretConfigured(ref.envVar);
    const usedBy = providers
      .filter((pr) => pr.secrets.some((s) => s.envVar === ref.envVar))
      .map((pr) => pr.displayName);
    return { ...ref, configured, usedBy };
  });
  const configuredCount = rows.filter((r) => r.configured).length;

  return (
    <>
      <div className="crm-wf-head">
        <div>
          <p className="crm-sub" style={{ marginBottom: '0.25rem' }}>
            <Link href="/crm/integrations" className="crm-link">Integration OS</Link> / Secrets
          </p>
          <h1 className="crm-h1">Secret Status</h1>
          <p className="crm-sub">
            {configuredCount} of {rows.length} configured. Status only — no secret
            value is ever read or displayed. Set or rotate values in the hosting
            environment (Netlify).
          </p>
        </div>
      </div>

      <div className="ios-section">
        {rows.map((r) => (
          <div key={r.envVar} className="ios-secret">
            <div>
              <div className="name">{r.envVar}</div>
              <div className="masked">{r.configured ? '••••••••••••••••' : 'not set'}</div>
              <div className="crm-sub" style={{ fontSize: '0.7rem', marginTop: '0.2rem' }}>Used by: {r.usedBy.join(', ')}{r.required ? ' · required' : ' · optional'}</div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <span className={'ios-badge ' + (r.configured ? 'connected' : (r.required ? 'error' : 'not_configured'))}>
                <span className="ios-dot" />{r.configured ? 'Configured' : (r.required ? 'Missing' : 'Optional')}
              </span>
              <button type="button" className="crm-btn-sm" disabled title="Rotate in the hosting environment">Rotate</button>
            </div>
          </div>
        ))}
      </div>

      <p className="crm-sub" style={{ fontSize: '0.75rem' }}>
        EMG Loop never stores integration secrets in the database or displays
        them. To add or rotate a value, update the environment variable in the
        hosting dashboard and redeploy; this page reflects the new state.
      </p>
    </>
  );
}
