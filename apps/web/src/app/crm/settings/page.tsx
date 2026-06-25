// CRM Settings — Sprint 7 (Identity, Authentication & Organizations).
//
// The organization Settings area: General (profile + timezone), Branding, and
// CRM Defaults (default pipeline status + default AI Employee). Pipeline
// defaults, tags, and business hours surface here as well. Protected by
// settings:view; saving requires settings:update. All reads/writes flow
// through the OrganizationRepository to Neon.

import { requirePermission, hasPermission } from '../../../auth/guard';
import { repositories, PIPELINE_STATUSES } from '@emgloop/database';
import {
  updateOrgProfileAction,
  updateBrandingAction,
  updateCrmDefaultsAction,
} from '../../../crm/admin-actions';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await requirePermission('settings', 'view');
  const canEdit = await hasPermission('settings', 'update');
  const orgId = session.organizationId;
  const [org, branding, crmDefaults, aiEmployees] = await Promise.all([
    repositories.organizations.findById(orgId),
    repositories.organizations.getBranding(orgId),
    repositories.organizations.getCrmDefaults(orgId),
    repositories.aiEmployees.listViews(orgId),
  ]);
  const fs = canEdit ? undefined : true;

  return (
    <div className="crm-page">
      <div className="crm-page-head">
        <div>
          <h1>Settings</h1>
          <p>{org ? org.name : 'Organization'} · {org ? org.timezone : 'UTC'}</p>
        </div>
      </div>

      <div className="crm-card" style={{ marginBottom: 16 }}>
        <h3>General</h3>
        <form action={updateOrgProfileAction} className="crm-form-grid" style={{ marginTop: 10 }}>
          <label className="crm-field"><span>Organization name</span>
            <input className="crm-input" name="name" defaultValue={org ? org.name : ''} disabled={fs} /></label>
          <label className="crm-field"><span>Timezone</span>
            <input className="crm-input" name="timezone" defaultValue={org ? org.timezone : 'UTC'} disabled={fs} /></label>
          <div className="crm-field full crm-inline-actions">
            <button className="crm-btn-sm" type="submit" disabled={fs}>Save general</button>
          </div>
        </form>
      </div>

      <div className="crm-card" style={{ marginBottom: 16 }}>
        <h3>Branding</h3>
        <form action={updateBrandingAction} className="crm-form-grid" style={{ marginTop: 10 }}>
          <label className="crm-field"><span>Logo text</span>
            <input className="crm-input" name="logoText" defaultValue={branding.logoText} disabled={fs} /></label>
          <label className="crm-field"><span>Tagline</span>
            <input className="crm-input" name="tagline" defaultValue={branding.tagline} disabled={fs} /></label>
          <label className="crm-field"><span>Primary color</span>
            <input className="crm-input" name="primaryColor" defaultValue={branding.primaryColor} disabled={fs} /></label>
          <label className="crm-field"><span>Accent color</span>
            <input className="crm-input" name="accentColor" defaultValue={branding.accentColor} disabled={fs} /></label>
          <div className="crm-field full crm-inline-actions">
            <button className="crm-btn-sm" type="submit" disabled={fs}>Save branding</button>
          </div>
        </form>
      </div>

      <div className="crm-card" style={{ marginBottom: 16 }}>
        <h3>CRM &amp; Pipeline defaults</h3>
        <form action={updateCrmDefaultsAction} className="crm-form-grid" style={{ marginTop: 10 }}>
          <label className="crm-field"><span>Default pipeline status</span>
            <select className="crm-select" name="defaultPipelineStatus" defaultValue={crmDefaults.defaultPipelineStatus} disabled={fs}>
              {PIPELINE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select></label>
          <label className="crm-field"><span>Default AI Employee</span>
            <select className="crm-select" name="defaultAIEmployee" defaultValue={crmDefaults.defaultAIEmployee} disabled={fs}>
              <option value="">None</option>
              {aiEmployees.map((e) => <option key={e.id} value={e.name}>{e.name}</option>)}
            </select></label>
          <div className="crm-field full crm-inline-actions">
            <button className="crm-btn-sm" type="submit" disabled={fs}>Save defaults</button>
          </div>
        </form>
      </div>

      <div className="crm-grid">
        <div className="crm-card"><h3>Business hours</h3><p>Per-organization operating hours feed AI Employee working hours. Managed alongside Organization DNA.</p></div>
        <div className="crm-card"><h3>Tags</h3><p>Tag taxonomy is derived from customers today; a managed tag list is scoped for a follow-up sprint.</p></div>
        <div className="crm-card"><h3>Default assignment rules</h3><p>Default assignee + AI Employee above seed new-customer assignment. Rule-based routing is a later sprint.</p></div>
      </div>
    </div>
  );
}
