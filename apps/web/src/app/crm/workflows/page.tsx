import Link from 'next/link';
import { loadOrFallback, DbNotConfigured } from '../../../demo/db-health';
import { crmRepos, resolveCrmOrganizationId } from '../../../crm/crm-data';
import { requirePermission, hasPermission } from '../../../auth/guard';
import { toggleWorkflowActiveAction } from '../../../crm/workflow-actions';

// Workflows list — Sprint 9 (Workflows & Automation, CRM Phase 4).
//
// Every workflow in the organization with its trigger type, active state,
// step count, and last-run status. Read straight from Neon via the workflows
// repository; the whole page is permission-gated behind workflows:view, and
// the activate/deactivate toggle behind workflows:update.

export const dynamic = 'force-dynamic';

const RUN_COLOR: Record<string, string> = {
  SUCCEEDED: 'var(--crm-accent)',
  FAILED: 'var(--crm-red, #f87171)',
  RUNNING: 'var(--crm-blue)',
  PENDING: 'var(--crm-amber)',
  CANCELED: 'var(--crm-faint)',
};

function relTime(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.floor(hrs / 24) + 'd ago';
}

export default async function WorkflowsPage() {
  await requirePermission('workflows', 'view');
  const canManage = await hasPermission('workflows', 'create');
  const canToggle = await hasPermission('workflows', 'update');

  const result = await loadOrFallback(async () => {
    const organizationId = await resolveCrmOrganizationId();
    if (!organizationId) return { empty: true as const };
    const workflows = await crmRepos.workflows.listWorkflows(organizationId);
    return { empty: false as const, workflows };
  });

  if (!result.ok) return <DbNotConfigured />;
  if (result.data.empty) {
    return (
      <>
        <h1 className="crm-h1">Workflows</h1>
        <p className="crm-sub">No organization data yet.</p>
      </>
    );
  }

  const { workflows } = result.data;
  const activeCount = workflows.filter((w) => w.isActive).length;

  return (
    <>
      <div className="crm-wf-head">
        <div>
          <h1 className="crm-h1">Workflows</h1>
          <p className="crm-sub">
            Internal automation — {workflows.length} workflow
            {workflows.length === 1 ? '' : 's'}, {activeCount} active.
          </p>
        </div>
        {canManage ? (
          <Link href="/crm/workflows/new" className="crm-btn">New workflow</Link>
        ) : null}
      </div>

      <div className="crm-panel">
        {workflows.length === 0 ? (
          <div className="crm-empty">
            No workflows yet. Automations run internal steps only — add tags, set
            pipeline or conversation status, assign, create notes, or emit events.
          </div>
        ) : (
          <table className="crm-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Trigger</th>
                <th>Steps</th>
                <th>State</th>
                <th>Last run</th>
                <th>Runs</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {workflows.map((w) => (
                <tr key={w.id}>
                  <td>
                    <Link className="crm-cell-name" href={'/crm/workflows/' + w.id}>
                      {w.name}
                    </Link>
                    {w.description ? (
                      <div className="crm-cell-muted">{w.description}</div>
                    ) : null}
                  </td>
                  <td>
                    {w.trigger}
                    {w.trigger === 'EVENT' && w.eventName ? (
                      <div className="crm-cell-muted">{w.eventName}</div>
                    ) : null}
                  </td>
                  <td>{w.stepCount}</td>
                  <td>
                    <span
                      className="crm-status-pill"
                      style={{ color: w.isActive ? 'var(--crm-accent)' : 'var(--crm-faint)' }}
                    >
                      {w.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td>
                    {w.lastRunStatus ? (
                      <span
                        className="crm-status-pill"
                        style={{ color: RUN_COLOR[w.lastRunStatus] ?? 'var(--crm-faint)' }}
                        title={relTime(w.lastRunAt)}
                      >
                        {w.lastRunStatus}
                      </span>
                    ) : (
                      <span className="crm-faint">never</span>
                    )}
                  </td>
                  <td>{w.runCount}</td>
                  <td>
                    {canToggle ? (
                      <form action={toggleWorkflowActiveAction} style={{ display: 'inline' }}>
                        <input type="hidden" name="workflowId" value={w.id} />
                        <input type="hidden" name="active" value={w.isActive ? 'false' : 'true'} />
                        <button className="crm-btn-sm" type="submit">
                          {w.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
