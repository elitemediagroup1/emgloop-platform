import Link from 'next/link';
import { notFound } from 'next/navigation';
import { loadOrFallback, DbNotConfigured } from '../../../../demo/db-health';
import { crmRepos, resolveCrmOrganizationId } from '../../../../crm/crm-data';
import { requirePermission, hasPermission } from '../../../../auth/guard';
import { PIPELINE_STATUSES } from '@emgloop/database';
import {
  updateWorkflowMetaAction,
  addStepAction,
  removeStepAction,
  toggleWorkflowActiveAction,
  runWorkflowAction,
} from '../../../../crm/workflow-actions';

// Workflow builder + run history — Sprint 9 (Workflows & Automation).
//
// One screen to edit a workflow's metadata + trigger, compose its ordered
// step graph (internal steps only), run it manually against a chosen customer
// / conversation, and review its WorkflowRun history. Strictly read/write
// through the workflows repository and guarded behind workflows permissions.

export const dynamic = 'force-dynamic';

const CONV_STATUSES = ['OPEN', 'PENDING', 'SNOOZED', 'CLOSED'];

const STEP_LABEL: Record<string, string> = {
  add_tag: 'Add tag',
  set_pipeline_status: 'Set pipeline status',
  assign: 'Assign to',
  create_note: 'Create note',
  set_conversation_status: 'Set conversation status',
  emit_event: 'Emit domain event',
};

const RUN_COLOR: Record<string, string> = {
  SUCCEEDED: 'var(--crm-accent)',
  FAILED: 'var(--crm-red, #f87171)',
  RUNNING: 'var(--crm-blue)',
  PENDING: 'var(--crm-amber)',
  CANCELED: 'var(--crm-faint)',
};

function fmt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function describeStep(type: string, config: Record<string, unknown>): string {
  const s = (k: string) => (typeof config[k] === 'string' ? (config[k] as string) : '');
  switch (type) {
    case 'add_tag': return s('tag') || '(no tag)';
    case 'set_pipeline_status': return s('status') || '(no status)';
    case 'assign': return s('humanName') || '(unassign)';
    case 'create_note': return s('text') || '(no text)';
    case 'set_conversation_status': return s('status') || '(no status)';
    case 'emit_event': return s('eventName') || '(no event)';
    default: return '';
  }
}

export default async function WorkflowBuilderPage({
  params,
}: {
  params: { id: string };
}) {
  await requirePermission('workflows', 'view');
  const canEdit = await hasPermission('workflows', 'update');

  const result = await loadOrFallback(async () => {
    const organizationId = await resolveCrmOrganizationId();
    if (!organizationId) return { empty: true as const };
    const [workflow, runs, customerList, conversationList] = await Promise.all([
      crmRepos.workflows.getWorkflow(params.id),
      crmRepos.workflows.listRuns(params.id, 25),
      crmRepos.crm.listCustomers(organizationId, { pageSize: 50 }),
      crmRepos.conversationsInbox.listConversations(organizationId, {}),
    ]);
    return {
      empty: false as const,
      workflow,
      runs,
      customers: customerList.rows,
      conversations: conversationList.rows,
    };
  });

  if (!result.ok) return <DbNotConfigured />;
  if (result.data.empty || !result.data.workflow) notFound();

  const { workflow, runs, customers, conversations } = result.data;
  const w = workflow!;

  return (
    <>
      <div className="crm-breadcrumb">
        <Link href="/crm/workflows">← Workflows</Link>
      </div>

      <div className="crm-wf-head">
        <div>
          <h1 className="crm-h1">{w.name}</h1>
          <p className="crm-sub">
            {w.trigger}
            {w.trigger === 'EVENT' && w.triggerConfig.eventName
              ? ' · ' + w.triggerConfig.eventName
              : ''}{' '}
            · {w.definition.steps.length} step
            {w.definition.steps.length === 1 ? '' : 's'} ·{' '}
            <span style={{ color: w.isActive ? 'var(--crm-accent)' : 'var(--crm-faint)' }}>
              {w.isActive ? 'Active' : 'Inactive'}
            </span>
          </p>
        </div>
        {canEdit ? (
          <form action={toggleWorkflowActiveAction}>
            <input type="hidden" name="workflowId" value={w.id} />
            <input type="hidden" name="active" value={w.isActive ? 'false' : 'true'} />
            <button className="crm-btn" type="submit">
              {w.isActive ? 'Deactivate' : 'Activate'}
            </button>
          </form>
        ) : null}
      </div>

      <div className="crm-wf-grid">
        <section className="crm-panel">
          <h2 className="crm-h2">Trigger & details</h2>
          {canEdit ? (
            <form action={updateWorkflowMetaAction} className="crm-form">
              <input type="hidden" name="workflowId" value={w.id} />
              <label className="crm-field">
                <span className="crm-faint">Name</span>
                <input className="crm-input" name="name" defaultValue={w.name} />
              </label>
              <label className="crm-field">
                <span className="crm-faint">Description</span>
                <input className="crm-input" name="description" defaultValue={w.description} />
              </label>
              <label className="crm-field">
                <span className="crm-faint">Trigger</span>
                <select className="crm-select" name="trigger" defaultValue={w.trigger}>
                  <option value="MANUAL">Manual</option>
                  <option value="EVENT">Event</option>
                  <option value="SCHEDULE">Schedule</option>
                </select>
              </label>
              <label className="crm-field">
                <span className="crm-faint">Event name</span>
                <input className="crm-input" name="eventName" defaultValue={w.triggerConfig.eventName ?? ''} placeholder="customer.created" />
              </label>
              <label className="crm-field">
                <span className="crm-faint">Schedule hint</span>
                <input className="crm-input" name="schedule" defaultValue={w.triggerConfig.schedule ?? ''} />
              </label>
              <div className="crm-form-actions">
                <button className="crm-btn-sm" type="submit">Save details</button>
              </div>
            </form>
          ) : (
            <p className="crm-faint">Read-only. {w.description}</p>
          )}
        </section>

        <section className="crm-panel">
          <h2 className="crm-h2">Steps</h2>
          {w.definition.steps.length === 0 ? (
            <div className="crm-empty">No steps yet.</div>
          ) : (
            <ol className="crm-step-list">
              {w.definition.steps.map((s, i) => (
                <li key={i} className="crm-step">
                  <span className="crm-step-idx">{i + 1}</span>
                  <span className="crm-step-label">{STEP_LABEL[s.type] ?? s.type}</span>
                  <span className="crm-step-detail">{describeStep(s.type, s.config)}</span>
                  {canEdit ? (
                    <form action={removeStepAction} style={{ display: 'inline' }}>
                      <input type="hidden" name="workflowId" value={w.id} />
                      <input type="hidden" name="index" value={i} />
                      <button className="crm-x" type="submit" title="Remove step">×</button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ol>
          )}

          {canEdit ? (
            <form action={addStepAction} className="crm-form crm-add-step">
              <input type="hidden" name="workflowId" value={w.id} />
              <label className="crm-field">
                <span className="crm-faint">Add a step</span>
                <select className="crm-select" name="type" defaultValue="add_tag">
                  <option value="add_tag">Add tag</option>
                  <option value="set_pipeline_status">Set pipeline status</option>
                  <option value="assign">Assign to human</option>
                  <option value="create_note">Create note</option>
                  <option value="set_conversation_status">Set conversation status</option>
                  <option value="emit_event">Emit domain event</option>
                </select>
              </label>
              <div className="crm-step-configs">
                <input className="crm-input crm-input-sm" name="tag" placeholder="tag (for Add tag)" />
                <select className="crm-select crm-input-sm" name="status" defaultValue="">
                  <option value="">pipeline status…</option>
                  {PIPELINE_STATUSES.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
                <input className="crm-input crm-input-sm" name="humanName" placeholder="assignee name (for Assign)" />
                <input className="crm-input crm-input-sm" name="text" placeholder="note text (for Create note)" />
                <select className="crm-select crm-input-sm" name="convStatus" defaultValue="">
                  <option value="">conversation status…</option>
                  {CONV_STATUSES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <input className="crm-input crm-input-sm" name="emitEventName" placeholder="event name (for Emit event)" />
              </div>
              <div className="crm-form-actions">
                <button className="crm-btn-sm" type="submit">Add step</button>
              </div>
            </form>
          ) : null}
        </section>
      </div>

      {canEdit ? (
        <section className="crm-panel">
          <h2 className="crm-h2">Run manually</h2>
          <p className="crm-faint">
            Pick a customer and/or conversation as the run context, then execute
            every step once. All effects are internal data writes.
          </p>
          <form action={runWorkflowAction} className="crm-inline-form crm-run-form">
            <input type="hidden" name="workflowId" value={w.id} />
            <select className="crm-select" name="customerId" defaultValue="">
              <option value="">— no customer —</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <select className="crm-select" name="conversationId" defaultValue="">
              <option value="">— no conversation —</option>
              {conversations.map((c) => (
                <option key={c.id} value={c.id}>{c.subject} · {c.customerName}</option>
              ))}
            </select>
            <button className="crm-btn" type="submit">Run now</button>
          </form>
        </section>
      ) : null}

      <section className="crm-panel">
        <h2 className="crm-h2">Run history</h2>
        {runs.length === 0 ? (
          <div className="crm-empty">This workflow has not run yet.</div>
        ) : (
          <table className="crm-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Status</th>
                <th>Result</th>
                <th>Triggered by</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{fmt(r.createdAt)}</td>
                  <td>
                    <span
                      className="crm-status-pill"
                      style={{ color: RUN_COLOR[r.status] ?? 'var(--crm-faint)' }}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="crm-cell-muted">
                    {r.summary}
                    {r.error ? ' · ' + r.error : ''}
                  </td>
                  <td className="crm-cell-muted">{r.triggeredBy ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
