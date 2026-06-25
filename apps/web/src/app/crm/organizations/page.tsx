// CRM Organizations — Sprint 7 (Identity, Authentication & Organizations).
//
// Real organization management replacing the demo-only assumption: list every
// organization with usage counts, mark the active one (an org switcher entry),
// and create new organizations. Editing branding / CRM defaults lives in
// Settings. Protected by organizations:view; creation requires create rights.

import { requirePermission, hasPermission } from '../../../auth/guard';
import { repositories } from '@emgloop/database';
import { createOrganizationAction } from '../../../crm/admin-actions';

export const dynamic = 'force-dynamic';

export default async function OrganizationsPage() {
  const session = await requirePermission('organizations', 'view');
  const canCreate = await hasPermission('organizations', 'create');
  const orgs = await repositories.organizations.listSummaries();

  return (
    <div className="crm-page">
      <div className="crm-page-head">
        <div>
          <h1>Organizations</h1>
          <p>{orgs.length} organization(s) on the platform</p>
        </div>
      </div>

      {canCreate ? (
        <div className="crm-card" style={{ marginBottom: 18 }}>
          <h3>Create organization</h3>
          <form action={createOrganizationAction} className="crm-form-grid" style={{ marginTop: 10 }}>
            <label className="crm-field"><span>Name</span>
              <input className="crm-input" name="name" required /></label>
            <label className="crm-field"><span>Timezone</span>
              <input className="crm-input" name="timezone" defaultValue="UTC" placeholder="e.g. America/Chicago" /></label>
            <div className="crm-field" style={{ display:'flex', alignItems:'flex-end' }}>
              <button className="crm-btn-primary" type="submit" style={{ width:'auto', padding:'9px 16px' }}>Create</button>
            </div>
          </form>
        </div>
      ) : null}

      <table className="crm-table">
        <thead>
          <tr><th>Name</th><th>Slug</th><th>Industry</th><th>Status</th><th>Timezone</th><th>Users</th><th>Customers</th><th></th></tr>
        </thead>
        <tbody>
          {orgs.map((o) => (
            <tr key={o.id}>
              <td>{o.name}</td>
              <td className="crm-faint">{o.slug}</td>
              <td className="crm-faint">{o.industry}</td>
              <td><span className={'crm-badge ' + (o.status === 'ACTIVE' ? 'ok' : 'off')}>{o.status}</span></td>
              <td className="crm-faint">{o.timezone}</td>
              <td>{o.userCount}</td>
              <td>{o.customerCount}</td>
              <td>{o.id === session.organizationId ? <span className="crm-badge role">Active</span> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="crm-auth-hint" style={{ marginTop: 16 }}>
        The active organization is the one your session is scoped to. Full
        multi-org switching for users that belong to several organizations is
        scoped for a follow-up sprint.
      </p>
    </div>
  );
}
