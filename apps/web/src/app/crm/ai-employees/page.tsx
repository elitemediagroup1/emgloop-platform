// CRM AI Employees — Sprint 7 (Identity, Authentication & Organizations).
//
// Management interface for AI Employees: list with title, department, status,
// channels and provider preferences; create a new AI Employee; edit core
// fields + status; archive. Voice / AI provider preferences are configuration
// only — no API keys, no real providers. Protected by aiEmployees:view; edits
// require manage rights. Persisted via the repository layer to Neon.

import { requirePermission, hasPermission } from '../../../auth/guard';
import { repositories } from '@emgloop/database';
import {
  createAIEmployeeAction,
  updateAIEmployeeAction,
  archiveAIEmployeeAction,
} from '../../../crm/admin-actions';

export const dynamic = 'force-dynamic';

const STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'];

export default async function AIEmployeesPage() {
  const session = await requirePermission('aiEmployees', 'view');
  const canManage = await hasPermission('aiEmployees', 'update');
  const employees = await repositories.aiEmployees.listViews(session.organizationId);

  return (
    <div className="crm-page">
      <div className="crm-page-head">
        <div>
          <h1>AI Employees</h1>
          <p>{employees.length} AI Employee(s) · configuration only, no live providers</p>
        </div>
      </div>

      {canManage ? (
        <div className="crm-card" style={{ marginBottom: 18 }}>
          <h3>Create AI Employee</h3>
          <form action={createAIEmployeeAction} className="crm-form-grid" style={{ marginTop: 10 }}>
            <label className="crm-field"><span>Name</span>
              <input className="crm-input" name="name" required /></label>
            <label className="crm-field"><span>Title</span>
              <input className="crm-input" name="title" placeholder="e.g. Dispatcher" /></label>
            <label className="crm-field"><span>Department</span>
              <input className="crm-input" name="department" placeholder="e.g. Front Desk" /></label>
            <label className="crm-field"><span>Voice provider preference</span>
              <input className="crm-input" name="voiceProvider" placeholder="config only (e.g. elevenlabs)" /></label>
            <label className="crm-field"><span>AI provider preference</span>
              <input className="crm-input" name="aiProvider" placeholder="config only (e.g. anthropic)" /></label>
            <div className="crm-field" style={{ display:'flex', alignItems:'flex-end' }}>
              <button className="crm-btn-primary" type="submit" style={{ width:'auto', padding:'9px 16px' }}>Create</button>
            </div>
          </form>
        </div>
      ) : null}

      <div className="crm-grid">
        {employees.map((e) => (
          <div className="crm-card" key={e.id}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <h3 style={{ marginBottom: 2 }}>{e.name}</h3>
              <span className={'crm-badge ' + (e.status === 'ACTIVE' ? 'ok' : e.status === 'ARCHIVED' ? 'off' : 'warn')}>{e.status}</span>
            </div>
            <p>{e.title || 'AI Employee'}{e.department ? ' · ' + e.department : ''}</p>
            <p style={{ marginTop: 6 }}>
              Voice: {e.voiceProvider || 'none'} · AI: {e.aiProvider || 'none'}
            </p>
            {canManage ? (
              <form action={updateAIEmployeeAction} style={{ marginTop: 12 }}>
                <input type="hidden" name="id" value={e.id} />
                <div className="crm-form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                  <label className="crm-field"><span>Title</span>
                    <input className="crm-input" name="title" defaultValue={e.title} /></label>
                  <label className="crm-field"><span>Department</span>
                    <input className="crm-input" name="department" defaultValue={e.department} /></label>
                  <label className="crm-field"><span>Status</span>
                    <select className="crm-select" name="status" defaultValue={e.status}>
                      {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select></label>
                  <div className="crm-field" style={{ display:'flex', alignItems:'flex-end', gap: 8 }}>
                    <button className="crm-btn-sm" type="submit">Save</button>
                  </div>
                </div>
              </form>
            ) : null}
            {canManage && e.status !== 'ARCHIVED' ? (
              <form action={archiveAIEmployeeAction} style={{ marginTop: 8 }}>
                <input type="hidden" name="id" value={e.id} />
                <button className="crm-btn-sm crm-btn-danger" type="submit">Archive</button>
              </form>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
