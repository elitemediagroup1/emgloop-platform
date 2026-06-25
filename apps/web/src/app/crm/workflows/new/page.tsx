import Link from 'next/link';
import { requirePermission } from '../../../../auth/guard';
import { createWorkflowAction } from '../../../../crm/workflow-actions';

// New workflow — Sprint 9 (Workflows & Automation, CRM Phase 4).
//
// Minimal create form: name, description, and the trigger (with an event-name
// field for EVENT triggers). Steps are added afterward in the builder. The
// page is permission-gated behind workflows:create; on submit the action
// persists the workflow and redirects to its builder.

export const dynamic = 'force-dynamic';

export default async function NewWorkflowPage() {
  await requirePermission('workflows', 'create');

  return (
    <>
      <div className="crm-breadcrumb">
        <Link href="/crm/workflows">← Workflows</Link>
      </div>
      <h1 className="crm-h1">New workflow</h1>
      <p className="crm-sub">
        Name the automation and pick a trigger. You will add steps next.
      </p>

      <div className="crm-panel">
        <form action={createWorkflowAction} className="crm-form">
          <label className="crm-field">
            <span className="crm-faint">Name</span>
            <input className="crm-input" name="name" required placeholder="e.g. Tag new HVAC leads" />
          </label>

          <label className="crm-field">
            <span className="crm-faint">Description</span>
            <input className="crm-input" name="description" placeholder="Optional summary" />
          </label>

          <label className="crm-field">
            <span className="crm-faint">Trigger</span>
            <select className="crm-select" name="trigger" defaultValue="MANUAL">
              <option value="MANUAL">Manual — run on demand</option>
              <option value="EVENT">Event — fire on a domain event</option>
              <option value="SCHEDULE">Schedule — recurring (hint only)</option>
            </select>
          </label>

          <label className="crm-field">
            <span className="crm-faint">Event name (for Event triggers)</span>
            <input className="crm-input" name="eventName" placeholder="e.g. customer.created" />
          </label>

          <label className="crm-field">
            <span className="crm-faint">Schedule hint (for Schedule triggers)</span>
            <input className="crm-input" name="schedule" placeholder="e.g. daily 09:00" />
          </label>

          <div className="crm-form-actions">
            <Link href="/crm/workflows" className="crm-btn-ghost crm-btn">Cancel</Link>
            <button className="crm-btn" type="submit">Create workflow</button>
          </div>
        </form>
      </div>
    </>
  );
}
